/**
 * The ledger-reading subcommands of `mph`: report, tune, price, price-probe, watch
 * and the knob-change history. This module only exports; importing it reads nothing.
 */
import { resolveModels } from "../upstream/config.js";
import { Ledger } from "../core/ledger.js";
import { buildReport, formatReport } from "./metrics.js";
import { tune } from "./tuner.js";
import { fitPrice, formatPriceFit } from "./price.js";
import { priceProbe, formatPlan, formatProbeResult } from "../upstream/price_probe.js";
import { loadKnobFile, knobsFor } from "../core/knobs.js";
import { LEDGER_HELP, type LedgerCommand } from "./commands.js";

export async function ledgerMain(cmd: LedgerCommand, args: string[]): Promise<void> {
  const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  if (args.includes("--help") || args.includes("-h")) { console.log(LEDGER_HELP); return; }
  const ledger = new Ledger(opt("--ledger"));

  if (cmd === "report") {
    const r = buildReport(ledger, { since: opt("--since") });
    console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : formatReport(r));
    return;
  }
  if (cmd === "tune") {
    for (const l of tune(ledger, { scope: opt("--scope", "global"), minRows: Number(opt("--min-rows", "200")), dryRun: args.includes("--dry-run") })) console.log(l);
    return;
  }
  if (cmd === "history") {
    for (const h of loadKnobFile().history ?? []) console.log(`${h.at} ${h.who.padEnd(8)} ${h.scope.padEnd(12)} ${JSON.stringify(h.changes)}  ${h.why}`);
    return;
  }
  if (cmd === "price") {
    const f = fitPrice(ledger, { since: opt("--since"), minBursts: Number(opt("--min-bursts", "4")), maxGapS: Number(opt("--max-gap", "120")), maxSpread: Number(opt("--max-spread", "3")) });
    console.log(args.includes("--json") ? JSON.stringify(f, null, 2) : formatPriceFit(f));
    if (!f.usable) process.exitCode = 1;    // a refusal is a result: scripts must not read it as a price
    return;
  }
  if (cmd === "price-probe") {
    // spends real quota, so: dry run unless --go, and --dry-run always wins
    const models = (opt("--models", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const r = await priceProbe({
      models: models.length ? models : [resolveModels(knobsFor({})).main],
      n: Number(opt("--n", "8")), settleS: Number(opt("--settle", "20")), effort: opt("--effort", "medium")!,
      pollEveryS: Number(opt("--poll-every", "5")), maxWaitS: Number(opt("--max-wait", "300")),
      go: args.includes("--go") && !args.includes("--dry-run"),
      pricesFile: opt("--prices"),
      log: (l) => { if (!args.includes("--json")) console.error(l); },
    });
    console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : r.table || !r.ok ? formatProbeResult(r) : formatPlan(r.plan));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "watch") {
    const every = Number(opt("--every", "900")) * 1000;
    const loop = () => {
      try {
        console.log(`[${new Date().toISOString()}]`);
        console.log(formatReport(buildReport(ledger)));
        for (const l of tune(ledger, { scope: opt("--scope", "global") })) console.log("tune:", l);
      } catch (e) { console.error(e); }
    };
    loop(); setInterval(loop, every);
    return;
  }
}
