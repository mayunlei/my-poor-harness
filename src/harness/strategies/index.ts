/**
 * Strategies: how a turn is organised.
 *
 * The harness has one loop primitive (`runTurn`) and several ways to arrange it.
 * ReAct — one agent, one growing context, think/act/observe until done — is the
 * default because it is what every client does today, not because it is best.
 * It is also the worst case for the cost model in README.md:
 *
 *     T_in ≈ n·C0 + n²/2·(o+a)
 *
 * with ONE C0 that grows all turn. plan_verify trades that for many small
 * contexts: the planner pays a big C0 once, then each step runs in a fresh
 * context whose C0 is the step contract (~2-3K), not the conversation (~94K).
 * The price is more model calls per unit of work (plan, worker, verifier, and
 * an argue round or two), so on a three-step task it loses and on a long one it
 * wins by a lot. Which is exactly why this is a pluggable choice with a
 * benchmark attached (`mph compare`) rather than an opinion in a prompt.
 */
import type { SessionData } from "../session.js";
import type { Knobs } from "../../core/knobs.js";
import { ArtifactStore } from "../../core/artifacts.js";
import { Ledger, type LedgerRow } from "../../core/ledger.js";
import { Router } from "../router.js";
import type { Usage } from "../providers.js";

export interface StrategyContext {
  session: SessionData;
  userText: string;
  knobs: Knobs;
  store: ArtifactStore;
  ledger: Ledger;
  router: Router;
  maxSteps?: number;
  onText?: (t: string) => void;
  onEvent?: (e: { kind: string; detail: string }) => void;
  quiet?: boolean;
  /** merged into the ledger rows of every model call this strategy makes */
  tag?: Record<string, unknown>;
}

export interface StrategyResult {
  strategy: string;
  text: string;
  /** model calls across every agent the strategy ran */
  steps: number;
  usage: Usage;
  costEquiv: number;
  /** present when the strategy verified its own work; undefined means "not checked" */
  verified?: boolean;
  detail?: Record<string, unknown>;
}

export interface Strategy {
  name: string;
  description: string;
  run(ctx: StrategyContext): Promise<StrategyResult>;
}

export const emptyUsage = (): Usage => ({ input: 0, cached: 0, output: 0, reasoning: 0 });
export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, reasoning: a.reasoning + b.reasoning };
}

/**
 * Phase rows. These are not responses — they mark what the strategy decided, so
 * the sidecar and the dashboard can attribute cost to planning vs doing vs
 * verifying, and compare strategies on the same ledger.
 */
export type Phase = "plan" | "step" | "verify" | "argue" | "replan" | "strategy";
export function logPhase(ledger: Ledger, phase: Phase, row: Omit<LedgerRow, "ts" | "source" | "event">): void {
  ledger.append({ ...row, source: "harness", event: phase });
}

/** Pull the first JSON object out of a model reply, fenced or not. */
export function extractJson<T>(text: string): T | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter(Boolean) as string[];
  for (const c of candidates) {
    const start = c.indexOf("{");
    if (start < 0) continue;
    // walk to the matching brace so trailing prose does not break the parse
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(c.slice(start, i + 1)) as T; } catch { break; } } }
    }
  }
  return undefined;
}

import { reactStrategy } from "./react.js";
import { planVerifyStrategy } from "./plan_verify.js";

export const STRATEGIES: Record<string, Strategy> = {
  [reactStrategy.name]: reactStrategy,
  [planVerifyStrategy.name]: planVerifyStrategy,
};

export function strategyFor(name?: string): Strategy {
  const s = STRATEGIES[name ?? "react"];
  if (!s) throw new Error(`unknown strategy "${name}": have ${Object.keys(STRATEGIES).join(", ")}`);
  return s;
}
