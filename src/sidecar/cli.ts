import { Ledger } from "../core/ledger.js";
import { buildReport, formatReport } from "./metrics.js";
import { tune } from "./tuner.js";
import { loadKnobFile } from "../core/knobs.js";

const args = process.argv.slice(2); const cmd = args[0] ?? "report";
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ledger = new Ledger(opt("--ledger"));
if (cmd === "report") { const r = buildReport(ledger, { since: opt("--since") }); console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : formatReport(r)); }
else if (cmd === "tune") { for (const l of tune(ledger, { scope: opt("--scope", "global"), minRows: Number(opt("--min-rows", "200")), dryRun: args.includes("--dry-run") })) console.log(l); }
else if (cmd === "history") { for (const h of loadKnobFile().history ?? []) console.log(`${h.at} ${h.who.padEnd(8)} ${h.scope.padEnd(12)} ${JSON.stringify(h.changes)}  ${h.why}`); }
else if (cmd === "watch") {
  const every = Number(opt("--every", "900")) * 1000;
  const loop = () => { try { console.log(`[${new Date().toISOString()}]`); console.log(formatReport(buildReport(ledger))); for (const l of tune(ledger, { scope: opt("--scope", "global") })) console.log("tune:", l); } catch (e) { console.error(e); } };
  loop(); setInterval(loop, every);
} else console.log("th-sidecar report [--since ISO] [--json] | tune [--scope global|project:PATH] [--dry-run] | history | watch [--every 900]");
