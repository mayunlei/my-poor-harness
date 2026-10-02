/**
 * The project is my-poor-harness and the CLI is mph -- one name, and since the four
 * binaries were merged, one command.
 * These tests fail if the old name creeps back in, which is easy to do: it hid
 * in a split HTML tag, in a wire-protocol string and in three duplicated
 * home-directory defaults the first time round.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, extname } from "node:path";
import { mphEnv } from "../src/core/env.js";

const ROOT = join(import.meta.dirname, "..");

function sourceFiles(dirs: string[], exts = [".ts", ".js", ".sh", ".yml", ".md", ".py"]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist" || name === "release" || name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.includes(extname(name))) out.push(p);
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return out;
}

test("mphEnv reads MPH_ and nothing else", () => {
  assert.equal(mphEnv("OPENAI_BASE_URL", { MPH_OPENAI_BASE_URL: "x" }), "x");
  assert.equal(mphEnv("OPENAI_BASE_URL", { TH_OPENAI_BASE_URL: "old" }), undefined, "the pre-rename prefix is gone, not quietly honoured");
  assert.equal(mphEnv("OPENAI_BASE_URL", {}), undefined);
});

test("harnessHome is MPH_HOME, else ~/.mph", async () => {
  const saved = process.env.MPH_HOME;
  const fresh = async () => (await import("../src/core/knobs.js?" + Math.random())).harnessHome();
  try {
    const dir = mkdtempSync(join(tmpdir(), "mph-home-"));
    process.env.MPH_HOME = dir;
    assert.equal(await fresh(), dir);
    delete process.env.MPH_HOME;
    assert.equal(await fresh(), join(homedir(), ".mph"));
  } finally {
    if (saved === undefined) delete process.env.MPH_HOME; else process.env.MPH_HOME = saved;
  }
});

test("one home directory: every module resolves artifacts and the ledger under the same root", async () => {
  const saved = process.env.MPH_HOME;
  const dir = mkdtempSync(join(tmpdir(), "mph-one-home-"));
  process.env.MPH_HOME = dir;
  try {
    const { ArtifactStore } = await import("../src/core/artifacts.js?" + Math.random());
    const { Ledger } = await import("../src/core/ledger.js?" + Math.random());
    // the three defaults used to be written out separately; a divergence here would
    // separate a session's artifacts from its ledger and break recall(id)
    assert.ok(new ArtifactStore().root.startsWith(dir), new ArtifactStore().root);
    assert.ok(new Ledger().path.startsWith(dir), new Ledger().path);
  } finally {
    if (saved === undefined) delete process.env.MPH_HOME; else process.env.MPH_HOME = saved;
  }
});

test("no old name anywhere in the shipped source, scripts, bins or docs", () => {
  const files = sourceFiles(["src", "bin", "scripts", "docs", "bench", ".github"]);
  assert.ok(files.length > 30, `expected to scan the tree, found ${files.length} files`);
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      // \bTH_ does not match AUTH_BASE or JWT_AUTH_CLAIM, which are not ours
      if (/token[-_]harness|TOKEN_HARNESS|\bTH_[A-Z]|\bth-(proxy|sidecar|dash)\b|\bmph-(proxy|sidecar|dash)\b/i.test(line)) {
        offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "old naming found:\n" + offenders.join("\n"));
});

test("the dashboard page names itself correctly, even split across markup", async () => {
  const { UI_HTML } = await import("../src/dashboard/ui.js");
  assert.match(UI_HTML, /my-poor-<b>harness<\/b>|my-poor-harness/);
  assert.ok(!/token-|token_/.test(UI_HTML), "the h1 once split the old name across tags, hiding it from a plain search");
});

test("package metadata and the bin names agree", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "my-poor-harness");
  // one CLI: mph proxy / mph dash / mph report replaced the extra binaries
  assert.deepEqual(Object.keys(pkg.bin), ["mph"], "there is exactly one command");
  assert.equal(pkg.bin.mph, "bin/mph.js");
  assert.ok(readFileSync(join(ROOT, pkg.bin.mph), "utf8").includes("launch("), "bin/mph.js is a launcher");
  assert.deepEqual(readdirSync(join(ROOT, "bin")).sort(), ["_launch.js", "mph.js"], "no leftover launchers");
});
