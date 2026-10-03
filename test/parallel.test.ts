/**
 * Tool batching: one model response can carry many tool calls, and they run
 * concurrently. This is the part people assume is missing -- "it only calls one tool
 * per inference" -- so the behaviour is pinned here, together with the ledger fields
 * and the report line that make it visible after the fact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, msg, call } from "./mock_model.js";

const HOME = mkdtempSync(join(tmpdir(), "mph-par-"));
process.env.MPH_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith("MPH_") && k !== "MPH_HOME") delete process.env[k];

const { runTurn } = await import("../src/harness/loop.js");
const { newSession, saveSession } = await import("../src/harness/session.js");
const { Router } = await import("../src/harness/router.js");
const { Ledger } = await import("../src/core/ledger.js");
const { ArtifactStore } = await import("../src/core/artifacts.js");
const { resolveKnobs } = await import("../src/core/knobs.js");
const { executeTool } = await import("../src/harness/tools.js");
const { buildReport, formatReport } = await import("../src/sidecar/metrics.js");

const store = new ArtifactStore(join(HOME, "art"));

test("one response, many calls: all of them run and the ledger says how many", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mph-par-ws-"));
  for (const f of ["a.py", "b.py", "c.py"]) writeFileSync(join(ws, f), `# ${f}\nvalue = "${f}"\n`);
  const mock = await startMock((body, n) => {
    if (n === 0) return { output: [call("read", { path: "a.py" }, "k1"), call("read", { path: "b.py" }, "k2"), call("read", { path: "c.py" }, "k3")] };
    // the model sees one output per call, in call order
    const outs = body.input.filter((x: any) => x.type === "function_call_output");
    assert.deepEqual(outs.map((o: any) => o.call_id), ["k1", "k2", "k3"]);
    assert.ok(outs.every((o: any, i: number) => o.output.includes(["a.py", "b.py", "c.py"][i])), "each output belongs to its own call");
    return { output: [msg("three files read in one round trip")] };
  });
  process.env.MPH_OPENAI_BASE_URL = mock.url + "/v1";
  try {
    const knobs = resolveKnobs({ main_model: "mock-main" });
    const ledger = new Ledger(join(HOME, "batch.jsonl"));
    const s = newSession(ws, "batch"); saveSession(s);
    const r = await runTurn({ session: s, userText: "read all three", knobs, store, ledger, router: new Router(knobs, ledger), multiTurn: false });
    assert.equal(r.steps, 2, "three tools cost two model calls, not four");

    const rows = ledger.readAll().filter((x) => x.event === "response");
    assert.equal(rows[0].tool_calls, 3);
    assert.deepEqual(rows[0].tool_kinds, ["read", "read", "read"]);
    assert.equal(rows[1].tool_calls, 0, "the final answer made no calls, and says so rather than leaving the field out");
  } finally { await mock.close(); delete process.env.MPH_OPENAI_BASE_URL; }
});

test("the batch runs concurrently, and tool_parallel bounds it", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mph-par-sleep-"));
  // shell_login=never keeps the one-time login-shell capture out of the measurement;
  // what is under test here is the loop's limiter
  const run = async (limit: number) => {
    const mock = await startMock((_b, n) => n === 0
      ? { output: [call("run", { cmd: "sleep 0.4" }, "s1"), call("run", { cmd: "sleep 0.4" }, "s2"), call("run", { cmd: "sleep 0.4" }, "s3")] }
      : { output: [msg("slept")] });
    process.env.MPH_OPENAI_BASE_URL = mock.url + "/v1";
    try {
      const knobs = resolveKnobs({ main_model: "mock-main", tool_parallel: limit, shell_login: "never" });
      const ledger = new Ledger(join(HOME, `sleep-${limit}.jsonl`));
      const s = newSession(ws, `sleep-${limit}`); saveSession(s);
      const t0 = Date.now();
      await runTurn({ session: s, userText: "sleep three times", knobs, store, ledger, router: new Router(knobs, ledger), multiTurn: false });
      return Date.now() - t0;
    } finally { await mock.close(); delete process.env.MPH_OPENAI_BASE_URL; }
  };

  const parallel = await run(8);
  const serial = await run(1);
  // 3 x 400ms: together is one sleep, one at a time is three. Compared against each
  // other, not against the clock: absolute thresholds here failed once on a machine
  // busy running the rest of the suite, which is a flake, not a finding.
  assert.ok(serial > parallel * 1.8, `serial ${serial}ms should be well above parallel ${parallel}ms`);
  assert.ok(serial > 1100, `three serialized 400ms sleeps cannot take only ${serial}ms`);
  assert.ok(parallel < 3 * 400 + 2000, `three concurrent sleeps should not look serial (${parallel}ms)`);
});

test("synchronous tools in one batch do not interleave, so same-file edits all land", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mph-par-edit-"));
  writeFileSync(join(ws, "a.py"), "a = 1\nb = 2\nc = 3\n");
  const ctx: any = { cwd: ws, knobs: resolveKnobs({}), store, sessionId: "s", filesTouched: new Set(), readCache: new Map(), cmdCache: new Map(), jobs: new Map() };
  // what a model does when it fixes three lines of one file in one response: a
  // read-modify-write each. They are safe because each handler is synchronous.
  await Promise.all([
    executeTool(ctx, "edit", { path: "a.py", old: "a = 1", new: "a = 10" }, "e1"),
    executeTool(ctx, "edit", { path: "a.py", old: "b = 2", new: "b = 20" }, "e2"),
    executeTool(ctx, "edit", { path: "a.py", old: "c = 3", new: "c = 30" }, "e3"),
  ]);
  assert.equal(readFileSync(join(ws, "a.py"), "utf8"), "a = 10\nb = 20\nc = 30\n", "no edit was lost");

  // and the read dedupe still fires inside one batch
  writeFileSync(join(ws, "b.py"), "x = 1\n".repeat(20));
  const [first, second] = await Promise.all([
    executeTool(ctx, "read", { path: "b.py" }, "r1"),
    executeTool(ctx, "read", { path: "b.py" }, "r2"),
  ]);
  assert.ok(first.includes("x = 1"), "the first read returns the file");
  assert.match(second, /unchanged/, "the second identical read in the same batch is deduped, not sent twice");
});

test("the report says how many tools the model got per round trip", () => {
  const path = join(HOME, "report.jsonl");
  const led = new Ledger(path);
  for (const n of [4, 3, 1, 1]) led.append({ source: "harness", session: "s1", turn: 0, step: 1, event: "response", input: 1000, cached: 800, uncached: 200, output: 50, tool_calls: n, tool_kinds: Array(n).fill("read") });
  const out = formatReport(buildReport(led));
  assert.match(out, /tool batching: 9 calls over 4 responses = 2\.25 per round trip \(widest 4\)/);

  // the hint needs a sample before it says anything: one call per response can also
  // mean the model merged the work into a single command, which is better, not worse
  const few = new Ledger(join(HOME, "few.jsonl"));
  for (let i = 0; i < 5; i++) few.append({ source: "harness", session: "s2", turn: 0, step: i + 1, event: "response", input: 100, cached: 0, uncached: 100, output: 10, tool_calls: 1, tool_kinds: ["run"] });
  const fewOut = formatReport(buildReport(few));
  assert.match(fewOut, /1\.00 per round trip \(widest 1\)$/m);
  assert.ok(!fewOut.includes("worth checking"), "five responses is not enough to draw a conclusion from");

  const many = new Ledger(join(HOME, "many.jsonl"));
  for (let i = 0; i < 12; i++) many.append({ source: "harness", session: "s3", turn: 0, step: i + 1, event: "response", input: 100, cached: 0, uncached: 100, output: 10, tool_calls: 1, tool_kinds: ["run"] });
  assert.match(formatReport(buildReport(many)), /1\.00 per round trip.*worth checking whether independent work could go out together/);
});
