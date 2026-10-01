/**
 * The agent loop with per-turn rebuild:
 *   model sees  F' (fixed prompt) + digest(S) + folded window + user message + this turn's steps
 * Inside a turn: append-only; ctx-core folds in batches when the budget is exceeded.
 * At turn end: state S is updated (deterministic + model notes), the turn's items are
 * folded into a window of stubs for the next turn, the transcript goes to the store.
 */
import { join } from "node:path";
import { rewrite, newRewriteState } from "../core/rewrite.js";
import { ArtifactStore } from "../core/artifacts.js";
import { knobsFor, resolveKnobs, type Knobs } from "../core/knobs.js";
import { Ledger } from "../core/ledger.js";
import { buildSummary, renderSummary } from "../core/summary.js";
import { parseInput } from "../core/items.js";
import { countTokens } from "../core/tokens.js";
import { TOOL_DEFS, executeTool, type ToolContext } from "./tools.js";
import { Router, taskClassOf, type Tier } from "./router.js";
import { saveSession, type SessionData, type TurnRecord } from "./session.js";
import type { ModelResponse } from "./providers.js";

export const FIXED_PROMPT = `You are a coding agent working in the user's workspace with a small set of tools.
Rules that save tokens and time:
- run(cmd) blocks until the command exits. Never poll: for long processes use run(background=true) then wait(job, until=regex|silence). Do not sleep, ps, or re-run a command just to check progress.
- Issue independent tool calls together in one response (several reads or greps at once).
- Do not re-read files you have not changed; earlier outputs you no longer see verbatim are summarized as stubs like [output #id …] — use recall(id, grep=…) when you actually need the detail.
- Keep tool output small: prefer targeted reads (line ranges), grep with limits, and test commands that print only failures.
- Prefer delegate(task, inputs, acceptance) for bounded, self-contained subtasks (locate X, run tests and report, mechanical edits).
- Do not send commentary-only responses; every response either calls tools or gives the final answer.
- Before giving the final answer, call state_update(notes) with durable notes: decisions, facts with artifact ids, open questions, next step (under 300 tokens).
- Final answers: lead with the outcome, name files changed, say what was verified and what was not.`;

export interface TurnOptions {
  session: SessionData; userText: string; knobs?: Knobs; store?: ArtifactStore; ledger?: Ledger; router?: Router;
  tier?: Tier; maxSteps?: number; onText?: (t: string) => void; onEvent?: (e: { kind: string; detail: string }) => void; quiet?: boolean;
}

export interface TurnResult { text: string; steps: number; usage: { input: number; cached: number; output: number; reasoning: number }; costEquiv: number; items: any[] }

function digestItem(session: SessionData, foldedCount: number): any {
  let text = renderSummary(session.state, foldedCount);
  if (session.merged.length) text += "\n" + session.merged.map((m) => `[merged from branch "${m.fromTitle}" at ${m.at.slice(0, 16)}]\n${m.text}`).join("\n");
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  const session = o.session;
  const knobs = o.knobs ?? resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), session.knobs as any);
  const store = o.store ?? new ArtifactStore();
  const ledger = o.ledger ?? new Ledger();
  const router = o.router ?? new Router(knobs, ledger);
  const tier = o.tier ?? "T4";
  const route = router.route(tier, session.turns.length === 0 ? "plan" : "execute");
  const client = router.client(route.model);
  const turnIdx = session.turns.length;
  const rec: TurnRecord = { idx: turnIdx, user: o.userText, steps: 0, startedAt: new Date().toISOString(), usage: { input: 0, cached: 0, output: 0, reasoning: 0 } };
  session.turns.push(rec);

  const ctx: ToolContext = { cwd: session.cwd, knobs, store, sessionId: session.id, filesTouched: new Set(session.state.filesTouched), readCache: new Map(), cmdCache: new Map(), jobs: new Map(), onEvent: o.onEvent };
  if (tier === "T4") ctx.delegate = (task, inputs, acceptance) => delegateTask({ parent: session, task, inputs, acceptance, knobs, store, ledger, router, onEvent: o.onEvent });

  // --- per-turn rebuild ------------------------------------------------------
  const base: any[] = [];
  if (session.turns.length > 1 || session.merged.length) base.push(digestItem(session, session.window.filter((x) => x.type === "function_call_output").length));
  base.push(...session.window);
  const items: any[] = [...base, { type: "message", role: "user", content: [{ type: "input_text", text: o.userText }] }];
  const rwState = { ...newRewriteState(session.id + ":" + turnIdx), stubs: session.rewriteState.stubs, userMsgCount: 0 };
  const toolDefs = tier === "T4" ? TOOL_DEFS : TOOL_DEFS.filter((t) => t.name !== "delegate");
  let finalText = ""; let steps = 0; let costEquiv = 0; let notes: string | undefined;
  const maxSteps = o.maxSteps ?? route.maxSteps;

  while (steps < maxSteps) {
    const rw = rewrite(items, { knobs, store, state: rwState, now: Date.now(), settingsHash: route.model + route.effort });
    let resp: ModelResponse;
    try {
      resp = await client.respond({ model: route.model, instructions: FIXED_PROMPT, input: rw.input, tools: toolDefs, reasoningEffort: route.effort, promptCacheKey: session.id, onText: o.onText });
    } catch (e: any) {
      finalText = `[model error] ${e?.message ?? e}`; break;
    }
    steps++; rec.steps = steps;
    rec.usage.input += resp.usage.input; rec.usage.cached += resp.usage.cached; rec.usage.output += resp.usage.output; rec.usage.reasoning += resp.usage.reasoning;
    const row = { source: "harness" as const, session: session.id, turn: turnIdx, step: steps, model: route.model, input: resp.usage.input, cached: resp.usage.cached, uncached: resp.usage.input - resp.usage.cached, output: resp.usage.output, reasoning: resp.usage.reasoning, ctx_before: rw.stats.tokensBefore, ctx_after: rw.stats.tokensAfter, event: rw.stats.compacted ? "compact" as const : "response" as const, cache_state: rw.stats.cacheState, tool_kind: resp.calls[0]?.name, extra: { folded: rw.stats.folded, shaped: rw.stats.shaped, compact_reason: rw.stats.compactReason, tier } };
    ledger.append(row); costEquiv += resp.usage.cached * 0.1 + (resp.usage.input - resp.usage.cached) + resp.usage.output * 8;
    items.push(...resp.output);
    if (resp.calls.length === 0) { finalText = resp.text; break; }
    if (!o.quiet && resp.text) o.onEvent?.({ kind: "commentary", detail: resp.text.slice(0, 200) });
    const outputs = await Promise.all(resp.calls.map(async (c) => {
      o.onEvent?.({ kind: "tool", detail: `${c.name} ${JSON.stringify(c.args).slice(0, 120)}` });
      if (c.name === "state_update") notes = String(c.args.notes ?? "");
      const out = await executeTool(ctx, c.name, c.args, c.callId);
      return { type: "function_call_output", call_id: c.callId, output: out };
    }));
    items.push(...outputs);
  }
  if (!finalText && steps >= maxSteps) finalText = `[stopped after ${maxSteps} steps]`;

  // --- turn end: update state, fold window, persist -----------------------------
  const parsed = parseInput(items);
  const turnSummary = buildSummary(parsed, { ...session.state, notes: notes ?? session.state.notes });
  const norm = (f: string) => (f.startsWith("/") ? f : join(session.cwd, f));
  session.state = { ...turnSummary, filesTouched: [...new Set([...session.state.filesTouched, ...turnSummary.filesTouched, ...ctx.filesTouched].map(norm))].slice(-40), turns: turnIdx + 1, notes: notes ?? session.state.notes };
  const transcript = store.put(JSON.stringify(items, null, 1), "transcript", `${session.id}:turn${turnIdx}`);
  if (knobs.use_model_summary && tier === "T4") {
    try {
      const t2 = router.route("T2");
      const brief = items.map((x) => x.type === "function_call" ? `CALL ${x.name} ${String(x.arguments).slice(0, 160)}` : x.type === "function_call_output" ? `OUT ${String(typeof x.output === "string" ? x.output : JSON.stringify(x.output)).slice(0, 300)}` : x.type === "message" ? `${x.role.toUpperCase()}: ${(Array.isArray(x.content) ? x.content.map((c: any) => c?.text ?? "").join("") : String(x.content)).slice(0, 400)}` : "").filter(Boolean).join("\n").slice(0, 24000);
      const r = await router.client(t2.model).respond({ model: t2.model, instructions: "Summarize this coding-agent turn in at most 150 tokens: goal, what changed (files), what was verified, open issues. Facts only, no advice.", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: brief }] }], tools: [], reasoningEffort: t2.effort, maxOutputTokens: 400 });
      if (r.text) session.state.modelSummary = r.text.trim().slice(0, 1200);
      ledger.append({ source: "harness", session: session.id, turn: turnIdx, step: steps, model: t2.model, input: r.usage.input, cached: r.usage.cached, uncached: r.usage.input - r.usage.cached, output: r.usage.output, event: "response", note: "T2 summary", extra: { tier: "T2" } });
    } catch (e: any) { o.onEvent?.({ kind: "warn", detail: `T2 summary failed: ${e?.message ?? e}` }); }
  }
  rec.endedAt = new Date().toISOString(); rec.transcriptArtifact = transcript.id; rec.finalText = finalText.slice(0, 600);
  // fold everything from this turn into stubs; carry only the last `window` observations
  const foldState = { ...newRewriteState(session.id + ":fold" + turnIdx), stubs: rwState.stubs, userMsgCount: 0 };
  const folded = rewrite(items.filter((x) => x.type !== "message" || x.role !== "user" || !String(x.content?.[0]?.text ?? "").startsWith("[context digest")), { knobs: { ...knobs, window: knobs.window, compact_on_turn_start: "always_if_over", turn_start_threshold: 0 }, store, state: foldState, now: Date.now(), forceCompact: true });
  const carry = folded.input.filter((x) => x.type === "function_call" || x.type === "function_call_output");
  session.window = carry.slice(-2 * knobs.window);
  session.rewriteState.stubs = { ...session.rewriteState.stubs, ...rwState.stubs, ...foldState.stubs };
  saveSession(session);
  ledger.append({ source: "harness", session: session.id, turn: turnIdx, step: steps, event: "keep", note: `turn end: window ${session.window.length} items, digest ${countTokens(renderSummary(session.state, 0))} tok`, cost_equiv: costEquiv });
  return { text: finalText, steps, usage: rec.usage, costEquiv, items };
}

export interface DelegateOptions { parent: SessionData; task: string; inputs: string; acceptance?: string; knobs: Knobs; store: ArtifactStore; ledger: Ledger; router: Router; onEvent?: (e: { kind: string; detail: string }) => void }

/** T3 subtask in a fresh context with escalation. Returns a short report. */
export async function delegateTask(d: DelegateOptions): Promise<string> {
  const cls = taskClassOf(d.task);
  const worker: SessionData = { ...JSON.parse(JSON.stringify(d.parent)), id: d.parent.id + ":w" + Date.now().toString(36), title: "worker", turns: [], window: [], merged: [], state: { filesTouched: [], commandsByKind: {}, errorsSeen: [], turns: 0 }, rewriteState: newRewriteState("w") };
  const prompt = `Subtask: ${d.task}\n\nInputs:\n${d.inputs}\n\n${d.acceptance ? `Acceptance (must exit 0): ${d.acceptance}\n\n` : ""}Work only on this subtask. Finish with a report under 300 words: what you found or changed (files, line numbers), how you verified it, anything the caller must know.`;
  let last = "";
  for (const tier of d.router.ladder(cls)) {
    const r = await runTurn({ session: worker, userText: prompt, knobs: d.knobs, store: d.store, ledger: d.ledger, router: d.router, tier, maxSteps: d.router.route(tier).maxSteps, onEvent: d.onEvent, quiet: true });
    last = r.text;
    let ok = true;
    if (d.acceptance) {
      const ctx: ToolContext = { cwd: d.parent.cwd, knobs: d.knobs, store: d.store, sessionId: worker.id, filesTouched: new Set(), readCache: new Map(), cmdCache: new Map(), jobs: new Map() };
      const out = await executeTool(ctx, "run", { cmd: d.acceptance, timeout_s: 600 }, "acc");
      ok = out.startsWith("[exit 0]");
      last += `\n[acceptance ${ok ? "passed" : "FAILED"}: ${out.slice(0, 400)}]`;
    }
    d.router.recordOutcome(cls, tier, ok);
    d.onEvent?.({ kind: "delegate", detail: `${cls} on ${tier}: ${ok ? "ok" : "failed"} (${r.steps} steps, ${r.usage.input} in / ${r.usage.output} out)` });
    if (ok) break;
    d.onEvent?.({ kind: "delegate", detail: `escalating ${cls}` });
  }
  const meta = d.store.put(last, "delegate", cls);
  let report = last;
  if (countTokens(report) > 500) report = report.slice(0, 1600) + `\n[report truncated → recall("${meta.id}")]`;
  for (const f of worker.state.filesTouched) if (!d.parent.state.filesTouched.includes(f)) d.parent.state.filesTouched.push(f);
  return `[delegate report (${cls})]\n` + report;
}

export { join };
