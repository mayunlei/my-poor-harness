/**
 * mph-dash — live dashboard over the ledger.
 *
 *   mph-dash                       # serve on 127.0.0.1:8792
 *   mph-dash --port 9000 --open    # pick a port, open the browser
 *   mph-dash --weekly-budget 50M   # draw the weekly quota gauge
 *   mph-dash --once                # print one JSON snapshot and exit (for scripts/CI)
 */
import { spawn } from "node:child_process";
import { mphEnv } from "../core/env.js";
import { startDashboard } from "./server.js";
import { defaultLedgerPath } from "./live.js";

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has = (n: string) => args.includes(n);

if (has("--help") || has("-h")) {
  console.log(`mph-dash [--port 8792] [--host 127.0.0.1] [--ledger PATH] [--weekly-budget N|50M] [--poll-ms 1000] [--open] [--once] [--quiet]

Live view of what the harness is saving: quota stretch, tokens not sent, cache
hit rate, per-session context curves and a feed of every fold as it happens.
Read-only; safe to run next to the proxy, the harness and the sidecar.`);
  process.exit(0);
}

/** Accepts 50000000, 50M, 1.5B. */
function budget(v?: string): number {
  if (!v) return Number(mphEnv("WEEKLY_BUDGET") ?? 0) || 0;
  const m = /^([\d.]+)\s*([kmbKMB])?$/.exec(v.trim());
  if (!m) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

const dash = await startDashboard({
  port: Number(opt("--port", "8792")),
  host: opt("--host", "127.0.0.1"),
  ledger: opt("--ledger"),
  pollMs: Number(opt("--poll-ms", "1000")),
  weeklyBudget: budget(opt("--weekly-budget")),
  verbose: !has("--quiet"),
});

if (has("--once")) {
  console.log(JSON.stringify(dash.snapshot(), null, 2));
  await dash.close();
  process.exit(0);
}

if (!has("--quiet")) {
  const s = dash.snapshot();
  console.log(`my-poor-harness dashboard  ${dash.url}`);
  console.log(`ledger: ${opt("--ledger") ?? defaultLedgerPath()}  (${s.rows} rows, ${s.totals.sessions} sessions)`);
  console.log(`quota stretch so far: x${s.totals.multiplier.toFixed(2)}  ·  ${Math.round(s.totals.savedTokens).toLocaleString("en-US")} tokens not sent`);
  console.log(`Ctrl-C to stop.`);
}

if (has("--open")) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [dash.url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { void dash.close().then(() => process.exit(0)); });
}
