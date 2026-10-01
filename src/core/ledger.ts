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
  event?: "compact" | "keep" | "fork" | "shape" | "dedupe" | "wait" | "recall" | "poll_collapse" | "delegate" | "merge" | "knob_change" | "response";
  tool_kind?: string;
  idle_s?: number;
  cache_state?: "warm" | "cold" | "unknown";
  recall_count?: number;
  retries?: number;
  task_outcome?: "success" | "fail" | "unknown";
  cost_equiv?: number;
  note?: string;
  extra?: Record<string, unknown>;
}

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
