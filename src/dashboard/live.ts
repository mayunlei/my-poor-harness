/**
 * Live state for the dashboard: an incremental fold of the ledger into
 * per-session effect numbers, plus a tailer that only reads appended bytes.
 *
 * Everything here is derived from ledger rows, like the sidecar's metrics, but
 * aggregated for "what is happening right now" instead of "what happened".
 */
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { harnessHome } from "../core/knobs.js";
import { type LedgerRow, costEquiv, PRICE } from "../core/ledger.js";

export const ACTIVE_WINDOW_S = 120;
const SERIES_MAX = 240;
const EVENTS_MAX = 60;

/**
 * Events worth showing in the feed: a token saving with a cause, or a decision a
 * strategy made (planning, a step, a verification, an argue round, a replan).
 */
const FEED_EVENTS = new Set(["compact", "shape", "dedupe", "poll_collapse", "wait", "recall", "delegate", "merge", "fork", "knob_change",
  "plan", "step", "verify", "argue", "replan", "strategy"]);

export interface SeriesPoint { t: number; step: number; before: number; after: number; cost: number }

export interface LiveSession {
  session: string;
  source: string;
  model?: string;
  firstTs: string;
  lastTs: string;
  responses: number;
  turns: number;
  lastStep: number;
  input: number; cached: number; uncached: number; output: number;
  cost: number;            // cost-equivalent actually paid
  baseline: number;        // cost-equivalent the unmodified client would have paid
  ctxBefore: number; ctxAfter: number;
  events: Record<string, number>;
  recalls: number;
  outcome: { success: number; fail: number; unknown: number };
  series: SeriesPoint[];
  active: boolean;
  idleS: number;
}

export interface LiveTotals {
  responses: number; sessions: number; turns: number;
  input: number; cached: number; uncached: number; output: number;
  cost: number; baseline: number;
  ctxBefore: number; ctxAfter: number;
  cacheHitRate: number;
  savedTokens: number; savedCost: number; multiplier: number;
}

export interface StrategyStats {
  strategy: string;
  /** model calls across every agent the strategy ran */
  responses: number;
  input: number; cached: number; output: number;
  cost: number; baseline: number;
  /** completed runs, from the strategy's own rollup rows */
  runs: number; passed: number;
  phases: Record<string, number>;
  costPerPass?: number;
}

export interface LiveSnapshot {
  now: string;
  ledger: string;
  rows: number;
  window: { from?: string; to?: string };
  totals: LiveTotals;
  budget?: { weekly: number; used: number; wouldHaveUsed: number; remainingSteps?: number };
  sessions: LiveSession[];
  feed: Array<{ ts: string; session: string; turn: number; step: number; event: string; note?: string; saved?: number; model?: string }>;
  byModel: Record<string, { responses: number; input: number; output: number; cost: number }>;
  byEvent: Record<string, number>;
  /** only populated once a strategy has tagged its rows (plan_verify, compare runs) */
  byStrategy: StrategyStats[];
}

/**
 * The baseline a row is compared against: what the client would have paid for
 * this same step without the rewrite. `ctx_before` is what it wanted to send;
 * the cached share is assumed to carry over, so the extra tokens price at the
 * uncached rate — the honest, conservative reading.
 */
function rowBaseline(r: LedgerRow): number {
  const paid = r.cost_equiv ?? costEquiv(r);
  if (!r.ctx_before || !r.ctx_after || r.ctx_before <= r.ctx_after) return paid;
  return paid + (r.ctx_before - r.ctx_after) * PRICE.uncached;
}

export class LiveState {
  readonly sessions = new Map<string, LiveSession>();
  feed: LiveSnapshot["feed"] = [];
  readonly strategies = new Map<string, StrategyStats>();
  rows = 0;
  from?: string;
  to?: string;
  weeklyBudget = 0;
  constructor(readonly ledgerPath: string) {}

  ingest(r: LedgerRow): void {
    if (!r.session || !r.ts) return;
    this.rows++;
    if (!this.from || r.ts < this.from) this.from = r.ts;
    if (!this.to || r.ts > this.to) this.to = r.ts;

    let s = this.sessions.get(r.session);
    if (!s) {
      s = {
        session: r.session, source: r.source, model: r.model, firstTs: r.ts, lastTs: r.ts,
        responses: 0, turns: 0, lastStep: 0,
        input: 0, cached: 0, uncached: 0, output: 0, cost: 0, baseline: 0, ctxBefore: 0, ctxAfter: 0,
        events: {}, recalls: 0, outcome: { success: 0, fail: 0, unknown: 0 },
        series: [], active: false, idleS: 0,
      };
      this.sessions.set(r.session, s);
    }
    if (r.ts > s.lastTs) s.lastTs = r.ts;
    if (r.model) s.model = r.model;
    s.turns = Math.max(s.turns, (r.turn ?? 0) + 1);
    s.lastStep = Math.max(s.lastStep, r.step ?? 0);
    if (r.event) s.events[r.event] = (s.events[r.event] ?? 0) + 1;
    s.recalls += r.recall_count ?? 0;
    if (r.task_outcome) s.outcome[r.task_outcome]++;

    const counted = r.input !== undefined || r.ctx_after !== undefined;
    if (counted) {
      s.responses++;
      s.input += r.input ?? 0; s.cached += r.cached ?? 0; s.uncached += r.uncached ?? 0; s.output += r.output ?? 0;
      s.cost += r.cost_equiv ?? costEquiv(r);
      s.baseline += rowBaseline(r);
      s.ctxBefore += r.ctx_before ?? 0; s.ctxAfter += r.ctx_after ?? 0;
      s.series.push({ t: Date.parse(r.ts), step: r.step ?? 0, before: r.ctx_before ?? r.input ?? 0, after: r.ctx_after ?? r.input ?? 0, cost: r.cost_equiv ?? costEquiv(r) });
      if (s.series.length > SERIES_MAX) s.series.splice(0, s.series.length - SERIES_MAX);
    }

    // a strategy tags every model call it makes, so its overhead cannot hide
    const sname = (r.extra as any)?.strategy;
    if (typeof sname === "string" && sname) {
      let st = this.strategies.get(sname);
      if (!st) { st = { strategy: sname, responses: 0, input: 0, cached: 0, output: 0, cost: 0, baseline: 0, runs: 0, passed: 0, phases: {} }; this.strategies.set(sname, st); }
      if (counted) {
        st.responses++; st.input += r.input ?? 0; st.cached += r.cached ?? 0; st.output += r.output ?? 0;
        st.cost += r.cost_equiv ?? costEquiv(r); st.baseline += rowBaseline(r);
      }
      const phase = (r.extra as any)?.phase;
      if (typeof phase === "string") st.phases[phase] = (st.phases[phase] ?? 0) + 1;
      // the rollup row of a finished run carries the verdict
      if (r.event === "strategy") { st.runs++; if (r.task_outcome === "success") st.passed++; }
    }

    if (r.event && FEED_EVENTS.has(r.event)) {
      const saved = r.ctx_before !== undefined && r.ctx_after !== undefined ? r.ctx_before - r.ctx_after : undefined;
      this.feed.push({ ts: r.ts, session: r.session, turn: r.turn ?? 0, step: r.step ?? 0, event: r.event, note: r.note, saved, model: r.model });
      if (this.feed.length > EVENTS_MAX) this.feed.splice(0, this.feed.length - EVENTS_MAX);
    }
  }

  snapshot(nowMs = Date.now()): LiveSnapshot {
    const totals: LiveTotals = {
      responses: 0, sessions: this.sessions.size, turns: 0,
      input: 0, cached: 0, uncached: 0, output: 0, cost: 0, baseline: 0, ctxBefore: 0, ctxAfter: 0,
      cacheHitRate: 0, savedTokens: 0, savedCost: 0, multiplier: 1,
    };
    const byModel: LiveSnapshot["byModel"] = {};
    const byEvent: Record<string, number> = {};
    const sessions: LiveSession[] = [];

    for (const s of this.sessions.values()) {
      const idleS = Math.max(0, (nowMs - Date.parse(s.lastTs)) / 1000);
      const view: LiveSession = { ...s, idleS, active: idleS <= ACTIVE_WINDOW_S };
      sessions.push(view);
      totals.responses += s.responses; totals.turns += s.turns;
      totals.input += s.input; totals.cached += s.cached; totals.uncached += s.uncached; totals.output += s.output;
      totals.cost += s.cost; totals.baseline += s.baseline;
      totals.ctxBefore += s.ctxBefore; totals.ctxAfter += s.ctxAfter;
      const m = s.model ?? "unknown";
      byModel[m] ??= { responses: 0, input: 0, output: 0, cost: 0 };
      byModel[m].responses += s.responses; byModel[m].input += s.input; byModel[m].output += s.output; byModel[m].cost += s.cost;
      for (const [k, v] of Object.entries(s.events)) byEvent[k] = (byEvent[k] ?? 0) + v;
    }

    totals.cacheHitRate = totals.input ? totals.cached / totals.input : 0;
    totals.savedTokens = Math.max(0, totals.ctxBefore - totals.ctxAfter);
    totals.savedCost = Math.max(0, totals.baseline - totals.cost);
    totals.multiplier = totals.cost > 0 ? totals.baseline / totals.cost : 1;

    sessions.sort((a, b) => b.lastTs.localeCompare(a.lastTs));

    const snap: LiveSnapshot = {
      now: new Date(nowMs).toISOString(),
      ledger: this.ledgerPath,
      rows: this.rows,
      window: { from: this.from, to: this.to },
      totals,
      sessions,
      feed: [...this.feed].reverse(),
      byModel, byEvent,
      byStrategy: [...this.strategies.values()]
        .map((st) => ({ ...st, costPerPass: st.passed ? st.cost / st.passed : undefined }))
        .sort((a, b) => b.cost - a.cost),
    };

    if (this.weeklyBudget > 0) {
      const used = totals.input + totals.output;
      const wouldHave = totals.ctxBefore ? totals.ctxBefore + totals.output : used;
      const perStep = totals.responses ? used / totals.responses : 0;
      snap.budget = {
        weekly: this.weeklyBudget, used, wouldHaveUsed: wouldHave,
        remainingSteps: perStep > 0 ? Math.max(0, Math.floor((this.weeklyBudget - used) / perStep)) : undefined,
      };
    }
    return snap;
  }
}

/** Follows an append-only file, handing back only complete new lines. */
export class LedgerTail {
  private offset = 0;
  private partial = "";
  constructor(readonly path: string) {}

  /** Reads whatever was appended since the last call. Handles truncation/rotation. */
  read(): LedgerRow[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.offset) { this.offset = 0; this.partial = ""; }   // truncated or rotated
    if (size === this.offset) return [];
    const fd = openSync(this.path, "r");
    const len = size - this.offset;
    const buf = Buffer.allocUnsafe(len);
    try { readSync(fd, buf, 0, len, this.offset); } finally { closeSync(fd); }
    this.offset = size;
    const text = this.partial + buf.toString("utf8");
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    const out: LedgerRow[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as LedgerRow); } catch { /* half-written row: skip */ }
    }
    return out;
  }
}

export function defaultLedgerPath(): string {
  return join(harnessHome(), "ledger.jsonl");
}
