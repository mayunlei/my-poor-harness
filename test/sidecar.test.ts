import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MPH_HOME = mkdtempSync(join(tmpdir(), "mph-s-"));
const { Ledger } = await import("../src/core/ledger.js");
const { buildReport, formatReport, compactionEffects } = await import("../src/sidecar/metrics.js");
const { tune, calibrateKHat } = await import("../src/sidecar/tuner.js");
const { knobsFor, loadKnobFile } = await import("../src/core/knobs.js");

test("metrics: compaction effects and report; tuner starts a trial and records provenance", () => {
  const ledger = new Ledger(join(process.env.MPH_HOME!, "ledger.jsonl"));
  let t = Date.parse("2026-10-01T00:00:00Z");
  for (let s = 0; s < 6; s++) for (let turn = 0; turn < 3; turn++) for (let step = 0; step < 15; step++) {
    const compact = step === 0 && turn > 0;
    ledger.append({ ts: new Date(t += 10000).toISOString(), source: "proxy", session: "s" + s, turn, step, input: 40000 + step * 1000, cached: compact ? 5000 : 38000 + step * 900, uncached: compact ? 35000 : 2000 + step * 100, output: 300, ctx_before: 120000 + step * 1000, ctx_after: 40000 + step * 1000, event: compact ? "compact" : "response", cache_state: "warm", idle_s: 5, knobs_hash: "h1", extra: compact ? { compact_reason: "turn-start", decision: { action: "compact", kHat: 13, kStar: 3 } } : {} });
  }
  const eff = compactionEffects(ledger.readAll());
  assert.equal(eff.length, 12); assert.ok(eff.every((e) => e.savedTokens > 0 && e.net > 0));
  const rep = buildReport(ledger);
  assert.equal(rep.total.rows, 270); assert.equal(rep.compactions.count, 12); assert.ok(rep.judge.compactRate === 1);
  assert.ok(formatReport(rep).includes("compactions: 12"));
  const log = tune(ledger, { minRows: 100, rng: () => 0.1, now: new Date("2026-10-02T00:00:00Z") });
  assert.ok(log.some((l) => l.includes("trial")), log.join("\n"));
  const f = loadKnobFile(); assert.ok(f.history && f.history.length >= 1 && f.history[0].who === "sidecar");
  const k = knobsFor(); assert.notEqual(k.turn_budget === 60000 && k.per_output_cap === 2000 && k.window === 10 && k.reasoning_keep_last === 4, true);
  const kh = calibrateKHat(ledger.readAll()); assert.ok(kh === null || kh.default > 0);
});
