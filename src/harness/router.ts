/**
 * Model routing by task tier. Routing happens only at task boundaries with
 * self-contained contexts (switching models mid-conversation would discard the
 * prefix cache and cannot carry reasoning items across models).
 */
import type { Knobs } from "../core/knobs.js";
import { Ledger } from "../core/ledger.js";
import { clientFor, type ModelClient } from "./providers.js";

export type Tier = "T1" | "T2" | "T3" | "T4";

export interface Route { tier: Tier; model: string; effort: string; maxSteps: number }

export class Router {
  private clients = new Map<string, ModelClient>();
  private passStats = new Map<string, { pass: number; fail: number }>();
  constructor(readonly knobs: Knobs, readonly ledger: Ledger) {}

  route(tier: Tier, phase: "plan" | "execute" | "summarize" = "execute"): Route {
    const k = this.knobs;
    switch (tier) {
      case "T1": return { tier, model: k.small_model, effort: "low", maxSteps: 1 };
      case "T2": return { tier, model: k.small_model, effort: k.effort_summarize, maxSteps: 1 };
      case "T3": return { tier, model: k.mid_model, effort: "medium", maxSteps: 25 };
      default: return { tier, model: k.main_model, effort: phase === "plan" ? k.effort_plan : k.effort_execute, maxSteps: 200 };
    }
  }

  client(model: string): ModelClient {
    let c = this.clients.get(model); if (!c) { c = clientFor(model); this.clients.set(model, c); } return c;
  }

  /** Escalation ladder for delegated work: start at the class's current tier, go up on failure. */
  ladder(taskClass: string): Tier[] {
    const st = this.passStats.get(taskClass);
    const rate = st ? st.pass / Math.max(1, st.pass + st.fail) : 1;
    return rate < this.knobs.t3_escalate_pass_rate && st && st.pass + st.fail >= 3 ? ["T4"] : ["T3", "T4"];
  }

  recordOutcome(taskClass: string, tier: Tier, ok: boolean): void {
    const st = this.passStats.get(taskClass) ?? { pass: 0, fail: 0 };
    if (ok) st.pass++; else st.fail++;
    this.passStats.set(taskClass, st);
    this.ledger.append({ source: "harness", session: "router", turn: 0, step: 0, event: "delegate", note: `${taskClass}:${tier}:${ok ? "pass" : "fail"}`, task_outcome: ok ? "success" : "fail" });
  }
}

export function taskClassOf(task: string): string {
  const t = task.toLowerCase();
  if (/test|pytest|jest|vitest|spec/.test(t)) return "run_tests";
  if (/find|locate|where|grep|search|list/.test(t)) return "locate";
  if (/refactor|rename|move|extract/.test(t)) return "refactor";
  if (/summar|report|describe|explain/.test(t)) return "summarize";
  if (/fix|bug|error|fail/.test(t)) return "fix";
  if (/implement|add|create|write/.test(t)) return "implement";
  return "other";
}
