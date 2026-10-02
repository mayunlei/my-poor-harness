/**
 * ReAct: one agent, one context, think/act/observe until it answers. This is
 * the baseline every strategy is measured against — it is `runTurn` unchanged.
 */
import { runTurn } from "../loop.js";
import type { Strategy, StrategyContext, StrategyResult } from "./index.js";

export const reactStrategy: Strategy = {
  name: "react",
  description: "single agent, growing context, tool calls until it answers (the baseline)",
  async run(ctx: StrategyContext): Promise<StrategyResult> {
    const r = await runTurn({
      session: ctx.session, userText: ctx.userText, knobs: ctx.knobs, store: ctx.store, ledger: ctx.ledger,
      router: ctx.router, maxSteps: ctx.maxSteps, onText: ctx.onText, onEvent: ctx.onEvent, quiet: ctx.quiet,
      tag: { strategy: "react", ...ctx.tag },
    });
    return { strategy: "react", text: r.text, steps: r.steps, usage: r.usage, costEquiv: r.costEquiv };
  },
};
