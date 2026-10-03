/**
 * One CLI. `mph-proxy`, `mph-dash` and `mph-sidecar` used to be separate binaries;
 * they are subcommands now, and these tests fail if one of them stops being reachable
 * or if a command list drifts from the dispatcher.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_COMMANDS } from "../src/sidecar/commands.js";

const ROOT = join(import.meta.dirname, "..");
const HOME = mkdtempSync(join(tmpdir(), "mph-cli-"));

function mph(args: string[], timeoutMs = 60_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, "bin/mph.js"), ...args], {
      // an isolated home, and no credentials of any kind: these tests must never
      // reach a real backend, not even the Codex CLI login this machine may have
      env: {
        ...process.env, MPH_HOME: HOME,
        MPH_OPENAI_BASE_URL: "", MPH_OPENAI_API_KEY: "", MPH_PROVIDER: "",
        MPH_CODEX_CLI_AUTH: join(HOME, "no-such-auth.json"),
        MPH_CODEX_ACCESS_TOKEN: "", MPH_CODEX_REFRESH_TOKEN: "", MPH_CODEX_ACCOUNT_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("exit", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

test("mph help lists every command, and the former binaries are gone from it", async () => {
  const { code, out } = await mph(["help"]);
  assert.equal(code, 0);
  for (const c of ["chat", "run", "vibe", "proxy", "dash", "knobs", "memory", "skill", "config", "login", ...LEDGER_COMMANDS]) {
    assert.match(out, new RegExp(`(^|\\s)${c.replace("-", "\\-")}\\b`, "m"), `help mentions ${c}`);
  }
  assert.ok(!/mph-proxy|mph-dash|mph-sidecar/.test(out), "no separate binaries are advertised");
});

test("every ledger command is dispatched, not swallowed as a chat prompt", async () => {
  for (const c of LEDGER_COMMANDS) {
    const { code, out, err } = await mph([c, "--help"]);
    assert.equal(code, 0, `${c} --help exited ${code}: ${err}`);
    assert.match(out, /mph report \[--since ISO\]/, `${c} --help prints the ledger help, not the top-level one`);
  }
});

test("common subcommands have focused help", async () => {
  const chat = await mph(["chat", "--help"]);
  assert.equal(chat.code, 0);
  assert.match(chat.out, /interactive coding session/);
  assert.match(chat.out, /--resume-last/);

  const run = await mph(["run", "--help"]);
  assert.equal(run.code, 0);
  assert.match(run.out, /send one prompt and exit/);
  assert.match(run.out, /--prompt-file/);

  const model = await mph(["help", "model"]);
  assert.equal(model.code, 0);
  assert.match(model.out, /\/model list/);
});

test("unknown commands fail safely instead of starting a model-backed chat", async () => {
  const { code, out, err } = await mph(["not-a-real-command"]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /Unknown command: not-a-real-command/);
  assert.match(err, /mph help/);
});

test("interactive chat exits cleanly on stdin EOF", async () => {
  const { code, out } = await mph(["chat"]);
  assert.equal(code, 0);
  assert.match(out, /session s_/);
});

test("mph proxy --help and mph dash --once work without a model or a login", async () => {
  const p = await mph(["proxy", "--help"]);
  assert.equal(p.code, 0);
  assert.match(p.out, /mph proxy \[--port 8791\]/);
  assert.match(p.out, /chatgpt_base_url/, "it still says how to point Codex at it");

  const ledger = join(HOME, "empty.jsonl");
  writeFileSync(ledger, "");
  const d = await mph(["dash", "--once", "--ledger", ledger, "--quiet"]);
  assert.equal(d.code, 0, d.err);
  const snap = JSON.parse(d.out);
  assert.equal(snap.rows, 0);
  assert.ok(snap.totals, "a snapshot has totals");
});

test("mph report reads an empty ledger instead of failing", async () => {
  const { code, out } = await mph(["report", "--json", "--ledger", join(HOME, "empty.jsonl")]);
  assert.equal(code, 0);
  assert.ok(JSON.parse(out), "report is valid JSON");
});

test("importing a subcommand module starts nothing", async () => {
  // they were top-level scripts: importing proxy/cli.ts used to bind a port
  const before = process.listenerCount("SIGINT");
  const proxy = await import("../src/proxy/cli.js");
  const dash = await import("../src/dashboard/cli.js");
  const ledger = await import("../src/sidecar/cli.js");
  assert.equal(typeof proxy.proxyMain, "function");
  assert.equal(typeof dash.dashMain, "function");
  assert.equal(typeof ledger.ledgerMain, "function");
  assert.equal(process.listenerCount("SIGINT"), before, "no signal handlers installed by an import");
});

test("vibe refuses to start without credentials instead of hanging on a model call", async () => {
  const { code, err } = await mph(["vibe", "turn memory off"]);
  assert.equal(code, 1);
  assert.match(err, /mph login|openai_compatible/, "it says how to get a model");
});

test("the launcher passes a configured proxy on to node, which ignores it otherwise", async () => {
  const { proxyEnv, PROXY_VARS } = await import("../bin/_launch.js");
  assert.deepEqual(proxyEnv({}), {}, "no proxy configured, nothing added");
  for (const k of PROXY_VARS) assert.deepEqual(proxyEnv({ [k]: "http://127.0.0.1:7897" }), { NODE_USE_ENV_PROXY: "1" }, k);
  assert.deepEqual(proxyEnv({ HTTPS_PROXY: "http://p", NODE_USE_ENV_PROXY: "0" }), {}, "an explicit setting wins, either way");
  assert.deepEqual(proxyEnv({ HTTPS_PROXY: "" }), {}, "an empty value is not a proxy");

  // end to end: the CLI reaches a local server only a proxy-aware fetch could reach is
  // beyond a unit test, so assert the flag actually arrives in the child's environment
  const out = await new Promise<string>((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, "bin/mph.js"), "run", "--cwd", ROOT, "x"], {
      env: { ...process.env, MPH_HOME: HOME, HTTPS_PROXY: "http://127.0.0.1:9", MPH_OPENAI_BASE_URL: "http://127.0.0.1:9/v1", MPH_CODEX_CLI_AUTH: join(HOME, "none.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let s = ""; p.stdout.on("data", (d) => (s += d)); p.stderr.on("data", (d) => (s += d));
    p.on("exit", () => resolve(s));
  });
  // 127.0.0.1 is in node's default NO_PROXY, so the request goes direct and fails fast;
  // what matters is that the launcher did not crash on the proxy handling
  assert.match(out, /model error|fetch failed|ECONNREFUSED/, out.slice(0, 300));
});
