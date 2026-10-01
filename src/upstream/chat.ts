/**
 * Chat Completions wire adapter: lets the harness and th-proxy (which speak the
 * Responses API internally) use endpoints that only offer /chat/completions
 * (DashScope, vLLM, Ollama, most OpenAI-compatible gateways).
 *
 *   request : Responses body  → chat body   (responsesToChat)
 *   response: chat JSON       → Responses   (chatToResponse)
 *   stream  : chat SSE chunks → Responses SSE events (ChatStreamTranslator)
 *
 * Mapping
 *   instructions / system / developer messages → system messages
 *   function_call (consecutive)                → one assistant message with tool_calls
 *   function_call_output                       → tool message
 *   custom_tool_call / _output                 → function tool call with {"input": "..."} / tool message
 *   reasoning                                  → dropped (chat endpoints cannot take encrypted reasoning back)
 *   other items with text content (agent_message, compaction, …) → user message with that text
 *   tools: function → function; custom → function{input:string}; built-in tools (web_search, …) dropped
 */
import { contentText, outputText } from "../core/items.js";

function msgText(content: any): string { return contentText(content); }

export function toolsToChat(tools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out: any[] = [];
  for (const t of tools) {
    if (t?.type === "function" || (t?.name && t?.parameters && !t.type)) out.push({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } } });
    else if (t?.type === "custom") out.push({ type: "function", function: { name: t.name, description: (t.description ?? "") + " (pass the raw tool input as the `input` string)", parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } } });
  }
  return out.length ? out : undefined;
}

export function inputToMessages(instructions: string | undefined, input: any[]): any[] {
  const msgs: any[] = [];
  if (instructions) msgs.push({ role: "system", content: instructions });
  for (const it of input ?? []) {
    const type = it?.type ?? (it?.role ? "message" : undefined);
    if (type === "function_call" || type === "custom_tool_call") {
      const args = type === "function_call" ? (typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {})) : JSON.stringify({ input: it.input ?? "" });
      const tc = { id: it.call_id, type: "function", function: { name: it.name, arguments: args } };
      const last = msgs[msgs.length - 1];
      // calls right after assistant text (or after other calls) belong to the same assistant message
      if (last?.role === "assistant") (last.tool_calls ??= []).push(tc);
      else msgs.push({ role: "assistant", content: null, tool_calls: [tc] });
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") { msgs.push({ role: "tool", tool_call_id: it.call_id, content: outputText(it.output) || "(empty)" }); continue; }
    if (type === "reasoning") continue;
    if (type === "message") {
      const role = it.role === "developer" || it.role === "system" ? "system" : it.role === "assistant" ? "assistant" : "user";
      const text = msgText(it.content);
      // chat APIs expect system messages first; a late system/developer message keeps its position as user text
      if (role === "system" && msgs.some((m) => m.role !== "system")) msgs.push({ role: "user", content: text });
      else msgs.push({ role, content: text });
      continue;
    }
    // other items (agent_message, compaction, …): keep readable text so folded stubs and digests survive
    const text = Array.isArray(it?.content) ? it.content.map((c: any) => c?.text ?? "").join("") : typeof it?.summary === "string" ? it.summary : "";
    if (text) msgs.push({ role: "user", content: text });
  }
  // every tool_call must be answered right after its assistant message; drop orphan tool messages, add placeholders for unanswered calls
  const fixed: any[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "tool") continue;   // consumed below or orphaned
    fixed.push(m);
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const ids = new Set(m.tool_calls.map((tc: any) => tc.id));
      const answers = new Map<string, any>();
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === "tool") { if (ids.has(msgs[j].tool_call_id) && !answers.has(msgs[j].tool_call_id)) answers.set(msgs[j].tool_call_id, msgs[j]); j++; }
      for (const tc of m.tool_calls) fixed.push(answers.get(tc.id) ?? { role: "tool", tool_call_id: tc.id, content: "(no output recorded)" });
      i = j - 1;
    }
  }
  // merge leading system messages
  while (fixed.length >= 2 && fixed[0].role === "system" && fixed[1].role === "system") { fixed[0] = { role: "system", content: fixed[0].content + "\n\n" + fixed[1].content }; fixed.splice(1, 1); }
  return fixed;
}

export function responsesToChat(body: any): any {
  const out: any = { model: body.model, messages: inputToMessages(body.instructions, Array.isArray(body.input) ? body.input : typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : []) };
  const tools = toolsToChat(body.tools);
  if (tools) { out.tools = tools; out.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice : "auto"; if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls; }
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  return out;
}

export function chatUsage(u: any): any {
  if (!u) return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
  return { input_tokens: u.prompt_tokens ?? 0, input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 }, output_tokens: u.completion_tokens ?? 0, output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 }, total_tokens: u.total_tokens ?? 0 };
}

function outputFrom(text: string, calls: { id: string; name: string; arguments: string }[], respId: string): any[] {
  const output: any[] = [];
  if (text) output.push({ type: "message", id: `msg_${respId}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  calls.forEach((c, i) => output.push({ type: "function_call", id: `fc_${respId}_${i}`, call_id: c.id || `call_${respId}_${i}`, name: c.name, arguments: c.arguments || "{}", status: "completed" }));
  return output;
}

export function chatToResponse(j: any, model?: string): any {
  const choice = j?.choices?.[0] ?? {};
  const m = choice.message ?? {};
  const id = String(j?.id ?? "chat").replace(/[^A-Za-z0-9_-]/g, "");
  const calls = (m.tool_calls ?? []).map((tc: any) => ({ id: tc.id, name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "{}" }));
  const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: any) => c?.text ?? "").join("") : "";
  return { id: `resp_${id}`, object: "response", status: choice.finish_reason === "length" ? "incomplete" : "completed", model: j?.model ?? model, output: outputFrom(text, calls, id), usage: chatUsage(j?.usage) };
}

const sse = (ev: any) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;

/** Turns chat.completion.chunk objects into Responses streaming events. */
export class ChatStreamTranslator {
  private text = "";
  private calls: { id: string; name: string; arguments: string }[] = [];
  private usage: any = null;
  private id = "";
  private model?: string;
  private started = false;
  private textOpen = false;
  private finish: string | null = null;
  private seq = 0;
  error: any = null;
  constructor(model?: string) { this.model = model; }

  private ev(e: any): string { return sse({ ...e, sequence_number: this.seq++ }); }

  /** feed one parsed chunk, returns SSE text to emit */
  feed(chunk: any): string {
    let out = "";
    if (chunk?.error) { this.error = chunk.error; return out; }
    if (!this.started) {
      this.started = true; this.id = String(chunk?.id ?? Date.now()).replace(/[^A-Za-z0-9_-]/g, ""); this.model = chunk?.model ?? this.model;
      out += this.ev({ type: "response.created", response: { id: `resp_${this.id}`, object: "response", status: "in_progress", model: this.model, output: [] } });
    }
    if (chunk?.usage) this.usage = chunk.usage;
    for (const ch of chunk?.choices ?? []) {
      const d = ch.delta ?? {};
      if (typeof d.content === "string" && d.content) {
        if (!this.textOpen) { this.textOpen = true; out += this.ev({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: `msg_${this.id}`, role: "assistant", status: "in_progress", content: [] } }); }
        this.text += d.content;
        out += this.ev({ type: "response.output_text.delta", item_id: `msg_${this.id}`, output_index: 0, content_index: 0, delta: d.content });
      }
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === "number" ? tc.index : this.calls.length;
        const cur = this.calls[i] ?? (this.calls[i] = { id: "", name: "", arguments: "" });
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") cur.arguments += tc.function.arguments;
      }
      if (ch.finish_reason) this.finish = ch.finish_reason;
    }
    return out;
  }

  /** final events (output items + completed / failed) */
  end(): string {
    if (!this.started) { this.started = true; this.id = String(Date.now()); }
    if (this.error) return this.ev({ type: "response.failed", response: { id: `resp_${this.id}`, object: "response", status: "failed", model: this.model, output: [], error: typeof this.error === "object" ? this.error : { message: String(this.error) } } });
    const output = outputFrom(this.text, this.calls.filter(Boolean), this.id);
    let out = "";
    output.forEach((item, i) => { out += this.ev({ type: "response.output_item.done", output_index: i, item }); });
    out += this.ev({ type: "response.completed", response: this.response() });
    return out;
  }

  response(): any {
    return { id: `resp_${this.id}`, object: "response", status: this.finish === "length" ? "incomplete" : "completed", model: this.model, output: outputFrom(this.text, this.calls.filter(Boolean), this.id), usage: chatUsage(this.usage) };
  }
}

/**
 * Send a Responses body to a chat-completions endpoint. Returns a Response that looks
 * like a Responses API reply: SSE when stream=true, JSON otherwise. The upstream call
 * always streams (works on every gateway, and long generations do not hit idle timeouts).
 */
export async function chatResponses(baseUrl: string, apiKey: string | undefined, body: any, opts: { stream: boolean; signal?: AbortSignal; forwardHeaders?: Record<string, string> }): Promise<Response> {
  const chat = { ...responsesToChat(body), stream: true, stream_options: { include_usage: true } };
  const headers: Record<string, string> = { ...(opts.forwardHeaders ?? {}), "content-type": "application/json", accept: "text/event-stream" };
  delete headers["content-length"];
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  let r: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", { method: "POST", headers, body: JSON.stringify(chat), signal: opts.signal });
      if ((r.status === 429 || r.status >= 500) && attempt < 3) { await r.text().catch(() => ""); await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt)); continue; }
      break;
    } catch (e) { if (attempt >= 3 || opts.signal?.aborted) throw e; await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt)); }
  }
  if (!r!.ok || !r!.body) return new Response(await r!.text(), { status: r!.status, headers: { "content-type": r!.headers.get("content-type") ?? "application/json" } });
  const ct = r!.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    // gateway ignored stream=true
    const j = await r!.json();
    const resp = chatToResponse(j, body.model);
    if (!opts.stream) return new Response(JSON.stringify(resp), { status: 200, headers: { "content-type": "application/json" } });
    const tr = new ChatStreamTranslator(body.model);
    const text = tr.feed({ id: j.id, model: j.model }) + resp.output.map((item: any, i: number) => sse({ type: "response.output_item.done", output_index: i, item })).join("") + sse({ type: "response.completed", response: resp });
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  const tr = new ChatStreamTranslator(body.model);
  const reader = r!.body.getReader(); const dec = new TextDecoder();
  let buf = "";
  const pump = async (emit: (s: string) => void) => {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx; while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim(); if (!payload || payload === "[DONE]") continue;
          let chunk: any; try { chunk = JSON.parse(payload); } catch { continue; }
          const s = tr.feed(chunk); if (s) emit(s);
        }
      }
    }
    emit(tr.end());
  };
  if (!opts.stream) {
    await pump(() => {});
    if (tr.error) return new Response(JSON.stringify({ error: tr.error }), { status: 502, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(tr.response()), { status: 200, headers: { "content-type": "application/json" } });
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try { await pump((s) => ctrl.enqueue(enc.encode(s))); }
      catch (e: any) { ctrl.enqueue(enc.encode(sse({ type: "response.failed", response: { status: "failed", output: [], error: { message: String(e?.message ?? e) } } }))); }
      ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
