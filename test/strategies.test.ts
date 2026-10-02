import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, msg, call } from "./mock_model.js";

process.env.TOKEN_HARNESS_HOME = mkdtempSync(join(tmpdir(), "th-strat-"));
const { strategyFor, STRATEGIES, extractJson } = await import("../src/harness/strategies/index.js");
const { newSession, saveSession } = await import("../src/harness/session.js");
const { Router } = await import("../src/harness/router.js");
const { Ledger } = await import("../src/core/ledger.js");
const { ArtifactStore } = await import("../src/core/artifacts.js");
const { resolveKnobs } = await import("../src/core/knobs.js");
const { compareStrategies, formatCompare } = await import("../src/harness/compare.js");
const { nextWave } = await import("../src/harness/strategies/plan_verify.js");

/** which agent is talking: the instructions tell them apart */
const who = (body: any): "planner" | "verifier" | "worker" =>
  /You are the planner/.test(body.instructions) ? "planner" : /independent verifier/.test(body.instructions) ? "verifier" : "worker";

const plan = (steps: any[]) => msg("Here is the plan.\n```json\n" + JSON.stringify({ goal: "make it work", assumptions: [], steps, done_when: "tests pass" }) + "\n```");
const verdict = (v: "pass" | "fail", objections: string[] = [], evidence = "ran the command") =>
  msg("```json\n" + JSON.stringify({ verdict: v, objections, evidence }) + "\n```");

function fixture() {
  const ws = mkdtempSync(join(tmpdir(), "th-ws-"));
  writeFileSync(join(ws, "a.txt"), "one\n");
  return ws;
}
const harness = (ws: string, over: any = {}) => {
  const knobs = resolveKnobs({ main_model: "mock-main", mid_model: "mock-mid", window: 3, ...over });
  const ledger = new Ledger(join(process.env.TOKEN_HARNESS_HOME!, "ledger.jsonl"));
  const store = new ArtifactStore(join(process.env.TOKEN_HARNESS_HOME!, "art"));
  const session = newSession(ws, "strat"); saveSession(session);
  return { knobs, ledger, store, session, router: new Router(knobs, ledger) };
};

test("extractJson: fenced, bare, trailing prose, and unparseable", () => {
  assert.deepEqual(extractJson<any>('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson<any>('prose {"a":{"b":2}} more prose'), { a: { b: 2 } });
  assert.deepEqual(extractJson<any>('{"s":"a } b"} tail'), { s: "a } b" });
  assert.equal(extractJson<any>("no json at all"), undefined);
  assert.equal(extractJson<any>('{"broken": '), undefined);
});

test("plan_verify: plans, runs a cheap worker per step, verifies independently, reports", async () => {
  const ws = fixture();
  const seen: string[] = [];
  let plannerTools: string[] = []; let verifierTools: string[] = []; let verifierSawClaim = false;
  const mock = await startMock((body) => {
    const role = who(body); seen.push(role);
    if (role === "planner") {
      plannerTools = body.tools.map((t: any) => t.name);
      return { output: [plan([
        { id: "s1", goal: "write two into a.txt", inputs: ["a.txt"], acceptance: "grep -q two a.txt", verify: "file still ends with a newline", depends_on: [], tier: "T3" },
        { id: "s2", goal: "add b.txt", inputs: [], acceptance: "test -f b.txt", verify: "not empty", depends_on: ["s1"], tier: "T3" },
      ])] };
    }
    if (role === "verifier") {
      verifierTools = body.tools.map((t: any) => t.name);
      verifierSawClaim ||= JSON.stringify(body.input).includes("I definitely did it");
      return { output: [verdict("pass")] };
    }
    // worker: one edit then a report
    const last = JSON.stringify(body.input.at(-1) ?? {});
    if (last.includes("YOUR STEP (s1)")) return { output: [call("write_file", { path: "a.txt", content: "two\n" }, "w1")] };
    if (last.includes("YOUR STEP (s2)")) return { output: [call("write_file", { path: "b.txt", content: "b\n" }, "w2")] };
    return { output: [msg("I definitely did it")] };
  });
  process.env.TH_OPENAI_BASE_URL = mock.url + "/v1";
  const h = harness(ws);
  const events: string[] = [];
  const r = await strategyFor("plan_verify").run({ ...h, userText: "make it work", onEvent: (e) => events.push(e.kind) });
  await mock.close();

  // the topology's guarantees, checked outside the handler so a failure cannot hang the server
  assert.ok(!plannerTools.includes("edit") && !plannerTools.includes("write_file"), `planner tools: ${plannerTools}`);
  assert.ok(!verifierTools.includes("edit") && !verifierTools.includes("write_file"), `verifier tools: ${verifierTools}`);
  assert.equal(verifierSawClaim, false, "the verifier must not be shown the worker's self-report");
  assert.equal(r.strategy, "plan_verify");
  assert.equal(r.verified, true, r.text);
  assert.match(r.text, /2\/2 planned steps/);
  assert.match(r.text, /✓ s1/);
  assert.match(r.text, /✓ s2/);
  // the work actually happened in the workspace
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "two\n");
  assert.equal(readFileSync(join(ws, "b.txt"), "utf8"), "b\n");
  // one planner call, two workers, two verifiers — the topology, not just the result
  assert.equal(seen.filter((x) => x === "planner").length, 1);
  assert.ok(seen.filter((x) => x === "verifier").length >= 2, seen.join(","));
  assert.ok(events.includes("plan") && events.includes("verify"));
  // phases landed in the ledger so cost can be attributed
  const rows = h.ledger.readAll();
  for (const ev of ["plan", "step", "verify", "strategy"]) assert.ok(rows.some((x) => x.event === (ev as any)), `ledger has a ${ev} row`);
  assert.ok(rows.some((x) => (x.extra as any)?.strategy === "plan_verify"));
});

test("plan_verify: a failing acceptance command sends the worker back, and the verifier's objection does too", async () => {
  const ws = fixture();
  let workerTries = 0; let verifierCalls = 0; const workerPrompts: string[] = [];
  const mock = await startMock((body) => {
    const role = who(body);
    if (role === "planner") return { output: [plan([
      { id: "s1", goal: "make a.txt say done", inputs: ["a.txt"], acceptance: "grep -q done a.txt", verify: "really done", depends_on: [], tier: "T3" },
    ])] };
    if (role === "verifier") {
      verifierCalls++;
      // reject the first passing attempt, accept the second
      return { output: [verifierCalls === 1 ? verdict("fail", ["a.txt says done but the trailing newline is gone"]) : verdict("pass")] };
    }
    // worker: act when handed a message, then report. What it writes depends on
    // what it was told, so the argue loop is what drives it to the right answer.
    const last: any = body.input.at(-1) ?? {};
    if (last.type === "function_call_output") return { output: [msg("wrote the file")] };
    workerTries++;
    const said = JSON.stringify(last);
    workerPrompts.push(said.slice(0, 400));
    if (said.includes("acceptance command failed") || said.includes("reviewer rejected"))
      return { output: [call("write_file", { path: "a.txt", content: "done\n" }, "x" + workerTries)] };
    return { output: [call("write_file", { path: "a.txt", content: "nope\n" }, "x" + workerTries)] };   // first try misses
  });
  process.env.TH_OPENAI_BASE_URL = mock.url + "/v1";
  const h = harness(ws, { argue_rounds: 2 });
  const events: string[] = [];
  const r = await strategyFor("plan_verify").run({ ...h, userText: "fix it", onEvent: (e) => events.push(`${e.kind}:${e.detail.slice(0, 40)}`) });
  await mock.close();

  assert.equal(r.verified, true, r.text);
  assert.ok(workerTries >= 3, `worker was sent back: ${workerTries} contract messages`);
  assert.ok(workerPrompts.some((p2) => p2.includes("acceptance command failed")), "the worker was told the command failed");
  assert.ok(workerPrompts.some((p2) => p2.includes("reviewer rejected")), "the worker was given the objection");
  assert.equal(verifierCalls, 2);
  assert.ok(events.some((e) => e.startsWith("argue")), events.join("\n"));
  const rows = h.ledger.readAll();
  assert.ok(rows.some((x) => x.event === ("argue" as any)));
  assert.ok(rows.filter((x) => x.event === ("step" as any)).some((x) => x.task_outcome === "fail"), "the failed acceptance is recorded");
});

test("plan_verify: an unusable verdict fails closed, and an exhausted step is reported unverified", async () => {
  const ws = fixture();
  const mock = await startMock((body) => {
    const role = who(body);
    if (role === "planner") return { output: [plan([
      { id: "s1", goal: "do the thing", inputs: [], acceptance: "true", verify: "x", depends_on: [], tier: "T3" },
    ])] };
    if (role === "verifier") return { output: [msg("Looks good to me!")] };      // no json: must not count as a pass
    return { output: [msg("done")] };
  });
  process.env.TH_OPENAI_BASE_URL = mock.url + "/v1";
  const h = harness(ws, { argue_rounds: 0, replan_limit: 0 });
  const r = await strategyFor("plan_verify").run({ ...h, userText: "go" });
  await mock.close();
  assert.equal(r.verified, false);
  assert.match(r.text, /Partly done|✗ s1/);
  assert.match(r.text, /did not return a usable verdict|unresolved/);
});

test("plan_verify: an unusable plan falls back to react instead of failing the task", async () => {
  const ws = fixture();
  const mock = await startMock((body) => {
    if (who(body) === "planner") return { output: [msg("I think we should probably just start coding.")] };
    return { output: [msg("react answer")] };
  });
  process.env.TH_OPENAI_BASE_URL = mock.url + "/v1";
  const h = harness(ws);
  const r = await strategyFor("plan_verify").run({ ...h, userText: "go" });
  await mock.close();
  assert.equal(r.strategy, "plan_verify→react");
  assert.equal(r.text, "react answer");
  assert.ok(h.ledger.readAll().some((x) => x.event === ("replan" as any) && /fell back to react/.test(x.note ?? "")));
});

test("compare: both strategies scored by the task's own oracle, not by their own claim", async () => {
  const ws = fixture();
  const mock = await startMock((body) => {
    const role = who(body);
    if (role === "planner") return { output: [plan([
      { id: "s1", goal: "create ok.txt", inputs: [], acceptance: "test -f ok.txt", verify: "exists", depends_on: [], tier: "T3" },
    ])] };
    if (role === "verifier") return { output: [verdict("pass")] };
    // the worker creates the file only when it is running under plan_verify's contract
    const text = JSON.stringify(body.input);
    if (text.includes("YOUR STEP (s1)")) return { output: [call("write_file", { path: "ok.txt", content: "x" }, "c1")] };
    return { output: [msg("I'm done, trust me")] };      // react: claims success, creates nothing
  });
  process.env.TH_OPENAI_BASE_URL = mock.url + "/v1";
  const rep = await compareStrategies({
    tasks: [{ name: "make-ok", prompt: "create ok.txt", acceptance: "test -f ok.txt", cwd: ws }],
    strategies: ["react", "plan_verify"],
    knobs: resolveKnobs({ main_model: "mock-main", mid_model: "mock-mid" }) as any,
    ledger: new Ledger(join(process.env.TOKEN_HARNESS_HOME!, "ledger.jsonl")),
    store: new ArtifactStore(join(process.env.TOKEN_HARNESS_HOME!, "art")),
    copy: true,
  });
  await mock.close();

  assert.equal(rep.runs.length, 2);
  const react = rep.runs.find((r) => r.strategy === "react")!;
  const pv = rep.runs.find((r) => r.strategy === "plan_verify")!;
  assert.equal(react.passed, false, "the oracle caught react's empty claim");
  assert.equal(pv.passed, true);
  assert.equal(rep.byStrategy.plan_verify.passed, 1);
  assert.equal(rep.byStrategy.react.passed, 0);
  assert.ok(rep.byStrategy.plan_verify.costEquiv > 0);
  // --copy means neither run could see the other's workspace
  assert.notEqual(react.cwd, pv.cwd);
  const out = formatCompare(rep);
  assert.match(out, /strategy comparison over 1 task/);
  assert.match(out, /make-ok/);
});

test("nextWave: respects the parallel limit and never runs two steps over the same file", () => {
  const st = (id: string, inputs: string[]) => ({ id, goal: id, inputs, acceptance: "true", verify: "", depends_on: [] });
  const ready = [st("s1", ["a.py"]), st("s2", ["b.py"]), st("s3", ["a.py", "c.py"]), st("s4", [])];
  assert.deepEqual(nextWave(ready as any, 2).map((s2: any) => s2.id), ["s1", "s2"]);
  // s3 shares a.py with s1, so it is skipped for this wave and s4 (no inputs) comes along
  assert.deepEqual(nextWave(ready as any, 3).map((s2: any) => s2.id), ["s1", "s2", "s4"]);
  assert.deepEqual(nextWave(ready as any, 1).map((s2: any) => s2.id), ["s1"]);
  // a conflict must never produce an empty wave: progress beats parallelism
  assert.deepEqual(nextWave([st("x", ["a"]), st("y", ["a"])] as any, 4).map((s2: any) => s2.id), ["x"]);
  assert.deepEqual(nextWave([] as any, 2), []);
});

test("strategy registry: react is the default, unknown names are rejected", () => {
  assert.equal(strategyFor().name, "react");
  assert.equal(strategyFor("react").name, "react");
  assert.throws(() => strategyFor("nope"), /unknown strategy/);
  assert.deepEqual(Object.keys(STRATEGIES).sort(), ["plan_verify", "react"]);
});
