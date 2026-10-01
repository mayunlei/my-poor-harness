/**
 * Chat Completions wire adapter: Responses ⇄ chat translation, streaming translation,
 * auto-fallback from /responses (404) to /chat/completions, and the harness client /
 * th-proxy going through a chat-only endpoint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

process.env.TOKEN_HARNESS_HOME = mkdtempSync(join(tmpdir(), "th-chat-"));
delete process.env.TH_OPENAI_BASE_URL; delete process.env.OPENAI_BASE_URL; delete process.env.TH_PROVIDER; delete process.env.TH_OPENAI_WIRE_API;
const { responsesToChat, chatToResponse, ChatStreamTranslator } = await import("../src/upstream/chat.js");
const { upstreamFor } = await import("../src/upstream/index.js");

/** chat-only mock: 404 on /responses, scripted /chat/completions (stream or not) */
async function chatMock(script: (body: any, n: number) => { content?: string; tool_calls?: { id: string; name: string; arguments: string }[] }) {
  const requests: any[] = []; let n = 0; let responsesHits = 0;
  const server = createServer((req, res) => {
    const ch: Buffer[] = []; req.on("data", (c) => ch.push(c));
    req.on("end", () => {
      if (req.url?.endsWith("/responses")) { responsesHits++; res.writeHead(404).end("not found"); return; }
      if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(ch).toString()); requests.push({ body, headers: req.headers });
      const r = script(body, n++);
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } };
      if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "c1", model: body.model, choices: [{ index: 0, finish_reason: r.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: r.content ?? null, tool_calls: r.tool_calls?.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) } }], usage })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: any, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "c1", model: body.model, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], usage: null })}\n\n`);
      chunk({ role: "assistant", content: "", reasoning_content: "thinking" });
      if (r.content) for (const part of r.content.match(/.{1,4}/g)!) chunk({ content: part });
      for (const [i, t] of (r.tool_calls ?? []).entries()) {
        chunk({ tool_calls: [{ index: i, id: t.id, type: "function", function: { name: t.name, arguments: "" } }] });
        for (const part of t.arguments.match(/.{1,5}/g) ?? []) chunk({ tool_calls: [{ index: i, id: "", type: "function", function: { arguments: part } }] });
      }
      chunk({}, r.tool_calls ? "tool_calls" : "stop");
      res.write(`data: ${JSON.stringify({ id: "c1", choices: [], usage })}\n\n`);
      res.write("data: [DONE]\n\n"); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  return { url, requests, get responsesHits() { return responsesHits; }, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test("responsesToChat: instructions/system first, tool calls grouped and answered, reasoning dropped, other items kept as text, tools mapped", () => {
  const body = {
    model: "m", instructions: "SYS", max_output_tokens: 99,
    tools: [{ type: "function", name: "run", description: "d", parameters: { type: "object", properties: { cmd: { type: "string" } } } }, { type: "custom", name: "apply_patch", description: "p" }, { type: "web_search" }],
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "DEV" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "do it" }] },
      { type: "reasoning", id: "rs1", encrypted_content: "xxx" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
      { type: "function_call", call_id: "a", name: "run", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call", call_id: "b", name: "run", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "a", output: "f1" },
      { type: "function_call_output", call_id: "b", output: [{ type: "input_text", text: "/x" }] },
      { type: "custom_tool_call", call_id: "c", name: "apply_patch", input: "*** Begin Patch" },
      { type: "agent_message", content: [{ type: "input_text", text: "[agent_message folded]" }] },
      { type: "function_call", call_id: "d", name: "run", arguments: "{}" },
    ],
  };
  const c = responsesToChat(body);
  assert.equal(c.max_tokens, 99);
  assert.deepEqual(c.messages[0], { role: "system", content: "SYS\n\nDEV" });
  assert.deepEqual(c.messages[1], { role: "user", content: "do it" });
  assert.equal(c.messages[2].role, "assistant"); assert.equal(c.messages[2].content, "on it"); assert.equal(c.messages[2].tool_calls.length, 2);
  assert.deepEqual(c.messages.slice(3, 5).map((m: any) => [m.role, m.tool_call_id, m.content]), [["tool", "a", "f1"], ["tool", "b", "/x"]]);
  assert.equal(c.messages[5].tool_calls[0].function.arguments, JSON.stringify({ input: "*** Begin Patch" }));
  assert.equal(c.messages[6].content, "(no output recorded)", "unanswered call gets a placeholder");
  assert.equal(c.messages[7].content, "[agent_message folded]");
  assert.equal(c.messages[8].tool_calls[0].id, "d"); assert.equal(c.messages[9].tool_call_id, "d");
  assert.ok(!JSON.stringify(c).includes("xxx"), "reasoning dropped");
  assert.deepEqual(c.tools.map((t: any) => t.function.name), ["run", "apply_patch"]);
});

test("chatToResponse and ChatStreamTranslator produce Responses output + usage", () => {
  const r = chatToResponse({ id: "x", model: "m", choices: [{ finish_reason: "tool_calls", message: { content: "hi", tool_calls: [{ id: "t1", function: { name: "run", arguments: "{\"a\":1}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } });
  assert.equal(r.output[0].content[0].text, "hi"); assert.equal(r.output[1].call_id, "t1"); assert.equal(r.output[1].arguments, "{\"a\":1}");
  assert.equal(r.usage.input_tokens, 10); assert.equal(r.usage.input_tokens_details.cached_tokens, 4);
  const tr = new ChatStreamTranslator("m");
  let sse = tr.feed({ id: "y", choices: [{ delta: { content: "he" } }] }) + tr.feed({ choices: [{ delta: { content: "llo", tool_calls: [{ index: 0, id: "t9", function: { name: "run", arguments: "{\"c" } }] } }] }) + tr.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: "", function: { arguments: "\":2}" } }] }, finish_reason: "tool_calls" }] }) + tr.feed({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }) + tr.end();
  assert.ok(sse.includes("response.created") && sse.includes("response.output_text.delta") && sse.includes("response.output_item.done") && sse.includes("response.completed"));
  const fin = tr.response();
  assert.equal(fin.output[0].content[0].text, "hello"); assert.equal(fin.output[1].arguments, "{\"c\":2}"); assert.equal(fin.output[1].call_id, "t9"); assert.equal(fin.usage.input_tokens, 7);
});

test("upstream: auto-fallback from /responses 404 to chat; explicit wire_api=chat skips /responses; stream and non-stream", async () => {
  const m = await chatMock(() => ({ content: "pong" }));
  const auto = upstreamFor({ baseUrl: m.url, apiKey: "sk-1" });
  assert.equal(auto.wireApi, "responses");
  const j: any = await (await auto.responses({ model: "q", input: [{ role: "user", content: "ping" }] }, { stream: false })).json();
  assert.equal(j.output[0].content[0].text, "pong"); assert.equal(j.usage.input_tokens, 100); assert.equal(j.usage.input_tokens_details.cached_tokens, 40);
  assert.equal(auto.wireApi, "chat"); assert.equal(m.responsesHits, 1);
  await auto.responses({ model: "q", input: [{ role: "user", content: "again" }] }, { stream: false });
  assert.equal(m.responsesHits, 1, "fallback is sticky");
  assert.equal(m.requests[0].headers.authorization, "Bearer sk-1");
  assert.equal(m.requests[0].body.stream, true); assert.deepEqual(m.requests[0].body.stream_options, { include_usage: true });
  const explicit = upstreamFor({ baseUrl: m.url, apiKey: "sk-1", wireApi: "chat" });
  const s = await explicit.responses({ model: "q", input: [{ role: "user", content: "x" }] }, { stream: true });
  assert.ok((s.headers.get("content-type") ?? "").includes("text/event-stream"));
  const txt = await s.text();
  assert.ok(txt.includes("\"delta\":\"pong\"") && txt.includes("response.completed")); assert.equal(m.responsesHits, 1);
  await m.close();
});

test("harness client and th-proxy run tool loops over a chat-only endpoint", async () => {
  const m = await chatMock((body, n) => n === 0 ? { tool_calls: [{ id: "call_1", name: "run", arguments: JSON.stringify({ cmd: "echo hi" }) }] } : { content: "done" });
  const { OpenAIResponsesClient } = await import("../src/harness/providers.js");
  const c = new OpenAIResponsesClient(upstreamFor({ baseUrl: m.url, wireApi: "chat" }));
  let streamed = "";
  const r1 = await c.respond({ model: "q", instructions: "sys", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }], tools: [{ name: "run", description: "d", parameters: { type: "object", properties: { cmd: { type: "string" } } } }], onText: (t) => { streamed += t; } });
  assert.equal(r1.calls.length, 1); assert.equal(r1.calls[0].name, "run"); assert.deepEqual(r1.calls[0].args, { cmd: "echo hi" }); assert.equal(r1.usage.input, 100);
  const r2 = await c.respond({ model: "q", instructions: "sys", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }, ...r1.output, { type: "function_call_output", call_id: "call_1", output: "hi" }], tools: [], onText: (t) => { streamed += t; } });
  assert.equal(r2.text, "done"); assert.equal(streamed, "done");
  const sent = m.requests[1].body.messages;
  assert.deepEqual(sent.slice(-2).map((x: any) => x.role), ["assistant", "tool"]);
  // proxy
  const { Proxy } = await import("../src/proxy/server.js");
  const p = new Proxy({ port: 0, upstream: m.url.replace(/\/v1$/, ""), upstreamPath: "/v1/responses", recallMode: "substitute", wireApi: "chat" });
  const srv = createServer((req, res) => { const ch: Buffer[] = []; req.on("data", (x) => ch.push(x)); req.on("end", () => p.handleResponses(req, res, Buffer.concat(ch).toString())); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const pr = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "q", input: [{ role: "user", content: "hi" }], stream: true, prompt_cache_key: "chat-1" }) });
  const t = await pr.text(); assert.ok(t.includes("response.completed"));
  assert.ok(m.requests.at(-1).body.tools.some((x: any) => x.function.name === "recall"), "recall tool injected and mapped");
  assert.equal(p.stats().responses, 1);
  srv.closeAllConnections(); srv.close(); await m.close();
});
