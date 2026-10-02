import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, msg, call } from "./mock_model.js";

process.env.MPH_HOME = mkdtempSync(join(tmpdir(), "mph-h-"));
const { runTurn } = await import("../src/harness/loop.js");
const { newSession, saveSession, forkSession, mergeSession, loadSession } = await import("../src/harness/session.js");
const { Router } = await import("../src/harness/router.js");
const { Ledger } = await import("../src/core/ledger.js");
const { ArtifactStore } = await import("../src/core/artifacts.js");
const { resolveKnobs } = await import("../src/core/knobs.js");
const { OpenAIResponsesClient } = await import("../src/harness/providers.js");

test("single-task turn: tools run, window folds, next turn rebuilds with digest; fork/merge", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mph-ws-"));
  writeFileSync(join(ws, "a.py"), "def f():\n    return 1\n");
  const mock = await startMock((body, n) => {
    const last = body.input.at(-1);
    if (n === 0) return { output: [call("read", { path: "a.py" }, "c1"), call("run", { cmd: "echo hello; echo there" }, "c2")] };
    if (n === 1) { assert.ok(last.type === "function_call_output"); return { output: [call("edit", { path: "a.py", old: "return 1", new: "return 2" }, "c3"), call("read", { path: "a.py" }, "c4")] }; }
    if (n === 2) return { output: [call("run", { cmd: "sleep 5; echo done", background: true }, "c5")] };
    if (n === 3) { const out = JSON.parse(JSON.stringify(last.output)); const job = /job_\w+/.exec(out)![0]; return { output: [call("wait", { job, until: "done", max_s: 20 }, "c6")] }; }
    if (n === 4) return { output: [call("state_update", { notes: "changed a.py f() to return 2; verified by read" }, "c7")] };
    if (n === 5) return { output: [msg("Done: a.py now returns 2.")] };
    // second turn: must see the digest and the folded window, not raw outputs
    if (n === 6) { const texts = body.input.map((x: any) => JSON.stringify(x)); assert.ok(texts.some((t: string) => t.includes("[context digest")), "digest present"); assert.ok(texts.some((t: string) => t.includes("return 2") === false)); return { output: [call("recall", { id: "nope" }, "c8")] }; }
    return { output: [msg("second turn answer")] };
  });
  process.env.MPH_OPENAI_BASE_URL = mock.url + "/v1";
  const knobs = resolveKnobs({ window: 2, main_model: "mock-main" });
  const ledger = new Ledger(join(process.env.MPH_HOME!, "ledger.jsonl"));
  const router = new Router(knobs, ledger);
  const store = new ArtifactStore(join(process.env.MPH_HOME!, "art"));
  const s = newSession(ws, "t1"); saveSession(s);
  const events: string[] = [];
  const r1 = await runTurn({ session: s, userText: "make f return 2", knobs, store, ledger, router, multiTurn: false, onEvent: (e) => events.push(e.kind + ":" + e.detail) });
  assert.equal(r1.text, "Done: a.py now returns 2.");
  assert.equal(r1.steps, 6);
  assert.equal(readFileSync(join(ws, "a.py"), "utf8"), "def f():\n    return 2\n");
  assert.ok(events.some((e) => e.startsWith("job:")), "background job event");
  assert.ok(s.state.notes?.includes("return 2"));
  assert.ok(s.window.length > 0 && s.window.length <= 2 * knobs.window, `window size ${s.window.length}`);
  assert.ok(s.window.every((x: any) => x.type === "function_call" || x.type === "function_call_output"));
  assert.ok(s.state.filesTouched.some((f) => f.endsWith("a.py")));
  const r2 = await runTurn({ session: s, userText: "what did you change?", knobs, store, ledger, router, multiTurn: false });
  assert.equal(r2.text, "second turn answer");
  // wait() blocked inside harness: the model made exactly one wait call and got "done"
  const waitReq = mock.requests[4]; const waitOut = waitReq.input.at(-1).output as string;
  assert.ok(waitOut.includes("done") && /matched|exited/.test(waitOut), waitOut);
  // fork / merge
  const b = forkSession(s, "side-q");
  b.turns.push({ idx: 0, user: "quick question", steps: 1, startedAt: "x", usage: { input: 1, cached: 0, output: 1, reasoning: 0 }, finalText: "the answer is 42" });
  b.state.filesTouched.push("/tmp/extra.py"); b.state.notes = "side notes";
  const blk = mergeSession(b, s);
  assert.ok(blk.text.includes("the answer is 42") && blk.text.includes("extra.py") && blk.text.includes("side notes"));
  assert.equal(loadSession(b.id)!.status, "merged");
  assert.ok(s.state.filesTouched.includes("/tmp/extra.py"));
  await mock.close();
});

test("OpenAIResponsesClient parses calls and usage (non-stream)", async () => {
  const mock = await startMock(() => ({ output: [call("run", { cmd: "ls" }, "cX"), msg("hi")], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 7 } }));
  const c = new OpenAIResponsesClient(mock.url + "/v1", "k");
  const r = await c.respond({ model: "m", instructions: "i", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }], tools: [] });
  assert.equal(r.calls[0].name, "run"); assert.equal(r.text, "hi"); assert.equal(r.usage.cached, 60);
  await mock.close();
});
