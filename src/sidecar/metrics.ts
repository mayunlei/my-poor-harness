/**
 * Sidecar metrics: aggregate the ledger into cost, per-policy effect and quality
 * signals. Everything here is derived from ledger rows only.
 */
import { Ledger, type LedgerRow, costEquiv } from "../core/ledger.js";

export interface Aggregate { rows: number; input: number; cached: number; uncached: number; output: number; cost: number; ctxBefore: number; ctxAfter: number; compactions: number; recalls: number; sessions: number; turns: number;
  /** real money, when the upstream reports a credits meter: summed balance drops.
   *  The meter is eventually consistent and the pool is shared across devices, so the
   *  total is sound and a single row is not. */
  credits: number; creditsBalance?: number }
export interface CompactionEffect { session: string; turn: number; step: number; reason?: string; followingSteps: number; savedTokens: number; savedCostEquiv: number; oneTimeCost: number; net: number; recallsAfter: number }
export interface Report {
  window: { from?: string; to?: string };
  total: Aggregate;
  bySource: Record<string, Aggregate>;
  byKnobsHash: Record<string, Aggregate & { costPerStep: number }>;
  byCacheState: Record<string, { rows: number; uncachedShare: number }>;
  compactions: { count: number; netTotal: number; medianNet: number; negative: number; effects: CompactionEffect[] };
  judge: { decisions: number; compactRate: number; kHatMAE?: number };
  delegate: Record<string, { pass: number; fail: number; byTier: Record<string, { pass: number; fail: number }> }>;
  quality: { turns: number; successes: number; fails: number; unknown: number };
}

function agg(rows: LedgerRow[]): Aggregate {
  const a: Aggregate = { rows: 0, input: 0, cached: 0, uncached: 0, output: 0, cost: 0, ctxBefore: 0, ctxAfter: 0, compactions: 0, recalls: 0, sessions: 0, turns: 0, credits: 0 };
  const sess = new Set<string>(); const turns = new Set<string>();
  for (const r of rows) {
    if (r.input === undefined && r.ctx_after === undefined) continue;
    a.rows++; a.input += r.input ?? 0; a.cached += r.cached ?? 0; a.uncached += r.uncached ?? 0; a.output += r.output ?? 0; a.cost += r.cost_equiv ?? costEquiv(r);
    a.ctxBefore += r.ctx_before ?? 0; a.ctxAfter += r.ctx_after ?? 0; if (r.event === "compact") a.compactions++; a.recalls += r.recall_count ?? 0;
    a.credits += r.credits_spent ?? 0;
    if (r.credits_balance !== undefined) a.creditsBalance = r.credits_balance;
    sess.add(r.session); turns.add(r.session + ":" + r.turn);
  }
  a.sessions = sess.size; a.turns = turns.size; return a;
}

export function compactionEffects(rows: LedgerRow[], horizon = 40): CompactionEffect[] {
  const bySession = new Map<string, LedgerRow[]>();
  for (const r of rows) if (r.source === "proxy" || r.source === "harness") { if (!bySession.has(r.session)) bySession.set(r.session, []); bySession.get(r.session)!.push(r); }
  const out: CompactionEffect[] = [];
  for (const [session, rs] of bySession) {
    rs.sort((a, b) => a.ts.localeCompare(b.ts));
    rs.forEach((r, i) => {
      if (r.event !== "compact" || r.ctx_before === undefined || r.ctx_after === undefined) return;
      const X = r.ctx_before - r.ctx_after; let saved = 0, n = 0, recalls = 0;
      for (let j = i + 1; j < rs.length && n < horizon; j++) { const s = rs[j]; if (s.input === undefined) continue; if (s.event === "compact") break; saved += X; n++; recalls += s.recall_count ?? 0; }
      const oneTime = (r.uncached ?? 0) + ((r.extra as any)?.summary_cost ?? 0);
      const savedCost = saved * 0.1; const net = savedCost - oneTime - recalls * 2000;
      out.push({ session, turn: r.turn, step: r.step, reason: (r.extra as any)?.compact_reason, followingSteps: n, savedTokens: saved, savedCostEquiv: savedCost, oneTimeCost: oneTime, net, recallsAfter: recalls });
    });
  }
  return out;
}

export function buildReport(ledger: Ledger, opts: { since?: string } = {}): Report {
  let rows = ledger.readAll();
  if (opts.since) rows = rows.filter((r) => r.ts >= opts.since!);
  const bySource: Record<string, Aggregate> = {};
  for (const src of new Set(rows.map((r) => r.source))) bySource[src] = agg(rows.filter((r) => r.source === src));
  const byKnobsHash: Record<string, Aggregate & { costPerStep: number }> = {};
  for (const h of new Set(rows.map((r) => r.knobs_hash).filter(Boolean) as string[])) { const a = agg(rows.filter((r) => r.knobs_hash === h)); byKnobsHash[h] = { ...a, costPerStep: a.rows ? a.cost / a.rows : 0 }; }
  const byCacheState: Record<string, { rows: number; uncachedShare: number }> = {};
  for (const cs of ["warm", "cold", "unknown"]) { const rs = rows.filter((r) => r.cache_state === cs && r.input); const inp = rs.reduce((a, r) => a + (r.input ?? 0), 0); byCacheState[cs] = { rows: rs.length, uncachedShare: inp ? rs.reduce((a, r) => a + (r.uncached ?? 0), 0) / inp : 0 }; }
  const effects = compactionEffects(rows);
  const nets = effects.map((e) => e.net).sort((a, b) => a - b);
  const judged = rows.filter((r) => (r.extra as any)?.decision);
  const delegate: Report["delegate"] = {};
  for (const r of rows.filter((r) => r.event === "delegate" && r.note?.includes(":"))) {
    const [cls, tier, res] = r.note!.split(":"); delegate[cls] ??= { pass: 0, fail: 0, byTier: {} }; delegate[cls].byTier[tier] ??= { pass: 0, fail: 0 };
    if (res === "pass") { delegate[cls].pass++; delegate[cls].byTier[tier].pass++; } else { delegate[cls].fail++; delegate[cls].byTier[tier].fail++; }
  }
  const outcomes = rows.filter((r) => r.task_outcome && r.event !== "delegate");
  return {
    window: { from: rows[0]?.ts, to: rows.at(-1)?.ts },
    total: agg(rows), bySource, byKnobsHash, byCacheState,
    compactions: { count: effects.length, netTotal: nets.reduce((a, b) => a + b, 0), medianNet: nets.length ? nets[Math.floor(nets.length / 2)] : 0, negative: nets.filter((n) => n < 0).length, effects: effects.slice(-20) },
    judge: { decisions: judged.length, compactRate: judged.length ? judged.filter((r) => (r.extra as any).decision.action === "compact").length / judged.length : 0 },
    delegate,
    quality: { turns: outcomes.length, successes: outcomes.filter((r) => r.task_outcome === "success").length, fails: outcomes.filter((r) => r.task_outcome === "fail").length, unknown: outcomes.filter((r) => r.task_outcome === "unknown").length },
  };
}

export function formatReport(r: Report): string {
  const f = (n: number) => Math.round(n).toLocaleString("en-US");
  const L: string[] = [];
  L.push(`ledger window: ${r.window.from ?? "-"} → ${r.window.to ?? "-"}`);
  L.push(`total: ${r.total.rows} responses, ${r.total.sessions} sessions, ${r.total.turns} turns`);
  L.push(`  input ${f(r.total.input)} (cached ${f(r.total.cached)} = ${(100 * r.total.cached / Math.max(1, r.total.input)).toFixed(0)}%), output ${f(r.total.output)}, cost-equiv ${f(r.total.cost)}`);
  if (r.total.ctxBefore) L.push(`  context: client would send ${f(r.total.ctxBefore)} → sent ${f(r.total.ctxAfter)} (×${(r.total.ctxBefore / Math.max(1, r.total.ctxAfter)).toFixed(2)})`);
  if (r.total.credits > 0) L.push(`  credits: ${r.total.credits.toFixed(3)} spent${r.total.creditsBalance !== undefined ? `, ${f(r.total.creditsBalance)} left` : ""}` +
    ` (${(r.total.credits / Math.max(1, r.total.input / 1e6)).toFixed(1)} per 1M input; the meter lags and the pool is shared, so trust the total, not a row)`);
  for (const [src, a] of Object.entries(r.bySource)) L.push(`  ${src}: ${a.rows} rows, cost ${f(a.cost)}, compactions ${a.compactions}, recalls ${a.recalls}`);
  L.push(`cache: ` + Object.entries(r.byCacheState).map(([k, v]) => `${k}=${v.rows} rows/${(100 * v.uncachedShare).toFixed(0)}% uncached`).join("  "));
  L.push(`compactions: ${r.compactions.count}, net ${f(r.compactions.netTotal)} cost-equiv (median ${f(r.compactions.medianNet)}, ${r.compactions.negative} negative)`);
  L.push(`judge: ${r.judge.decisions} decisions, compact rate ${(100 * r.judge.compactRate).toFixed(0)}%`);
  for (const [cls, d] of Object.entries(r.delegate)) L.push(`delegate ${cls}: pass ${d.pass} fail ${d.fail} ` + Object.entries(d.byTier).map(([t, v]) => `${t}=${v.pass}/${v.pass + v.fail}`).join(" "));
  if (Object.keys(r.byKnobsHash).length > 1) { L.push("by knobs:"); for (const [h, a] of Object.entries(r.byKnobsHash)) L.push(`  ${h}: ${a.rows} rows, cost/step ${f(a.costPerStep)}, ctx ×${(a.ctxBefore / Math.max(1, a.ctxAfter)).toFixed(2)}`); }
  L.push(`quality: ${r.quality.successes} success / ${r.quality.fails} fail / ${r.quality.unknown} unknown`);
  return L.join("\n");
}
