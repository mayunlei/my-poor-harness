/**
 * Price metering: the aggregate burst estimator over a synthetic ledger whose weights we know,
 * every refusal path it must take instead of guessing, and the price-probe dry run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "th-price-"));
process.env.TOKEN_HARNESS_HOME = HOME;
delete process.env.TH_OPENAI_BASE_URL; delete process.env.OPENAI_BASE_URL; delete process.env.TH_PROVIDER;

const { Ledger, costEquiv } = await import("../src/core/ledger.js");
const { fitPrice, formatPriceFit } = await import("../src/sidecar/price.js");
const { priceProbe, probePlan, formatPlan, nnls3, loadPrices, SHAPES } = await import("../src/upstream/price_probe.js");
const { upstreamFor } = await import("../src/upstream/index.js");

/** the weights we plant, in credits per 1M tokens; the fit has to find these and nothing else */
const W = { cached: 0.5, uncached: 12, output: 96 };
const cost = (t: { cached: number; uncached: number; output: number }) => (t.cached * W.cached + t.uncached * W.uncached + t.output * W.output) / 1e6;

function listen(handler: (req: any, res: any, body: string) => void): Promise<{ url: string; count: () => number; close: () => Promise<void>; server: Server }> {
  let n = 0;
  const server = createServer((req, res) => { n++; const ch: Buffer[] = []; req.on("data", (c) => ch.push(c)); req.on("end", () => handler(req, res, Buffer.concat(ch).toString())); });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, count: () => n, server, close: () => new Promise((d) => { server.closeAllConnections(); server.close(() => d()); }) })));
}

/**
 * Write a ledger of bursts. Each burst is one session's contiguous run; the balance recorded on
 * a row is the balance AFTER that response, so the drop from row 0 to row n-1 is exactly the
 * cost of rows 1..n-1 — the one-response lag the real meter shows.
 */
function writeLedger(path: string, bursts: { mix: { cached: number; uncached: number; output: number }; rows: number }[], opts: { credits?: boolean; model?: string; session?: (i: number) => string; startMs?: number; gapMinutes?: number } = {}): void {
  const lines: string[] = [];
  let balance = 50000;
  let t = opts.startMs ?? Date.parse("2026-09-01T00:00:00Z");
  bursts.forEach((b, i) => {
    for (let k = 0; k < b.rows; k++) {
      const row: any = {
        ts: new Date(t).toISOString(), source: "proxy", session: (opts.session ?? ((j: number) => `s${j}`))(i), turn: 0, step: k + 1,
        model: opts.model ?? "m1", effort: "medium", event: "response",
        input: b.mix.cached + b.mix.uncached, cached: b.mix.cached, uncached: b.mix.uncached, output: b.mix.output,
        cost_equiv: costEquiv(b.mix), primary_used_percent: 40 + i,
      };
      if (k > 0) balance -= cost(b.mix);           // row 0's own cost landed before we started watching
      if (opts.credits !== false) row.credits_balance = balance;
      lines.push(JSON.stringify(row));
      t += 20_000;
    }
    t += (opts.gapMinutes ?? 30) * 60_000;         // well past maxGapS, so the next run is a new burst
  });
  writeFileSync(path, lines.join("\n") + "\n");
}

/** five bursts with deliberately different token mixes: that variation is what identifies the weights */
const MIXES = [
  { cached: 50000, uncached: 500, output: 100 },
  { cached: 1000, uncached: 40000, output: 100 },
  { cached: 1000, uncached: 500, output: 20000 },
  { cached: 20000, uncached: 20000, output: 5000 },
  { cached: 30000, uncached: 5000, output: 10000 },
];

test("fitPrice recovers planted weights from clean bursts of varied token mix", () => {
  const path = join(HOME, "planted.jsonl");
  writeLedger(path, MIXES.map((mix) => ({ mix, rows: 4 })));
  const f = fitPrice(new Ledger(path), { maxSpread: 100 });
  assert.equal(f.diagnostics.bursts, 5, "five clean bursts");
  assert.deepEqual(f.diagnostics.dropped, {});
  assert.equal(f.groups.length, 1);
  const g = f.groups[0];
  assert.equal(g.model, "m1"); assert.equal(g.effort, "medium");
  assert.equal(g.responses, 15, "the first row of each burst only supplies the starting balance");
  assert.ok(g.confidence !== "none", g.note);
  assert.ok(g.weights, g.weightsNote);
  for (const k of ["cached", "uncached", "output"] as const) {
    const rel = Math.abs(g.weights![k] - W[k]) / W[k];
    assert.ok(rel < 0.02, `${k}: fitted ${g.weights![k]} vs planted ${W[k]}`);
  }
  // the scalar rate has to be consistent with the same planted weights
  const expectedSpent = MIXES.reduce((a, m) => a + 3 * cost(m), 0);
  assert.ok(Math.abs(g.creditsSpent - expectedSpent) / expectedSpent < 1e-9);
  assert.ok(Math.abs(g.creditsPerStep - expectedSpent / 15) / (expectedSpent / 15) < 1e-9);
  assert.ok(formatPriceFit(f).includes("cr/1M cost-eq"));
  assert.ok(f.usable || g.confidence === "low");
});

test("fitPrice refuses: no credits headers, overlapping sessions, a single burst", () => {
  // (a) percent-only account: the only meter is an integer shared across devices
  const noCredits = join(HOME, "no-credits.jsonl");
  writeLedger(noCredits, MIXES.map((mix) => ({ mix, rows: 4 })), { credits: false });
  const a = fitPrice(new Ledger(noCredits));
  assert.equal(a.usable, false);
  assert.equal(a.groups.length, 0);
  assert.equal(a.diagnostics.rowsWithCredits, 0);
  assert.equal(a.diagnostics.rowsWithPercentOnly, 20);
  assert.ok(a.refusals.some((r) => /percent-only/.test(r)), a.refusals.join(" | "));
  assert.ok(a.advice.some((l) => l.includes("price-probe")));
  assert.ok(formatPriceFit(a).includes("NO PRICE TABLE"));

  // (b) concurrency: a second session answering inside the window shares the credit pool
  const conc = join(HOME, "concurrent.jsonl");
  const lines: string[] = [];
  let bal = 50000; let t = Date.parse("2026-09-01T00:00:00Z");
  for (let k = 0; k < 12; k++) {
    const mix = MIXES[k % MIXES.length];
    bal -= cost(mix);
    lines.push(JSON.stringify({ ts: new Date(t).toISOString(), source: "proxy", session: k % 2 ? "sA" : "sB", turn: 0, step: k, model: "m1", effort: "medium", input: mix.cached + mix.uncached, ...mix, cost_equiv: costEquiv(mix), credits_balance: bal }));
    t += 15_000;
  }
  writeFileSync(conc, lines.join("\n") + "\n");
  const b = fitPrice(new Ledger(conc));
  assert.equal(b.usable, false);
  assert.ok((b.diagnostics.dropped.concurrent_sessions ?? 0) > 0, JSON.stringify(b.diagnostics.dropped));
  assert.ok(b.refusals.some((r) => /overlapping sessions/.test(r)), b.refusals.join(" | "));

  // (c) one clean burst is not a measurement
  const one = join(HOME, "one-burst.jsonl");
  writeLedger(one, [{ mix: MIXES[0], rows: 6 }]);
  const c = fitPrice(new Ledger(one));
  assert.equal(c.usable, false);
  assert.equal(c.diagnostics.bursts, 1);
  assert.equal(c.groups[0].confidence, "none");
  assert.equal(c.groups[0].weights, undefined, "no weights from a single burst");
  assert.ok(c.refusals.some((r) => /only 1 clean burst/.test(r)), c.refusals.join(" | "));

  // (d) a model switch inside the balance lag window contaminates the next burst
  const sw = join(HOME, "switch.jsonl");
  const rows: any[] = [];
  let bb = 50000; let tt = Date.parse("2026-09-02T00:00:00Z");
  for (const model of ["m1", "m2"]) for (let k = 0; k < 4; k++) {
    const mix = MIXES[1]; if (k > 0) bb -= cost(mix);
    rows.push({ ts: new Date(tt).toISOString(), source: "proxy", session: "sX", turn: 0, step: k, model, effort: "medium", input: mix.cached + mix.uncached, ...mix, cost_equiv: costEquiv(mix), credits_balance: bb });
    tt += 20_000;
  }
  writeFileSync(sw, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const d = fitPrice(new Ledger(sw));
  assert.equal(d.diagnostics.dropped.model_switch, 1, JSON.stringify(d.diagnostics.dropped));
  assert.ok(d.refusals.some((r) => /model switch/.test(r)));

  // (e) real agent traffic: every burst ~95% cached, so the three weights are not separable
  const flat = join(HOME, "flat-mix.jsonl");
  writeLedger(flat, [0, 1, 2, 3, 4].map((i) => ({ mix: { cached: 95000 + i * 100, uncached: 5000, output: 500 }, rows: 4 })));
  const e = fitPrice(new Ledger(flat), { maxSpread: 100 });
  assert.equal(e.groups[0].weights, undefined);
  assert.ok(/not separable/.test(e.groups[0].weightsNote), e.groups[0].weightsNote);
  assert.ok(e.groups[0].creditsPer1M > 0, "the scalar rate is still identifiable");
});

test("nnls3 solves the well-conditioned system and clamps instead of going negative", () => {
  const A = [[7, 0.01, 0.0001], [0, 0.08, 0.0001], [0.007, 0.001, 0.008]];
  const c = A.map((r) => r[0] * 0.5 + r[1] * 12 + r[2] * 96);
  const { w, residual } = nnls3(A, c);
  assert.ok(residual < 1e-9);
  assert.ok(Math.abs(w[0] - 0.5) < 1e-6 && Math.abs(w[1] - 12) < 1e-6 && Math.abs(w[2] - 96) < 1e-6);
  // a target that only an unphysical negative weight could reach is clamped, not reported negative
  const neg = nnls3([[1, 1, 0], [1, 2, 0], [1, 3, 0]], [10, 5, 0]);
  assert.ok(neg.w.every((v) => v >= 0), JSON.stringify(neg.w));
});

test("price-probe --dry-run prints the plan and sends zero requests", async () => {
  const mock = await listen((_req, res) => { res.writeHead(500).end("the dry run must never reach me"); });
  const up = upstreamFor({ baseUrl: mock.url + "/v1" });
  const r = await priceProbe({ models: ["gpt-5.6-sol", "gpt-5.5"], n: 8, settleS: 20, effort: "medium", go: false, upstream: up });
  assert.equal(mock.count(), 0, "a dry run sends nothing");
  assert.equal(r.ok, true); assert.equal(r.table, undefined); assert.equal(r.savedTo, undefined);
  assert.equal(r.plan.requests, 48, "3 shapes × 8 calls × 2 models");
  assert.deepEqual(r.plan.shapes.map((s) => s.shape), SHAPES);
  assert.ok(r.plan.pollRequests > 0, "the meter can only be read by sending something, and the plan says so");
  assert.ok(r.plan.shapes[0].cached > r.plan.shapes[0].uncached, "the cached shape is mostly cache hits");
  assert.equal(r.plan.shapes[1].cached, 0, "the uncached shape must never cache");
  assert.ok(r.plan.shapes[2].output > r.plan.shapes[0].output * 10, "the output shape is mostly output");
  assert.equal(r.plan.estCredits, undefined);
  assert.match(r.plan.estCreditsSource, /unknown/);
  const text = formatPlan(r.plan);
  for (const frag of ["DRY RUN", "gpt-5.6-sol", "shape cached", "shape uncached", "shape output", "--go", "QUIET account"]) assert.ok(text.includes(frag), frag);
  assert.ok(!existsSync(join(HOME, "prices.json")), "a dry run writes no prices.json");
  // warnings call out settings that would under-measure
  assert.ok(probePlan({ models: ["m"], n: 2, settleS: 3, effort: "low", go: false }).warnings.length >= 2);
  assert.equal(mock.count(), 0);
  await mock.close();
});

test("price-probe --go measures the planted weights against a mock upstream and records provenance", async () => {
  let balance = 100000;
  const seen = new Map<string, number>();
  const mock = await listen((_req, res, raw) => {
    const body = JSON.parse(raw || "{}");
    const text = (body.instructions ?? "") + (body.input ?? []).map((i: any) => (i.content ?? []).map((c: any) => c.text ?? "").join("")).join("");
    const input = Math.ceil(text.length / 4);
    const prev = seen.get(body.prompt_cache_key);
    const cached = prev ? Math.max(0, Math.min(prev, input) - 8) : 0;      // fixed prefix hits, the changed tail does not
    seen.set(body.prompt_cache_key, input);
    const output = body.max_output_tokens ?? 16;
    balance -= cost({ cached, uncached: input - cached, output });
    res.writeHead(200, {
      "content-type": "application/json",
      "x-codex-plan-type": "pro", "x-codex-active-limit": "premium", "x-codex-primary-used-percent": "41",
      "x-codex-credits-balance": balance.toFixed(10), "x-codex-credits-has-credits": "True", "x-codex-credits-unlimited": "False",
    });
    res.end(JSON.stringify({ id: "resp_1", output: [], usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: output } }));
  });
  const pricesFile = join(HOME, "prices-measured.json");
  // settle 0 keeps the test fast: the settle loop still runs, it just needs one poll to call it flat
  const r = await priceProbe({ models: ["m1"], n: 8, settleS: 0, pollEveryS: 0, effort: "medium", go: true, upstream: upstreamFor({ baseUrl: mock.url + "/v1" }), pricesFile });
  assert.equal(r.ok, true, r.reason);
  const p = r.table!.models.m1;
  for (const k of ["cached", "uncached", "output"] as const) {
    const rel = Math.abs(p[k] - W[k]) / W[k];
    assert.ok(rel < 0.15, `${k}: measured ${p[k]} vs planted ${W[k]} (${(100 * rel).toFixed(1)}%)`);
  }
  assert.ok(Math.abs(p.relative.output - W.output / W.uncached) < 1.5, JSON.stringify(p.relative));
  assert.equal(p.effort, "medium"); assert.equal(p.unit, "credits per 1M tokens");
  assert.equal(p.shapes.length, 3);
  assert.ok(p.shapes.every((s) => s.calls === 8 && s.creditsSpent > 0));
  assert.ok(p.shapes[1].cached === 0, "the uncached shape never hit the cache");
  // provenance
  assert.equal(r.table!.plan, "pro"); assert.equal(r.table!.activeLimit, "premium");
  assert.equal(r.table!.n, 8); assert.equal(r.table!.settleS, 0);
  assert.equal(r.savedTo, pricesFile);
  assert.equal(loadPrices(pricesFile)!.models.m1.output.toFixed(4), p.output.toFixed(4));
  assert.ok(r.table!.probe.totalCredits > 0);
  // with a prices.json in hand the next dry run can quote the probe's own cost
  const next = probePlan({ models: ["m1"], n: 8, settleS: 20, effort: "medium", go: false, pricesFile });
  assert.ok(next.estCredits! > 0); assert.match(next.estCreditsSource, /measured/);
  await mock.close();
});

test("price-probe aborts on an account it cannot measure", async () => {
  // no meter headers at all: there is nothing to measure, and we must say so rather than invent a price
  const bare = await listen((_req, res) => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ output: [], usage: { input_tokens: 1, output_tokens: 1 } })); });
  const a = await priceProbe({ models: ["m1"], n: 1, settleS: 0, pollEveryS: 0, effort: "low", go: true, upstream: upstreamFor({ baseUrl: bare.url + "/v1" }), pricesFile: join(HOME, "never.json") });
  assert.equal(a.ok, false);
  assert.match(a.reason!, /no x-codex meter headers/);
  await bare.close();

  // percent-only quota: readable meter, no credits
  const pct = await listen((_req, res) => { res.writeHead(200, { "content-type": "application/json", "x-codex-plan-type": "plus", "x-codex-primary-used-percent": "55" }).end(JSON.stringify({ output: [], usage: {} })); });
  const b = await priceProbe({ models: ["m1"], n: 1, settleS: 0, pollEveryS: 0, effort: "low", go: true, upstream: upstreamFor({ baseUrl: pct.url + "/v1" }), pricesFile: join(HOME, "never.json") });
  assert.equal(b.ok, false);
  assert.match(b.reason!, /percent-only quota/);
  await pct.close();

  // a busy account: the polls are identical, so two idle windows must agree; here spend accelerates
  // (someone else is working), which is exactly the condition that invalidates the measurement
  let bal = 1e9; let n = 0;
  const busy = await listen((_req, res) => { bal -= 2 ** ++n; res.writeHead(200, { "content-type": "application/json", "x-codex-credits-balance": bal.toFixed(6), "x-codex-credits-has-credits": "True", "x-codex-credits-unlimited": "False" }).end(JSON.stringify({ output: [], usage: {} })); });
  const c = await priceProbe({ models: ["m1"], n: 1, settleS: 0.3, pollEveryS: 0.1, maxWaitS: 1, effort: "low", go: true, upstream: upstreamFor({ baseUrl: busy.url + "/v1" }), pricesFile: join(HOME, "never.json") });
  assert.equal(c.ok, false);
  assert.match(c.reason!, /not quiet/);
  assert.ok(!existsSync(join(HOME, "never.json")));
  await busy.close();
});
