import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shapeOutput, isEmptyPoll } from "../src/core/shapers.js";
import { defaultKnobs, resolveKnobs, applyKnobChange, knobsFor, PROFILES } from "../src/core/knobs.js";
import { rewrite, newRewriteState } from "../src/core/rewrite.js";
import { ArtifactStore } from "../src/core/artifacts.js";
import { judge, predictSteps, kStar } from "../src/core/judge.js";
import { estimateCacheState } from "../src/core/cache_state.js";
import { parseInput, readKeyOf, commandKind } from "../src/core/items.js";
import { countTokens } from "../src/core/tokens.js";

process.env.MPH_HOME = mkdtempSync(join(tmpdir(), "mph-test-"));
const K = defaultKnobs();
const SK = { perOutputCap: 300, headShare: 0.6, rgMaxHits: 5, logTailLines: 5, tracebackTailLines: 4, stripExecHeader: true };

test("shaper strips exec header and keeps exit code", () => {
  const r = shapeOutput("Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 1\nOriginal token count: 3\nOutput:\nboom\n", "ls", SK);
  assert.equal(r.text, "[exit 1] boom\n");
  assert.ok(r.tags.has("error"));
});

test("shaper preserves traceback and assertion lines under cap", () => {
  const noise = Array.from({ length: 400 }, (_, i) => `line ${i} lorem ipsum dolor sit amet`).join("\n");
  const tb = "Traceback (most recent call last):\n  File \"x.py\", line 3, in <module>\n    assert 1 == 2\nAssertionError: 1 != 2\n";
  const text = noise + "\n" + tb + "=========== 1 failed in 0.1s ===========\n";
  const r = shapeOutput(text, "pytest tests", SK);
  assert.ok(r.tokensAfter < r.tokensBefore / 3, "should shrink a lot");
  assert.ok(r.text.includes("AssertionError: 1 != 2"));
  assert.ok(r.text.includes("1 failed"));
  assert.ok(r.tags.has("traceback") && r.tags.has("test"));
});

test("rg shaper caps hits with per-file summary", () => {
  const text = Array.from({ length: 300 }, (_, i) => `src/f${i % 7}.py:${i}: match`).join("\n");
  const r = shapeOutput(text, "rg -n match src", SK);
  assert.ok(r.text.split("\n").length <= 7);
  assert.ok(r.text.includes("more hits across 7 files"));
});

test("empty poll detection", () => {
  assert.ok(isEmptyPoll("Chunk ID: 2\nWall time: 1.0 seconds\nProcess running\nOutput:\n"));
  assert.ok(!isEmptyPoll("Output:\nhello world"));
});

test("knobs clamp, layer and record history", () => {
  const k = resolveKnobs({ turn_budget: 999999999, window: 1 }, PROFILES.long_task);
  assert.equal(k.turn_budget, 40000); // profile overrides, clamped
  assert.equal(k.window, 8);
  applyKnobChange("project:/p", { per_output_cap: 100 }, "test", "why");
  const kk = knobsFor({ project: "/p" });
  assert.equal(kk.per_output_cap, 500); // clamped to min
});

test("items parse, read keys and command kinds", () => {
  assert.equal(readKeyOf("sed -n '1,220p' /a/b.py"), "/a/b.py:1-220");
  assert.equal(readKeyOf("cat foo/bar.ts"), "foo/bar.ts");
  assert.equal(commandKind("conda run -n py39pd python x.py"), "run");
  assert.equal(commandKind("rg -n foo"), "search");
  const items = parseInput([{ type: "message", role: "developer", content: [{ type: "input_text", text: "sys" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  assert.equal(items[0].kind, "system"); assert.equal(items[1].kind, "user"); assert.equal(items[1].turn, 0);
});

function mkHistory(nCalls: number, outputText: (i: number) => string, cmd: (i: number) => string = (i) => `cat f${i}.py`) {
  const input: any[] = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "You are a coding agent. ".repeat(50) }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "please fix the bug in parser" }] },
  ];
  for (let i = 0; i < nCalls; i++) {
    input.push({ type: "reasoning", id: `rs_${i}`, summary: [], encrypted_content: "x".repeat(200) });
    input.push({ type: "function_call", name: "exec_command", call_id: `call_${i}`, arguments: JSON.stringify({ cmd: cmd(i) }) });
    input.push({ type: "function_call_output", call_id: `call_${i}`, output: outputText(i) });
  }
  return input;
}

test("rewrite is idempotent and folds beyond budget", () => {
  const store = new ArtifactStore(join(process.env.MPH_HOME!, "art"));
  const k = { ...K, turn_budget: 4000, window: 3, per_output_cap: 500 };
  const state = newRewriteState("s1");
  const big = (i: number) => `Output:\n` + `line ${i} `.repeat(400);
  const hist = mkHistory(12, big);
  const r1 = rewrite(hist, { knobs: k, store, state, now: 1000 });
  assert.ok(r1.stats.compacted, "budget fold should trigger");
  assert.ok(r1.stats.tokensAfter < r1.stats.tokensBefore / 2);
  const stubs = r1.input.filter((x: any) => typeof x.output === "string" && x.output.startsWith("[output #"));
  assert.equal(stubs.length, 12 - 3);
  // re-run same history: identical output (idempotent), no new compaction
  const r2 = rewrite(hist, { knobs: k, store, state, now: 2000 });
  assert.deepEqual(r2.input, r1.input);
  assert.ok(!r2.stats.compacted);
  // append one more step: prefix stays identical
  const hist2 = [...hist, { type: "function_call", name: "exec_command", call_id: "call_x", arguments: JSON.stringify({ cmd: "ls" }) }, { type: "function_call_output", call_id: "call_x", output: "Output:\nok" }];
  const r3 = rewrite(hist2, { knobs: k, store, state, now: 3000 });
  for (let i = 0; i < r1.input.length; i++) assert.deepEqual(r3.input[i], r1.input[i]);
  // digest present and mentions recall
  const digest = r3.input.find((x: any) => x.role === "user" && typeof x.content?.[0]?.text === "string" && x.content[0].text.startsWith("[context digest"));
  assert.ok(digest);
});

test("rewrite collapses empty poll chains keeping first and last", () => {
  const store = new ArtifactStore(join(process.env.MPH_HOME!, "art"));
  const input: any[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "run tests" }] }];
  input.push({ type: "function_call", name: "exec_command", call_id: "c0", arguments: JSON.stringify({ cmd: "pytest" }) });
  input.push({ type: "function_call_output", call_id: "c0", output: "Process running\nOutput:\n" });
  for (let i = 1; i <= 6; i++) {
    input.push({ type: "function_call", name: "write_stdin", call_id: `p${i}`, arguments: JSON.stringify({ session_id: 1, chars: "" }) });
    input.push({ type: "function_call_output", call_id: `p${i}`, output: "Process running\nOutput:\n" });
  }
  const r = rewrite(input, { knobs: K, store, state: newRewriteState("s2"), now: 1 });
  assert.equal(r.stats.pollsCollapsed, 4);
  const polls = r.input.filter((x: any) => x.name === "write_stdin");
  assert.deepEqual(polls.map((p: any) => p.call_id), ["p1", "p6"]);
});

test("rewrite dedupes identical repeated reads", () => {
  const store = new ArtifactStore(join(process.env.MPH_HOME!, "art"));
  const hist = mkHistory(3, () => "Output:\n" + "def f():\n  return 1\n".repeat(20), () => "sed -n '1,40p' a.py");
  const r = rewrite(hist, { knobs: K, store, state: newRewriteState("s3"), now: 1 });
  assert.equal(r.stats.readsDeduped, 2);
  assert.ok((r.input.at(-1) as any).output.startsWith("[unchanged"));
});

test("judge: cold cache compacts, short question keeps, long task compacts", () => {
  const base = { F: 15000, targetC: 25000, idleS: 10, stepsSinceLastCompact: 50, turnIndex: 3 } as const;
  const cold = judge({ ...base, C: 120000, userText: "what is this?", prevTurnSteps: 2, cacheState: "cold", idleS: 5000 }, K);
  assert.equal(cold.action, "compact");
  const q = judge({ ...base, C: 60000, userText: "这是什么？", prevTurnSteps: 2, cacheState: "warm" }, K);
  assert.equal(q.action, "keep");
  const t = judge({ ...base, C: 120000, userText: "请实现一个新的解析器并跑测试", prevTurnSteps: 30, cacheState: "warm" }, K);
  assert.equal(t.action, "compact");
  assert.ok(kStar({ C: 120000, F: 15000, targetC: 25000, cacheState: "warm" }, K) < 5);
  assert.equal(predictSteps({ userText: "why?", prevTurnSteps: 0, turnIndex: 2 }), 3);
});

test("cache state by idle and settings", () => {
  const warm = estimateCacheState({ lastRequestAt: 0, lastSettingsHash: "a", lastPrefixHash: "p" }, 60_000, 1800, "a", "p");
  assert.equal(warm.state, "warm");
  const cold = estimateCacheState({ lastRequestAt: 0, lastSettingsHash: "a", lastPrefixHash: "p" }, 3600_000, 1800, "a", "p");
  assert.equal(cold.state, "cold");
  const chg = estimateCacheState({ lastRequestAt: 0, lastSettingsHash: "a", lastPrefixHash: "p" }, 1000, 1800, "b", "p");
  assert.equal(chg.state, "cold");
});

test("token counter works", () => { assert.ok(countTokens("hello world, 你好世界") > 3); });

test("rewrite resyncs when the client replaces its history", () => {
  const store = new ArtifactStore(join(process.env.MPH_HOME!, "art"));
  const k = { ...K, turn_budget: 4000, window: 3, per_output_cap: 500 };
  const state = newRewriteState("s4");
  const big = (i: number) => `Output:\n` + `line ${i} `.repeat(400);
  const r1 = rewrite(mkHistory(12, big), { knobs: k, store, state, now: 1000 });
  assert.ok(r1.stats.compacted && state.foldedThroughCallId);
  // client-side compaction: history replaced by a summary + new user message
  const replaced = [{ type: "message", role: "user", content: [{ type: "input_text", text: "summary of earlier work" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "continue with the next step" }] }];
  const r2 = rewrite(replaced, { knobs: k, store, state, now: 2000 });
  assert.equal(state.foldedThroughCallId, undefined);
  assert.ok(r2.stats.isTurnStart);
  assert.equal(r2.input.length, 2);
});

test("rewrite folds multi-agent agent_message items outside the window (encrypted payload dropped, text payload recallable)", () => {
  const store = new ArtifactStore(join(process.env.MPH_HOME!, "art"));
  const k = { ...K, turn_budget: 4000, window: 3, per_output_cap: 500 };
  const state = newRewriteState("agents");
  const big = (i: number) => `Output:\n` + `line ${i} `.repeat(400);
  const hist = mkHistory(10, big);
  // interleave agent messages after the first outputs: one encrypted (Codex ≥0.9 shape), one plain text
  const encMsg = { type: "agent_message", id: "amsg_enc", author: "/root/worker", recipient: "/root", content: [{ type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/worker\nPayload:\n" }, { type: "encrypted_content", encrypted_content: "g".repeat(12000) }] };
  const txtMsg = { type: "agent_message", id: "amsg_txt", author: "/root/worker2", recipient: "/root", content: [{ type: "input_text", text: "Message Type: MESSAGE\nSender: /root/worker2\nPayload:\n" + "finding ".repeat(400) }] };
  hist.splice(8, 0, encMsg); hist.splice(12, 0, txtMsg);
  const r1 = rewrite(hist, { knobs: k, store, state, now: 1000 });
  assert.ok(r1.stats.compacted);
  const enc = r1.input.find((x: any) => x.type === "agent_message" && x.id === "amsg_enc");
  const txt = r1.input.find((x: any) => x.type === "agent_message" && x.id === "amsg_txt");
  assert.ok(enc && txt, "agent messages still present as items");
  assert.equal(enc.content.length, 1); assert.ok(!JSON.stringify(enc).includes("gggg"), "encrypted payload removed");
  assert.match(enc.content[0].text, /^\[agent_message Message Type: MESSAGE; Task name: \/root; Sender: \/root\/worker · \d+ tok · encrypted payload folded\]$/);
  assert.match(txt.content[0].text, /^\[agent_message .* recall\("[0-9a-f]{12}"\)\]$/);
  const id = /recall\("([0-9a-f]{12})"\)/.exec(txt.content[0].text)![1];
  assert.ok(store.recall(id, { head: 5 }).includes("finding"), "text payload recallable");
  // idempotent
  const r2 = rewrite(hist, { knobs: k, store, state, now: 2000 });
  assert.deepEqual(r2.input, r1.input);
  // token accounting treats encrypted payload like reasoning, not as raw JSON length
  const before = r1.stats.tokensBefore; assert.ok(before < 12000 + 20000, `tokensBefore ${before}`);
});
