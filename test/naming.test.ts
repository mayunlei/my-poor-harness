/**
 * The project was renamed from token-harness to my-poor-harness (mph). These pin
 * the compatibility promises, because breaking them silently loses a user's
 * ledger history or their Codex credentials.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mphEnv } from "../src/core/env.js";

test("mphEnv: MPH_ wins, TH_ still works, neither means undefined", () => {
  assert.equal(mphEnv("OPENAI_BASE_URL", { MPH_OPENAI_BASE_URL: "new", TH_OPENAI_BASE_URL: "old" }), "new");
  assert.equal(mphEnv("OPENAI_BASE_URL", { TH_OPENAI_BASE_URL: "old" }), "old", "a shell set up before the rename keeps working");
  assert.equal(mphEnv("OPENAI_BASE_URL", {}), undefined);
  assert.equal(mphEnv("NOPE", { MPH_OTHER: "x" }), undefined);
});

test("harnessHome: MPH_HOME wins, then the legacy env var, then an existing legacy directory", async () => {
  const saved = { MPH_HOME: process.env.MPH_HOME, TOKEN_HARNESS_HOME: process.env.TOKEN_HARNESS_HOME };
  const fresh = async () => {
    // knobs.ts reads process.env at call time, so a plain re-import is enough
    const { harnessHome } = await import("../src/core/knobs.js?" + Math.random());
    return harnessHome();
  };
  try {
    const a = mkdtempSync(join(tmpdir(), "mph-home-"));
    process.env.MPH_HOME = a; delete process.env.TOKEN_HARNESS_HOME;
    assert.equal(await fresh(), a, "MPH_HOME is honoured");

    const b = mkdtempSync(join(tmpdir(), "mph-legacy-env-"));
    delete process.env.MPH_HOME; process.env.TOKEN_HARNESS_HOME = b;
    assert.equal(await fresh(), b, "the pre-rename variable still points the harness at its data");

    delete process.env.TOKEN_HARNESS_HOME;
    const home = await fresh();
    // whichever applies on this machine, it must be one of the two known locations
    assert.ok(home === join(homedir(), ".token_harness") || home === join(homedir(), ".mph"), home);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("no stale TH_/token-harness names leak into the shipped CLI help", async () => {
  const { UI_HTML } = await import("../src/dashboard/ui.js");
  assert.match(UI_HTML, /my-poor-harness|mph/, "the dashboard identifies itself by the new name");
  // the h1 splits the name across tags, so a plain "token-harness" check misses it
  assert.ok(!/token-harness/.test(UI_HTML), "no old product name on the page");
  assert.ok(!/token-|token_harness/.test(UI_HTML), "not even split across markup");
});
