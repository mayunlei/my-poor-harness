/**
 * Codex transport: sends a Responses API body to the ChatGPT Codex backend
 * (the same endpoint the Codex CLI uses) with the OAuth credentials from codex_auth.
 *
 * Backend constraints (observed in the Codex CLI / codex_api):
 *   - POST {base}/codex/responses, always `stream: true` and `store: false`
 *   - `instructions` must be present (system/developer messages are hoisted into it)
 *   - headers: Authorization: Bearer, chatgpt-account-id, OpenAI-Beta: responses=experimental,
 *     originator, session_id (optional; we use prompt_cache_key)
 * A client that asked for a non-streaming reply gets the SSE aggregated into the final
 * `response` JSON. A 401 triggers one credential refresh and a retry.
 */
import { CodexAuth, type CodexCredentials } from "./codex_auth.js";
import { contentText } from "../core/items.js";
import { ResponseCollector, parseSseBlocks } from "./sse.js";

export interface CodexSendOptions {
  /** whether the caller will consume SSE; otherwise the stream is aggregated into JSON */
  stream: boolean;
  sessionId?: string;
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
}

export function codexHeaders(c: CodexCredentials, originator: string, sessionId?: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    ...extra,
    authorization: `Bearer ${c.accessToken}`,
    "chatgpt-account-id": c.accountId,
    "openai-beta": "responses=experimental",
    originator,
    accept: "text/event-stream",
    "content-type": "application/json",
    "user-agent": `token_harness (${process.platform}; node ${process.versions.node})`,
  };
  if (sessionId) h["session_id"] = sessionId;
  return h;
}

/** make the body acceptable for the Codex backend without changing what the model sees */
export function prepareCodexBody(body: any): any {
  const b: any = { ...body, stream: true, store: false };
  delete b.metadata;              // backend rejects unknown metadata; th_compact already consumed by the proxy
  delete b.user;
  delete b.service_tier;
  if (typeof b.instructions !== "string" || !b.instructions) {
    // hoist leading system/developer messages into `instructions`
    const input: any[] = Array.isArray(b.input) ? [...b.input] : [];
    const parts: string[] = [];
    while (input.length && (input[0]?.role === "system" || input[0]?.role === "developer") && (input[0]?.type === "message" || input[0]?.type === undefined)) parts.push(contentText(input.shift().content));
    b.instructions = parts.join("\n\n") || "You are a helpful coding assistant.";
    b.input = input;
  }
  if (!Array.isArray(b.include)) b.include = ["reasoning.encrypted_content"];
  return b;
}

/** Read an SSE body to completion and return the final response object (or an error). */
export async function aggregateSse(res: Response): Promise<{ status: number; json: any }> {
  const text = await res.text();
  const col = new ResponseCollector();
  for (const ev of parseSseBlocks(text)) col.feed(ev);
  const final = col.response();
  if (final && !col.error) return { status: 200, json: final };
  if (col.error) return { status: 502, json: { error: typeof col.error === "object" ? col.error : { message: String(col.error) } } };
  return { status: 502, json: { error: { message: "stream ended without response.completed", raw: text.slice(0, 500) } } };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true }); }); }

export class CodexTransport {
  maxRetries = 3;
  backoffMs = 1000;
  constructor(readonly auth: CodexAuth, readonly baseUrl: string, readonly originator = "codex_cli_rs") {}

  get responsesUrl(): string { return this.baseUrl.replace(/\/$/, "") + "/codex/responses"; }

  /** Returns the upstream Response: SSE when opts.stream, otherwise a synthesized JSON Response.
   *  Retries HTTP 429 / 5xx and network errors with backoff (1s, 2s, 4s); a 401 refreshes the token once. */
  async responses(body: any, opts: CodexSendOptions): Promise<Response> {
    const prepared = prepareCodexBody(body);
    const sessionId = opts.sessionId ?? (typeof prepared.prompt_cache_key === "string" ? prepared.prompt_cache_key : undefined);
    const payload = JSON.stringify(prepared);
    let creds = await this.auth.get();
    let r!: Response; let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await fetch(this.responsesUrl, { method: "POST", headers: codexHeaders(creds, this.originator, sessionId, opts.extraHeaders), body: payload, signal: opts.signal });
      } catch (e: any) {
        if (attempt >= this.maxRetries || opts.signal?.aborted) throw e;
        await sleep(this.backoffMs * 2 ** attempt, opts.signal); continue;
      }
      if (r.status === 401 && !refreshed) { refreshed = true; await r.text().catch(() => ""); creds = await this.auth.get(true); continue; }
      if ((r.status === 429 || r.status >= 500) && attempt < this.maxRetries) { await r.text().catch(() => ""); await sleep(this.backoffMs * 2 ** attempt, opts.signal); continue; }
      break;
    }
    if (opts.stream || !r.ok) return r;
    const { status, json } = await aggregateSse(r);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }
}
