/**
 * `mph dash` — live dashboard over the ledger. One of the subcommands of the single
 * `mph` CLI; this module only exports, so importing it starts no server.
 */
import { spawn } from "node:child_process";
import { mphEnv } from "../core/env.js";
import { snapshotOnce, startDashboard } from "./server.js";
import { defaultLedgerPath } from "./live.js";

export const DASH_HELP = `mph dash [--port 8792] [--host 127.0.0.1] [--ledger PATH] [--weekly-budget N|50M] [--poll-ms 1000] [--open] [--once] [--quiet]

Live view of what the harness is saving: quota stretch, tokens not sent, cache
hit rate, per-session context curves and a feed of every fold as it happens.
Read-only; safe to run next to the proxy, a chat session and \`mph watch\`.
\`--once\` prints one JSON snapshot and exits, for scripts and CI.`;

/** Accepts 50000000, 50M, 1.5B. */
function budget(v?: string): number {
  if (!v) return Number(mphEnv("WEEKLY_BUDGET") ?? 0) || 0;
  const m = /^([\d.]+)\s*([kmbKMB])?$/.exec(v.trim());
  if (!m) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

export async function dashMain(args: string[]): Promise<void> {
  const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const has = (n: string) => args.includes(n);
  if (has("--help") || has("-h")) { console.log(DASH_HELP); return; }

  // --once reads the ledger and leaves; it must not need a free port
  if (has("--once")) {
    console.log(JSON.stringify(snapshotOnce({ ledger: opt("--ledger"), weeklyBudget: budget(opt("--weekly-budget")) }), null, 2));
    return;
  }

  const dash = await startDashboard({
    port: Number(opt("--port", "8792")),
    host: opt("--host", "127.0.0.1"),
    ledger: opt("--ledger"),
    pollMs: Number(opt("--poll-ms", "1000")),
    weeklyBudget: budget(opt("--weekly-budget")),
    verbose: !has("--quiet"),
  });

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
}
