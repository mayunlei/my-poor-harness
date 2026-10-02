/**
 * Price fitting: what does a request actually cost on this subscription?
 *
 * `PRICE` in core/ledger.ts is a guess (0.1 / 1 / 8, the public pay-as-you-go shape). The only
 * real meter the Codex backend gives us is `x-codex-credits-balance`, which the proxy records
 * per response. Three measured properties of that meter decide the whole design here:
 *
 *   1. It is eventually consistent. Consecutive responses show a delta of 0 and then a lump, so
 *      a single row's `credits_spent` is noise (lag-0 correlation with cost-equivalent 0.61,
 *      lag-1 0.08). Only the sum across a run of responses is a measurement.
 *   2. `used_percent` is an integer and is shared with every other device on the account, so it
 *      cannot substitute (a tick-to-tick fit gives a negative R², and 15% of the ticks moved
 *      with no local traffic at all).
 *   3. Even aggregated, credits-per-token varied 9x inside one session for the same
 *      model/effort, because concurrent sessions draw on the same pool.
 *
 * So this fits BURSTS, not rows: a contiguous run of responses from one session and one
 * (model, effort) whose balance only goes down. Within a burst the delta b[0]-b[n-1] pairs with
 * the tokens of rows 1..n-1 — one response of lag, which is what the measurements support.
 *
 * And because (3) means passive data can be arbitrarily contaminated, this refuses to print a
 * price table rather than print a wrong one. Two quantities are estimated, with different odds:
 *   - one scalar, credits per unit of cost-equivalent, which is identifiable whenever a few
 *     clean bursts exist, and is the table's headline;
 *   - the three weights (credits per 1M cached / uncached / output), by non-negative least
 *     squares over the bursts — but only when the bursts actually differ in their token mix. In
 *     real agent traffic cached input is ~95% of every request, so the three columns are
 *     collinear and any split would be fiction; that case is refused, not reported. Measuring
 *     the weights properly is what src/upstream/price_probe.ts is for.
 */
import { Ledger, type LedgerRow, costEquiv } from "../core/ledger.js";
import { nnls3, type ProbeWeights } from "../upstream/price_probe.js";

export interface PriceBurst {
  model: string;
  effort: string;
  session: string;
  from: string;
  to: string;
  /** responses whose tokens are attributed to this burst (the run length minus the first row) */
  responses: number;
  creditsSpent: number;
  cached: number;
  uncached: number;
  output: number;
  costEquiv: number;
  /** credits per 1M units of cost-equivalent */
  rate: number;
}

export interface PriceGroup {
  model: string;
  effort: string;
  bursts: number;
  responses: number;
  creditsSpent: number;
  costEquiv: number;
  /** credits per 1M cost-equivalent, burst-weighted */
  creditsPer1M: number;
  /** credits per response, i.e. per typical agent step */
  creditsPerStep: number;
  /** max/min of the per-burst rate; 1 would be perfect agreement */
  spread: number;
  confidence: "none" | "low" | "medium";
  note: string;
  /** credits per 1M tokens of each class — only present when the bursts differ enough in mix */
  weights?: ProbeWeights;
  /** why the three weights are (not) there */
  weightsNote: string;
}

export interface PriceFit {
  /** false means: do not believe any number below, do the probe instead */
  usable: boolean;
  groups: PriceGroup[];
  bursts: PriceBurst[];
  /** why a price table cannot be trusted (or cannot be produced at all) */
  refusals: string[];
  /** what the user must do instead */
  advice: string[];
  diagnostics: {
    rows: number;
    responseRows: number;
    rowsWithCredits: number;
    rowsWithPercentOnly: number;
    runs: number;
    bursts: number;
    dropped: Record<string, number>;
    window: { from?: string; to?: string };
  };
}

export interface FitPriceOptions {
  /** seconds of silence that end a burst (default 120: beyond that the balance lag has settled elsewhere) */
  maxGapS?: number;
  /** bursts a (model, effort) needs before its rate is reported at all */
  minBursts?: number;
  /** per-burst rate spread above which the group is called low confidence */
  maxSpread?: number;
  since?: string;
}

const KEY = (r: LedgerRow) => `${r.model ?? "?"}\u0000${r.effort ?? "-"}`;

/**
 * Can these bursts separate the three weights at all? Only if their token mixes differ: if every
 * burst is 95% cached input (which is what real agent traffic looks like) the three columns are
 * collinear and the "solution" is whatever the noise picks. Requiring two of the three shares to
 * range by `minRange` across the bursts is a cheap, explainable identifiability test.
 */
function mixIdentifiable(bs: PriceBurst[], minRange = 0.1): { ok: boolean; ranges: [number, number, number] } {
  const shares = bs.map((b) => { const t = b.cached + b.uncached + b.output || 1; return [b.cached / t, b.uncached / t, b.output / t] as [number, number, number]; });
  const ranges = [0, 1, 2].map((j) => Math.max(...shares.map((s) => s[j])) - Math.min(...shares.map((s) => s[j]))) as [number, number, number];
  return { ok: bs.length >= 3 && ranges.filter((r) => r >= minRange).length >= 2, ranges };
}

function isResponse(r: LedgerRow): boolean {
  return (r.source === "proxy" || r.source === "harness") && r.input !== undefined;
}

/**
 * Cut the response rows into runs that the aggregate estimator can use, and record why each
 * rejected run was rejected — the diagnostics are the point, not a side note.
 */
function buildBursts(rows: LedgerRow[], opts: Required<Pick<FitPriceOptions, "maxGapS">>): { bursts: PriceBurst[]; runs: number; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {};
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1; };
  const metered = rows.filter((r) => typeof r.credits_balance === "number" && Number.isFinite(r.credits_balance));
  const runs: LedgerRow[][] = [];
  // a run is cut by a model/effort change, a balance that went UP (top-up or reset), or silence.
  // Deliberately NOT by a session change: interleaved sessions must land inside one run so the
  // concurrency check below can see them, instead of being quietly diced into short runs.
  for (const r of metered) {
    const cur = runs[runs.length - 1];
    const prev = cur?.[cur.length - 1];
    const gapS = prev ? (Date.parse(r.ts) - Date.parse(prev.ts)) / 1000 : 0;
    const breaks = !prev || KEY(r) !== KEY(prev) || r.credits_balance! > prev.credits_balance! || !(gapS >= 0 && gapS <= opts.maxGapS);
    if (breaks) runs.push([r]); else cur.push(r);
  }
  const bursts: PriceBurst[] = [];
  const pos = new Map<LedgerRow, number>(); rows.forEach((r, i) => pos.set(r, i));
  for (const run of runs) {
    if (run.length < 3) { drop("too_short"); continue; }
    const spent = run[0].credits_balance! - run[run.length - 1].credits_balance!;
    if (!(spent > 0)) { drop("balance_flat"); continue; }
    // a model switch just before the run leaks the previous model's lagged spend into delta[0]
    const i0 = pos.get(run[0])!, iN = pos.get(run[run.length - 1])!;
    const before = i0 > 0 ? rows[i0 - 1] : undefined;
    if (before && (Date.parse(run[0].ts) - Date.parse(before.ts)) / 1000 <= opts.maxGapS && KEY(before) !== KEY(run[0])) { drop("model_switch"); continue; }
    // any other session answering inside the window (metered or not) means the balance drop is not
    // ours alone. This catches overlapping local sessions; another DEVICE on the account leaves no
    // trace here at all, which is the whole reason price-probe exists.
    let foreign = false;
    for (let i = i0; i <= iN && !foreign; i++) foreign = rows[i].session !== run[0].session;
    if (foreign) { drop("concurrent_sessions"); continue; }
    const body = run.slice(1);
    const cached = body.reduce((a, r) => a + (r.cached ?? 0), 0);
    const uncached = body.reduce((a, r) => a + (r.uncached ?? 0), 0);
    const output = body.reduce((a, r) => a + (r.output ?? 0), 0);
    const ce = body.reduce((a, r) => a + (r.cost_equiv ?? costEquiv(r)), 0);
    if (!(ce > 0)) { drop("no_tokens"); continue; }
    bursts.push({
      model: run[0].model ?? "?", effort: run[0].effort ?? "-", session: run[0].session,
      from: run[0].ts, to: run[run.length - 1].ts, responses: body.length,
      creditsSpent: spent, cached, uncached, output, costEquiv: ce, rate: (spent * 1e6) / ce,
    });
  }
  return { bursts, runs: runs.length, dropped };
}

export function fitPrice(ledger: Ledger, opts: FitPriceOptions = {}): PriceFit {
  const maxGapS = opts.maxGapS ?? 120;
  const minBursts = opts.minBursts ?? 4;
  const maxSpread = opts.maxSpread ?? 3;
  let all = ledger.readAll();
  if (opts.since) all = all.filter((r) => r.ts >= opts.since!);
  const rows = all.filter(isResponse).sort((a, b) => a.ts.localeCompare(b.ts));
  const withCredits = rows.filter((r) => typeof r.credits_balance === "number");
  const percentOnly = rows.filter((r) => r.credits_balance === undefined && r.primary_used_percent !== undefined);
  const { bursts, runs, dropped } = buildBursts(rows, { maxGapS });

  const refusals: string[] = [];
  const advice: string[] = [];
  const groups: PriceGroup[] = [];

  for (const key of new Set(bursts.map((b) => `${b.model}\u0000${b.effort}`))) {
    const bs = bursts.filter((b) => `${b.model}\u0000${b.effort}` === key);
    const [model, effort] = key.split("\u0000");
    const spent = bs.reduce((a, b) => a + b.creditsSpent, 0);
    const ce = bs.reduce((a, b) => a + b.costEquiv, 0);
    const responses = bs.reduce((a, b) => a + b.responses, 0);
    const rates = bs.map((b) => b.rate).sort((x, y) => x - y);
    const spread = rates[0] > 0 ? rates[rates.length - 1] / rates[0] : Infinity;
    let confidence: PriceGroup["confidence"] = "medium";
    let note = `${bs.length} bursts agree within ×${spread.toFixed(1)}`;
    if (bs.length < minBursts) { confidence = "none"; note = `only ${bs.length} clean burst${bs.length === 1 ? "" : "s"}, need ${minBursts}`; }
    else if (!Number.isFinite(spread) || spread > maxSpread) { confidence = "low"; note = `per-burst rate spreads ×${spread.toFixed(1)} — a shared credit pool, not a price`; }
    // the three weights, when the bursts are varied enough in mix to pin them down
    const mix = mixIdentifiable(bs);
    let weights: ProbeWeights | undefined;
    let weightsNote = `token mix barely varies across bursts (share ranges ${mix.ranges.map((r) => r.toFixed(2)).join("/")}): cached / uncached / output are not separable from this data`;
    if (mix.ok && confidence !== "none") {
      const A = bs.map((b) => [b.cached / 1e6, b.uncached / 1e6, b.output / 1e6]);
      const c = bs.map((b) => b.creditsSpent);
      const { w, residual } = nnls3(A, c);
      const norm = Math.sqrt(c.reduce((a, v) => a + v * v, 0));
      const rel = norm > 0 ? residual / norm : 1;
      if (rel <= 0.25) { weights = { cached: w[0], uncached: w[1], output: w[2] }; weightsNote = `nnls over ${bs.length} bursts, residual ${(100 * rel).toFixed(0)}% of credits`; }
      else weightsNote = `nnls residual is ${(100 * rel).toFixed(0)}% of the credits spent: the bursts do not agree on any single set of weights`;
    }
    groups.push({
      model, effort, bursts: bs.length, responses, creditsSpent: spent, costEquiv: ce,
      creditsPer1M: (spent * 1e6) / ce, creditsPerStep: spent / responses, spread, confidence, note, weights, weightsNote,
    });
    if (confidence === "none") refusals.push(`${model} (effort ${effort}): ${note}`);
    else if (confidence === "low") refusals.push(`${model} (effort ${effort}): ${note}`);
  }
  groups.sort((a, b) => b.responses - a.responses || a.model.localeCompare(b.model));

  if (rows.length === 0) refusals.push("no response rows in the ledger");
  else if (withCredits.length === 0) {
    refusals.push(percentOnly.length
      ? `no credits headers on ${rows.length} responses: this account meters percent-only quota (x-codex-{primary,secondary}-used-percent). That percent is an integer shared with every other device on the account and cannot price a request — there is nothing here to fit.`
      : `no meter headers on ${rows.length} responses: the upstream is not Codex, or the proxy was not in the path. Only a Codex response carries x-codex-credits-balance.`);
  } else if (bursts.length === 0) {
    refusals.push(`${withCredits.length} metered responses but no usable burst (${Object.entries(dropped).map(([k, v]) => `${k}=${v}`).join(", ") || "none formed"})`);
  }
  if (dropped.concurrent_sessions) refusals.push(`${dropped.concurrent_sessions} burst(s) dropped for overlapping sessions: concurrent traffic shares the credit pool, so the balance drop is not ours alone`);
  if (dropped.model_switch) refusals.push(`${dropped.model_switch} burst(s) dropped for a model switch inside the balance lag window`);

  const usable = groups.some((g) => g.confidence === "medium");
  if (!usable) {
    advice.push("Passive ledger data cannot price this subscription. Measure it instead:");
    advice.push("  mph-sidecar price-probe --models gpt-5.6-sol --n 8 --settle 20        # plan only (default)");
    advice.push("  mph-sidecar price-probe --models gpt-5.6-sol --n 8 --settle 20 --go   # sends requests, spends credits");
    advice.push("The probe needs a QUIET account: stop every other Codex client first, or the measurement is someone else's traffic.");
  } else {
    advice.push("These are observational rates for one scalar (credits per unit of cost-equivalent), not the three weights.");
    advice.push("For the cached / uncached / output split run: mph-sidecar price-probe --models <model> --go");
  }

  return {
    usable, groups, bursts, refusals, advice,
    diagnostics: {
      rows: all.length, responseRows: rows.length, rowsWithCredits: withCredits.length, rowsWithPercentOnly: percentOnly.length,
      runs, bursts: bursts.length, dropped, window: { from: rows[0]?.ts, to: rows[rows.length - 1]?.ts },
    },
  };
}

const sig = (n: number, d = 4) => (Number.isFinite(n) ? Number(n.toPrecision(d)).toLocaleString("en-US", { maximumFractionDigits: 6 }) : "-");

export function formatPriceFit(f: PriceFit): string {
  const L: string[] = [];
  const d = f.diagnostics;
  L.push(`ledger: ${d.responseRows} responses (${d.rowsWithCredits} with a credits balance${d.rowsWithPercentOnly ? `, ${d.rowsWithPercentOnly} percent-only` : ""}), ${d.window.from ?? "-"} → ${d.window.to ?? "-"}`);
  L.push(`bursts: ${d.bursts} usable of ${d.runs} runs` + (Object.keys(d.dropped).length ? `  dropped: ${Object.entries(d.dropped).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""));
  if (f.groups.length) {
    const head = ["model", "effort", "bursts", "resp", "credits", "cr/1M cost-eq", "cr/step", "confidence"];
    const rowsOut = f.groups.map((g) => [g.model, g.effort, String(g.bursts), String(g.responses), sig(g.creditsSpent), sig(g.creditsPer1M), sig(g.creditsPerStep, 3), g.confidence]);
    const w = head.map((h, i) => Math.max(h.length, ...rowsOut.map((r) => r[i].length)));
    const line = (cells: string[]) => "  " + cells.map((c, i) => (i <= 1 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ");
    L.push(line(head));
    rowsOut.forEach((r, i) => {
      const g = f.groups[i];
      L.push(line(r));
      L.push(`      ↳ ${g.note}`);
      L.push(`      ↳ ${g.weights ? `credits/1M: cached ${sig(g.weights.cached)}, uncached ${sig(g.weights.uncached)}, output ${sig(g.weights.output)} (${g.weightsNote})` : g.weightsNote}`);
    });
  }
  if (f.refusals.length) { L.push("not trustworthy:"); for (const r of f.refusals) L.push(`  - ${r}`); }
  if (!f.usable) L.push("NO PRICE TABLE: refusing to emit one from this data.");
  for (const a of f.advice) L.push(a);
  return L.join("\n");
}
