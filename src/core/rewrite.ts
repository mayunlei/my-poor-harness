/**
 * rewrite(): the pure, idempotent context rewrite pass.
 *
 * Given a Responses API `input` array as the client would send it, produce the
 * array the model should actually see. Rules (see DESIGN.md 3.5 / 4.2):
 *   - append-only within a turn; folding only at turn start (judge) or when the
 *     turn budget is exceeded; the fold boundary is monotonic and keyed by call_id
 *     so the same history always rewrites the same way (cache-stable prefix).
 *   - every tool output is shaped deterministically (per-output cap, failure
 *     fields preserved); the raw text goes to the ArtifactStore.
 *   - consecutive empty polls collapse to first+last; repeated identical reads
 *     become "unchanged" stubs; reasoning items before the boundary are dropped.
 */
import { parseInput, toResponsesInput, sha1, type Item, type OutputItem, type CallItem, type StubItem, type Tag } from "./items.js";
import { countTokens } from "./tokens.js";
import { shapeOutput, isEmptyPoll } from "./shapers.js";
import { shaperKnobs, type Knobs } from "./knobs.js";
import { ArtifactStore } from "./artifacts.js";
import { estimateCacheState, type CacheState } from "./cache_state.js";
import { judge, lexicalSimilarity, type JudgeDecision } from "./judge.js";
import { buildSummary, renderSummary, type StateSummary } from "./summary.js";

/**
 * Fixed-prefix diet for known client boilerplate (Codex Desktop). Deterministic:
 * drops whole injected blocks that only list plugins/apps/memory digests, and cuts
 * sections of the desktop developer block that are irrelevant to coding.
 */
const DROP_USER_BLOCKS = ["<recommended_plugins>", "<apps_instructions>"];
const CUT_SECTIONS = ["## Examples (inbox-item)", "## What's in Memory", "### Older Memory Topics", "## Plugins", "### How to use plugins", "## Apps (Connectors)", "### Available skills"];
export function trimFixedPrefix(items: Item[], mode: string): { items: Item[]; saved: number } {
  if (mode === "none") return { items, saved: 0 };
  let saved = 0;
  const n = fixedPrefixLength(items);
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i >= n) { out.push(it); continue; }
    if (it.kind === "user" && DROP_USER_BLOCKS.some((b) => it.text.startsWith(b))) { saved += countTokens(it.text); continue; }
    if (it.kind === "system" && it.role === "developer" && it.text.length > 4000) {
      let text = it.text;
      for (const sec of CUT_SECTIONS) {
        const idx = text.indexOf("\n" + sec);
        if (idx < 0) continue;
        const level = sec.startsWith("### ") ? "### " : "## ";
        // cut until the next heading of the same or higher level
        const rest = text.slice(idx + 1 + sec.length);
        const m = level === "### " ? /\n(?:##|###) /.exec(rest) : /\n## /.exec(rest);
        const end = m ? idx + 1 + sec.length + m.index : text.length;
        text = text.slice(0, idx) + "\n" + sec + "\n[section trimmed by harness]" + text.slice(end);
      }
      if (text !== it.text) { saved += countTokens(it.text) - countTokens(text); out.push({ ...it, text, raw: { ...it.raw, content: [{ type: "input_text", text }] } }); continue; }
    }
    out.push(it);
  }
  return { items: out, saved };
}

export interface RewriteState {
  sessionId: string;
  foldedThroughCallId?: string;
  summary?: StateSummary;
  stubs: Record<string, { artifactId: string; text: string }>;
  stepsSinceCompact: number;
  prevTurnSteps: number;
  currentTurnSteps: number;
  turnIndex: number;
  lastRequestAt?: number;
  lastSettingsHash?: string;
  lastPrefixHash?: string;
  lastUserText?: string;
  compactions: number;
  userMsgCount?: number;
  /** reasoning items with id in this set (or older than reasoningDropThroughId) are dropped */
  reasoningDropThroughId?: string;
}

export function newRewriteState(sessionId: string): RewriteState {
  return { sessionId, stubs: {}, stepsSinceCompact: 1e9, prevTurnSteps: 0, currentTurnSteps: 0, turnIndex: -1, compactions: 0 };
}

export interface RewriteStats {
  tokensBefore: number;
  tokensAfter: number;
  fixedPrefixTokens: number;
  prefixTrimmed: number;
  outputs: number;
  shaped: number;
  shapedSaved: number;
  pollsCollapsed: number;
  readsDeduped: number;
  folded: number;
  reasoningDropped: number;
  compacted: boolean;
  compactReason?: string;
  decision?: JudgeDecision;
  cacheState: CacheState;
  idleS: number;
  isTurnStart: boolean;
  turnIndex: number;
}

export interface RewriteContext {
  knobs: Knobs;
  store: ArtifactStore;
  state: RewriteState;
  now?: number;
  settingsHash?: string;
  topicSimilarity?: number;
  /** force a fold regardless of judge (e.g. explicit /compact) */
  forceCompact?: boolean;
}

/** encrypted reasoning payload chars per billed reasoning token (calibrated on recorded sessions) */
export let REASONING_CHARS_PER_TOKEN = 8;
export function setReasoningCharsPerToken(v: number) { REASONING_CHARS_PER_TOKEN = v; }

function itemTokens(it: Item): number {
  switch (it.kind) {
    case "system": case "user": case "assistant": return countTokens(it.text) + 4;
    case "call": return countTokens(it.args) + countTokens(it.tool) + 8;
    case "output": return countTokens(it.text) + 8;
    case "stub": return countTokens(it.summary) + 8;
    case "reasoning": return (typeof it.raw?.encrypted_content === "string" ? Math.min(6000, Math.ceil(it.raw.encrypted_content.length / REASONING_CHARS_PER_TOKEN)) : countTokens(JSON.stringify(it.raw?.summary ?? ""))) + 4;
    default: {
      if (it.raw?.type === "agent_message" && Array.isArray(it.raw.content)) {
        // multi-agent messages carry their payload as encrypted content: count it like reasoning, not as JSON text
        return it.raw.content.reduce((a: number, c: any) => a + (typeof c?.encrypted_content === "string" ? Math.min(6000, Math.ceil(c.encrypted_content.length / REASONING_CHARS_PER_TOKEN)) : countTokens(c?.text ?? "")), 0) + 8;
      }
      return countTokens(JSON.stringify(it.raw)) + 4;
    }
  }
}

function isInjectedUser(it: Item): boolean {
  return it.kind === "user" && (it.text.startsWith("<") || it.text.startsWith("# AGENTS.md"));
}

function fixedPrefixLength(items: Item[]): number {
  let n = 0;
  for (const it of items) { if (it.kind === "system" || isInjectedUser(it)) n++; else break; }
  return n;
}

function keyLine(o: OutputItem): string | undefined {
  if (!o.tags.has("error") && !o.tags.has("test")) return undefined;
  const lines = o.text.split("\n");
  const l = lines.find((x) => /Error|Exception|FAILED|fatal|passed|failed|Ran \d+/.test(x)) ?? lines.find((x) => x.trim());
  return l?.trim().slice(0, 140);
}

function stubFor(o: OutputItem, callsById: Map<string, CallItem>, store: ArtifactStore, cache: Record<string, { artifactId: string; text: string }>): StubItem {
  const cached = cache[o.callId];
  if (cached) return { kind: "stub", idx: o.idx, raw: o.raw, turn: o.turn, callId: o.callId, summary: cached.text, artifactId: cached.artifactId };
  const meta = store.put(o.text, "output", o.command?.slice(0, 80));
  const call = callsById.get(o.callId);
  const cmd = (o.command ?? call?.args ?? "").replace(/\s+/g, " ").slice(0, 90);
  const parts = [`[output #${meta.id}`, call?.tool ?? "tool", cmd ? "`" + cmd + "`" : "", `${countTokens(o.text)} tok`];
  if (o.exitCode !== null && o.exitCode !== undefined) parts.push(`exit ${o.exitCode}`);
  const kl = keyLine(o);
  if (kl) parts.push(`"${kl}"`);
  parts.push(`recall("${meta.id}")]`);
  const text = parts.filter(Boolean).join(" · ");
  cache[o.callId] = { artifactId: meta.id, text };
  return { kind: "stub", idx: o.idx, raw: o.raw, turn: o.turn, callId: o.callId, summary: text, artifactId: meta.id };
}

const PATCH_FILES_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
function foldCall(c: CallItem, store: ArtifactStore, cache: Record<string, { artifactId: string; text: string }>): CallItem {
  const key = "call:" + c.callId;
  let brief = cache[key]?.text;
  if (!brief) {
    const meta = store.put(c.args, "call", c.tool);
    let desc: string;
    if (c.tool === "apply_patch") {
      const files = [...c.args.matchAll(PATCH_FILES_RE)].map((m) => `${m[1][0]}:${m[2].trim()}`);
      const adds = (c.args.match(/^\+/gm) ?? []).length, dels = (c.args.match(/^-/gm) ?? []).length;
      desc = `patch ${files.length} file(s) ${files.slice(0, 6).join(", ")} +${adds}/-${dels}`;
    } else desc = `${c.tool} ${(c.command ?? c.args).replace(/\s+/g, " ").slice(0, 120)}`;
    brief = JSON.stringify({ _folded: desc, recall: meta.id });
    cache[key] = { artifactId: meta.id, text: brief };
  }
  const raw = c.raw.type === "custom_tool_call" ? { ...c.raw, input: brief } : { ...c.raw, arguments: brief };
  return { ...c, args: brief, raw };
}

export function rewrite(input: any[], ctx: RewriteContext): { input: any[]; stats: RewriteStats; items: Item[] } {
  const { knobs: k, store, state } = ctx;
  const now = ctx.now ?? Date.now();
  const sk = shaperKnobs(k);
  let items = parseInput(input);
  const tokensBefore = items.reduce((a, it) => a + itemTokens(it), 0);
  let prefixTrimmed = 0;
  if (k.prefix_trim !== "none") {
    const trimmed = trimFixedPrefix(items, k.prefix_trim);
    prefixTrimmed = trimmed.saved; items = trimmed.items;
  }
  const nPrefix = fixedPrefixLength(items);
  const prefixHash = sha1(items.slice(0, nPrefix).map((it) => (it as any).text ?? JSON.stringify(it.raw)).join("\u0000"));
  const fixedPrefixTokens = items.slice(0, nPrefix).reduce((a, it) => a + itemTokens(it), 0);

  // --- turn bookkeeping -------------------------------------------------------
  // A turn starts when a new (non-injected) user message appeared since the last
  // request. Works both for the proxy (request ends with the user message) and
  // for replay snapshots taken after the response.
  const userMsgs = items.filter((it) => it.kind === "user" && !isInjectedUser(it));
  if (userMsgs.length < (state.userMsgCount ?? 0)) {
    // the client replaced its history (its own compaction, a rollback, or a fork): resync counters,
    // the fold boundary is re-validated below by call_id
    state.userMsgCount = Math.max(0, userMsgs.length - 1);
    state.currentTurnSteps = 0;
  }
  const isTurnStart = userMsgs.length > (state.userMsgCount ?? 0);
  if (isTurnStart) {
    state.userMsgCount = userMsgs.length;
    state.turnIndex += 1;
    state.prevTurnSteps = state.currentTurnSteps;
    state.currentTurnSteps = 0;
    state.lastUserText = (userMsgs[userMsgs.length - 1] as any).text ?? "";
  } else {
    state.currentTurnSteps += 1;
  }
  const settingsHash = ctx.settingsHash ?? "";
  const cs = estimateCacheState(state, now, k.cache_ttl_estimate_s, settingsHash, prefixHash);

  // --- pass A: shape outputs ---------------------------------------------------
  const callsById = new Map<string, CallItem>();
  for (const it of items) if (it.kind === "call") callsById.set(it.callId, it);
  let shaped = 0, shapedSaved = 0;
  for (const it of items) {
    if (it.kind !== "output") continue;
    const r = shapeOutput(it.text, it.command, sk);
    for (const t of r.tags) it.tags.add(t as Tag);
    if (r.text !== it.text) {
      if (r.tokensAfter < r.tokensBefore) { shaped++; shapedSaved += r.tokensBefore - r.tokensAfter; }
      if (r.artifactNeeded && r.tokensBefore - r.tokensAfter > 50) {
        const meta = store.put(it.text, "output", it.command?.slice(0, 80));
        it.text = r.text + `\n[full output: ${meta.lines} lines, ${r.tokensBefore} tok → recall("${meta.id}")]`;
      } else it.text = r.text;
    }
    const kind = it.tool === "write_stdin" || it.tool === "wait" ? "poll" : undefined;
    if (kind === "poll") { it.tags.add("poll"); if (isEmptyPoll(it.text)) it.tags.add("poll-empty"); }
  }

  // --- pass B: collapse empty poll chains (keep first + last) --------------------
  let pollsCollapsed = 0;
  if (k.collapse_poll_chains) {
    const drop = new Set<number>();
    let run: number[] = [];   // indices (into items) of output items in the current chain
    const flush = () => { if (run.length > 2) for (const i of run.slice(1, -1)) drop.add(i); run = []; };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "output" && it.tags.has("poll-empty")) { run.push(i); continue; }
      if (it.kind === "call" && (it.tool === "write_stdin" || it.tool === "wait")) continue; // part of chain
      if (it.kind === "reasoning" || it.kind === "assistant") continue; // commentary between polls does not break the chain
      flush();
    }
    flush();
    if (drop.size) {
      const dropCalls = new Set<string>();
      for (const i of drop) dropCalls.add((items[i] as OutputItem).callId);
      items = items.filter((it, i) => !(drop.has(i) || (it.kind === "call" && dropCalls.has(it.callId))));
      pollsCollapsed = drop.size;
    }
  }

  // --- locate fold boundary (monotonic, by call_id) -------------------------------
  let boundary = -1; // index in items; outputs at index < boundary are folded
  if (state.foldedThroughCallId) {
    const key = state.foldedThroughCallId;
    const pos = key.startsWith("other:")
      ? items.findIndex((it, i) => it.kind === "other" && `other:${(it.raw as any)?.id ?? i}` === key)
      : items.findIndex((it) => it.kind === "output" && it.callId === key);
    if (pos >= 0) boundary = pos + 1;
    else { state.foldedThroughCallId = undefined; state.reasoningDropThroughId = undefined; }
  }

  // --- pass C: dedupe repeated identical reads (only against verbatim copies) ---
  let readsDeduped = 0;
  if (k.dedupe_reads) {
    const seen = new Map<string, { callId: string; hash: string; idx: number }>();
    items.forEach((it, i) => {
      if (it.kind !== "output" || !it.readKey) return;
      const h = sha1(it.text);
      const prev = seen.get(it.readKey);
      if (prev && prev.hash === h && prev.idx >= boundary) {
        it.text = `[unchanged: identical to earlier read of ${it.readKey} (call ${prev.callId.slice(-6)})]`;
        it.tags.add("dup"); readsDeduped++;
      } else seen.set(it.readKey, { callId: it.callId, hash: h, idx: i });
    });
  }

  // --- decide whether to move the boundary ------------------------------------------
  // "observations" are the units of the window: tool outputs and other model-visible
  // results (agent messages, web search calls). Multi-agent sessions can have hundreds
  // of items between two tool outputs, so the window must count these too.
  const outputIdx = items.map((it, i) => (it.kind === "output" || it.kind === "other" ? i : -1)).filter((i) => i >= 0);
  const tokensNow = () => items.reduce((a, it) => a + itemTokens(it), 0);
  let compacted = false, compactReason: string | undefined, decision: JudgeDecision | undefined;
  const targetC = fixedPrefixTokens + 3000 + k.window * Math.min(k.per_output_cap, 800);
  const foldTo = (reason: string) => {
    const keep = outputIdx.slice(-k.window);
    const firstKept = keep.length ? keep[0] : items.length;
    const lastFolded = [...outputIdx].reverse().find((i) => i < firstKept);
    if (lastFolded === undefined) return false;
    const newBoundary = lastFolded + 1;   // boundary = index right after the last folded output (same rule as replay)
    if (newBoundary <= boundary) return false;
    boundary = newBoundary;
    const lf = items[lastFolded] as any;
    state.foldedThroughCallId = lf.kind === "output" ? lf.callId : `other:${lf.raw?.id ?? lastFolded}`;
    compacted = true; compactReason = reason; state.stepsSinceCompact = 0; state.compactions++;
    return true;
  };
  const C = tokensNow();
  if (ctx.forceCompact) foldTo("forced");
  if (!compacted && isTurnStart) {
    let sim = ctx.topicSimilarity;
    if (sim === undefined && userMsgs.length >= 2 && state.turnIndex >= 2) {
      // compare the new message with the previous user messages + digest of this session
      const prev = userMsgs.slice(0, -1).map((u: any) => u.text).join(" ") + " " + (state.summary ? renderSummary(state.summary, 0) : "");
      sim = lexicalSimilarity(state.lastUserText ?? "", prev);
    }
    decision = judge({ C, F: fixedPrefixTokens, targetC, userText: state.lastUserText ?? "", prevTurnSteps: state.prevTurnSteps, turnIndex: state.turnIndex, cacheState: cs.state, idleS: cs.idleS, stepsSinceLastCompact: state.stepsSinceCompact, topicSimilarity: sim }, k);
    // "fork" cannot be executed by a rewrite pass; unrelated topic => the old history is dead weight, fold it
    if (decision.action === "compact" || decision.action === "fork") foldTo(`turn-start: ${decision.reason}`);
  }
  if (!compacted) {
    // mid-turn batch fold with hysteresis: only when the variable part exceeds the
    // budget AND at least one full window of new outputs accumulated since the last
    // fold. This keeps folds rare (cache breaks once per >= window steps) instead of
    // sliding every step.
    const variable = C - fixedPrefixTokens;
    const verbatim = outputIdx.filter((i) => i >= boundary).length;
    if (variable > k.turn_budget && verbatim >= 2 * k.window && state.stepsSinceCompact >= k.window) {
      foldTo(`budget: variable ${variable} > ${k.turn_budget}, ${verbatim} verbatim outputs`);
    }
  }
  if (!compacted) state.stepsSinceCompact += 1;
  if (compacted && k.drop_reasoning_outside_window) {
    const rIdx = items.map((it, i) => (it.kind === "reasoning" ? i : -1)).filter((i) => i >= 0);
    const cut = rIdx.length - k.reasoning_keep_last;
    if (cut > 0) { const lastDrop = items[rIdx[cut - 1]] as any; state.reasoningDropThroughId = lastDrop.id ?? lastDrop.raw?.id ?? `idx:${rIdx[cut - 1]}`; }
  }
  let reasoningCutIdx = -1;
  if (state.reasoningDropThroughId) {
    const key = state.reasoningDropThroughId;
    reasoningCutIdx = key.startsWith("idx:") ? Number(key.slice(4)) : items.findIndex((it) => it.kind === "reasoning" && ((it as any).id ?? it.raw?.id) === key);
  }

  // --- apply fold: stubs, drop old reasoning, insert digest ---------------------------
  let folded = 0, reasoningDropped = 0;
  const out: Item[] = [];
  const foldedItems: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "reasoning" && k.drop_reasoning_outside_window && (i < boundary || i <= reasoningCutIdx)) { reasoningDropped++; continue; }
    if (it.kind === "other" && it.raw?.type === "compaction") {
      // client-side compaction summary: cap but never drop (it is the only memory of the pre-compaction history)
      const txt = Array.isArray(it.raw.content) ? it.raw.content.map((c: any) => c?.text ?? "").join("") : typeof it.raw.summary === "string" ? it.raw.summary : "";
      if (txt && countTokens(txt) > k.compaction_item_cap) {
        const key = "compaction:" + (it.raw.id ?? it.idx);
        let brief = state.stubs[key]?.text;
        if (!brief) { const meta = store.put(txt, "compaction"); brief = txt.slice(0, k.compaction_item_cap * 3) + `\n[compaction summary truncated: ${countTokens(txt)} tok → recall("${meta.id}")]`; state.stubs[key] = { artifactId: meta.id, text: brief }; }
        out.push({ ...it, raw: { ...it.raw, ...(Array.isArray(it.raw.content) ? { content: [{ type: "input_text", text: brief }] } : { summary: brief }) } }); continue;
      }
    }
    if (i < boundary) {
      if (it.kind === "output" && k.stub_old_outputs) { foldedItems.push(it); out.push(stubFor(it, callsById, store, state.stubs)); folded++; continue; }
      if (it.kind === "other" && k.stub_old_outputs && it.raw?.type === "agent_message" && Array.isArray(it.raw.content)) {
        // Codex multi-agent traffic (spawn_agent / send_message). Outside the window the payload is dead weight:
        // text parts go to the artifact store (recallable); encrypted parts cannot be recalled and are dropped.
        const txt = it.raw.content.map((c: any) => c?.text ?? "").join("");
        const enc = it.raw.content.filter((c: any) => typeof c?.encrypted_content === "string");
        const tok = itemTokens(it);
        if (enc.length || countTokens(txt) > 200) {
          const key = "agent:" + (it.raw.id ?? it.idx);
          let brief = state.stubs[key]?.text;
          if (!brief) {
            const header = txt.split("\n").filter((l: string) => /^(Message Type|Task name|Sender|Recipient):/.test(l)).join("; ") || `${it.raw.author ?? "?"} → ${it.raw.recipient ?? "?"}`;
            if (countTokens(txt) > 200) { const meta = store.put(txt, "other", "agent_message"); brief = `[agent_message ${header} · ${tok} tok · recall("${meta.id}")]`; state.stubs[key] = { artifactId: meta.id, text: brief }; }
            else { brief = `[agent_message ${header} · ${tok} tok · ${enc.length ? "encrypted payload folded" : "folded"}]`; state.stubs[key] = { artifactId: "", text: brief }; }
          }
          out.push({ ...it, raw: { ...it.raw, content: [{ type: "input_text", text: brief }] } }); folded++; continue;
        }
      }
      if (it.kind === "other" && k.stub_old_outputs && Array.isArray(it.raw?.content)) {
        const txt = it.raw.content.map((c: any) => c?.text ?? "").join("");
        if (countTokens(txt) > 200) {
          const key = "other:" + (it.raw.id ?? it.idx);
          let brief = state.stubs[key]?.text;
          if (!brief) { const meta = store.put(txt, "other", it.raw.type); brief = txt.slice(0, 200).replace(/\s+/g, " ") + ` … [folded ${countTokens(txt)} tok → recall("${meta.id}")]`; state.stubs[key] = { artifactId: meta.id, text: brief }; }
          out.push({ ...it, raw: { ...it.raw, content: [{ type: "input_text", text: brief }] } }); folded++; continue;
        }
      }
      if (it.kind === "call") {
        foldedItems.push(it);
        if (k.stub_old_outputs && countTokens(it.args) > 200) { out.push(foldCall(it, store, state.stubs)); folded++; continue; }
      }
    }
    out.push(it);
  }
  if (boundary > 0 && folded > 0) {
    state.summary = buildSummary(foldedItems, state.summary ? { filesTouched: [], commandsByKind: {}, errorsSeen: [], turns: 0, notes: state.summary.notes, modelSummary: state.summary.modelSummary } : undefined);
    const digest = renderSummary(state.summary, folded);
    // insert digest right after the last folded item (stable position)
    let pos = 0;
    for (let i = 0; i < out.length; i++) if (out[i].kind === "stub") pos = i + 1;
    out.splice(pos, 0, { kind: "user", idx: -1, raw: { type: "message", role: "user", content: [{ type: "input_text", text: digest }] }, turn: out[pos - 1]?.turn ?? 0, text: digest });
  }

  const tokensAfter = out.reduce((a, it) => a + itemTokens(it), 0);
  state.lastRequestAt = now; state.lastSettingsHash = settingsHash; state.lastPrefixHash = prefixHash;
  return {
    input: toResponsesInput(out),
    items: out,
    stats: { tokensBefore, tokensAfter, fixedPrefixTokens, prefixTrimmed, outputs: outputIdx.length, shaped, shapedSaved, pollsCollapsed, readsDeduped, folded, reasoningDropped, compacted, compactReason, decision, cacheState: cs.state, idleS: cs.idleS, isTurnStart, turnIndex: state.turnIndex },
  };
}
