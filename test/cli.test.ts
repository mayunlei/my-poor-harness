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
  for (const c of ["chat", "run", "proxy", "dash", "knobs", "memory", "skill", "config", "login", ...LEDGER_COMMANDS]) {
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
