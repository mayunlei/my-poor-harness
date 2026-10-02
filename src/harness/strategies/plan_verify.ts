/**
 * plan_verify: a strong model plans, cheap models execute, an independent agent
 * verifies, and the two argue until the evidence says the step is done.
 *
 * Why this shape, and not ReAct:
 *   - ReAct interleaves planning with doing in ONE context, so every step pays
 *     for every earlier step (n·C0 with a large, growing C0). Planning up front
 *     pays the big context once.
 *   - A step contract (goal + inputs + acceptance command + what to check) is a
 *     few hundred tokens. A worker that gets only the contract starts from
 *     C0 ≈ 3K instead of 94K, which is the entire thesis of this repo applied
 *     to the agent topology rather than to the request body.
 *   - It lets the expensive model be used where it is worth the money — framing
 *     the problem and writing the acceptance criteria — and the cheap model do
 *     the typing.
 *
 * The part that makes or breaks it is verification, so two rules are structural:
 *   1. Acceptance is a COMMAND, not an opinion. A step is not done because an
 *      agent says so; it is done because something exits 0.
 *   2. The verifier never sees the worker's reasoning or its self-report — only
 *      the contract, the files that changed, and the command output, and it runs
 *      the command itself. A verifier reading "I fixed it, all tests pass" is a
 *      rubber stamp, and a rubber stamp costs money and buys nothing.
 *
 * Honest limits: a plan made before the work starts goes stale, so a step that
 * cannot be made to pass triggers a bounded replan rather than more arguing;
 * and for a task of two or three steps the verification overhead is pure loss.
 * `mph compare` exists to find out where the crossover actually is instead of
 * guessing.
 */
import { runTurn, FIXED_PROMPT } from "../loop.js";
import { newRewriteState } from "../../core/rewrite.js";
import { executeTool, type ToolContext } from "../tools.js";
import { countTokens } from "../../core/tokens.js";
import type { SessionData } from "../session.js";
import type { Tier } from "../router.js";
import { reactStrategy } from "./react.js";
import { addUsage, emptyUsage, extractJson, logPhase, type Strategy, type StrategyContext, type StrategyResult } from "./index.js";

export interface PlanStep {
  id: string;
  goal: string;
  /** files / artifact ids the worker needs; it starts with nothing else */
  inputs: string[];
  /** shell command that exits 0 only when this step is genuinely done */
  acceptance: string;
  /** what an independent reviewer must confirm beyond the command exiting 0 */
  verify: string;
  depends_on: string[];
  tier?: "T3" | "T4";
}

export interface Plan {
  goal: string;
  assumptions: string[];
  steps: PlanStep[];
  done_when: string;
}

export interface StepOutcome {
  id: string;
  goal: string;
  tier: Tier;
  passed: boolean;
  verified: boolean;
  rounds: number;
  acceptanceOutput?: string;
  objections: string[];
  report: string;
  filesTouched: string[];
}

const PLANNER_INSTRUCTIONS = `You are the planner for a team of coding agents. You do not write the code.

How execution works, and why it constrains your plan:
- Each step you emit is executed by a SEPARATE, CHEAPER agent in a FRESH context. That agent sees only what you write in the step: the goal, the inputs you name, the acceptance command and the verify note. It cannot see this conversation, your reasoning, or the other steps' work beyond a one-line report.
- After a step runs, its acceptance command is executed and an INDEPENDENT verifier agent checks the result against your verify note. The verifier sees the changed files and the command output, never the worker's claims.

So a good step is: self-contained, independently checkable, and worth a fresh context. A bad step is "continue the refactor" or "make sure it works".

Rules:
- Use the tools to look at the repository before planning. Read what you need; do not modify anything.
- acceptance MUST be a single shell command that exits 0 only when the step is actually done (a test, a build, a grep that must match, a script). If there is genuinely nothing executable, write a command that checks the observable effect, e.g. "test -f path && grep -q 'thing' path".
- verify is a short sentence telling the verifier what a passing command does NOT prove, e.g. "confirm the fix handles an empty list too, not just the failing case".
- inputs names the files or artifact ids the worker must read. Be specific: paths, not descriptions.
- depends_on lists step ids that must finish first. Keep independent steps independent so they run in parallel.
- tier is "T3" (default, cheaper model) or "T4" (the strong model) — use T4 only for a step that genuinely needs it, such as a tricky design decision.

Reply with ONE fenced json block and nothing else:
\`\`\`json
{"goal":"...","assumptions":["..."],"steps":[{"id":"s1","goal":"...","inputs":["path"],"acceptance":"cmd","verify":"...","depends_on":[],"tier":"T3"}],"done_when":"..."}
\`\`\``;

const WORKER_INSTRUCTIONS = FIXED_PROMPT + `

You are executing ONE step of a larger plan, in a fresh context. You cannot see the rest of the plan or the conversation that produced it. Work only on this step. Your work is checked by running the acceptance command and by an independent reviewer, so do not claim anything you have not run.`;

const VERIFIER_INSTRUCTIONS = `You are an independent verifier. Another agent claims it finished a step. You do not trust it and you cannot see what it said or thought.

Your job is to find out whether the step is actually done, using evidence you gather yourself:
- Run the acceptance command yourself. Read the files that changed. Run anything else that would expose a shortcut (the wider test suite, a grep for a hardcoded value, the opposite input).
- Look for the usual ways a step passes without being done: the test was weakened or skipped, the value was hardcoded to satisfy the assertion, an unrelated file was broken to make the command exit 0, the change only handles the exact case in the command, a file was created empty.
- You must not fix anything. You judge.

Reply with ONE fenced json block and nothing else:
\`\`\`json
{"verdict":"pass"|"fail","objections":["concrete thing that is wrong, with the file and the evidence"],"evidence":"what you ran and what it showed, one or two sentences"}
\`\`\`
Pass only if your own evidence supports it. An empty objections list with verdict "fail" is not useful: say what is wrong.`;

function freshWorker(parent: SessionData, suffix: string, title: string): SessionData {
  return {
    ...JSON.parse(JSON.stringify(parent)),
    id: `${parent.id}:${suffix}`,
    title,
    turns: [], window: [], merged: [],
    state: { filesTouched: [], commandsByKind: {}, errorsSeen: [], turns: 0 },
    rewriteState: newRewriteState(suffix),
  };
}

/** Run a command for its exit status only; the harness pays nothing for this. */
async function runAcceptance(ctx: StrategyContext, cmd: string, sessionId: string): Promise<{ ok: boolean; out: string }> {
  const tctx: ToolContext = {
    cwd: ctx.session.cwd, knobs: ctx.knobs, store: ctx.store, sessionId,
    filesTouched: new Set(), readCache: new Map(), cmdCache: new Map(), jobs: new Map(),
  };
  const out = await executeTool(tctx, "run", { cmd, timeout_s: ctx.knobs.blocking_exec_timeout_s }, "acc");
  return { ok: out.startsWith("[exit 0]"), out };
}

function validatePlan(p: any, knobs: StrategyContext["knobs"]): { plan?: Plan; problem?: string } {
  if (!p || !Array.isArray(p.steps)) return { problem: "no steps array" };
  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of p.steps.entries()) {
    const id = String(raw?.id ?? `s${i + 1}`);
    if (seen.has(id)) return { problem: `duplicate step id ${id}` };
    seen.add(id);
    if (!raw?.goal) return { problem: `step ${id} has no goal` };
    steps.push({
      id, goal: String(raw.goal),
      inputs: Array.isArray(raw.inputs) ? raw.inputs.map(String) : [],
      acceptance: String(raw.acceptance ?? ""),
      verify: String(raw.verify ?? ""),
      depends_on: Array.isArray(raw.depends_on) ? raw.depends_on.map(String) : [],
      tier: raw.tier === "T4" ? "T4" : "T3",
    });
  }
  if (steps.length < 1) return { problem: "empty plan" };
  if (steps.length > knobs.plan_max_tasks) return { problem: `${steps.length} steps exceeds plan_max_tasks=${knobs.plan_max_tasks}` };
  for (const s of steps) for (const d of s.depends_on) if (!seen.has(d)) return { problem: `step ${s.id} depends on unknown ${d}` };
  return { plan: { goal: String(p.goal ?? ""), assumptions: Array.isArray(p.assumptions) ? p.assumptions.map(String) : [], steps, done_when: String(p.done_when ?? "") } };
}

/**
 * Which of the ready steps may run at once.
 *
 * Parallel workers share one working tree, so two steps that name the same input
 * would edit the same file at the same time. Dependencies order the obvious
 * cases; this serialises the rest. It is a proxy, not a lock: the planner names
 * what a step reads, which is usually but not always what it writes. Set
 * plan_parallel=1 for a workspace where that is not good enough.
 */
export function nextWave(ready: PlanStep[], limit: number): PlanStep[] {
  const wave: PlanStep[] = [];
  const claimed = new Set<string>();
  for (const cand of ready) {
    if (wave.length >= Math.max(1, limit)) break;
    const touches = cand.inputs.map((i) => i.trim()).filter(Boolean);
    if (wave.length && touches.some((t) => claimed.has(t))) continue;
    for (const t of touches) claimed.add(t);
    wave.push(cand);
  }
  if (!wave.length && ready.length) wave.push(ready[0]);
  return wave;
}

export const planVerifyStrategy: Strategy = {
  name: "plan_verify",
  description: "strong model plans with acceptance commands, cheap workers execute in fresh contexts, an independent verifier argues until the evidence holds",

  async run(ctx: StrategyContext): Promise<StrategyResult> {
    const { knobs, ledger, session } = ctx;
    const tag = { strategy: "plan_verify", ...ctx.tag };
    let usage = emptyUsage(); let steps = 0; let costEquiv = 0;
    const say = (kind: string, detail: string) => ctx.onEvent?.({ kind, detail });

    // --- plan ----------------------------------------------------------------
    const planner = freshWorker(session, "plan" + Date.now().toString(36), "planner");
    let plan: Plan | undefined; let planProblem: string | undefined;
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      const ask = attempt === 0
        ? `Task from the user:\n${ctx.userText}\n\nWorkspace: ${session.cwd}\nPlan between ${knobs.plan_min_tasks} and ${knobs.plan_max_tasks} steps.`
        : `Your previous reply could not be used: ${planProblem}. Reply with only the json block, matching the schema exactly.`;
      const r = await runTurn({
        session: planner, userText: ask, knobs, store: ctx.store, ledger, router: ctx.router, tier: "T4",
        instructions: PLANNER_INSTRUCTIONS, toolNames: ["run", "read", "recall"],
        maxSteps: knobs.plan_max_steps, quiet: true, onEvent: ctx.onEvent, tag: { ...tag, phase: "plan" },
      });
      usage = addUsage(usage, r.usage); steps += r.steps; costEquiv += r.costEquiv;
      const parsed = validatePlan(extractJson<any>(r.text), knobs);
      plan = parsed.plan; planProblem = parsed.problem;
    }

    if (!plan) {
      // A planner that cannot produce a plan is not a reason to fail the task.
      say("warn", `planning failed (${planProblem}); falling back to react`);
      logPhase(ledger, "replan", { session: session.id, turn: session.turns.length, step: steps, note: `plan unusable: ${planProblem}; fell back to react`, extra: tag });
      const r = await reactStrategy.run(ctx);
      return { ...r, strategy: "plan_verify→react", steps: steps + r.steps, usage: addUsage(usage, r.usage), costEquiv: costEquiv + r.costEquiv, detail: { planFailed: planProblem } };
    }

    logPhase(ledger, "plan", {
      session: session.id, turn: session.turns.length, step: steps,
      note: `${plan.steps.length} steps: ${plan.steps.map((s) => s.id).join(",")}`,
      extra: { ...tag, phase: "plan", plan_steps: plan.steps.length, plan_goal: plan.goal.slice(0, 200) },
    });
    say("plan", `${plan.steps.length} steps — ${plan.steps.map((s) => `${s.id}:${s.goal.slice(0, 48)}`).join(" | ")}`);

    // --- execute, verify, argue ---------------------------------------------
    const outcomes = new Map<string, StepOutcome>();
    let replans = 0;

    const runOne = async (st: PlanStep): Promise<StepOutcome> => {
      const deps = st.depends_on.map((d) => outcomes.get(d)).filter(Boolean) as StepOutcome[];
      let tier: Tier = (st.tier ?? knobs.worker_tier) as Tier;
      const worker = freshWorker(session, `w${st.id}-${Date.now().toString(36)}`, `worker ${st.id}`);
      const contract =
        `Overall goal (for orientation only): ${plan!.goal}\n\n` +
        `YOUR STEP (${st.id}): ${st.goal}\n` +
        (st.inputs.length ? `Read these first: ${st.inputs.join(", ")}\n` : "") +
        (st.acceptance ? `Acceptance — this command must exit 0 when you are done: ${st.acceptance}\n` : "No acceptance command was given; make the result observable and say exactly how you checked it.\n") +
        (st.verify ? `An independent reviewer will also check: ${st.verify}\n` : "") +
        (deps.length ? `\nAlready done by other agents:\n${deps.map((d) => `- ${d.id}: ${d.report.slice(0, 220)}`).join("\n")}\n` : "") +
        `\nFinish with a report under 200 words: what you changed (files and lines), what you ran, what it printed.`;

      const outcome: StepOutcome = { id: st.id, goal: st.goal, tier, passed: false, verified: false, rounds: 0, objections: [], report: "", filesTouched: [] };
      let message = contract;

      for (let round = 0; round <= knobs.argue_rounds + 1; round++) {
        outcome.rounds = round + 1;
        const r = await runTurn({
          session: worker, userText: message, knobs, store: ctx.store, ledger, router: ctx.router, tier,
          instructions: WORKER_INSTRUCTIONS, maxSteps: Math.min(ctx.maxSteps ?? 40, 40), quiet: true,
          onEvent: ctx.onEvent, tag: { ...tag, phase: "step", plan_step: st.id, round },
        });
        usage = addUsage(usage, r.usage); steps += r.steps; costEquiv += r.costEquiv;
        outcome.report = r.text;
        outcome.filesTouched = [...new Set([...outcome.filesTouched, ...worker.state.filesTouched])];

        // 1. the command decides, not the agent
        let ok = true; let accOut = "";
        if (st.acceptance) {
          const acc = await runAcceptance(ctx, st.acceptance, worker.id);
          ok = acc.ok; accOut = acc.out; outcome.acceptanceOutput = acc.out.slice(0, 2000);
        } else if (knobs.verify_requires_command) {
          ok = false; accOut = "[no acceptance command: step cannot be verified]";
        }
        logPhase(ledger, "step", {
          session: session.id, turn: session.turns.length, step: steps, model: r.text ? undefined : undefined,
          note: `${st.id} round ${round} on ${tier}: acceptance ${st.acceptance ? (ok ? "passed" : "FAILED") : "none"}`,
          task_outcome: ok ? "success" : "fail",
          extra: { ...tag, phase: "step", plan_step: st.id, round, tier, acceptance: st.acceptance.slice(0, 200) },
        });

        if (!ok) {
          say("step", `${st.id} round ${round}: acceptance failed`);
          if (round >= knobs.argue_rounds) { if (tier !== "T4") { tier = "T4"; say("step", `${st.id}: escalating worker to T4`); } else break; }
          message = `The acceptance command failed.\n\nCommand: ${st.acceptance}\nOutput:\n${accOut.slice(0, 3000)}\n\nFix the cause, not the command. Then report again.`;
          continue;
        }

        // 2. an independent agent tries to break it
        const verdict = await verify(ctx, st, outcome, tag);
        usage = addUsage(usage, verdict.usage); steps += verdict.steps; costEquiv += verdict.costEquiv;
        logPhase(ledger, "verify", {
          session: session.id, turn: session.turns.length, step: steps,
          note: `${st.id}: ${verdict.pass ? "pass" : "fail"}${verdict.objections.length ? " — " + verdict.objections[0].slice(0, 120) : ""}`,
          task_outcome: verdict.pass ? "success" : "fail",
          extra: { ...tag, phase: "verify", plan_step: st.id, round, objections: verdict.objections.length, evidence: verdict.evidence.slice(0, 300) },
        });

        if (verdict.pass) {
          outcome.passed = true; outcome.verified = true;
          say("verify", `${st.id} verified (${outcome.rounds} round${outcome.rounds > 1 ? "s" : ""})`);
          break;
        }
        outcome.objections = verdict.objections;
        say("argue", `${st.id}: verifier objects — ${verdict.objections[0]?.slice(0, 100) ?? "(no reason given)"}`);
        logPhase(ledger, "argue", {
          session: session.id, turn: session.turns.length, step: steps,
          note: `${st.id} round ${round}: ${verdict.objections.length} objection(s)`,
          extra: { ...tag, phase: "argue", plan_step: st.id, round },
        });
        if (round >= knobs.argue_rounds) { if (tier !== "T4") { tier = "T4"; say("step", `${st.id}: escalating worker to T4`); } else break; }
        message = `The acceptance command passes but an independent reviewer rejected the step:\n\n${verdict.objections.map((o) => "- " + o).join("\n")}\n\nEvidence it gathered: ${verdict.evidence}\n\nAddress every objection. Do not weaken the test or the acceptance command.`;
      }

      // the parent keeps the file list so later turns know what moved
      for (const f of outcome.filesTouched) if (!session.state.filesTouched.includes(f)) session.state.filesTouched.push(f);
      return outcome;
    };

    // dependency waves, independent steps in parallel
    let remaining = [...plan.steps];
    let guard = 0;
    while (remaining.length && guard++ < 50) {
      const ready = remaining.filter((s) => s.depends_on.every((d) => outcomes.get(d)?.passed));
      const blocked = remaining.filter((s) => !ready.includes(s));
      if (!ready.length) {
        // everything left depends on a step that failed
        for (const s of blocked) outcomes.set(s.id, { id: s.id, goal: s.goal, tier: (s.tier ?? knobs.worker_tier) as Tier, passed: false, verified: false, rounds: 0, objections: ["skipped: a step it depends on did not pass"], report: "", filesTouched: [] });
        break;
      }
      const wave = nextWave(ready, knobs.plan_parallel);
      const done = await Promise.all(wave.map(runOne));
      for (const d of done) outcomes.set(d.id, d);
      remaining = remaining.filter((s) => !wave.includes(s));

      // a step that cannot be made to pass invalidates the plan, not just the step
      const failed = done.filter((d) => !d.passed);
      if (failed.length && remaining.length && replans < knobs.replan_limit) {
        replans++;
        const revised = await replan(ctx, plan, failed, remaining, tag);
        usage = addUsage(usage, revised.usage); steps += revised.steps; costEquiv += revised.costEquiv;
        logPhase(ledger, "replan", {
          session: session.id, turn: session.turns.length, step: steps,
          note: `after ${failed.map((f) => f.id).join(",")}: ${revised.plan ? `${revised.plan.steps.length} new steps` : "planner kept the plan"}`,
          extra: { ...tag, phase: "replan", attempt: replans },
        });
        if (revised.plan) {
          say("replan", `${failed.map((f) => f.id).join(",")} failed — ${revised.plan.steps.length} revised steps`);
          remaining = revised.plan.steps.filter((s) => !outcomes.has(s.id) || !outcomes.get(s.id)!.passed);
          plan = { ...plan, steps: [...plan.steps.filter((s) => outcomes.get(s.id)?.passed), ...remaining] };
        }
      }
    }

    // --- rollup (deterministic: no model call to describe what we already know)
    const all = plan.steps.map((s) => outcomes.get(s.id)).filter(Boolean) as StepOutcome[];
    const passed = all.filter((o) => o.passed);
    const failedSteps = all.filter((o) => !o.passed);
    const files = [...new Set(all.flatMap((o) => o.filesTouched))];
    const lines: string[] = [];
    lines.push(failedSteps.length === 0
      ? `Done: ${passed.length}/${all.length} planned steps completed and independently verified.`
      : `Partly done: ${passed.length}/${all.length} steps verified, ${failedSteps.length} not.`);
    if (plan.goal) lines.push(`Goal: ${plan.goal}`);
    for (const o of all) {
      lines.push(`${o.passed ? "✓" : "✗"} ${o.id} ${o.goal}${o.rounds > 1 ? ` (${o.rounds} rounds)` : ""}`);
      if (!o.passed && o.objections.length) lines.push(`    unresolved: ${o.objections[0].slice(0, 200)}`);
    }
    if (files.length) lines.push(`Files changed: ${files.join(", ")}`);
    lines.push(`Verified by: ${all.filter((o) => o.verified).length} acceptance command(s) plus an independent verifier.`);
    if (failedSteps.length) lines.push(`Not verified: ${failedSteps.map((o) => o.id).join(", ")}.`);
    const text = lines.join("\n");

    session.state.notes = text.slice(0, 1200);
    logPhase(ledger, "strategy", {
      session: session.id, turn: session.turns.length, step: steps,
      note: `plan_verify: ${passed.length}/${all.length} verified, ${steps} model calls`,
      task_outcome: failedSteps.length === 0 ? "success" : "fail", cost_equiv: costEquiv,
      extra: { ...tag, phase: "strategy", planned: all.length, passed: passed.length, replans, digest_tokens: countTokens(text) },
    });

    return {
      strategy: "plan_verify", text, steps, usage, costEquiv,
      verified: failedSteps.length === 0,
      detail: { planned: all.length, passed: passed.length, replans, steps: all },
    };
  },
};

/** Independent verification: fresh context, evidence only, no edit tools. */
async function verify(ctx: StrategyContext, st: PlanStep, outcome: StepOutcome, tag: Record<string, unknown>) {
  const v = freshWorker(ctx.session, `v${st.id}-${Date.now().toString(36)}`, `verifier ${st.id}`);
  const ask =
    `Step under review (${st.id}): ${st.goal}\n` +
    `Acceptance command: ${st.acceptance || "(none was specified)"}\n` +
    (st.verify ? `What to check beyond the command: ${st.verify}\n` : "") +
    (outcome.filesTouched.length ? `Files the worker touched: ${outcome.filesTouched.join(", ")}\n` : "No file changes were recorded.\n") +
    `Acceptance output when it was run:\n${(outcome.acceptanceOutput ?? "(not run)").slice(0, 1500)}\n\n` +
    `Gather your own evidence and return the json verdict.`;
  const r = await runTurn({
    session: v, userText: ask, knobs: ctx.knobs, store: ctx.store, ledger: ctx.ledger, router: ctx.router,
    tier: ctx.knobs.verifier_tier as Tier, instructions: VERIFIER_INSTRUCTIONS, toolNames: ["run", "read", "recall"],
    maxSteps: 12, quiet: true, onEvent: ctx.onEvent, tag: { ...tag, phase: "verify", plan_step: st.id },
  });
  const j = extractJson<{ verdict?: string; objections?: unknown; evidence?: unknown }>(r.text);
  const objections = Array.isArray(j?.objections) ? j!.objections.map(String).filter(Boolean) : [];
  // An unparseable verdict is not a pass: silence fails closed.
  const pass = j?.verdict === "pass" && objections.length === 0;
  return {
    pass, objections: pass ? [] : objections.length ? objections : [j ? "verifier gave no reason" : "verifier did not return a usable verdict"],
    evidence: String(j?.evidence ?? r.text.slice(0, 300)), usage: r.usage, steps: r.steps, costEquiv: r.costEquiv,
  };
}

/** The planner revises what is left, seeing only the failure and the remainder. */
async function replan(ctx: StrategyContext, plan: Plan, failed: StepOutcome[], remaining: PlanStep[], tag: Record<string, unknown>) {
  const p = freshWorker(ctx.session, "rp" + Date.now().toString(36), "replanner");
  const ask =
    `Original goal: ${plan.goal}\n\nThese steps could not be made to pass:\n` +
    failed.map((f) => `- ${f.id} ${f.goal}\n  unresolved: ${f.objections.slice(0, 3).join("; ") || "acceptance kept failing"}\n  last output: ${(f.acceptanceOutput ?? "").slice(0, 400)}`).join("\n") +
    `\n\nSteps not started yet:\n${remaining.map((s) => `- ${s.id} ${s.goal}`).join("\n")}\n\n` +
    `Revise the remaining work: a json plan containing only the steps still to do (reuse ids where the step is unchanged, new ids otherwise). If the original remainder is still right, return it unchanged.`;
  const r = await runTurn({
    session: p, userText: ask, knobs: ctx.knobs, store: ctx.store, ledger: ctx.ledger, router: ctx.router, tier: "T4",
    instructions: PLANNER_INSTRUCTIONS, toolNames: ["run", "read", "recall"],
    maxSteps: Math.max(4, Math.floor(ctx.knobs.plan_max_steps / 2)), quiet: true, onEvent: ctx.onEvent,
    tag: { ...tag, phase: "replan" },
  });
  const parsed = validatePlan(extractJson<any>(r.text), ctx.knobs);
  return { plan: parsed.plan, usage: r.usage, steps: r.steps, costEquiv: r.costEquiv };
}
