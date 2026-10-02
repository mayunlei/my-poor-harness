import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveState, LedgerTail } from "../src/dashboard/live.js";
import { startDashboard } from "../src/dashboard/server.js";
import type { LedgerRow } from "../src/core/ledger.js";

function row(o: Partial<LedgerRow>): LedgerRow {
  return { ts: new Date().toISOString(), source: "proxy", session: "s1", turn: 0, step: 1, ...o } as LedgerRow;
}

test("live state: per-session effect, baseline, multiplier, feed", () => {
  const st = new LiveState("/tmp/none.jsonl");
  // Two steps where the client wanted to send 100K but we sent 20K.
  for (let i = 1; i <= 2; i++) {
    st.ingest(row({ step: i, model: "m1", input: 20_000, cached: 18_000, uncached: 2_000, output: 100, ctx_before: 100_000, ctx_after: 20_000, event: "response" }));
  }
  st.ingest(row({ step: 3, event: "compact", ctx_before: 100_000, ctx_after: 20_000, note: "fold 12 outputs" }));
  st.ingest(row({ session: "s2", step: 1, model: "m2", input: 1_000, cached: 0, uncached: 1_000, output: 10, event: "response" }));

  const s = st.snapshot();
  assert.equal(s.totals.sessions, 2);
  assert.equal(s.totals.savedTokens, 240_000);                 // 3 rows × 80K
  assert.equal(s.totals.cached, 36_000);
  assert.ok(s.totals.multiplier > 1, "baseline must exceed what we paid");
  assert.ok(s.totals.baseline > s.totals.cost);
  // Sessions are ordered newest-first and carry their own series.
  const s1 = s.sessions.find((x) => x.session === "s1")!;
  assert.equal(s1.responses, 3);
  assert.equal(s1.series.length, 3);
  assert.equal(s1.events.compact, 1);
  assert.ok(s1.active, "a just-written session is active");
  // The feed shows the fold with its saving, newest first.
  assert.equal(s.feed[0].event, "compact");
  assert.equal(s.feed[0].saved, 80_000);
  assert.equal(s.byEvent.compact, 1);
});

test("live state: strategy rows aggregate separately, with pass rate from the rollup row", () => {
  const st = new LiveState("/tmp/none.jsonl");
  // plan_verify: a planner call, two worker calls, a verifier call, then its rollup
  st.ingest(row({ step: 1, input: 10_000, cached: 0, uncached: 10_000, output: 300, ctx_before: 10_000, ctx_after: 10_000, event: "response", extra: { strategy: "plan_verify", phase: "plan" } }));
  st.ingest(row({ step: 2, input: 3_000, cached: 1_000, uncached: 2_000, output: 100, ctx_before: 3_000, ctx_after: 3_000, event: "response", extra: { strategy: "plan_verify", phase: "step" } }));
  st.ingest(row({ step: 3, input: 3_000, cached: 1_000, uncached: 2_000, output: 100, ctx_before: 3_000, ctx_after: 3_000, event: "response", extra: { strategy: "plan_verify", phase: "step" } }));
  st.ingest(row({ step: 4, input: 2_000, cached: 0, uncached: 2_000, output: 80, event: "response", extra: { strategy: "plan_verify", phase: "verify" } }));
  // plus the phase marker rows the strategy writes so cost can be attributed
  st.ingest(row({ step: 1, event: "plan" as any, note: "2 steps: s1,s2", extra: { strategy: "plan_verify", phase: "plan" } }));
  st.ingest(row({ step: 4, event: "verify" as any, note: "s1: pass", task_outcome: "success", extra: { strategy: "plan_verify", phase: "verify" } }));
  st.ingest(row({ step: 4, event: "strategy" as any, task_outcome: "success", extra: { strategy: "plan_verify", phase: "strategy" } }));
  // react on another task, which failed
  st.ingest(row({ session: "s9", step: 1, input: 50_000, cached: 40_000, uncached: 10_000, output: 500, event: "response", extra: { strategy: "react" } }));
  st.ingest(row({ session: "s9", step: 2, event: "strategy" as any, task_outcome: "fail", extra: { strategy: "react" } }));

  const s = st.snapshot();
  assert.equal(s.byStrategy.length, 2);
  const pv = s.byStrategy.find((x) => x.strategy === "plan_verify")!;
  assert.equal(pv.responses, 4, "every agent the strategy ran is counted");
  assert.equal(pv.runs, 1);
  assert.equal(pv.passed, 1);
  assert.equal(pv.phases.step, 2, "both workers counted");
  assert.ok(pv.phases.plan >= 1 && pv.phases.verify >= 1 && pv.phases.strategy === 1, JSON.stringify(pv.phases));
  assert.ok(pv.costPerPass && pv.costPerPass > 0);
  const re = s.byStrategy.find((x) => x.strategy === "react")!;
  assert.equal(re.runs, 1);
  assert.equal(re.passed, 0);
  assert.equal(re.costPerPass, undefined, "no passes means no cost-per-pass, not a divide by zero");
  // the phase markers reach the feed, so planning and verification stream live
  assert.ok(s.feed.some((f) => f.event === "verify"), JSON.stringify(s.feed.map((f) => f.event)));
  assert.ok(s.feed.some((f) => f.event === "plan"));
  assert.ok(s.feed.some((f) => f.event === "strategy"));
});

test("live state: a row with no token numbers still registers the session and event", () => {
  const st = new LiveState("/tmp/none.jsonl");
  st.ingest(row({ event: "knob_change", note: "window 8 → 6" }));
  const s = st.snapshot();
  assert.equal(s.totals.sessions, 1);
  assert.equal(s.totals.responses, 0);
  assert.equal(s.totals.multiplier, 1);
  assert.equal(s.feed.length, 1);
});

test("ledger tail: reads only what was appended, tolerates half-written lines and truncation", () => {
  const dir = mkdtempSync(join(tmpdir(), "th-dash-"));
  const p = join(dir, "ledger.jsonl");
  writeFileSync(p, JSON.stringify(row({ step: 1 })) + "\n");
  const tail = new LedgerTail(p);
  assert.equal(tail.read().length, 1);
  assert.equal(tail.read().length, 0, "no new bytes → nothing");

  // A row still being written: half a line now, the rest later.
  const half = JSON.stringify(row({ step: 2 }));
  appendFileSync(p, half.slice(0, 20));
  assert.equal(tail.read().length, 0, "incomplete line is held back");
  appendFileSync(p, half.slice(20) + "\n");
  assert.equal(tail.read().length, 1, "completed line is delivered once");

  appendFileSync(p, "{not json}\n" + JSON.stringify(row({ step: 3 })) + "\n");
  assert.equal(tail.read().length, 1, "garbage line skipped, good row kept");

  writeFileSync(p, JSON.stringify(row({ step: 9 })) + "\n");   // rotated/truncated
  assert.equal(tail.read().length, 1, "re-reads from the start after truncation");
});

test("dashboard server: page, snapshot, SSE, health; picks up appended rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "th-dash-srv-"));
  const p = join(dir, "ledger.jsonl");
  writeFileSync(p, JSON.stringify(row({ input: 1000, cached: 0, uncached: 1000, output: 10, ctx_before: 5000, ctx_after: 1000, event: "response" })) + "\n");

  const dash = await startDashboard({ port: 0, ledger: p, pollMs: 50, throttleMs: 10, weeklyBudget: 1_000_000 });
  try {
    const page = await fetch(`${dash.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /token-harness live/);

    const snap = await (await fetch(`${dash.url}/api/snapshot`)).json() as any;
    assert.equal(snap.totals.savedTokens, 4000);
    assert.equal(snap.budget.weekly, 1_000_000);
    assert.equal(snap.budget.used, 1010);

    assert.equal((await (await fetch(`${dash.url}/healthz`)).json() as any).ok, true);
    assert.equal((await fetch(`${dash.url}/nope`)).status, 404);

    // SSE: first frame on connect, then a frame after a new row lands.
    const res = await fetch(`${dash.url}/api/stream`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const frame = async () => {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value, { stream: true });
        const m = /data: (.*)\n\n/.exec(buf);
        if (m) return JSON.parse(m[1]);
      }
    };
    assert.equal((await frame()).rows, 1);
    appendFileSync(p, JSON.stringify(row({ step: 2, input: 500, uncached: 500, ctx_before: 9000, ctx_after: 500, event: "dedupe" })) + "\n");
    const next = await frame();
    assert.equal(next.rows, 2);
    assert.equal(next.totals.savedTokens, 12_500);
    assert.equal(next.feed[0].event, "dedupe");
    await reader.cancel();
  } finally {
    await dash.close();
  }
});
