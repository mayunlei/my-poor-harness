/**
 * mph save: a session with its full per-turn context goes into a dataset for backtesting,
 * and a one-sentence note saying what problem it is about is required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { startMock, msg, call } from "./mock_model.js";

const HOME = mkdtempSync(join(tmpdir(), "mph-ds-"));
process.env.MPH_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith("MPH_") && k !== "MPH_HOME") delete process.env[k];

const { runTurn } = await import("../src/harness/loop.js");
const { newSession, saveSession, loadSession } = await import("../src/harness/session.js");
const { Router } = await import("../src/harness/router.js");
const { Ledger } = await import("../src/core/ledger.js");
const { ArtifactStore } = await import("../src/core/artifacts.js");
const { resolveKnobs } = await import("../src/core/knobs.js");
const { MemoryStore } = await import("../src/memory/store.js");
const { saveToDataset, readIndex, readCase, listDatasets, validateNote, datasetsDir } = await import("../src/harness/dataset.js");

function gitRepo(): string {
  const ws = mkdtempSync(join(tmpdir(), "mph-ds-ws-"));
  writeFileSync(join(ws, "a.py"), "x = 1\n");
  for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["add", "."], ["commit", "-qm", "init"]]) spawnSync("git", a, { cwd: ws });
  return ws;
}

function mainMock(answers: string[]) {
  let n = 0;
  return startMock((body) => {
    const ins = String(body.instructions ?? "");
    if (ins.startsWith("You maintain the long-term memory")) return { output: [msg('{"items":[{"op":"new","type":"decision","title":"x stays an int","body":"user wants ints"}]}')] };
    if (!ins.startsWith("You are a coding agent in a long-running conversation")) return { output: [msg("{}")] };
    const i = n++;
    if (i === 0) return { output: [call("edit", { path: "a.py", old: "x = 1", new: "x = 2" }, "c1")] };
    return { output: [msg(answers[Math.min(i - 1, answers.length - 1)])] };
  });
}

test("save: transcript, per-turn context, ledger, memories, git state and the note go into the dataset", async () => {
  const ws = gitRepo();
  const mock = await mainMock(["Done: x is now 2 in a.py.", "It is 2."]);
  process.env.MPH_OPENAI_BASE_URL = mock.url + "/v1";
  const knobs = resolveKnobs({ main_model: "mock-main", small_model: "mock-small" });
  const ledger = new Ledger(join(HOME, "ledger.jsonl"));
  const store = new ArtifactStore(join(HOME, "artifacts"));
  const memory = new MemoryStore(join(HOME, "memory.db"));
  const router = new Router(knobs, ledger);
  const s = newSession(ws, "save-me"); saveSession(s);
  const u0 = "把 a.py 里的 x 改成 2。记住：x 必须是整数。";
  const u1 = "现在 x 是多少？\n```log\nline1\nline2\n```";
  await runTurn({ session: s, userText: u0, knobs, store, ledger, router, memory, memorySettings: { recall: true, write: true }, skills: [] });
  await runTurn({ session: s, userText: u1, knobs, store, ledger, router, memory, memorySettings: { recall: true, write: true }, skills: [] });
  assert.equal(s.turns[0].git?.head?.length, 40, "turn records the git HEAD it started on");

  assert.throws(() => saveToDataset(s, { note: "  ", store, ledger, memory }), /一句话注释/);
  assert.throws(() => validateNote("x".repeat(301)), /300/);

  const note = "复现：用户中途追问时，模型要能直接回答上一轮改过的值";
  const r = saveToDataset(s, { note, dataset: "regress", store, ledger, memory, now: new Date("2026-10-02T21:30:00Z") });
  assert.equal(r.dataset, "regress"); assert.equal(r.turns, 2); assert.equal(r.contextFiles, 2); assert.ok(r.memories >= 2, `memories ${r.memories}`);
  for (const f of ["case.json", "transcript.jsonl", "turns/turn-0.json", "turns/turn-1.json", "ledger.jsonl", "memory.jsonl", "workspace.diff"]) assert.ok(existsSync(join(r.dir, f)), f);

  const k = readCase("regress", r.id);
  assert.equal(k.note, note);
  assert.equal(k.turns[0].user, u0); assert.equal(k.turns[1].user, u1, "user words verbatim, paste included");
  assert.equal(k.turns[0].answer, "Done: x is now 2 in a.py."); assert.deepEqual(k.turns[0].files_changed, ["a.py"]);
  assert.equal(k.turns[0].gate.action, "rebuild");
  assert.ok(k.models_used.includes("mock-main"), JSON.stringify(k.models_used)); assert.equal(k.session.id, s.id); assert.equal(k.git_at_save.dirty, true);
  assert.ok(readFileSync(join(r.dir, "workspace.diff"), "utf8").includes("+x = 2"));
  const ctx0 = JSON.parse(readFileSync(join(r.dir, "turns/turn-0.json"), "utf8"));
  assert.ok(ctx0.some((x: any) => x.type === "function_call" && x.name === "edit"), "full context has the tool calls");
  assert.ok(JSON.stringify(ctx0).includes("把 a.py 里的 x 改成 2"));
  assert.ok(readFileSync(join(r.dir, "ledger.jsonl"), "utf8").split("\n").filter(Boolean).every((l) => JSON.parse(l).session.startsWith(s.id)));
  const mems = readFileSync(join(r.dir, "memory.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(mems.some((m) => m.quote === "记住：x 必须是整数。"));

  const idx = readIndex("regress");
  assert.equal(idx.length, 1); assert.equal(idx[0].note, note); assert.equal(idx[0].turns, 2);
  assert.deepEqual(listDatasets(), [{ name: "regress", cases: 1 }]);
  assert.throws(() => saveToDataset(s, { note, dataset: "regress", store, ledger, memory, now: new Date("2026-10-02T21:30:00Z") }), /already has a case/);
  const r2 = saveToDataset(s, { note, dataset: "regress", id: "second copy", store, ledger, memory });
  assert.equal(r2.id, "second-copy"); assert.equal(readIndex("regress").length, 2);
  memory.close(); await mock.close();
});

test("mph save --last --note and mph dataset show work from the command line", async () => {
  const ws = gitRepo();
  const mock = await mainMock(["pong"]);
  const home = mkdtempSync(join(tmpdir(), "mph-ds-cli-"));
  const run = (argv: string[], input?: string) => new Promise<{ out: string; err: string; code: number | null }>((res) => {
    const loader = join(process.cwd(), "node_modules/tsx/dist/loader.mjs");   // absolute: the child runs inside the workspace
    const p = spawn(process.execPath, ["--import", "file://" + loader, join(process.cwd(), "src/harness/cli.ts"), ...argv], { cwd: ws, env: { ...process.env, MPH_HOME: home, MPH_OPENAI_BASE_URL: mock.url + "/v1", MPH_MEMORY_WRITE: "0" } });
    let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ out, err, code })); p.stdin.end(input ?? "");
  });
  const r1 = await run(["run", "make x 2", "--model", "mock-main"]);
  assert.equal(r1.code, 0, r1.err.slice(-400));
  const bad = await run(["save", "--last"]);
  assert.notEqual(bad.code, 0); assert.match(bad.err, /一句话注释/);
  const ok = await run(["save", "--last", "--note", "检查单轮改文件后保存数据集是否完整"]);
  assert.equal(ok.code, 0, ok.err.slice(-400)); assert.match(ok.out, /saved s_\w+ .* as default\//);
  const ls = await run(["dataset", "default"]);
  assert.match(ls.out, /检查单轮改文件后保存数据集是否完整/);
  const id = ls.out.trim().split(/\s+/)[0];
  const show = await run(["dataset", "show", `default/${id}`]);
  assert.match(show.out, /note: 检查单轮改文件后保存数据集是否完整/); assert.match(show.out, /user: make x 2/);
  await mock.close();
  void datasetsDir; void loadSession;
});
