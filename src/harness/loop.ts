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
import { ALL_TOOL_DEFS, TOOL_DEFS, MULTI_TURN_TOOL_DEFS, executeTool, type ToolContext } from "./tools.js";
import { MULTI_TURN_PROMPT, assembleInput, capCarried, mergedBlocks, renderBriefing, workspaceDigest } from "./assemble.js";
import { decideTurn, gateFeatures, mentionedFiles, type GateAction, type GateDecision } from "./gate.js";
import { appendAnswer, appendUser, checkUserFidelity, readTranscript, renderTranscript, ruleCard, userTextTokens, type AnswerEntry, type UserEntry } from "../transcript/index.js";
import { MemoryStore, projectOf, type MemoryEntry } from "../memory/store.js";
import { candidates as memoryCandidates, pinnedWithin, renderMemoryBriefing } from "../memory/recall.js";
import { addUnlessDuplicate, applyExtracted, modelExtract, ruleExtract } from "../memory/write.js";
import { discoverSkills, loadSkillBody, projectInstructions, renderSkillIndex, type Skill } from "../skills/index.js";
import { memorySettings, type MemorySettings } from "../upstream/config.js";
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
  /** replace the fixed prompt (planner and verifier agents have their own) */
  instructions?: string;
  /** restrict the tool set, e.g. a planner that must not edit, a verifier that must not fix */
  toolNames?: string[];
  /** merged into every ledger row's `extra`, so a strategy's rows can be told apart */
  tag?: Record<string, unknown>;
  /** multi-turn mode (transcript, gate, memory, skills). Default: on for plain T4 turns, off for
   *  strategies (custom instructions / tool sets) and delegate workers. */
  multiTurn?: boolean;
  /** user command: /continue or /new forces the gate */
  gateAction?: GateAction;
  /** injected for tests; otherwise opened from settings */
  memory?: MemoryStore | null;
  memorySettings?: MemorySettings;
  skills?: Skill[];
}

export interface TurnResult { text: string; steps: number; usage: { input: number; cached: number; output: number; reasoning: number }; costEquiv: number; items: any[]; gate?: GateDecision; fidelity?: boolean; memory?: { recalled: string[]; written: string[]; misses: string[] } }

let sharedMemory: MemoryStore | null | undefined;
/** one store per process; null when it cannot be opened (memory is then off for the run) */
export function openMemory(): MemoryStore | null {
  if (sharedMemory !== undefined) return sharedMemory;
  try { sharedMemory = new MemoryStore(); } catch { sharedMemory = null; }
  return sharedMemory;
}

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

  const multiTurn = o.multiTurn ?? (tier === "T4" && !o.instructions && !o.toolNames);
  let finalText = ""; let steps = 0; let costEquiv = 0; let notes: string | undefined;
  const maxSteps = o.maxSteps ?? route.maxSteps;
  let items: any[]; let instructions: string; let toolDefs; let stepKnobs = knobs;
  let mt: MultiTurnState | undefined;

  if (multiTurn) {
    mt = await prepareMultiTurn({ o, session, knobs, store, ledger, router, turnIdx, ctx });
    items = mt.items; instructions = mt.instructions; toolDefs = MULTI_TURN_TOOL_DEFS;
    // the gate already decided what to carry; inside the turn only the budget fold applies
    stepKnobs = { ...knobs, compact_on_turn_start: "never" };
  } else {
    // --- per-turn rebuild (single-task mode: strategies, workers) ---------------
    const base: any[] = [];
    if (session.turns.length > 1 || session.merged.length) base.push(digestItem(session, session.window.filter((x) => x.type === "function_call_output").length));
    base.push(...session.window);
    items = [...base, { type: "message", role: "user", content: [{ type: "input_text", text: o.userText }] }];
    instructions = o.instructions ?? FIXED_PROMPT;
    toolDefs = tier === "T4" ? TOOL_DEFS : TOOL_DEFS.filter((t) => t.name !== "delegate");
    // from every registered tool, not just the default set: vibe mode names tools that
    // are deliberately absent from it
    if (o.toolNames) toolDefs = ALL_TOOL_DEFS.filter((t) => o.toolNames!.includes(t.name));
  }
  const rwState = { ...newRewriteState(session.id + ":" + turnIdx), stubs: session.rewriteState.stubs, userMsgCount: 0 };
  let fidelityOk = true;

  while (steps < maxSteps) {
    const rw = rewrite(items, { knobs: stepKnobs, store, state: rwState, now: Date.now(), settingsHash: route.model + route.effort });
    if (mt) {
      const f = checkUserFidelity(rw.input, mt.userEntries);
      if (!f.ok) {
        fidelityOk = false;
        ledger.append({ source: "harness", session: session.id, turn: turnIdx, step: steps + 1, event: "fidelity", note: `user words missing from the request: ${f.missing.map((m) => `turn ${m.turn}: "${m.words.slice(0, 60)}"`).join("; ")}`.slice(0, 1000) });
        o.onEvent?.({ kind: "warn", detail: `user-words fidelity violated (${f.missing.length} segment(s)); see ledger` });
      }
    }
    let resp: ModelResponse;
    try {
      resp = await client.respond({ model: route.model, instructions, input: rw.input, tools: toolDefs, reasoningEffort: route.effort, promptCacheKey: session.id, onText: o.onText });
    } catch (e: any) {
      finalText = `[model error] ${e?.message ?? e}`; break;
    }
    steps++; rec.steps = steps;
    rec.usage.input += resp.usage.input; rec.usage.cached += resp.usage.cached; rec.usage.output += resp.usage.output; rec.usage.reasoning += resp.usage.reasoning;
    const row = { source: "harness" as const, session: session.id, turn: turnIdx, step: steps, model: route.model, input: resp.usage.input, cached: resp.usage.cached, uncached: resp.usage.input - resp.usage.cached, output: resp.usage.output, reasoning: resp.usage.reasoning, ctx_before: rw.stats.tokensBefore, ctx_after: rw.stats.tokensAfter, event: rw.stats.compacted ? "compact" as const : "response" as const, cache_state: rw.stats.cacheState, tool_kind: resp.calls[0]?.name, extra: { folded: rw.stats.folded, shaped: rw.stats.shaped, compact_reason: rw.stats.compactReason, tier, ...(mt && steps === 1 ? { segments: mt.segments, gate: mt.gate.action } : {}), ...o.tag } };
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
  let memoryOut: TurnResult["memory"];
  if (mt) memoryOut = await finishMultiTurn({ o, mt, session, knobs, store, ledger, router, turnIdx, ctx, finalText, items, steps });
  saveSession(session);
  ledger.append({ source: "harness", session: session.id, turn: turnIdx, step: steps, event: "keep", note: `turn end: window ${session.window.length} items, digest ${countTokens(renderSummary(session.state, 0))} tok`, cost_equiv: costEquiv });
  return { text: finalText, steps, usage: rec.usage, costEquiv, items, gate: mt?.gate, fidelity: mt ? fidelityOk : undefined, memory: memoryOut };
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

// ---------------------------------------------------------------------------------------------
// Multi-turn mode (docs/MEMORY_DESIGN.md): transcript, gate, memory, skills
// ---------------------------------------------------------------------------------------------

interface MultiTurnState {
  items: any[];
  instructions: string;
  userEntries: { turn: number; text: string }[];
  gate: GateDecision;
  segments: Record<string, number>;
  memory: MemoryStore | null;
  settings: MemorySettings;
  project: string;
  skills: Skill[];
  filesBefore: Set<string>;
  pinned: MemoryEntry[];
}

interface MultiTurnArgs { o: TurnOptions; session: SessionData; knobs: Knobs; store: ArtifactStore; ledger: Ledger; router: Router; turnIdx: number; ctx: ToolContext }

async function prepareMultiTurn(a: MultiTurnArgs): Promise<MultiTurnState> {
  const { o, session, knobs, store, ledger, router, turnIdx, ctx } = a;
  const entries = readTranscript(session.id);
  appendUser(session.id, turnIdx, o.userText);   // the user's words are on disk before anything can fail
  const settings = o.memorySettings ?? memorySettings();
  const memory = settings.recall || settings.write ? (o.memory !== undefined ? o.memory : openMemory()) : null;
  const project = projectOf(session.cwd);
  const skills = o.skills ?? discoverSkills(session.cwd, project);
  const users = entries.filter((e): e is UserEntry => e.kind === "user");
  const answers = entries.filter((e): e is AnswerEntry => e.kind === "answer");
  const prevUser = users.at(-1)?.text;
  const prevAnswer = answers.at(-1);

  // --- memory candidates -------------------------------------------------------------------
  let pinned: MemoryEntry[] = []; let cands: ReturnType<typeof memoryCandidates> = [];
  if (memory && settings.recall) {
    pinned = pinnedWithin(memory, knobs.memory_l0_budget, project).shown;
    cands = memoryCandidates(memory, { query: `${o.userText}\n${prevUser ?? ""}`, files: [...mentionedFiles(o.userText), ...session.state.filesTouched], project, limit: knobs.memory_candidates, exclude: new Set(pinned.map((e) => e.id)) });
    memory.refreshStaleness([...pinned, ...cands.map((c) => c.entry)]);
  }

  // --- gate -----------------------------------------------------------------------------------
  const features = gateFeatures({ userText: o.userText, prevUser, prevAnswer: prevAnswer?.card || prevAnswer?.text, lastEndedAt: session.turns[turnIdx - 1]?.endedAt, hasWindow: session.window.length > 0, filesTouched: session.state.filesTouched, ttlS: knobs.cache_ttl_estimate_s, explicit: o.gateAction });
  const small = router.route("T1");
  const gate = await decideTurn({ userText: o.userText, prevUser, prevAnswer: prevAnswer?.card || prevAnswer?.text, features, candidates: cands, skills, knobs, client: router.client(small.model), model: small.model });
  ledger.append({ source: "harness", session: session.id, turn: turnIdx, step: 0, event: "gate", model: gate.modelCalled ? small.model : undefined, input: gate.usage?.input, cached: gate.usage?.cached, uncached: gate.usage ? gate.usage.input - gate.usage.cached : undefined, output: gate.usage?.output, note: `${gate.action} by ${gate.by}: ${gate.why}`, extra: { action: gate.action, by: gate.by, model_called: gate.modelCalled, latency_ms: gate.latencyMs, topic_sim: +features.topicSim.toFixed(3), back_ref: features.backRef, cache_warm: features.cacheWarm, idle_s: Number.isFinite(features.idleS) ? Math.round(features.idleS) : null, files_overlap: features.filesOverlap, candidates: cands.length, skills: gate.skills, ...o.tag } });
  o.onEvent?.({ kind: "gate", detail: `${gate.action} (${gate.by}: ${gate.why})` });

  // --- memory briefing --------------------------------------------------------------------------
  const shown = new Set<string>();
  let memoryText: string | undefined;
  if (memory && settings.recall) {
    const byId = new Map(cands.map((c) => [c.entry.id, memory.get(c.entry.id) ?? c.entry]));
    const detail = gate.detailIds.map((id) => byId.get(id)).filter((e): e is MemoryEntry => !!e);
    const index = gate.memoryIds.filter((id) => !gate.detailIds.includes(id)).map((id) => byId.get(id)).filter((e): e is MemoryEntry => !!e);
    const b = renderMemoryBriefing(memory, { pinned: pinned.map((e) => memory.get(e.id) ?? e), index, detail });
    if (b.pinned.length + b.index.length + b.detail.length) memoryText = b.text;
    for (const id of [...b.pinned, ...b.index, ...b.detail]) shown.add(id);
    for (const id of b.detail) memory.touch(id);
  }

  // --- skills preloaded by the gate -----------------------------------------------------------
  const preloaded = gate.skills.map((n) => skills.find((s) => s.name === n)).filter((s): s is Skill => !!s && !s.missing.length);
  const skillText = preloaded.length ? preloaded.map((s) => loadSkillBody(s)).join("\n\n") : undefined;

  // --- user words budget: warn, never drop ---------------------------------------------------------
  const userTok = userTextTokens([...entries, { kind: "user", turn: turnIdx, at: "", text: o.userText, sha1: "" }]);
  const warning = userTok > knobs.user_text_budget ? `(note to assistant: this conversation's user messages total ${userTok} tokens; if the user asks about cost or speed, suggest /fork or a new session — memories carry over)` : undefined;
  if (warning) o.onEvent?.({ kind: "warn", detail: `user messages total ${userTok} tokens (> ${knobs.user_text_budget}); consider /fork or a new session` });

  // --- assemble -----------------------------------------------------------------------------------
  const transcriptItems = renderTranscript(entries, knobs, store);
  const carried = gate.action === "continue" ? capCarried(session.window, knobs.continue_budget) : [];
  const gateNote = gate.action === "continue" && carried.length
    ? "The previous turn's tool calls and outputs are included above (older ones as stubs)."
    : turnIdx > 0 ? "Earlier tool work is not shown verbatim; the workspace state and memories below summarize it, and recall(id) in earlier answers expands it." : undefined;
  const briefing = renderBriefing({ gate: gateNote, workspace: workspaceDigest(session), merged: mergedBlocks(session), memory: memoryText, skills: skillText, userTextWarning: warning });
  const asm = assembleInput({ transcript: transcriptItems, carried, briefing, userText: o.userText });
  const instructions = [MULTI_TURN_PROMPT, renderSkillIndex(skills, knobs.skill_index_budget), projectInstructions(session.cwd, project, knobs.project_doc_budget)].filter(Boolean).join("\n\n");

  Object.assign(ctx, {
    memory, memoryRecall: !!memory && settings.recall, memoryWrite: !!memory && settings.write,
    memoryShown: shown, memoryUsed: new Set<string>(), memoryMisses: [], remembered: [],
    project, turn: turnIdx, skills, skillsLoaded: preloaded.map((s) => s.name),
  });
  return {
    items: asm.input, instructions, gate, memory, settings, project, skills, pinned,
    segments: { S1: countTokens(instructions), ...asm.segments },
    userEntries: [...users.map((u) => ({ turn: u.turn, text: u.text })), { turn: turnIdx, text: o.userText }],
    filesBefore: new Set(ctx.filesTouched),
  };
}

export const CARD_PROMPT = "Condense this assistant answer into a card of at most 80 words: the outcome, files changed, what was verified, open items. Plain text, no preamble.";

async function finishMultiTurn(a: MultiTurnArgs & { mt: MultiTurnState; finalText: string; items: any[]; steps: number }): Promise<{ recalled: string[]; written: string[]; misses: string[] }> {
  const { o, mt, session, knobs, store, ledger, router, turnIdx, ctx, finalText, items, steps } = a;
  const rel = (f: string) => (f.startsWith(session.cwd + "/") ? f.slice(session.cwd.length + 1) : f);
  const filesChanged = [...ctx.filesTouched].filter((f) => !mt.filesBefore.has(f)).map(rel);
  const art = finalText ? store.put(finalText, "answer", `${session.id}:turn${turnIdx}`) : undefined;
  const small = router.route("T2");
  let card = knobs.answer_card_model ? null : ruleCard(finalText, filesChanged, art?.id);
  if (!card && finalText) {
    try {
      const r = await router.client(small.model).respond({ model: small.model, instructions: CARD_PROMPT, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: finalText.slice(0, 12000) }] }], tools: [], reasoningEffort: "low", maxOutputTokens: 300 });
      card = `[answer card] ${r.text.trim()}${art ? ` · full: recall("${art.id}")` : ""}`;
      ledger.append({ source: "harness", session: session.id, turn: turnIdx, step: steps, event: "response", model: small.model, input: r.usage.input, cached: r.usage.cached, uncached: r.usage.input - r.usage.cached, output: r.usage.output, note: "answer card", extra: { tier: "T2" } });
    } catch { card = `[answer card] ${finalText.slice(0, 300)}…${art ? ` · full: recall("${art.id}")` : ""}`; }
  }
  appendAnswer(session.id, { turn: turnIdx, artifact: art?.id, text: finalText, card: card ?? "", filesChanged, status: finalText.startsWith("[model error]") ? "error" : finalText.startsWith("[stopped") ? "stopped" : "done" });

  const written: string[] = [...(ctx.remembered ?? [])];
  const memory = mt.memory;
  if (memory && mt.settings.write) {
    for (const m of ruleExtract(o.userText)) written.push(addUnlessDuplicate(memory, { ...m, project: mt.project, source: { session: session.id, turn: turnIdx, by: "user" } }).entry.id);
    const worth = finalText && !finalText.startsWith("[model error]") && (steps > 1 || finalText.length > 200);
    if (knobs.memory_extract && worth) {
      try {
        const existing = [...new Map([...memory.search(o.userText, { limit: 15 }).map((h) => h.entry), ...mt.pinned].map((e) => [e.id, e])).values()];
        const toolSummary = items.filter((x) => x.type === "function_call").map((x) => `${x.name} ${String(x.arguments ?? "").replace(/\s+/g, " ").slice(0, 140)}`).join("\n");
        const r = await modelExtract(router.client(small.model), small.model, { userText: o.userText, answer: finalText, toolSummary, existing });
        ledger.append({ source: "harness", session: session.id, turn: turnIdx, step: steps, event: "response", model: small.model, input: r.usage.input, cached: r.usage.cached, uncached: r.usage.input - r.usage.cached, output: r.usage.output, note: "memory extract", extra: { tier: "T2" } });
        written.push(...applyExtracted(memory, r.items, { session: session.id, turn: turnIdx, project: mt.project, cwd: session.cwd }));
      } catch (e: any) { o.onEvent?.({ kind: "warn", detail: `memory extraction failed: ${e?.message ?? e}` }); }
    }
  }
  const recalled = [...(ctx.memoryShown ?? [])];
  const misses = [...(ctx.memoryMisses ?? [])];
  ledger.append({ source: "harness", session: session.id, turn: turnIdx, step: steps, event: "memory", note: `shown ${recalled.length}, used ${ctx.memoryUsed?.size ?? 0}, missed ${misses.length}, written ${new Set(written).size}`, extra: { shown: recalled, used: [...(ctx.memoryUsed ?? [])], misses, written: [...new Set(written)], skills_loaded: ctx.skillsLoaded ?? [], recall_on: mt.settings.recall, write_on: mt.settings.write } });
  return { recalled, written: [...new Set(written)], misses };
}
