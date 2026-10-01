/**
 * Sidecar tuner: adjusts knobs within their bounds from ledger evidence.
 *   - continuous knobs: one-step hill climbing on cost-per-step, with a quality guard
 *   - discrete knobs: Thompson sampling over choices
 *   - k_hat calibration: refit the step predictor table from actual steps per turn
 *   - cache TTL: refit from (idle, cached share) samples
 * Every change is recorded with provenance and can be rolled back.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Ledger, type LedgerRow } from "../core/ledger.js";
import { KNOB_SPECS, applyKnobChange, loadKnobFile, knobsFor, harnessHome, type KnobName, type KnobOverrides } from "../core/knobs.js";
import { fitTtl } from "../core/cache_state.js";
import { predictSteps, loadKHatTable, type KHatTable } from "../core/judge.js";
import { buildReport } from "./metrics.js";

export interface TunerState {
  trials: Record<string, { knob: string; from: any; to: any; startedAt: string; baselineCostPerStep: number; baselineQuality: number; rowsBefore: number }>;
  bandits: Record<string, Record<string, { alpha: number; beta: number }>>;
  frozen: Record<string, string>;   // knob -> until ISO
  lastRun?: string;
}
const statePath = () => join(harnessHome(), "sidecar", "state.json");
export function loadTunerState(): TunerState { const p = statePath(); if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { /* ignore */ } } return { trials: {}, bandits: {}, frozen: {} }; }
export function saveTunerState(s: TunerState): void { const p = statePath(); mkdirSync(join(harnessHome(), "sidecar"), { recursive: true }); writeFileSync(p, JSON.stringify(s, null, 2)); }

const CONTINUOUS: KnobName[] = ["turn_budget", "per_output_cap", "window", "reasoning_keep_last"];
const DISCRETE: KnobName[] = ["compact_on_turn_start"];

function costPerStep(rows: LedgerRow[]): number { const rs = rows.filter((r) => r.input !== undefined); return rs.length ? rs.reduce((a, r) => a + (r.cost_equiv ?? 0), 0) / rs.length : 0; }
function quality(rows: LedgerRow[]): number { const o = rows.filter((r) => r.task_outcome === "success" || r.task_outcome === "fail"); return o.length ? o.filter((r) => r.task_outcome === "success").length / o.length : 1; }
function recallRate(rows: LedgerRow[]): number { const rs = rows.filter((r) => r.input !== undefined); return rs.length ? rs.reduce((a, r) => a + (r.recall_count ?? 0), 0) / rs.length : 0; }

export interface TuneOptions { scope?: string; minRows?: number; dryRun?: boolean; now?: Date; rng?: () => number }

export function tune(ledger: Ledger, opts: TuneOptions = {}): string[] {
  const log: string[] = [];
  const now = opts.now ?? new Date(); const rng = opts.rng ?? Math.random;
  const scope = opts.scope ?? "global"; const minRows = opts.minRows ?? 200;
  const st = loadTunerState();
  const rows = ledger.readAll().filter((r) => r.source === "proxy" || r.source === "harness");
  const recent = rows.slice(-2000);
  const knobs = knobsFor({ project: scope.startsWith("project:") ? scope.slice(8) : undefined });
  const change = (changes: KnobOverrides, why: string) => { log.push(`${scope}: ${JSON.stringify(changes)} — ${why}`); if (!opts.dryRun) applyKnobChange(scope, changes, "sidecar", why); };

  // 0. calibrations that never hurt quality
  const ttlSamples = recent.filter((r) => r.idle_s !== undefined && r.input).map((r) => ({ idleS: r.idle_s!, cachedShare: (r.cached ?? 0) / Math.max(1, r.input!) }));
  if (ttlSamples.length >= 30) { const ttl = fitTtl(ttlSamples, knobs.cache_ttl_estimate_s); if (Math.abs(ttl - knobs.cache_ttl_estimate_s) >= 300) change({ cache_ttl_estimate_s: ttl }, `fitted TTL from ${ttlSamples.length} samples`); }
  const kh = calibrateKHat(rows); if (kh) { log.push(`k_hat table: ${JSON.stringify(kh)}`); if (!opts.dryRun) writeFileSync(join(harnessHome(), "judge_model.json"), JSON.stringify(kh, null, 2)); }

  if (recent.filter((r) => r.input !== undefined).length < minRows) { log.push(`only ${recent.length} rows; need ${minRows} before tuning knobs`); st.lastRun = now.toISOString(); if (!opts.dryRun) saveTunerState(st); return log; }

  // 1. evaluate running trials
  for (const [id, t] of Object.entries(st.trials)) {
    const after = rows.slice(t.rowsBefore);
    if (after.filter((r) => r.input !== undefined).length < minRows / 2) continue;
    const cps = costPerStep(after), q = quality(after), rr = recallRate(after);
    const worseQuality = q < t.baselineQuality * 0.95; const worseCost = cps > t.baselineCostPerStep * 0.98; const tooManyRecalls = rr > 0.15;
    if (worseQuality || worseCost || tooManyRecalls) {
      change({ [t.knob]: t.from } as any, `rollback trial ${id}: cost/step ${cps.toFixed(0)} vs ${t.baselineCostPerStep.toFixed(0)}, quality ${q.toFixed(2)} vs ${t.baselineQuality.toFixed(2)}, recall/step ${rr.toFixed(2)}`);
      if (worseQuality) st.frozen[t.knob] = new Date(now.getTime() + 7 * 86400e3).toISOString();
    } else log.push(`trial ${id} kept: cost/step ${cps.toFixed(0)} (was ${t.baselineCostPerStep.toFixed(0)}), quality ${q.toFixed(2)}`);
    delete st.trials[id];
  }

  // 2. start at most one new continuous trial (hill-climb one step toward cheaper)
  if (Object.keys(st.trials).length === 0) {
    const candidates = CONTINUOUS.filter((k) => !(st.frozen[k] && st.frozen[k] > now.toISOString()));
    const knob = candidates[Math.floor(rng() * candidates.length)];
    if (knob) {
      const spec = KNOB_SPECS[knob] as any; const cur = (knobs as any)[knob] as number; const step = spec.step ?? 1;
      // direction: cheaper = smaller for all four; but if recall rate is already high, go the other way
      const dir = recallRate(recent) > 0.1 ? +1 : -1;
      const to = Math.min(spec.max, Math.max(spec.min, cur + dir * step));
      if (to !== cur) {
        const id = `${knob}@${now.toISOString().slice(0, 16)}`;
        st.trials[id] = { knob, from: cur, to, startedAt: now.toISOString(), baselineCostPerStep: costPerStep(recent), baselineQuality: quality(recent), rowsBefore: rows.length };
        change({ [knob]: to } as any, `trial ${id}: hill-climb ${dir > 0 ? "up" : "down"} (recall/step ${recallRate(recent).toFixed(2)})`);
      }
    }
  }

  // 3. discrete knobs: Thompson sampling on per-turn cost outcomes
  for (const knob of DISCRETE) {
    const spec = KNOB_SPECS[knob] as any; st.bandits[knob] ??= {};
    for (const c of spec.choices) st.bandits[knob][c] ??= { alpha: 1, beta: 1 };
    // reward: compaction net positive (for judge/always) or absence of needless compaction (never)
    const rep = buildReport(ledger);
    const cur = String((knobs as any)[knob]);
    const good = rep.compactions.count ? rep.compactions.netTotal > 0 : true;
    if (good) st.bandits[knob][cur].alpha += 1; else st.bandits[knob][cur].beta += 1;
    let best = cur, bestSample = -1;
    for (const [c, ab] of Object.entries(st.bandits[knob])) { const s = betaSample(ab.alpha, ab.beta, rng); if (s > bestSample) { bestSample = s; best = c; } }
    if (best !== cur && !(st.frozen[knob] && st.frozen[knob] > now.toISOString())) change({ [knob]: best } as any, `thompson sampling (${JSON.stringify(st.bandits[knob])})`);
  }
  st.lastRun = now.toISOString(); if (!opts.dryRun) saveTunerState(st);
  return log;
}

function betaSample(a: number, b: number, rng: () => number): number {
  // crude: mean plus noise scaled by uncertainty (sufficient for a few arms)
  const mean = a / (a + b); const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  const u = rng() || 1e-9, v = rng(); const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + sd * z;
}

/** Refit k_hat table: group turns by the same features the judge uses and take the median actual steps. */
export function calibrateKHat(rows: LedgerRow[]): KHatTable | null {
  const turns = new Map<string, { steps: number; user?: string; prev: number; idx: number }>();
  for (const r of rows) { if (r.input === undefined) continue; const key = r.session + ":" + r.turn; const t = turns.get(key) ?? { steps: 0, prev: 0, idx: r.turn }; t.steps++; turns.set(key, t); }
  if (turns.size < 50) return null;
  // without user text in the ledger we can only calibrate by previous-turn steps and turn index
  const bySession = new Map<string, number[]>();
  for (const [key, t] of turns) { const s = key.split(":")[0]; if (!bySession.has(s)) bySession.set(s, []); bySession.get(s)![t.idx] = t.steps; }
  const prevGe50: number[] = [], prevGe10: number[] = [], first: number[] = [], def: number[] = [];
  for (const arr of bySession.values()) arr.forEach((steps, i) => { if (steps === undefined) return; const prev = i > 0 ? arr[i - 1] ?? 0 : 0; if (i === 0) first.push(steps); else if (prev >= 50) prevGe50.push(steps); else if (prev >= 10) prevGe10.push(steps); else def.push(steps); });
  const med = (xs: number[], fb: number) => (xs.length >= 10 ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : fb);
  const base = loadKHatTable();
  return { ...base, first_turn: med(first, base.first_turn), prev_ge_50: med(prevGe50, base.prev_ge_50), prev_ge_10: med(prevGe10, base.prev_ge_10), default: med(def, base.default) };
}

export { predictSteps };
