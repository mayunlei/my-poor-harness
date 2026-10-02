/**
 * ctx-proxy: a transparent Responses API proxy that rewrites `input` with
 * ctx-core before forwarding upstream (codex_api, api.openai.com, or any
 * Responses-compatible endpoint). Streams SSE back unchanged, extracts usage
 * from `response.completed`, and logs a ledger row per response.
 *
 * recall(id): the proxy injects a `recall` function tool. Two modes:
 *   - "substitute": the client executes the unknown tool and reports an error
 *     output; on the next request the proxy replaces that output with the real
 *     artifact slice. Zero latency cost, streaming intact.
 *   - "loop": the proxy buffers the upstream response; if it contains recall
 *     calls, it resolves them and re-requests upstream before replying.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rewrite, newRewriteState, type RewriteState } from "../core/rewrite.js";
import { ArtifactStore } from "../core/artifacts.js";
import { knobsFor, harnessHome, type Knobs } from "../core/knobs.js";
import { Ledger } from "../core/ledger.js";
import { settingsHash } from "../core/cache_state.js";
import { sha1, outputText } from "../core/items.js";
import { initTokenizer, tokenizerName, countTokens } from "../core/tokens.js";
import { upstreamFor, type Upstream, type Provider } from "../upstream/index.js";
import { ResponseCollector, SseLineBuffer, parseSseBlocks } from "../upstream/sse.js";
import { parseMeter, meterDelta, type MeterSnapshot } from "../upstream/meter.js";

export interface ProxyOptions {
  port: number;
  /** openai_compatible upstream origin, e.g. http://127.0.0.1:8790 (combined with upstreamPath). Omit to use config / the built-in Codex upstream. */
  upstream?: string;
  upstreamKey?: string;        // optional Authorization override
  /** openai_compatible: "chat" translates to /chat/completions */
  wireApi?: "responses" | "chat";
  /** "codex" = built-in ChatGPT OAuth reverse proxy; "openai_compatible" = plain /responses endpoint */
  provider?: Provider;
  recallMode: "substitute" | "loop" | "off";
  upstreamPath?: string;      // default /v1/responses (openai_compatible only)
  project?: string;
  verbose?: boolean;
}

export const RECALL_TOOL = {
  type: "function",
  name: "recall",
  description: "Expand a folded tool output or artifact by id. Use when a stub like [output #abc123 ...] or recall(\"abc123\") does not carry enough detail. Optional: grep (regex), range [start,end] lines, head/tail line counts.",
  strict: false,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "artifact id from the stub" },
      grep: { type: "string" }, range: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
      head: { type: "integer" }, tail: { type: "integer" },
    },
    required: ["id"],
  },
};

function sessionsDir(): string { const d = join(harnessHome(), "proxy", "sessions"); mkdirSync(d, { recursive: true }); return d; }

export class SessionStore {
  private cache = new Map<string, RewriteState>();
  load(id: string): RewriteState {
    const hit = this.cache.get(id); if (hit) return hit;
    const p = join(sessionsDir(), sha1(id).slice(0, 16) + ".json");
    let st: RewriteState;
    if (existsSync(p)) { try { st = JSON.parse(readFileSync(p, "utf8")); } catch { st = newRewriteState(id); } } else st = newRewriteState(id);
    this.cache.set(id, st); return st;
  }
  save(id: string, st: RewriteState): void {
    const p = join(sessionsDir(), sha1(id).slice(0, 16) + ".json");
    writeFileSync(p, JSON.stringify(st));
  }
  list(): string[] { return readdirSync(sessionsDir()).filter((f) => f.endsWith(".json")); }
}

export function sessionIdOf(body: any): string {
  if (typeof body?.prompt_cache_key === "string" && body.prompt_cache_key) return body.prompt_cache_key;
  if (typeof body?.metadata?.session_id === "string") return body.metadata.session_id;
  if (typeof body?.conversation === "string") return body.conversation;
  const input = Array.isArray(body?.input) ? body.input : [];
  const firstUser = input.find((x: any) => x?.role === "user" && !(typeof x.content === "string" ? x.content : x.content?.[0]?.text ?? "").startsWith("<"));
  const seed = JSON.stringify([body?.instructions ?? "", firstUser ?? input[0] ?? ""]).slice(0, 4000);
  return "anon:" + sha1(seed).slice(0, 16);
}

/** In substitute mode: replace client-side error outputs for recall calls with real artifact slices. */
export function substituteRecalls(input: any[], store: ArtifactStore): { input: any[]; substituted: number } {
  let substituted = 0;
  const calls = new Map<string, any>();
  const out = input.map((x) => {
    if (x?.type === "function_call" && x.name === "recall") { calls.set(x.call_id, x); return x; }
    if (x?.type === "function_call_output" && calls.has(x.call_id)) {
      const cur = outputText(x.output);
      if (cur.startsWith("[recall]")) return x; // already substituted earlier (client echoes our output back)
      let args: any = {}; try { args = JSON.parse(calls.get(x.call_id).arguments ?? "{}"); } catch { /* ignore */ }
      const text = "[recall] " + store.recall(String(args.id ?? ""), { grep: args.grep, range: Array.isArray(args.range) ? [Number(args.range[0]), Number(args.range[1])] : undefined, head: args.head, tail: args.tail });
      substituted++;
      return { ...x, output: text };
    }
    return x;
  });
  return { input: out, substituted };
}

function finalOf(events: any[]): any { const col = new ResponseCollector(); for (const e of events) col.feed(e); return col.response(); }

export class Proxy {
  readonly store = new ArtifactStore();
  readonly sessions = new SessionStore();
  readonly ledger = new Ledger();
  private steps = new Map<string, number>();
  /** last meter snapshot per session, to turn an absolute credits balance into an observed drop */
  private lastMeter = new Map<string, MeterSnapshot>();
  readonly up: Upstream;
  constructor(readonly opts: ProxyOptions) {
    const base = opts.upstream ? opts.upstream.replace(/\/$/, "") + (opts.upstreamPath ?? "/v1/responses").replace(/\/responses$/, "") : undefined;
    this.up = upstreamFor({ provider: opts.provider ?? (opts.upstream ? "openai_compatible" : undefined), baseUrl: base, apiKey: opts.upstreamKey, wireApi: opts.wireApi });
  }

  private log(...a: unknown[]) { if (this.opts.verbose) console.error("[mph-proxy]", ...a); }

  private upstreamHeaders(req: IncomingMessage): Record<string, string> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "content-length", "connection", "transfer-encoding"].includes(k)) continue;
      if (typeof v === "string") h[k] = v; else if (Array.isArray(v)) h[k] = v.join(", ");
    }
    if (this.opts.upstreamKey) h["authorization"] = `Bearer ${this.opts.upstreamKey}`;
    return h;
  }

  async handleResponses(req: IncomingMessage, res: ServerResponse, rawBody: string): Promise<void> {
    let body: any;
    try { body = JSON.parse(rawBody); } catch { res.writeHead(400).end("invalid json"); return; }
    const sid = sessionIdOf(body);
    const knobs: Knobs = knobsFor({ project: this.opts.project, session: sid });
    const state = this.sessions.load(sid);
    const step = (this.steps.get(sid) ?? 0) + 1; this.steps.set(sid, step);
    const t0 = Date.now();

    let input: any[] = Array.isArray(body.input) ? body.input : [];
    let substituted = 0;
    if (this.opts.recallMode === "substitute") ({ input, substituted } = substituteRecalls(input, this.store));
    const forceCompact = typeof body?.metadata?.th_compact === "string";
    const rw = rewrite(input, { knobs, store: this.store, state, now: t0, settingsHash: settingsHash(body), forceCompact });
    this.sessions.save(sid, state);

    const upstreamBody: any = { ...body, input: rw.input };
    if (this.opts.recallMode !== "off") {
      const tools = Array.isArray(body.tools) ? body.tools : [];
      if (!tools.some((t: any) => t?.name === "recall")) upstreamBody.tools = [...tools, RECALL_TOOL];
    }
    delete upstreamBody.metadata?.th_compact;

    this.log(`session=${sid.slice(0, 12)} step=${step} ctx ${rw.stats.tokensBefore}→${rw.stats.tokensAfter} folded=${rw.stats.folded} shaped=${rw.stats.shaped} polls=${rw.stats.pollsCollapsed} dedupe=${rw.stats.readsDeduped} cache=${rw.stats.cacheState}${rw.stats.compacted ? " COMPACT(" + rw.stats.compactReason + ")" : ""}${substituted ? " recall=" + substituted : ""}`);

    const stream = body.stream !== false;
    let usage: any = null; let outputItems: any[] = []; let streamError: string | undefined; let meter: MeterSnapshot | undefined;
    const doUpstream = async (b: any): Promise<Response> => this.up.responses(b, { stream, sessionId: sid, forwardHeaders: this.upstreamHeaders(req) });

    try {
      if (this.opts.recallMode === "loop" && stream) {
        // buffered loop: resolve recall calls internally, then replay final SSE to client
        let cur = upstreamBody; let text = ""; let events: any[] = [];
        for (let hop = 0; hop < 4; hop++) {
          const up = await doUpstream(cur);
          meter = parseMeter(up.headers) ?? meter;   // last hop wins: the balance after the final call
          if (!up.ok || !up.body) { res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "text/plain" }); res.end(await up.text()); return; }
          text = await up.text(); events = parseSseBlocks(text);
          const items = finalOf(events)?.output ?? [];
          const recalls = items.filter((x: any) => x.type === "function_call" && x.name === "recall");
          if (recalls.length === 0) break;
          const extra: any[] = [];
          for (const rc of recalls) {
            let args: any = {}; try { args = JSON.parse(rc.arguments ?? "{}"); } catch { /* ignore */ }
            extra.push(rc, { type: "function_call_output", call_id: rc.call_id, output: "[recall] " + this.store.recall(String(args.id ?? ""), { grep: args.grep, range: args.range, head: args.head, tail: args.tail }) });
            this.ledger.append({ source: "proxy", session: sid, turn: state.turnIndex, step, event: "recall", note: String(args.id ?? "") });
          }
          cur = { ...cur, input: [...cur.input, ...items.filter((x: any) => x.type !== "function_call" || x.name !== "recall"), ...extra] };
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(text);
        const fin = finalOf(events);
        usage = fin?.usage ?? null; outputItems = fin?.output ?? [];
      } else {
        const up = await doUpstream(upstreamBody);
        meter = parseMeter(up.headers);
        const ct = up.headers.get("content-type") ?? (stream && up.ok ? "text/event-stream" : "application/json");   // the Codex backend omits content-type on SSE
        const isSse = stream && up.ok && !ct.includes("application/json");
        const outHeaders: Record<string, string> = { "content-type": isSse ? "text/event-stream; charset=utf-8" : ct, "cache-control": "no-cache" };
        up.headers.forEach((v, k) => { if (k.startsWith("x-codex-") || k === "x-oai-request-id") outHeaders[k] = v; });   // rate-limit headers the Codex client displays
        res.writeHead(up.status, outHeaders);
        if (!up.body) { res.end(); return; }
        if (isSse) {
          const reader = up.body.getReader(); const dec = new TextDecoder(); const lines = new SseLineBuffer(); const col = new ResponseCollector();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = dec.decode(value, { stream: true });
            res.write(chunk);
            for (const ev of lines.push(chunk)) col.feed(ev);
          }
          const fin = col.response();
          if (fin) { usage = fin.usage ?? null; outputItems = fin.output ?? []; }
          if (col.error) { streamError = typeof col.error === "object" ? (col.error.code ?? col.error.message ?? "error") : String(col.error); this.log("upstream response.failed", streamError); }
          res.end();
        } else {
          const txt = await up.text(); res.end(txt);
          try { const j = JSON.parse(txt); usage = j.usage ?? null; outputItems = j.output ?? []; } catch { /* ignore */ }
        }
      }
    } catch (e: any) {
      this.log("upstream error", e?.message ?? e, e?.cause?.message ?? "");
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `upstream error: ${e?.message ?? e}${e?.cause?.message ? " (" + e.cause.message + ")" : ""}`, upstream: this.up.responsesUrl() } }));
      return;
    }

    const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
    const inTok = usage?.input_tokens ?? rw.stats.tokensAfter;
    const toolKind = outputItems.find((x: any) => x.type === "function_call" || x.type === "custom_tool_call")?.name;
    const prev = this.lastMeter.get(sid);
    const spent = meter && prev ? meterDelta(prev, meter).creditsSpent : undefined;
    if (meter) this.lastMeter.set(sid, meter);
    this.ledger.append({
      source: "proxy", session: sid, turn: state.turnIndex, step, model: body.model, effort: typeof body?.reasoning?.effort === "string" ? body.reasoning.effort : undefined,
      knobs_hash: sha1(JSON.stringify(knobs)).slice(0, 8),
      credits_balance: meter?.credits?.balance, credits_spent: spent,
      primary_used_percent: meter?.primary?.usedPercent, secondary_used_percent: meter?.secondary?.usedPercent,
      plan_type: meter?.planType, active_limit: meter?.activeLimit,
      input: inTok, cached, uncached: inTok - cached, output: usage?.output_tokens ?? 0, reasoning: usage?.output_tokens_details?.reasoning_tokens ?? 0,
      ctx_before: rw.stats.tokensBefore, ctx_after: rw.stats.tokensAfter,
      event: rw.stats.compacted ? "compact" : rw.stats.isTurnStart ? "keep" : "response",
      tool_kind: toolKind, idle_s: Number.isFinite(rw.stats.idleS) ? Math.round(rw.stats.idleS) : undefined, cache_state: rw.stats.cacheState,
      recall_count: substituted,
      extra: { folded: rw.stats.folded, shaped: rw.stats.shaped, shaped_saved: rw.stats.shapedSaved, polls: rw.stats.pollsCollapsed, dedupe: rw.stats.readsDeduped, prefix_trimmed: rw.stats.prefixTrimmed, decision: rw.stats.decision ? { action: rw.stats.decision.action, kHat: rw.stats.decision.kHat, kStar: Number(rw.stats.decision.kStar.toFixed(2)), reason: rw.stats.decision.reason } : undefined, compact_reason: rw.stats.compactReason, latency_ms: Date.now() - t0, error: streamError },
    });
  }

  async passthrough(req: IncomingMessage, res: ServerResponse, rawBody: string): Promise<void> {
    try {
      const url = req.url ?? "/";
      if (/\/models(\?.*)?$/.test(url) && req.method === "GET") {
        const m = await this.up.models(this.upstreamHeaders(req));
        res.writeHead(m.status, { "content-type": "application/json" }); res.end(m.body); return;
      }
      if (this.up.provider === "codex" || !this.opts.upstream) {
        res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `mph-proxy: only /responses and /models are served for the ${this.up.provider} upstream (${url})` } })); return;
      }
      const up = await fetch(this.opts.upstream.replace(/\/$/, "") + url, { method: req.method, headers: this.upstreamHeaders(req), body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : rawBody });
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream" });
      if (!up.body) { res.end(); return; }
      const reader = up.body.getReader();
      for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); }
      res.end();
    } catch (e: any) {
      res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `upstream error: ${e?.message ?? e}` } }));
    }
  }

  stats(): any {
    const rows = this.ledger.readAll().filter((r) => r.source === "proxy");
    const sum = (k: string) => rows.reduce((a, r: any) => a + (r[k] ?? 0), 0);
    const before = sum("ctx_before"), after = sum("ctx_after");
    return { responses: rows.length, sessions: new Set(rows.map((r) => r.session)).size, ctx_before: before, ctx_after: after, raw_multiple: +(before / Math.max(1, after)).toFixed(2), input: sum("input"), cached: sum("cached"), uncached: sum("uncached"), output: sum("output"), cost_equiv: Math.round(sum("cost_equiv")), compactions: rows.filter((r) => r.event === "compact").length, recalls: sum("recall_count"), tokenizer: tokenizerName() };
  }

  async listen(): Promise<void> {
    await initTokenizer();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const url = req.url ?? "/";
        if (url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, upstream: this.up.describe(), recall: this.opts.recallMode, tokenizer: tokenizerName() })); return; }
        if (url === "/stats") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(this.stats(), null, 2)); return; }
        if (/\/responses(\?.*)?$/.test(url) && req.method === "POST") { this.handleResponses(req, res, raw).catch((e) => { if (!res.headersSent) res.writeHead(500); res.end(String(e)); }); return; }
        this.passthrough(req, res, raw).catch(() => res.end());
      });
    });
    server.listen(this.opts.port, () => console.error(`mph-proxy listening on :${this.opts.port} → ${this.up.describe()} (recall=${this.opts.recallMode}, tokenizer=${tokenizerName()}, home=${harnessHome()})`));
  }
}
