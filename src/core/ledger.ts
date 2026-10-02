/**
 * Ledger: append-only JSONL, one row per model response (plus policy events).
 * The sidecar reads it to compute savings and tune knobs.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { harnessHome } from "./knobs.js";

export interface LedgerRow {
  ts: string;
  source: "proxy" | "harness" | "sidecar" | "bench";
  session: string;
  turn: number;
  step: number;
  model?: string;
  effort?: string;
  policy_version?: string;
  knobs_hash?: string;
  input?: number;
  cached?: number;
  uncached?: number;
  output?: number;
  reasoning?: number;
  ctx_before?: number;      // tokens the client would have sent
  ctx_after?: number;       // tokens actually sent after rewrite
  delta_new?: number;
  // savings events, then the phases a strategy goes through (see src/harness/strategies)
  event?: "compact" | "keep" | "fork" | "shape" | "dedupe" | "wait" | "recall" | "poll_collapse" | "delegate" | "merge" | "knob_change" | "response"
        | "plan" | "step" | "verify" | "argue" | "replan" | "strategy"
        // multi-turn: the turn gate, memory recall/writes, and a broken user-words invariant
        | "gate" | "memory" | "fidelity";
  tool_kind?: string;
  idle_s?: number;
  cache_state?: "warm" | "cold" | "unknown";
  recall_count?: number;
  retries?: number;
  task_outcome?: "success" | "fail" | "unknown";
  cost_equiv?: number;
  // quota/billing meter off the response headers (Codex upstream only; see src/upstream/meter.ts)
  credits_balance?: number;        // x-codex-credits-balance after this response
  credits_spent?: number;          // balance drop since the previous observed response of this session.
                                   // NOT this response's price: the backend's balance is eventually
                                   // consistent, so only the sum over a burst means anything.
  primary_used_percent?: number;   // integer 0..100, shared with other devices on the account
  secondary_used_percent?: number;
  plan_type?: string;
  active_limit?: string;
  note?: string;
  extra?: Record<string, unknown>;
}

/**
 * Cost-equivalent weights, in units of "one uncached input token". They are a PLACEHOLDER:
 * 0.1 / 1 / 8 is the public pay-as-you-go shape (cached input is a tenth, output is eight
 * times input), and it has NOT been verified against what a Codex subscription actually
 * charges — a subscription meters quota, not dollars, and may weigh the three classes
 * differently or not weigh output at all. Every savings number derived from costEquiv is
 * therefore a relative figure, trustworthy for comparing two policies on the same weights and
 * nothing more. `mph-sidecar price` estimates the real weights from the credits meter in the
 * ledger, and `mph-sidecar price-probe` measures them with a controlled experiment; until one of
 * those has run, do not quote costEquiv as money.
 */
export const PRICE = { cached: 0.1, uncached: 1.0, output: 8.0, cacheWrite: 1.0 };

export function costEquiv(r: { cached?: number; uncached?: number; output?: number }): number {
  return (r.cached ?? 0) * PRICE.cached + (r.uncached ?? 0) * PRICE.uncached + (r.output ?? 0) * PRICE.output;
}

export class Ledger {
  readonly path: string;
  constructor(path?: string) {
    this.path = path ?? join(harnessHome(), "ledger.jsonl");
    mkdirSync(dirname(this.path), { recursive: true });
  }
  append(row: Omit<LedgerRow, "ts"> & { ts?: string }): void {
    const full: LedgerRow = { ts: row.ts ?? new Date().toISOString(), ...row } as LedgerRow;
    if (full.cost_equiv === undefined && (full.cached !== undefined || full.uncached !== undefined || full.output !== undefined)) full.cost_equiv = costEquiv(full);
    appendFileSync(this.path, JSON.stringify(full) + "\n");
  }
  *rows(): Generator<LedgerRow> {
    if (!existsSync(this.path)) return;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch { /* skip */ }
    }
  }
  readAll(): LedgerRow[] { return [...this.rows()]; }
}
