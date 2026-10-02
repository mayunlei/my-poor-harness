/**
 * The names and help text of the ledger subcommands, with no imports of their own.
 * `mph` dispatches on this list without loading the ledger, the tuner or the price
 * fitter; sidecar/cli.ts implements them. One list, so the two cannot drift.
 */
export const LEDGER_COMMANDS = ["report", "tune", "price", "price-probe", "watch", "history"] as const;
export type LedgerCommand = (typeof LEDGER_COMMANDS)[number];

export const LEDGER_HELP = `mph report [--since ISO] [--json]                       cost, credits, cache, compaction net effect, pass rates
mph tune [--scope global|project:PATH] [--dry-run]      move the knobs within bounds, with provenance
mph watch [--every 900] [--scope ...]                   report + tune on a loop
mph history                                             every knob change: when, by whom, why
mph price [--since ISO] [--min-bursts 4] [--max-gap 120] [--json]
                                                        fit the real credits price from the ledger (exits 1 when the data cannot support one)
mph price-probe [--models a,b] [--n 8] [--settle 20] [--effort medium] [--json] [--go]
                                                        measure it with a controlled burst; dry run unless --go`;
