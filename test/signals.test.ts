/**
 * The ledger fields the harness never filled in.
 *
 * Reviewing ~/.mph after real use turned up a turn with 71 model calls and twenty
 * recall() expansions that `mph report` summarized as "recalls 0", because
 * recall_count, the credits meter and task_outcome were all written by the proxy
 * only. Everything downstream read those fields: the compaction net effect prices a
 * fold against the recalls it causes, the tuner rolls a trial back when recalls climb,
 * and its quality guard scored an empty window as a perfect 1.0. These tests pin the
 * fields at the point they are written, and the guard that no longer passes for free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, msg, call } from "./mock_model.js";

const HOME = mkdtempSync(join(tmpdir(), "mph-sig-"));
process.env.MPH_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith("MPH_") && k !== "MPH_HOME") delete process.env[k];

const { runTurn } = await import("../src/harness/loop.js");
const { newSession, saveSession, pruneEmptySessions } = await import("../src/harness/session.js");
const { Router } = await import("../src/harness/router.js");
const { Ledger } = await import("../src/core/ledger.js");
const { ArtifactStore } = await import("../src/core/artifacts.js");
const { resolveKnobs } = await import("../src/core/knobs.js");
const { rewrite, newRewriteState } = await import("../src/core/rewrite.js");
const { buildReport, formatReport, compactionEffects, recallUnitCost, RECALL_COST_FALLBACK } = await import("../src/sidecar/metrics.js");
const { tune, saveTunerState } = await import("../src/sidecar/tuner.js");
const { durableOnly, findDuplicate } = await import("../src/memory/write.js");
const { MemoryStore } = await import("../src/memory/store.js");

const store = new ArtifactStore(join(HOME, "art"));

const METER = (balance: number) => ({
  "x-codex-plan-type": "pro",
  "x-codex-primary-used-percent": "42",
  "x-codex-credits-balance": String(balance),
  "x-codex-credits-has-credits": "true",
});

test("a harness turn records its recalls, its credits and its outcome", async (t) => {
  const ws = mkdtempSync(join(tmpdir(), "mph-sig-ws-"));
  writeFileSync(join(ws, "a.txt"), "hello\n");
  const mock = await startMock((_b, n) => {
    if (n === 0) return { output: [call("read", { path: "a.txt" }, "r1")], headers: METER(60) };
    if (n === 1) return { output: [call("recall", { id: "nope" }, "k1"), call("recall", { id: "nope2" }, "k2")], headers: METER(57.5) };
    return { output: [msg("done")], headers: METER(55) };
  });
  t.after(() => mock.close());
  process.env.MPH_OPENAI_BASE_URL = mock.url + "/v1";

  const knobs = resolveKnobs({ main_model: "mock-main" });
  const ledger = new Ledger(join(HOME, "turn.jsonl"));
  const s = newSession(ws, "signals"); saveSession(s);
  await runTurn({ session: s, userText: "look at a.txt", knobs, store, ledger, router: new Router(knobs, ledger), multiTurn: false });

  const rows = ledger.readAll();
  const resp = rows.filter((r) => r.event === "response");
  assert.deepEqual(resp.map((r) => r.recall_count), [0, 2, 0], "the step that expanded two stubs says so");

  // the meter: an absolute balance per row, and the drop since the previous response
  assert.deepEqual(resp.map((r) => r.credits_balance), [60, 57.5, 55]);
  assert.equal(resp[0].credits_spent, undefined, "the first row of a process has nothing to subtract from");
  assert.ok(Math.abs((resp[1].credits_spent ?? 0) - 2.5) < 1e-9, `spent ${resp[1].credits_spent}`);
  assert.equal(resp[1].plan_type, "pro");
  assert.equal(resp[1].primary_used_percent, 42);

  const turn = rows.filter((r) => r.event === "turn");
  assert.equal(turn.length, 1, "one row per finished turn");
  assert.equal(turn[0].task_outcome, "unknown", "a react turn has no acceptance command, so success is not claimed");
  assert.equal(turn[0].recall_count, 2, "the turn's recalls, summed");

  // and the report stops saying zero
  const out = formatReport(buildReport(ledger));
  assert.match(out, /recalls 2/);
  assert.match(out, /credits: 5\.000 spent/);
  assert.match(out, /0 success \/ 0 fail \/ 1 unknown/);
});

test("a turn that failed hard says so, instead of counting as nothing", async (t) => {
  const ws = mkdtempSync(join(tmpdir(), "mph-sig-fail-"));
  const mock = await startMock(() => ({ output: [call("read", { path: "nope.txt" }, "x1")] }));   // never answers
  t.after(() => mock.close());
  process.env.MPH_OPENAI_BASE_URL = mock.url + "/v1";
  const knobs = resolveKnobs({ main_model: "mock-main" });
  const ledger = new Ledger(join(HOME, "fail.jsonl"));
  const s = newSession(ws, "fails"); saveSession(s);
  const r = await runTurn({ session: s, userText: "spin", knobs, store, ledger, router: new Router(knobs, ledger), multiTurn: false, maxSteps: 3 });
  assert.match(r.text, /\[stopped after 3 steps\]/);
  const turn = ledger.readAll().find((x) => x.event === "turn")!;
  assert.equal(turn.task_outcome, "fail");
  assert.match(turn.note ?? "", /failed: \[stopped after/);
});

test("a fold is priced against what its recalls really cost, measured", () => {
  // one fold, then steps that do nothing but expand stubs again. The same fold is
  // scored twice: once where a recall round trip is cheap, once where it is not.
  const build = (file: string, perRecallRow: { input: number; cached: number; output: number }, savedPerStep: number) => {
    const led = new Ledger(join(HOME, file));
    let t = Date.parse("2026-10-01T00:00:00Z");
    led.append({ ts: new Date(t += 10_000).toISOString(), source: "harness", session: "s1", turn: 0, step: 1, input: 30_000, cached: 2_000, uncached: 28_000, output: 200, ctx_before: 30_000 + savedPerStep, ctx_after: 30_000, event: "compact", cache_state: "warm", recall_count: 0, tool_calls: 0 });
    for (let i = 2; i <= 12; i++) led.append({
      ts: new Date(t += 10_000).toISOString(), source: "harness", session: "s1", turn: 0, step: i,
      input: perRecallRow.input, cached: perRecallRow.cached, uncached: perRecallRow.input - perRecallRow.cached, output: perRecallRow.output,
      ctx_before: 30_000, ctx_after: 30_000, event: "response", cache_state: "warm",
      recall_count: 2, tool_calls: 2, tool_kinds: ["recall", "recall"],
    });
    return led;
  };

  const cheap = build("net-cheap.jsonl", { input: 6_000, cached: 5_800, output: 20 }, 120_000);
  const dear = build("net-dear.jsonl", { input: 25_000, cached: 20_000, output: 200 }, 120_000);
  const [effCheap] = compactionEffects(cheap.readAll());
  const [effDear] = compactionEffects(dear.readAll());
  assert.equal(effCheap.recallsAfter, 22, "the recalls that followed the fold are counted at all");
  assert.equal(effDear.recallsAfter, 22);
  assert.ok(effDear.net < effCheap.net, `expensive recalls must lower the net (${effDear.net} vs ${effCheap.net})`);

  // and the price is no longer a constant: it comes from the pure-recall rows
  assert.ok(recallUnitCost(dear.readAll()) > 4_000, `measured ${recallUnitCost(dear.readAll())}`);
  assert.equal(recallUnitCost([]), RECALL_COST_FALLBACK, "a ledger with no recall steps keeps the old constant");

  // a fold that saves little and is undone often is a loss, and now reads as one
  const bad = build("net-bad.jsonl", { input: 25_000, cached: 20_000, output: 200 }, 12_000);
  const [effBad] = compactionEffects(bad.readAll());
  assert.ok(effBad.net < 0, `net ${effBad.net}`);
  assert.match(formatReport(buildReport(bad)), /each recall it caused priced at .* \(measured\)/);
});

test("the tuner rolls a trial back when nothing says whether quality held", () => {
  const led = new Ledger(join(HOME, "tune.jsonl"));
  let t = Date.parse("2026-10-01T00:00:00Z");
  for (let i = 0; i < 60; i++) led.append({ ts: new Date(t += 10_000).toISOString(), source: "harness", session: "s" + (i % 3), turn: 0, step: i, input: 10_000, cached: 8_000, uncached: 2_000, output: 100, cost_equiv: 5_000, event: "response", cache_state: "warm" });
  saveTunerState({
    trials: { "turn_budget@trial": { knob: "turn_budget", from: 60_000, to: 50_000, startedAt: "2026-10-01T00:00:00Z", baselineCostPerStep: 9_000, baselineQuality: null, rowsBefore: 0 } },
    bandits: {}, frozen: {},
  });
  const log = tune(led, { minRows: 20, rng: () => 0.9, now: new Date("2026-10-02T00:00:00Z") });
  const rollback = log.find((l) => l.includes("rollback trial"));
  assert.ok(rollback, log.join("\n"));
  assert.match(rollback!, /no pass\/fail evidence/);
  assert.match(rollback!, /"turn_budget":60000/, "the knob goes back to where it was");
});

test("an extracted memory without a reason to last is dropped; a near-duplicate updates instead of piling up", () => {
  const { kept, dropped } = durableOnly([
    { op: "new", type: "fact", title: "the build succeeded" },
    { op: "new", type: "fact", title: "installed version is 0.5.0", durable: "  " },
    { op: "new", type: "decision", title: "x stays an int", durable: "the user will keep expecting ints" },
    { op: "new", type: "nonsense", title: "bad type", durable: "whatever" },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, "x stays an int");
  assert.equal(dropped.length, 3);

  const mem = new MemoryStore(join(HOME, "mem.db"));
  try {
    const base = { type: "fact" as const, project: "/p", source: { session: "s", turn: 0, by: "model" as const } };
    const first = mem.add({ ...base, title: "my-poor-harness installed globally", body: "" });
    const dup = findDuplicate(mem, { type: "fact", title: "my-poor-harness installed globally with npm" });
    assert.equal(dup?.id, first.id, "one title containing the other is the same memory");
    assert.equal(findDuplicate(mem, { type: "fact", title: "the gate uses the small model" }), undefined);
    assert.equal(findDuplicate(mem, { type: "decision", title: "my-poor-harness installed globally" }), undefined, "a different type is a different memory");
  } finally { mem.close(); }
});

test("sessions that never ran a turn are not left behind, and prune clears the old ones", () => {
  const ws = mkdtempSync(join(tmpdir(), "mph-sig-prune-"));
  const empty = newSession(ws, "never-ran"); saveSession(empty);
  const used = newSession(ws, "ran-once"); used.turns.push({ idx: 0, user: "hi", steps: 1, startedAt: new Date().toISOString(), usage: { input: 1, cached: 0, output: 1, reasoning: 0 } } as any); saveSession(used);
  const { removed, kept } = pruneEmptySessions();
  assert.ok(removed.includes(empty.id), `removed ${removed.join(",")}`);
  assert.ok(!removed.includes(used.id));
  assert.ok(kept >= 1);
  assert.ok(!existsSync(join(HOME, "harness", "sessions", empty.id + ".json")));
  assert.ok(existsSync(join(HOME, "harness", "sessions", used.id + ".json")));
});

test("the fold leaves the newest recall outputs alone, so it cannot undo what it just asked for", () => {
  // the loop the real session showed: fold -> the model recalls a stub -> the next fold
  // stubs the recall's own output -> the model recalls it again, a round trip each time.
  // The verbatim window already protects the newest outputs, so the recalls under test
  // sit further back, inside the range the fold would otherwise stub.
  const art = new ArtifactStore(join(HOME, "fold-art"));
  const items: any[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: "audit the repo" }] }];
  const big = (tag: string) => `Output:\n` + `${tag} `.repeat(500);
  const tools = ["read", "recall", "read", "recall", "recall", "read", "read", "read"];
  tools.forEach((tool, i) => {
    const id = `c${i + 1}`;
    items.push({ type: "function_call", name: tool, call_id: id, arguments: "{}" });
    items.push({ type: "function_call_output", call_id: id, output: big(tool + (i + 1)) });
  });

  const run = (recall_keep_last: number) => {
    const knobs = resolveKnobs({ recall_keep_last, turn_budget: 2000, window: 3, per_output_cap: 400 });
    const r = rewrite(items, { knobs, store: art, state: newRewriteState("fold" + recall_keep_last), now: 1, forceCompact: true });
    const stubbed = new Set<string>();
    for (const x of r.input as any[]) if (typeof x.output === "string" && x.output.startsWith("[output #")) stubbed.add(x.call_id);
    return stubbed;
  };

  // window=3 keeps c6..c8 verbatim; the fold covers c1..c5, where c4 and c5 are recalls
  const guarded = run(2);
  assert.ok(!guarded.has("c4") && !guarded.has("c5"), `the two newest recall outputs must survive the fold, stubbed: ${[...guarded]}`);
  assert.ok(guarded.has("c1") && guarded.has("c3"), `ordinary outputs still fold, stubbed: ${[...guarded]}`);
  assert.ok(guarded.has("c2"), "a recall older than the protected tail folds like anything else");

  const off = run(0);
  for (const id of ["c1", "c2", "c3", "c4", "c5"]) assert.ok(off.has(id), `with the knob off ${id} folds too`);
});
