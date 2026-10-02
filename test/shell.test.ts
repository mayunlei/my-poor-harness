/**
 * run(cmd) used to spawn `bash -lc`, sourcing the user's profile on every single
 * command: 682ms each on the machine this was found on, against 2ms for `bash -c`.
 * The profile cannot just be dropped -- it is what puts conda, nvm and pyenv on PATH,
 * and `conda` is a shell function -- so it is captured once and replayed. These tests
 * use a profile of their own, so they assert the mechanism rather than this machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "mph-shell-"));
process.env.MPH_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith("MPH_") && k !== "MPH_HOME") delete process.env[k];

// a login shell that exports a variable, defines a function, and extends PATH
const FAKE_HOME = mkdtempSync(join(tmpdir(), "mph-fakehome-"));
const BIN = join(FAKE_HOME, "bin");
writeFileSync(join(FAKE_HOME, ".bash_profile"), [
  `export MPH_PROFILE_MARKER=from-the-profile`,
  `export PATH="${BIN}:$PATH"`,
  `mph_profile_fn() { echo "the function ran"; }`,
  "",
].join("\n"));
process.env.HOME = FAKE_HOME;

const { executeTool, resetShellCache } = await import("../src/harness/tools.js");
const { ArtifactStore } = await import("../src/core/artifacts.js");
const { resolveKnobs } = await import("../src/core/knobs.js");

const store = new ArtifactStore(join(HOME, "art"));
const ws = mkdtempSync(join(tmpdir(), "mph-shell-ws-"));
const ctxFor = (mode: string) => ({
  cwd: ws, knobs: resolveKnobs({ shell_login: mode }), store, sessionId: "s",
  filesTouched: new Set<string>(), readCache: new Map(), cmdCache: new Map(), jobs: new Map(),
} as any);

test("cached: the profile's variables and functions reach the command", async () => {
  resetShellCache();
  const ctx = ctxFor("cached");
  const env = await executeTool(ctx, "run", { cmd: "echo $MPH_PROFILE_MARKER" }, "1");
  assert.match(env, /from-the-profile/, env);
  const fn = await executeTool(ctx, "run", { cmd: "mph_profile_fn" }, "2");
  assert.match(fn, /the function ran/, "a function defined by the profile is callable -- this is how `conda activate` keeps working");
  const path = await executeTool(ctx, "run", { cmd: "echo $PATH" }, "3");
  assert.ok(path.includes(BIN), "the profile's PATH addition survives");

  const fnFile = join(HOME, "shell-functions.sh");
  assert.ok(existsSync(fnFile), "the captured functions are on disk");
  assert.match(readFileSync(fnFile, "utf8"), /mph_profile_fn/);
});

test("never: no profile at all, which is the point of the mode", async () => {
  const ctx = ctxFor("never");
  const env = await executeTool(ctx, "run", { cmd: "echo [$MPH_PROFILE_MARKER]" }, "1");
  assert.match(env, /\[\]/, "the profile variable is absent");
  const fn = await executeTool(ctx, "run", { cmd: "mph_profile_fn || echo no-such-function" }, "2");
  assert.match(fn, /no-such-function/);
});

test("always: still correct, and that is the fallback when a capture fails", async () => {
  const ctx = ctxFor("always");
  assert.match(await executeTool(ctx, "run", { cmd: "echo $MPH_PROFILE_MARKER" }, "1"), /from-the-profile/);
});

test("the profile is sourced once, not once per command", async () => {
  // count it: the profile appends a line to a file every time it is sourced
  const counter = join(FAKE_HOME, "sourced.log");
  writeFileSync(join(FAKE_HOME, ".bash_profile"), [
    `echo sourced >> ${JSON.stringify(counter)}`,
    `export MPH_PROFILE_MARKER=from-the-profile`,
    `mph_profile_fn() { echo "the function ran"; }`,
    "",
  ].join("\n"));
  writeFileSync(counter, "");

  resetShellCache();
  const ctx = ctxFor("cached");
  for (let i = 0; i < 5; i++) await executeTool(ctx, "run", { cmd: `echo ${i}` }, "c" + i);
  const cached = readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length;

  writeFileSync(counter, "");
  const always = ctxFor("always");
  for (let i = 0; i < 5; i++) await executeTool(always, "run", { cmd: `echo ${i}` }, "a" + i);
  const perCommand = readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length;

  assert.ok(cached <= 2, `cached sourced the profile ${cached} times for 5 commands (the capture itself runs it once or twice)`);
  assert.equal(perCommand, 5, "always sources it once per command, which is the cost this replaces");
});

test("a command still sees its exit code, output and the workspace cwd", async () => {
  resetShellCache();
  const ctx = ctxFor("cached");
  writeFileSync(join(ws, "marker.txt"), "hi\n");
  assert.match(await executeTool(ctx, "run", { cmd: "cat marker.txt" }, "1"), /hi/);
  assert.match(await executeTool(ctx, "run", { cmd: "exit 3" }, "2"), /\[exit 3\]/);
});
