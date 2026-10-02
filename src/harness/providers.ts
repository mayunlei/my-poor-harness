/**
 * Model clients. The harness speaks one internal shape (Responses-like items)
 * and adapts to OpenAI Responses (incl. codex_api proxy / ctx-proxy) or
 * Anthropic Messages. The OpenAI path goes through `Upstream` (built-in Codex
 * reverse proxy or any OpenAI-compatible endpoint, see src/upstream).
 */
import { upstreamFor, type Upstream } from "../upstream/index.js";
import { ResponseCollector, SseLineBuffer } from "../upstream/sse.js";
export interface ToolDef { name: string; description: string; parameters: any }
export interface ModelRequest {
  model: string;
  instructions: string;
  input: any[];                    // Responses-style items
  tools: ToolDef[];
  reasoningEffort?: string;
  maxOutputTokens?: number;
  promptCacheKey?: string;
  onText?: (delta: string) => void;
}
export interface Usage { input: number; cached: number; output: number; reasoning: number }
export interface ModelResponse { output: any[]; usage: Usage; text: string; calls: { callId: string; name: string; args: any; raw: any }[]; raw?: any }
export interface ModelClient { respond(req: ModelRequest): Promise<ModelResponse> }

function callsOf(output: any[]): ModelResponse["calls"] {
  return output.filter((x) => x?.type === "function_call").map((x) => { let args: any = {}; try { args = JSON.parse(x.arguments ?? "{}"); } catch { args = { _raw: x.arguments }; } return { callId: x.call_id, name: x.name, args, raw: x }; });
}
function textOf(output: any[]): string {
  return output.filter((x) => x?.type === "message" && x.role === "assistant").map((x) => (Array.isArray(x.content) ? x.content.map((c: any) => c?.text ?? "").join("") : String(x.content ?? ""))).join("\n");
}

export class OpenAIResponsesClient implements ModelClient {
  readonly upstream: Upstream;
  /** `new OpenAIResponsesClient(upstream)` or the legacy `(baseUrl, apiKey, extraHeaders)` form */
  constructor(target: Upstream | string, readonly apiKey?: string, readonly extraHeaders: Record<string, string> = {}) {
    this.upstream = typeof target === "string" ? upstreamFor({ provider: "openai_compatible", baseUrl: target, apiKey }) : target;
  }
  /** transient failures (overloaded / rate limited / 5xx) are retried with backoff before surfacing */
  async respond(req: ModelRequest): Promise<ModelResponse> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.respondOnce(req); }
      catch (e: any) {
        const transient = /overloaded|rate_limit|rate limit|429|50[0-4]|ECONNRESET|fetch failed|socket hang up/i.test(String(e?.message ?? e));
        if (!transient || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      }
    }
  }
  private async respondOnce(req: ModelRequest): Promise<ModelResponse> {
    const stream = !!req.onText;
    const body: any = {
      model: req.model, instructions: req.instructions, input: req.input, store: false, stream,
      tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
      parallel_tool_calls: true, include: ["reasoning.encrypted_content"],
    };
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort, summary: "auto" };
    if (req.maxOutputTokens) body.max_output_tokens = req.maxOutputTokens;
    if (req.promptCacheKey) body.prompt_cache_key = req.promptCacheKey;
    let r = await this.upstream.responses(body, { stream, sessionId: req.promptCacheKey, forwardHeaders: this.extraHeaders });
    if (!r.ok) {
      const errorText = await r.text();
      // Some Responses-compatible providers reject the OpenAI-only
      // `max_output_tokens` field (notably for their small/auxiliary models).
      // Retry once without the optional cap instead of failing memory/card work.
      if (r.status === 400 && /unsupported parameter[^\n]*max_output_tokens|unsupported[^\n]*max_output_tokens/i.test(errorText)) {
        const fallbackBody = { ...body };
        delete fallbackBody.max_output_tokens;
        r = await this.upstream.responses(fallbackBody, { stream, sessionId: req.promptCacheKey, forwardHeaders: this.extraHeaders });
      } else {
        throw new Error(`model error ${r.status}: ${errorText.slice(0, 2000)}`);
      }
    }
    if (!r.ok) throw new Error(`model error ${r.status}: ${(await r.text()).slice(0, 2000)}`);
    let resp: any;
    const ct = r.headers.get("content-type") ?? "";
    if (stream && !ct.includes("application/json")) {   // the Codex backend sends SSE without a content-type header
      const reader = r.body!.getReader(); const dec = new TextDecoder(); const lines = new SseLineBuffer(); const col = new ResponseCollector();
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        for (const ev of lines.push(dec.decode(value, { stream: true }))) {
          if (ev.type === "response.output_text.delta" && ev.delta) req.onText?.(ev.delta);
          col.feed(ev);
          if (col.error) throw new Error("model stream error: " + JSON.stringify(col.error).slice(0, 500));
        }
      }
      resp = col.response();
      if (!resp) throw new Error("stream ended without response.completed");
    } else {
      resp = await r.json();
      if (resp?.error && !resp.output) throw new Error("model error: " + JSON.stringify(resp.error).slice(0, 500));
      if (stream) req.onText?.(textOf(resp.output ?? []));
    }
    const u = resp.usage ?? {};
    const output = resp.output ?? [];
    return { output, text: textOf(output), calls: callsOf(output), raw: resp, usage: { input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens ?? 0 } };
  }
}

/** Anthropic Messages adapter: converts Responses-style items to messages and back. */
export class AnthropicClient implements ModelClient {
  constructor(readonly apiKey: string, readonly baseUrl = "https://api.anthropic.com") {}
  async respond(req: ModelRequest): Promise<ModelResponse> {
    const messages: any[] = [];
    const push = (role: string, block: any) => { const last = messages[messages.length - 1]; if (last && last.role === role) last.content.push(block); else messages.push({ role, content: [block] }); };
    for (const it of req.input) {
      if (it.type === "message" || it.role) {
        const text = Array.isArray(it.content) ? it.content.map((c: any) => c?.text ?? "").join("") : String(it.content ?? "");
        push(it.role === "assistant" ? "assistant" : "user", { type: "text", text: text || "(empty)" });
      } else if (it.type === "function_call") { let input: any = {}; try { input = JSON.parse(it.arguments ?? "{}"); } catch { /* ignore */ } push("assistant", { type: "tool_use", id: it.call_id, name: it.name, input }); }
      else if (it.type === "function_call_output") push("user", { type: "tool_result", tool_use_id: it.call_id, content: typeof it.output === "string" ? it.output : JSON.stringify(it.output) });
    }
    const body: any = { model: req.model, max_tokens: req.maxOutputTokens ?? 8192, system: [{ type: "text", text: req.instructions, cache_control: { type: "ephemeral" } }], messages, tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) };
    if (req.reasoningEffort && req.reasoningEffort !== "low") body.thinking = { type: "enabled", budget_tokens: req.reasoningEffort === "xhigh" ? 16000 : req.reasoningEffort === "high" ? 8000 : 3000 };
    const r = await fetch(this.baseUrl.replace(/\/$/, "") + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`model error ${r.status}: ${(await r.text()).slice(0, 2000)}`);
    const j: any = await r.json();
    const output: any[] = [];
    for (const b of j.content ?? []) {
      if (b.type === "text") { output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: b.text }] }); req.onText?.(b.text); }
      else if (b.type === "tool_use") output.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
    }
    const u = j.usage ?? {};
    return { output, text: textOf(output), calls: callsOf(output), raw: j, usage: { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: 0 } };
  }
}

export function clientFor(model: string, env = process.env): ModelClient {
  if (/^claude/.test(model)) return new AnthropicClient(env.ANTHROPIC_API_KEY ?? "", env.ANTHROPIC_BASE_URL);
  // provider comes from env / ~/.mph/config.json; default is the built-in Codex (ChatGPT OAuth) upstream
  return new OpenAIResponsesClient(upstreamFor({}, env));
}
