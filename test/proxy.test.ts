import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, msg, call } from "./mock_model.js";

process.env.MPH_HOME = mkdtempSync(join(tmpdir(), "mph-p-"));
const { Proxy, sessionIdOf, substituteRecalls } = await import("../src/proxy/server.js");
const { ArtifactStore } = await import("../src/core/artifacts.js");

function bigHistory(n: number) {
  const input: any[] = [{ type: "message", role: "developer", content: [{ type: "input_text", text: "sys ".repeat(100) }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "do the task" }] }];
  for (let i = 0; i < n; i++) { input.push({ type: "function_call", name: "exec_command", call_id: `c${i}`, arguments: JSON.stringify({ cmd: `cat big${i}.txt` }) }); input.push({ type: "function_call_output", call_id: `c${i}`, output: "Output:\n" + `data line ${i} `.repeat(600) }); }
  return input;
}

test("proxy rewrites input, injects recall tool, substitutes recall outputs, logs ledger", async () => {
  const mock = await startMock((body, n) => n === 0 ? { output: [call("recall", { id: "zzz" }, "r1")] } : { output: [msg("ok")] });
  const p = new Proxy({ port: 0, upstream: mock.url, recallMode: "substitute" });
  // drive handleResponses directly through an http server on an ephemeral port
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => { const ch: Buffer[] = []; req.on("data", (c) => ch.push(c)); req.on("end", () => p.handleResponses(req, res, Buffer.concat(ch).toString())); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const post = (body: any) => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const hist = bigHistory(40);
  const r1: any = await post({ model: "m", input: hist, stream: false, prompt_cache_key: "sess-1" });
  assert.equal(r1.output[0].name, "recall");
  const up1 = mock.requests[0];
  assert.ok(up1.tools.some((t: any) => t.name === "recall"), "recall tool injected");
  assert.ok(JSON.stringify(up1.input).length < JSON.stringify(hist).length / 2, "input shrunk");
  const stubs = up1.input.filter((x: any) => typeof x.output === "string" && x.output.startsWith("[output #"));
  assert.ok(stubs.length >= 20, `folded stubs ${stubs.length}`);
  const id = /#([0-9a-f]{12})/.exec(stubs[0].output)![1];
  // client "executes" recall and reports an error; proxy substitutes real content on next request
  const hist2 = [...hist, r1.output[0], { type: "function_call_output", call_id: "r1", output: "unsupported call: recall" }];
  hist2[hist2.length - 2] = { ...r1.output[0], arguments: JSON.stringify({ id, head: 3 }) };
  const r2: any = await post({ model: "m", input: hist2, stream: false, prompt_cache_key: "sess-1" });
  assert.equal(r2.output[0].content[0].text, "ok");
  const up2 = mock.requests[1];
  const sub = up2.input.find((x: any) => x.call_id === "r1" && x.type === "function_call_output");
  assert.ok(sub.output.startsWith("[recall] ") && sub.output.includes("data line"), sub.output.slice(0, 80));
  // prefix stability: everything before the appended items is identical between the two upstream requests
  for (let i = 0; i < up1.input.length; i++) assert.deepEqual(up2.input[i], up1.input[i], `prefix item ${i} stable`);
  const st = p.stats();
  assert.equal(st.responses, 2); assert.equal(st.recalls, 1);
  srv.closeAllConnections(); srv.close(); await mock.close();
});

test("sessionIdOf prefers prompt_cache_key; substituteRecalls is a no-op without recall calls", () => {
  assert.equal(sessionIdOf({ prompt_cache_key: "abc" }), "abc");
  assert.ok(sessionIdOf({ input: [{ role: "user", content: "hi" }] }).startsWith("anon:"));
  const store = new ArtifactStore(join(process.env.MPH_HOME!, "art"));
  const r = substituteRecalls([{ type: "function_call", name: "x", call_id: "1", arguments: "{}" }, { type: "function_call_output", call_id: "1", output: "o" }], store);
  assert.equal(r.substituted, 0);
});
