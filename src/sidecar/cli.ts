import { Ledger } from "../core/ledger.js";
import { buildReport, formatReport } from "./metrics.js";
import { tune } from "./tuner.js";
import { fitPrice, formatPriceFit } from "./price.js";
import { priceProbe, formatPlan, formatProbeResult } from "../upstream/price_probe.js";
import { loadKnobFile, knobsFor } from "../core/knobs.js";

const args = process.argv.slice(2); const cmd = args[0] ?? "report";
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ledger = new Ledger(opt("--ledger"));
if (cmd === "report") { const r = buildReport(ledger, { since: opt("--since") }); console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : formatReport(r)); }
else if (cmd === "tune") { for (const l of tune(ledger, { scope: opt("--scope", "global"), minRows: Number(opt("--min-rows", "200")), dryRun: args.includes("--dry-run") })) console.log(l); }
else if (cmd === "history") { for (const h of loadKnobFile().history ?? []) console.log(`${h.at} ${h.who.padEnd(8)} ${h.scope.padEnd(12)} ${JSON.stringify(h.changes)}  ${h.why}`); }
else if (cmd === "price") {
  const f = fitPrice(ledger, { since: opt("--since"), minBursts: Number(opt("--min-bursts", "4")), maxGapS: Number(opt("--max-gap", "120")), maxSpread: Number(opt("--max-spread", "3")) });
  console.log(args.includes("--json") ? JSON.stringify(f, null, 2) : formatPriceFit(f));
  if (!f.usable) process.exitCode = 1;    // a refusal is a result: scripts must not read it as a price
} else if (cmd === "price-probe") {
  // spends real quota, so: dry run unless --go, and --dry-run always wins
  const models = (opt("--models", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const r = await priceProbe({
    models: models.length ? models : [knobsFor({}).main_model],
    n: Number(opt("--n", "8")), settleS: Number(opt("--settle", "20")), effort: opt("--effort", "medium")!,
    pollEveryS: Number(opt("--poll-every", "5")), maxWaitS: Number(opt("--max-wait", "300")),
    go: args.includes("--go") && !args.includes("--dry-run"),
    pricesFile: opt("--prices"),
    log: (l) => { if (!args.includes("--json")) console.error(l); },
  });
  console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : r.table || !r.ok ? formatProbeResult(r) : formatPlan(r.plan));
  if (!r.ok) process.exitCode = 1;
} else if (cmd === "watch") {
  const every = Number(opt("--every", "900")) * 1000;
  const loop = () => { try { console.log(`[${new Date().toISOString()}]`); console.log(formatReport(buildReport(ledger))); for (const l of tune(ledger, { scope: opt("--scope", "global") })) console.log("tune:", l); } catch (e) { console.error(e); } };
  loop(); setInterval(loop, every);
} else console.log(`th-sidecar report [--since ISO] [--json] | tune [--scope global|project:PATH] [--dry-run] | history | watch [--every 900]
             price [--since ISO] [--min-bursts 4] [--max-gap 120] [--json]   fit the real credits price from the ledger (exits 1 when the data cannot support one)
             price-probe [--models a,b] [--n 8] [--settle 20] [--effort medium] [--json] [--go]   measure it with a controlled burst; dry run unless --go`);
