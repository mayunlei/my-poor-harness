/**
 * Vibe mode: configuring the harness by talking to it. What matters here is that the
 * agent cannot lie about a write (every rejection is explicit, and a bad value writes
 * nothing at all), and that these tools exist only in vibe mode -- a coding turn must
 * not be able to rewrite the harness's own settings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, msg, call } from "./mock_model.js";

const HOME = mkdtempSync(join(tmpdir(), "mph-vibe-"));
process.env.MPH_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith("MPH_") && k !== "MPH_HOME") delete process.env[k];

const { validateKnobs, knobTable, VIBE_TOOL_NAMES, VIBE_PROMPT } = await import("../src/harness/vibe.js");
const { executeTool, TOOL_DEFS, MULTI_TURN_TOOL_DEFS, ALL_TOOL_DEFS } = await import("../src/harness/tools.js");
const { ArtifactStore } = await import("../src/core/artifacts.js");
const { resolveKnobs, knobsFor, loadKnobFile } = await import("../src/core/knobs.js");
const { runTurn } = await import("../src/harness/loop.js");
const { newSession, saveSession } = await import("../src/harness/session.js");
const { Router } = await import("../src/harness/router.js");
const { Ledger } = await import("../src/core/ledger.js");
const { loadConfigFile } = await import("../src/upstream/config.js");

const store = new ArtifactStore(join(HOME, "art"));
const K = resolveKnobs({});
const ctxFor = (cwd: string, sessionId = "s_vibe") => ({
  cwd, knobs: K, store, sessionId,
  filesTouched: new Set<string>(), readCache: new Map(), cmdCache: new Map(), jobs: new Map(),
} as any);

test("validateKnobs refuses instead of silently falling back to the default", () => {
  const bad = validateKnobs({ turn_budget: 999_999_999, strategy: "telepathy", nope: 1, gate_use_model: "maybe" });
  assert.equal(Object.keys(bad.values).length, 0, "nothing survives");
  assert.equal(bad.errors.length, 4, bad.errors.join(" | "));
  assert.match(bad.errors.join("\n"), /turn_budget must be <= \d+/);
  assert.match(bad.errors.join("\n"), /strategy must be one of react, plan_verify/);
  assert.match(bad.errors.join("\n"), /unknown knob "nope"/);
  assert.match(bad.errors.join("\n"), /gate_use_model must be true or false/);

  const good = validateKnobs({ turn_budget: 40_000, strategy: "plan_verify", gate_use_model: "off", memory_l1_max: "8" });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.values, { turn_budget: 40_000, strategy: "plan_verify", gate_use_model: false, memory_l1_max: 8 });
});

test("a near miss on a knob name suggests the real ones", () => {
  const { errors } = validateKnobs({ memory_l1: 5 });
  assert.match(errors[0], /did you mean .*memory_l1_max/);
});

test("settings_write is all or nothing, scoped, and leaves a reason behind", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mph-vibe-ws-"));
  const ctx = ctxFor(ws);

  // one bad value and nothing is written -- not the good knob, not the config
  const refused = await executeTool(ctx, "settings_write", { why: "try it", knobs: { turn_budget: 40_000, strategy: "nope" }, config: { memory_write: "off" } }, "1");
  assert.match(refused, /nothing written/);
  assert.equal(knobsFor({}).turn_budget, K.turn_budget, "the good knob was not written either");
  assert.equal(loadConfigFile().memory?.write, undefined, "and neither was the config");

  const ok = await executeTool(ctx, "settings_write", { why: "上下文给小一点", knobs: { turn_budget: 40_000 } }, "2");
  assert.match(ok, /turn_budget: 60000 -> 40000 \(global\)/);
  assert.match(ok, /undo:/);
  assert.equal(knobsFor({}).turn_budget, 40_000);

  const hist = loadKnobFile().history ?? [];
  assert.equal(hist.at(-1)!.who, "vibe");
  assert.equal(hist.at(-1)!.why, "上下文给小一点", "the user's own words are the provenance");

  // scope session: the global value stays put
  await executeTool(ctx, "settings_write", { why: "just for now", scope: "session", knobs: { turn_budget: 22_000 } }, "3");
  assert.equal(knobsFor({ session: "s_vibe" }).turn_budget, 22_000);
  assert.equal(knobsFor({}).turn_budget, 40_000);

  // a cache-breaking knob says so, because the next turn pays for it
  const cb = await executeTool(ctx, "settings_write", { why: "bigger model", knobs: { main_model: "gpt-5.6-sol" } }, "4");
  assert.match(cb, /cache-breaking/);

  // config goes through the same validator the CLI uses
  const badKey = await executeTool(ctx, "settings_write", { why: "x", config: { memory_recall: "sometimes" } }, "5");
  assert.match(badKey, /must be on or off/);
  const goodKey = await executeTool(ctx, "settings_write", { why: "记忆先关掉", config: { memory_recall: "off" } }, "6");
  assert.match(goodKey, /config.memory_recall = off/);
  assert.equal(loadConfigFile().memory?.recall, false);

  // an api key is never echoed back into the transcript
  const key = await executeTool(ctx, "settings_write", { why: "set the key", config: { api_key: "sk-secret-value" } }, "7");
  assert.ok(!key.includes("sk-secret-value"), key);
  assert.match(key, /\*\*\*/);

  assert.match(await executeTool(ctx, "settings_write", { why: "nothing" }, "8"), /nothing to change/);
  assert.match(await executeTool(ctx, "settings_write", { knobs: { window: 3 } }, "9"), /why is required/);
});

test("settings_read says what is in force, and the knob table carries range and provenance", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mph-vibe-ro-"));
  const ctx = ctxFor(ws);
  const overview = await executeTool(ctx, "settings_read", {}, "1");
  for (const line of ["home:", "upstream:", "models:", "memory:", "skills:", "ledger:"]) assert.ok(overview.includes(line), `${line} in overview:\n${overview}`);
  assert.ok(!overview.includes("sk-secret"), "no secrets in the overview");

  const knobs = await executeTool(ctx, "settings_read", { section: "knobs", filter: "memory_l1" }, "2");
  assert.match(knobs, /memory_l1_max = \d+/);
  assert.match(knobs, /default 12 · 0\.\.40/);
  assert.ok(!knobs.includes("turn_budget"), "the filter actually filters");

  const cfg = await executeTool(ctx, "settings_read", { section: "config" }, "3");
  assert.match(cfg, /memory_recall\s+on \| off/);

  assert.match(knobTable(ws, "s_vibe", "no_such_knob_name"), /no knob matches/);
});

test("the settings tools exist only in vibe mode", () => {
  const names = (defs: { name: string }[]) => defs.map((d) => d.name);
  for (const t of ["settings_read", "settings_write", "upstream_probe"]) {
    assert.ok(!names(TOOL_DEFS).includes(t), `${t} is not in the single-task tool set`);
    assert.ok(!names(MULTI_TURN_TOOL_DEFS).includes(t), `${t} is not in the multi-turn tool set`);
    assert.ok(names(ALL_TOOL_DEFS).includes(t), `${t} is reachable when named`);
  }
  // and vibe cannot edit files or run commands
  for (const t of ["run", "write_file", "edit", "multi_edit", "delegate", "remember"]) {
    assert.ok(!VIBE_TOOL_NAMES.includes(t), `vibe must not have ${t}`);
  }
  assert.match(VIBE_PROMPT, /never ask the user to paste one into this conversation/i);
});

test("a vibe turn gets only the vibe tools, and its write lands in the knob file", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mph-vibe-e2e-"));
  const mock = await startMock((body, n) => {
    if (n === 0) {
      assert.deepEqual(body.tools.map((t: any) => t.name).sort(), [...VIBE_TOOL_NAMES].sort(), "exactly the vibe tools");
      assert.match(body.instructions, /You configure my-poor-harness/);
      return { output: [call("settings_read", { section: "knobs", filter: "memory_extract" }, "v1")] };
    }
    if (n === 1) {
      const out = JSON.stringify(body.input.at(-1));
      assert.match(out, /memory_extract = true/, "it saw the current value");
      return { output: [call("settings_write", { why: "把记忆抽取关掉", knobs: { memory_extract: false } }, "v2")] };
    }
    return { output: [msg("Turned memory extraction off (global). Undo with `mph knobs memory_extract=true`.")] };
  });
  process.env.MPH_OPENAI_BASE_URL = mock.url + "/v1";
  try {
    const knobs = resolveKnobs({ main_model: "mock-main" });
    const ledger = new Ledger(join(HOME, "ledger.jsonl"));
    const s = newSession(ws, "vibe"); saveSession(s);
    const r = await runTurn({
      session: s, userText: "把记忆抽取关掉", knobs, store, ledger, router: new Router(knobs, ledger),
      instructions: VIBE_PROMPT, toolNames: VIBE_TOOL_NAMES, multiTurn: false,
    });
    assert.match(r.text, /Turned memory extraction off/);
    assert.equal(knobsFor({}).memory_extract, false, "the knob file changed");
    assert.equal((loadKnobFile().history ?? []).at(-1)!.why, "把记忆抽取关掉");
  } finally { await mock.close(); delete process.env.MPH_OPENAI_BASE_URL; }
});

test("the memory store and the config file stay where MPH_HOME says", () => {
  assert.ok(existsSync(join(HOME, "knobs.json")), "knobs went to the test home, not the real one");
  assert.ok(readFileSync(join(HOME, "config.json"), "utf8").includes("memory"));
});
