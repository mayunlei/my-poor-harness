/**
 * price-probe: the controlled experiment that measures what a token actually costs on this
 * subscription, because passive observation provably cannot (see src/sidecar/price.ts).
 *
 * Why an experiment is required. Across 2,155 recorded sessions the credits meter turned out to
 * be (a) eventually consistent — per-response attribution correlates 0.61 at lag 0 and 0.08 at
 * lag 1, so a single response's balance drop is noise — and (b) shared: aggregate
 * credits-per-token varied 9x inside one session for the same model and effort, because other
 * sessions and other devices draw on the same pool. Neither problem is a fitting problem. Both
 * are fixed by controlling the account: send a known burst, wait for the meter to settle, and
 * make sure nothing else is spending while you do it.
 *
 * Protocol
 *   0. Preconditions. The meter must be readable and must carry credits. Then measure two
 *      consecutive idle windows of `--settle` seconds each. This serves two purposes at once:
 *      reading the meter is itself a request (the backend publishes it on response headers and
 *      nowhere else), so the idle windows calibrate what one meter poll costs; and because the
 *      two windows contain the same number of identical polls, they must come out the same.
 *      If they disagree, something else is spending — abort, the measurement would be theirs.
 *   1. Three shapes, designed so the 3x3 design matrix is well conditioned:
 *        cached   — a long fixed prefix (fixed prompt_cache_key) repeated, tiny new tail, tiny
 *                   output: calls 2..n are almost pure cached input.
 *        uncached — a long UNIQUE body and a unique cache key per call, tiny output: pure
 *                   uncached input.
 *        output   — a tiny input asking for a long fixed-length answer: almost pure output.
 *   2. Per model and shape: `--n` requests sent SEQUENTIALLY (concurrency is the thing that
 *      ruined the passive data), then poll the meter until the balance has not moved for
 *      `--settle` seconds. That wait is what defeats eventual consistency.
 *   3. Solve the 3x3 system for credits per 1M cached / uncached / output tokens with
 *      non-negative least squares, using the token counts the responses themselves reported
 *      (never our own estimates), and write the result with provenance to prices.json.
 *
 * This spends real quota, so it is dry-run by default and only sends anything with `--go`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessHome } from "../core/knobs.js";
import { upstreamFor, type Upstream } from "./index.js";
import { parseMeter, type MeterSnapshot } from "./meter.js";

/** credits per 1,000,000 tokens of each class */
export interface ProbeWeights { cached: number; uncached: number; output: number }

export interface ProbeShapeResult {
  shape: ShapeName;
  calls: number;
  /** token counts as the responses reported them */
  cached: number;
  uncached: number;
  output: number;
  /** credits the balance dropped for this phase, minus our own meter-poll overhead */
  creditsSpent: number;
  pollsCharged: number;
  settleS: number;
  /** seconds we waited for the balance to stop moving */
  waitedS: number;
}

export interface ProbeModelPrice extends ProbeWeights {
  effort: string;
  unit: "credits per 1M tokens";
  /** euclidean residual of the 3x3 solve, and the same relative to |credits| */
  residual: number;
  relativeResidual: number;
  /** weights normalised so uncached = 1, directly comparable with PRICE in core/ledger.ts */
  relative: ProbeWeights;
  shapes: ProbeShapeResult[];
  warnings: string[];
}

export interface PriceTable {
  version: 1;
  at: string;
  account?: string;
  plan?: string;
  activeLimit?: string;
  n: number;
  settleS: number;
  shapes: ShapeName[];
  models: Record<string, ProbeModelPrice>;
  probe: { pollCredits: number; idleWindows: number[]; overheadCredits: number; totalCredits: number };
}

export type ShapeName = "cached" | "uncached" | "output";
export const SHAPES: ShapeName[] = ["cached", "uncached", "output"];

/** prefix/body size and answer length of the three shapes, in tokens (approximate by design) */
export const SHAPE_SIZES = { prefixTokens: 8000, tailTokens: 24, tinyOutputTokens: 16, longOutputTokens: 1000 };

export function pricesPath(): string { return join(harnessHome(), "prices.json"); }

export function loadPrices(path = pricesPath()): PriceTable | undefined {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as PriceTable; } catch { return undefined; }
}

export function savePrices(t: PriceTable, path = pricesPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp"; writeFileSync(tmp, JSON.stringify(t, null, 2) + "\n"); renameSync(tmp, path);
}

// ---------------------------------------------------------------- linear algebra

/** Gaussian elimination with partial pivoting; undefined when singular. */
function solveLinear(M: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const a = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[p][col])) p = r;
    if (Math.abs(a[p][col]) < 1e-12) return undefined;
    [a[col], a[p]] = [a[p], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);   // Gauss-Jordan left row i with its pivot in column i
}

function residualOf(A: number[][], w: number[], c: number[]): number {
  let s = 0;
  for (let i = 0; i < c.length; i++) { const d = A[i].reduce((acc, v, j) => acc + v * w[j], 0) - c[i]; s += d * d; }
  return Math.sqrt(s);
}

/**
 * Non-negative least squares for exactly three unknowns, by exhaustive active sets: with 3
 * columns there are only 8 subsets, so the global optimum is cheap and exact. A plain solve is
 * what we want when it already comes out non-negative; the enumeration is what keeps a noisy
 * phase from producing a negative weight (which would be a measurement artefact, not a price).
 */
export function nnls3(A: number[][], c: number[]): { w: [number, number, number]; residual: number } {
  let best: { w: [number, number, number]; residual: number } = { w: [0, 0, 0], residual: residualOf(A, [0, 0, 0], c) };
  for (let mask = 1; mask < 8; mask++) {
    const cols = [0, 1, 2].filter((j) => mask & (1 << j));
    // normal equations on the selected columns
    const M = cols.map((j) => cols.map((k) => A.reduce((a, row) => a + row[j] * row[k], 0)));
    const rhs = cols.map((j) => A.reduce((a, row, i) => a + row[j] * c[i], 0));
    const sol = solveLinear(M, rhs);
    if (!sol || sol.some((v) => !Number.isFinite(v) || v < -1e-9)) continue;
    const w: [number, number, number] = [0, 0, 0];
    cols.forEach((j, i) => { w[j] = Math.max(0, sol[i]); });
    const res = residualOf(A, w, c);
    if (res < best.residual - 1e-12) best = { w, residual: res };
  }
  return best;
}

// ---------------------------------------------------------------- the shapes

const WORDS = "the quick brown fox jumps over a lazy dog while nine red ships carry salt past cold stone piers and every clerk writes down what the tide left behind on the long grey shore".split(" ");

/** deterministic filler of roughly `tokens` tokens; short words are about one token each */
export function filler(tokens: number, seed: number): string {
  let s = (seed * 2654435761) % 4294967291 || 1;
  const out: string[] = [];
  for (let i = 0; i < tokens; i++) { s = (s * 1103515245 + 12345) % 2147483648; out.push(WORDS[s % WORDS.length]); }
  return out.join(" ");
}

export interface ShapeRequest { body: any; /** what we expect, for the plan only */ est: { cached: number; uncached: number; output: number } }

/**
 * One request of a shape. `call` is 0-based: for the cached shape call 0 writes the prefix cache
 * and calls 1.. read it, which is exactly the separation the fit needs.
 */
export function shapeRequest(shape: ShapeName, model: string, effort: string, call: number, runId: string): ShapeRequest {
  const S = SHAPE_SIZES;
  const base: any = { model, store: false, stream: false, reasoning: { effort }, parallel_tool_calls: false };
  if (shape === "cached") {
    const prefix = filler(S.prefixTokens, 1);     // identical on every call, so it caches
    return {
      body: {
        ...base,
        instructions: "Answer with the single word OK and nothing else.",
        prompt_cache_key: `mph-price-probe-${runId}-cached-${model}`,
        max_output_tokens: S.tinyOutputTokens,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prefix + `\n\ncall ${call}: answer OK` }] }],
      },
      est: { cached: call === 0 ? 0 : S.prefixTokens, uncached: call === 0 ? S.prefixTokens + S.tailTokens : S.tailTokens, output: S.tinyOutputTokens },
    };
  }
  if (shape === "uncached") {
    return {
      body: {
        ...base,
        instructions: "Answer with the single word OK and nothing else.",
        prompt_cache_key: `mph-price-probe-${runId}-uncached-${model}-${call}`,   // unique: nothing may cache
        max_output_tokens: S.tinyOutputTokens,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: filler(S.prefixTokens, 1000 + call) + `\n\nanswer OK` }] }],
      },
      est: { cached: 0, uncached: S.prefixTokens + S.tailTokens, output: S.tinyOutputTokens },
    };
  }
  return {
    body: {
      ...base,
      instructions: "Follow the instruction exactly. Do not add commentary.",
      prompt_cache_key: `mph-price-probe-${runId}-output-${model}`,
      max_output_tokens: S.longOutputTokens,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Write the integers from 1 to ${S.longOutputTokens - 200}, one per line, nothing else.` }] }],
    },
    est: { cached: call === 0 ? 0 : 40, uncached: call === 0 ? 40 : 4, output: S.longOutputTokens },
  };
}

/** the smallest request that still returns meter headers: the only way to read the meter */
export function pollRequest(model: string, runId: string): any {
  return {
    model, store: false, stream: false, reasoning: { effort: "low" }, max_output_tokens: 16,
    instructions: "Answer with the single word OK and nothing else.",
    prompt_cache_key: `mph-price-probe-${runId}-poll`,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
  };
}

// ---------------------------------------------------------------- the plan (dry run)

export interface ProbeOptions {
  models: string[];
  n: number;
  settleS: number;
  effort: string;
  /** poll interval while waiting for the balance to settle */
  pollEveryS?: number;
  /** give up waiting for the meter after this long */
  maxWaitS?: number;
  go: boolean;
  upstream?: Upstream;
  log?: (line: string) => void;
  pricesFile?: string;
}

export interface ProbePlan {
  models: string[];
  n: number;
  settleS: number;
  effort: string;
  shapes: { shape: ShapeName; calls: number; cached: number; uncached: number; output: number }[];
  /** per model */
  requests: number;
  pollRequests: number;
  totalRequests: number;
  tokens: { cached: number; uncached: number; output: number };
  estCredits?: number;
  estCreditsSource: string;
  warnings: string[];
}

export function probePlan(opts: ProbeOptions): ProbePlan {
  const pollEveryS = opts.pollEveryS ?? 5;
  const shapes = SHAPES.map((shape) => {
    let cached = 0, uncached = 0, output = 0;
    for (let call = 0; call < opts.n; call++) { const e = shapeRequest(shape, opts.models[0] ?? "model", opts.effort, call, "plan").est; cached += e.cached; uncached += e.uncached; output += e.output; }
    return { shape, calls: opts.n, cached, uncached, output };
  });
  const perModelTokens = shapes.reduce((a, s) => ({ cached: a.cached + s.cached, uncached: a.uncached + s.uncached, output: a.output + s.output }), { cached: 0, uncached: 0, output: 0 });
  const models = opts.models.length;
  // two idle windows up front, then one settle window per model-shape phase
  const pollsPerWindow = Math.max(2, Math.ceil(opts.settleS / pollEveryS) + 1);
  const pollRequests = pollsPerWindow * (2 + models * SHAPES.length);
  const pollTokens = { cached: 0, uncached: 8 * pollRequests, output: 8 * pollRequests };
  const tokens = {
    cached: perModelTokens.cached * models + pollTokens.cached,
    uncached: perModelTokens.uncached * models + pollTokens.uncached,
    output: perModelTokens.output * models + pollTokens.output,
  };
  const prices = loadPrices(opts.pricesFile);
  const warnings: string[] = [];
  let estCredits: number | undefined;
  let estCreditsSource = "unknown: no prices.json yet, so the cost of this probe cannot be predicted — that is what the probe is for";
  const w = prices && opts.models.map((m) => prices.models[m]).find(Boolean);
  if (w) {
    estCredits = (tokens.cached * w.cached + tokens.uncached * w.uncached + tokens.output * w.output) / 1e6;
    estCreditsSource = `from ${opts.pricesFile ?? pricesPath()} measured ${prices!.at}`;
    if (opts.models.some((m) => !prices!.models[m])) warnings.push("prices.json does not cover every requested model; the estimate reuses another model's weights");
  }
  if (opts.n < 4) warnings.push(`--n ${opts.n} is small: the balance lag needs a burst to aggregate over, 8 or more is advisable`);
  if (opts.settleS < 10) warnings.push(`--settle ${opts.settleS}s is short: the credits balance lags by seconds to tens of seconds, and a short settle will under-report`);
  return { models: opts.models, n: opts.n, settleS: opts.settleS, effort: opts.effort, shapes, requests: opts.n * SHAPES.length * models, pollRequests, totalRequests: opts.n * SHAPES.length * models + pollRequests, tokens, estCredits, estCreditsSource, warnings };
}

export function formatPlan(p: ProbePlan): string {
  const f = (n: number) => Math.round(n).toLocaleString("en-US");
  const L: string[] = [];
  L.push(`price-probe plan (DRY RUN — nothing has been sent)`);
  L.push(`  models   ${p.models.join(", ") || "(none)"}    effort ${p.effort}    n ${p.n}    settle ${p.settleS}s`);
  for (const s of p.shapes) L.push(`  shape ${s.shape.padEnd(8)} ${s.calls} calls/model, per model ≈ cached ${f(s.cached)} / uncached ${f(s.uncached)} / output ${f(s.output)} tokens`);
  L.push(`  requests ${p.requests} measured + ${p.pollRequests} meter polls = ${p.totalRequests} total`);
  L.push(`  tokens   ≈ cached ${f(p.tokens.cached)}, uncached ${f(p.tokens.uncached)}, output ${f(p.tokens.output)} (estimates; the fit uses the counts the API reports)`);
  L.push(`  cost     ${p.estCredits !== undefined ? `≈ ${p.estCredits.toFixed(4)} credits (${p.estCreditsSource})` : p.estCreditsSource}`);
  for (const w of p.warnings) L.push(`  ! ${w}`);
  L.push(`  reading the meter is itself a request: the two idle windows measure what one poll costs and that overhead is subtracted.`);
  L.push(`  run it on a QUIET account — no other Codex client, no other device — or the probe aborts.`);
  L.push(`  to actually spend credits: add --go`);
  return L.join("\n");
}

// ---------------------------------------------------------------- the experiment

export interface ProbeResult {
  plan: ProbePlan;
  ok: boolean;
  /** why we stopped, when !ok */
  reason?: string;
  table?: PriceTable;
  savedTo?: string;
  log: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Sent { meter?: MeterSnapshot; cached: number; uncached: number; output: number }

/** one request through the existing upstream client; returns the meter and the reported usage */
async function send(up: Upstream, body: any, sessionId: string): Promise<Sent> {
  const res = await up.responses(body, { stream: false, sessionId });
  const meter = parseMeter(res.headers);
  let usage: any;
  try { usage = (await res.json() as any)?.usage; } catch { usage = undefined; }
  if (!res.ok) throw new Error(`upstream ${res.status} during the probe`);
  const input = usage?.input_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  return { meter, cached, uncached: Math.max(0, input - cached), output: usage?.output_tokens ?? 0 };
}

/**
 * Run the probe. Returns a plan without sending anything unless `opts.go`.
 * Never silently degrades: every precondition that fails ends the run with a reason.
 */
export async function priceProbe(opts: ProbeOptions): Promise<ProbeResult> {
  const plan = probePlan(opts);
  const log: string[] = [];
  const say = (s: string) => { log.push(s); opts.log?.(s); };
  if (!opts.go) return { plan, ok: true, log };
  if (!opts.models.length) return { plan, ok: false, reason: "no models given (--models a,b)", log };

  const up = opts.upstream ?? upstreamFor({});
  const account = await up.codex?.auth.get().then((c) => c.accountId).catch(() => undefined);
  const runId = Math.random().toString(36).slice(2, 8);
  const pollEveryS = opts.pollEveryS ?? 5;
  const maxWaitS = opts.maxWaitS ?? 300;
  const probeModel = opts.models[0];
  let polls = 0;
  const poll = async (): Promise<MeterSnapshot> => {
    polls++;
    const s = await send(up, pollRequest(probeModel, runId), `mph-price-probe-${runId}-poll`);
    if (!s.meter) throw new Error("the upstream returned no x-codex meter headers: this provider does not publish a quota meter, so there is nothing to measure");
    return s.meter;
  };

  // 0. preconditions
  let first: MeterSnapshot;
  try { first = await poll(); } catch (e: any) { return { plan, ok: false, reason: String(e?.message ?? e), log }; }
  if (!first.credits) return { plan, ok: false, reason: `the meter is readable (plan ${first.planType ?? "?"}, limit ${first.activeLimit ?? "?"}) but carries no x-codex-credits-balance: this account meters percent-only quota, which is an integer and cannot price a request. There is nothing this probe can measure here.`, log };
  say(`meter ok: plan=${first.planType ?? "?"} limit=${first.activeLimit ?? "?"} credits=${first.credits.balance}${first.credits.unlimited ? " (unlimited)" : ""}`);
  if (first.credits.unlimited) return { plan, ok: false, reason: "x-codex-credits-unlimited is set: the balance will not move, so credits cannot be used as a meter on this account", log };

  /** poll for `seconds`, return the drop over the window and the polls it took */
  const idleWindow = async (seconds: number): Promise<{ drop: number; polls: number; from: number; to: number }> => {
    const t0 = Date.now(); const start = await poll(); let last = start; let used = 1;
    while ((Date.now() - t0) / 1000 < seconds) { await sleep(pollEveryS * 1000); last = await poll(); used++; }
    return { drop: Math.max(0, (start.credits?.balance ?? 0) - (last.credits?.balance ?? 0)), polls: used, from: start.credits?.balance ?? 0, to: last.credits?.balance ?? 0 };
  };

  let a: { drop: number; polls: number; from: number; to: number }, b: typeof a;
  try { a = await idleWindow(opts.settleS); b = await idleWindow(opts.settleS); }
  catch (e: any) { return { plan, ok: false, reason: String(e?.message ?? e), log }; }
  say(`idle windows: ${a.drop.toFixed(6)} and ${b.drop.toFixed(6)} credits over ${a.polls} and ${b.polls} polls`);
  // the two windows contain the same identical polls, so they must agree; if they do not, someone else is spending
  const hi = Math.max(a.drop, b.drop), lo = Math.min(a.drop, b.drop);
  if (hi > 0 && hi - lo > 0.5 * hi + 1e-9) {
    return { plan, ok: false, reason: `the account is not quiet: two identical idle windows spent ${a.drop.toFixed(6)} and ${b.drop.toFixed(6)} credits. Something else on this account is spending (another device, another session, a background client). Stop it and retry — otherwise the probe would attribute their traffic to our shapes.`, log };
  }
  const pollCredits = (a.drop + b.drop) / Math.max(1, a.polls - 1 + b.polls - 1);
  say(`one meter poll costs ${pollCredits.toFixed(8)} credits; that overhead is subtracted from every phase`);

  // 1-2. the shapes
  let cursor = b.to;
  const models: Record<string, ProbeModelPrice> = {};
  let totalCredits = 0, overheadCredits = 0;
  for (const model of opts.models) {
    const results: ProbeShapeResult[] = [];
    const warnings: string[] = [];
    for (const shape of SHAPES) {
      let cached = 0, uncached = 0, output = 0;
      try {
        for (let call = 0; call < opts.n; call++) {
          const s = await send(up, shapeRequest(shape, model, opts.effort, call, runId).body, `mph-price-probe-${runId}-${shape}-${model}`);
          cached += s.cached; uncached += s.uncached; output += s.output;
        }
      } catch (e: any) { return { plan, ok: false, reason: `${model}/${shape}: ${e?.message ?? e}`, log }; }
      // 2. wait for the balance to stop moving for a full settle window
      const t0 = Date.now(); let phasePolls = 0; let lastChange = Date.now(); let bal = cursor;
      try {
        for (;;) {
          const m = await poll(); phasePolls++;
          const v = m.credits?.balance ?? bal;
          // the polls themselves keep spending, so "stopped moving" means "moving no faster than one poll"
          if (Math.abs(v - bal) > pollCredits * 1.5 + 1e-9) { bal = v; lastChange = Date.now(); }
          else bal = Math.min(bal, v);
          if ((Date.now() - lastChange) / 1000 >= opts.settleS) break;
          if ((Date.now() - t0) / 1000 >= maxWaitS) { warnings.push(`${shape}: balance still moving after ${maxWaitS}s, measurement truncated`); break; }
          await sleep(pollEveryS * 1000);
        }
      } catch (e: any) { return { plan, ok: false, reason: `${model}/${shape} while settling: ${e?.message ?? e}`, log }; }
      const gross = Math.max(0, cursor - bal);
      const overhead = pollCredits * phasePolls;
      const net = Math.max(0, gross - overhead);
      totalCredits += gross; overheadCredits += overhead;
      results.push({ shape, calls: opts.n, cached, uncached, output, creditsSpent: net, pollsCharged: phasePolls, settleS: opts.settleS, waitedS: Math.round((Date.now() - t0) / 1000) });
      say(`${model} ${shape.padEnd(8)} tokens cached=${cached} uncached=${uncached} output=${output}  credits ${net.toFixed(6)} (gross ${gross.toFixed(6)}, poll overhead ${overhead.toFixed(6)}, waited ${Math.round((Date.now() - t0) / 1000)}s)`);
      cursor = bal;
    }
    // 3. solve the 3x3
    const A = results.map((r) => [r.cached / 1e6, r.uncached / 1e6, r.output / 1e6]);
    const c = results.map((r) => r.creditsSpent);
    const { w, residual } = nnls3(A, c);
    const norm = Math.sqrt(c.reduce((s, v) => s + v * v, 0));
    if (w.every((v) => v === 0)) warnings.push("every weight solved to zero: the balance did not move measurably, so either credits are not charged for these requests or the burst was too small");
    if (norm > 0 && residual / norm > 0.25) warnings.push(`residual is ${(100 * residual / norm).toFixed(0)}% of the measured credits: the three shapes did not separate cleanly, treat the split as indicative only`);
    const rel: ProbeWeights = w[1] > 0 ? { cached: w[0] / w[1], uncached: 1, output: w[2] / w[1] } : { cached: 0, uncached: 0, output: 0 };
    models[model] = { cached: w[0], uncached: w[1], output: w[2], effort: opts.effort, unit: "credits per 1M tokens", residual, relativeResidual: norm > 0 ? residual / norm : 0, relative: rel, shapes: results, warnings };
  }

  const table: PriceTable = {
    version: 1, at: new Date().toISOString(), account, plan: first.planType, activeLimit: first.activeLimit,
    n: opts.n, settleS: opts.settleS, shapes: SHAPES, models,
    probe: { pollCredits, idleWindows: [a.drop, b.drop], overheadCredits, totalCredits },
  };
  const path = opts.pricesFile ?? pricesPath();
  savePrices(table, path);
  return { plan, ok: true, table, savedTo: path, log };
}

export function formatProbeResult(r: ProbeResult): string {
  if (!r.ok) return `price-probe aborted: ${r.reason}`;
  if (!r.table) return formatPlan(r.plan);
  const t = r.table;
  const L: string[] = [];
  L.push(`price-probe measured ${t.at} (plan ${t.plan ?? "?"}, limit ${t.activeLimit ?? "?"}, n=${t.n}, settle=${t.settleS}s)`);
  L.push(`  spent ${t.probe.totalCredits.toFixed(6)} credits, of which ${t.probe.overheadCredits.toFixed(6)} was meter polling`);
  const head = ["model", "effort", "cached/1M", "uncached/1M", "output/1M", "rel cached", "rel output", "resid"];
  const rows = Object.entries(t.models).map(([m, p]) => [m, p.effort, p.cached.toFixed(4), p.uncached.toFixed(4), p.output.toFixed(4), p.relative.cached.toFixed(3), p.relative.output.toFixed(3), `${(100 * p.relativeResidual).toFixed(0)}%`]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r2) => r2[i].length)));
  const line = (cells: string[]) => "  " + cells.map((c, i) => (i <= 1 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ");
  L.push(line(head));
  for (const row of rows) L.push(line(row));
  L.push(`  relative weights are normalised to uncached = 1, so compare them with PRICE = 0.1 / 1 / 8 in core/ledger.ts`);
  for (const [m, p] of Object.entries(t.models)) for (const wn of p.warnings) L.push(`  ! ${m}: ${wn}`);
  L.push(`  written to ${r.savedTo}`);
  return L.join("\n");
}
