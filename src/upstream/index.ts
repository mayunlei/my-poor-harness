/**
 * Upstream: one object both the harness model client and `mph proxy` use to send a
 * Responses API request. Two providers:
 *   - codex: built-in ChatGPT OAuth reverse proxy (see codex.ts / codex_auth.ts)
 *   - openai_compatible: any /responses endpoint with an optional Bearer key, or a
 *     /chat/completions endpoint (wire_api=chat; requests and replies are translated, see chat.ts)
 */
import { resolveUpstream, describeUpstream, type ResolvedUpstream, type UpstreamOverrides } from "./config.js";
import { CodexAuth } from "./codex_auth.js";
import { CodexTransport } from "./codex.js";
import { chatResponses } from "./chat.js";

export interface SendOptions {
  stream: boolean;
  sessionId?: string;
  signal?: AbortSignal;
  /** headers forwarded from a proxied client (openai_compatible only; auth is overridden by the configured key) */
  forwardHeaders?: Record<string, string>;
}

export class Upstream {
  readonly codex?: CodexTransport;
  /** current wire api (may switch from responses to chat after a 404 when not set explicitly) */
  wireApi: "responses" | "chat";
  constructor(readonly resolved: ResolvedUpstream, env: NodeJS.ProcessEnv = process.env) {
    this.wireApi = resolved.wireApi;
    if (resolved.provider === "codex") this.codex = new CodexTransport(new CodexAuth(env), resolved.baseUrl, resolved.originator);
  }

  describe(): string { return describeUpstream(this.resolved); }
  get provider() { return this.resolved.provider; }


  responsesUrl(): string {
    if (this.codex) return this.codex.responsesUrl;
    return this.resolved.baseUrl.replace(/\/$/, "") + (this.wireApi === "chat" ? "/chat/completions" : "/responses");
  }

  async responses(body: any, opts: SendOptions): Promise<Response> {
    if (this.codex) return this.codex.responses(body, { stream: opts.stream, sessionId: opts.sessionId, signal: opts.signal });
    if (this.wireApi === "chat") return chatResponses(this.resolved.baseUrl, this.resolved.apiKey, body, opts);
    const headers: Record<string, string> = { ...(opts.forwardHeaders ?? {}), "content-type": "application/json" };
    if (this.resolved.apiKey) headers["authorization"] = `Bearer ${this.resolved.apiKey}`;
    const r = await fetch(this.responsesUrl(), { method: "POST", headers, body: JSON.stringify({ ...body, stream: opts.stream }), signal: opts.signal });
    if (r.status === 404 && !this.resolved.wireApiExplicit) {
      // endpoint has no Responses API: switch this upstream to chat completions for good
      await r.text().catch(() => "");
      this.wireApi = "chat";
      return chatResponses(this.resolved.baseUrl, this.resolved.apiKey, body, opts);
    }
    return r;
  }

  /** model list for /models (codex has no list endpoint; openai_compatible is proxied) */
  async models(forwardHeaders: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    if (this.codex) return { status: 200, body: JSON.stringify({ object: "list", data: this.resolved.codexModels.map((id) => ({ id, object: "model", owned_by: "chatgpt" })) }) };
    const headers: Record<string, string> = { ...forwardHeaders };
    if (this.resolved.apiKey) headers["authorization"] = `Bearer ${this.resolved.apiKey}`;
    const r = await fetch(this.resolved.baseUrl.replace(/\/$/, "") + "/models", { headers });
    return { status: r.status, body: await r.text() };
  }
}

export function upstreamFor(overrides: UpstreamOverrides = {}, env: NodeJS.ProcessEnv = process.env): Upstream {
  return new Upstream(resolveUpstream(overrides, env), env);
}

export { resolveUpstream, describeUpstream, loadConfigFile, saveConfigFile, configPath, type ResolvedUpstream, type UpstreamOverrides, type Provider, type WireApi } from "./config.js";
export { CodexAuth, loadCredentials, saveCredentials, clearCredentials, authFilePath, codexCliAuthPath, planFromToken } from "./codex_auth.js";
export { parseMeter, meterDelta, meterHeaders, METER_HEADERS, type MeterSnapshot, type MeterWindow, type MeterCredits, type MeterDelta } from "./meter.js";
