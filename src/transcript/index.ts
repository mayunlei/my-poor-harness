/**
 * Conversation transcript (docs/MEMORY_DESIGN.md §2): the append-only record of a
 * multi-turn session, rendered as segment S2 of every request.
 *
 * Invariants
 *   - The user's message is written to disk before anything else happens in a turn.
 *   - The user's own words are never rewritten, summarized or dropped. Only large
 *     pasted blocks (code fences, logs, tracebacks) may be externalized, and only once
 *     the turn they came in is older than the current epoch.
 *   - An answer is stored in full (artifact) plus a card fixed at turn end. Recent
 *     answers render verbatim, older ones as their card.
 *   - Rendering is a pure function of (entries, completed turns, knobs), and changes
 *     only every `answer_verbatim_turns` turns, so S2 stays a cache-stable prefix.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { harnessHome } from "../core/knobs.js";
import { sha1, contentText } from "../core/items.js";
import { countTokens } from "../core/tokens.js";
import type { ArtifactStore } from "../core/artifacts.js";

export interface UserEntry { kind: "user"; turn: number; at: string; text: string; sha1: string }
export interface AnswerEntry { kind: "answer"; turn: number; at: string; artifact?: string; text: string; card: string; filesChanged: string[]; status: "done" | "stopped" | "error" }
export type TranscriptEntry = UserEntry | AnswerEntry;

export function transcriptDir(): string { const d = join(harnessHome(), "harness", "transcripts"); mkdirSync(d, { recursive: true }); return d; }
export function transcriptPath(sid: string): string { return join(transcriptDir(), sid.replace(/[^A-Za-z0-9_.:-]/g, "_") + ".jsonl"); }

export function readTranscript(sid: string): TranscriptEntry[] {
  const p = transcriptPath(sid);
  if (!existsSync(p)) return [];
  const out: TranscriptEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* torn tail line */ } }
  return out;
}

export function appendUser(sid: string, turn: number, text: string): UserEntry {
  const e: UserEntry = { kind: "user", turn, at: new Date().toISOString(), text, sha1: sha1(text) };
  appendFileSync(transcriptPath(sid), JSON.stringify(e) + "\n");
  return e;
}

export function appendAnswer(sid: string, e: Omit<AnswerEntry, "kind" | "at">): AnswerEntry {
  const full: AnswerEntry = { kind: "answer", at: new Date().toISOString(), ...e };
  appendFileSync(transcriptPath(sid), JSON.stringify(full) + "\n");
  return full;
}

/** copy a transcript to a new session (fork) */
export function copyTranscript(from: string, to: string, uptoTurn = Infinity): void {
  for (const e of readTranscript(from)) if (e.turn < uptoTurn) appendFileSync(transcriptPath(to), JSON.stringify(e) + "\n");
}

// --- pasted content ---------------------------------------------------------------

export interface Segment { kind: "words" | "paste"; text: string; label?: string }

const TRACE_RE = /^(Traceback \(most recent call last\)|\s+at \S+ \(|\s+File ".*", line \d+|Exception in thread|panic: |goroutine \d+ \[)/;
const LOG_LINE_RE = /^(\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+|\d{2}:\d{2}:\d{2}[.,]\d+|\[(INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\]|(INFO|WARN|WARNING|ERROR|DEBUG)\s)/;

/**
 * Split a user message into the user's own words and pasted blocks. Pasted = fenced code
 * blocks, or runs of >= 8 consecutive log/trace-looking lines. When unsure, it is words.
 */
export function splitUserText(text: string): Segment[] {
  const segs: Segment[] = [];
  const lines = text.split("\n");
  let words: string[] = [];
  const flushWords = () => { if (words.length) { segs.push({ kind: "words", text: words.join("\n") }); words = []; } };
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(```|~~~)(\S*)/.exec(lines[i]);
    if (fence) {
      const close = lines.findIndex((l, j) => j > i && l.trim().startsWith(fence[1]));
      if (close > i) { flushWords(); segs.push({ kind: "paste", text: lines.slice(i, close + 1).join("\n"), label: fence[2] || "code" }); i = close; continue; }
    }
    if (LOG_LINE_RE.test(lines[i]) || TRACE_RE.test(lines[i])) {
      let j = i; while (j < lines.length && (LOG_LINE_RE.test(lines[j]) || TRACE_RE.test(lines[j]) || /^\s{2,}\S/.test(lines[j]) || /^\S+(Error|Exception)\b/.test(lines[j]))) j++;
      if (j - i >= 8) { flushWords(); segs.push({ kind: "paste", text: lines.slice(i, j).join("\n"), label: TRACE_RE.test(lines[i]) ? "traceback" : "log" }); i = j - 1; continue; }
    }
    words.push(lines[i]);
  }
  flushWords();
  return segs;
}

/** the user's own words of a message (what the fidelity check requires verbatim) */
export function userWords(text: string): string[] {
  return splitUserText(text).filter((s) => s.kind === "words").map((s) => s.text.trim()).filter(Boolean);
}

// --- rendering ------------------------------------------------------------------------

export interface RenderKnobs { answer_verbatim_turns: number; paste_externalize_tokens: number }

/**
 * First turn index rendered fully verbatim. Changes only when the number of completed
 * turns crosses a multiple of the epoch, so the rendered prefix stays stable in between.
 */
export function epochStart(completedTurns: number, epoch: number): number {
  const e = Math.max(1, epoch);
  return Math.max(0, (Math.floor(completedTurns / e) - 1) * e);
}

function renderUser(e: UserEntry, verbatim: boolean, k: RenderKnobs, store: ArtifactStore): string {
  if (verbatim) return e.text;
  return splitUserText(e.text).map((s) => {
    if (s.kind === "words") return s.text;
    const tok = countTokens(s.text);
    if (tok <= k.paste_externalize_tokens) return s.text;
    const meta = store.put(s.text, "paste", `turn${e.turn}:${s.label}`);   // content-addressed: same id every render
    const ls = s.text.split("\n");
    return `[pasted ${s.label} · ${ls.length} lines / ${tok} tok · head: ${ls.slice(0, 3).join(" ⏎ ").slice(0, 240)} … tail: ${ls.slice(-3).join(" ⏎ ").slice(0, 240)} · recall("${meta.id}")]`;
  }).join("\n");
}

/**
 * Render S2: one user message and one assistant message per past turn. The caller
 * passes the entries read before the current user message was appended (that one is S5).
 */
export function renderTranscript(entries: TranscriptEntry[], k: RenderKnobs, store: ArtifactStore): any[] {
  const answers = new Map<number, AnswerEntry>();
  for (const e of entries) if (e.kind === "answer") answers.set(e.turn, e);
  const users = entries.filter((e): e is UserEntry => e.kind === "user");
  // every past user message is rendered, answered or not (an interrupted turn must not lose the user's words)
  const start = epochStart(users.length, k.answer_verbatim_turns);
  const out: any[] = [];
  users.forEach((e, i) => {
    const verbatim = i >= start;
    out.push({ type: "message", role: "user", content: [{ type: "input_text", text: renderUser(e, verbatim, k, store) }] });
    const a = answers.get(e.turn);
    const body = !a ? "(turn interrupted; no answer was recorded)" : verbatim ? a.text : a.card;
    out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: body || "(no answer)" }] });
  });
  return out;
}

export function userTextTokens(entries: TranscriptEntry[]): number {
  return entries.filter((e): e is UserEntry => e.kind === "user").reduce((a, e) => a + userWords(e.text).reduce((b, w) => b + countTokens(w), 0), 0);
}

// --- answer cards ------------------------------------------------------------------------

/**
 * Rule-based card: the first paragraph (answers are asked to lead with the outcome),
 * files changed, and lines that look like verification or open items. null if the
 * answer has no usable structure (the caller may then ask the small model).
 */
export function ruleCard(answer: string, filesChanged: string[], artifactId?: string, maxTok = 120): string | null {
  const t = answer.trim();
  if (!t) return null;
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let lead = paras[0].replace(/\s+/g, " ");
  if (countTokens(lead) > maxTok * 0.7) lead = lead.slice(0, Math.floor(maxTok * 0.7 * 2.5)) + "…";
  const extra = t.split("\n").map((l) => l.trim()).filter((l) => /(verified|tested|passes|passed|failed|not verified|todo|open|验证|测试|未验证|遗留|待办)/i.test(l) && !lead.includes(l)).slice(0, 2).map((l) => l.replace(/^[-*]\s*/, "").slice(0, 160));
  const parts = [lead];
  if (filesChanged.length) parts.push("files: " + filesChanged.slice(0, 8).join(", ") + (filesChanged.length > 8 ? ` +${filesChanged.length - 8}` : ""));
  parts.push(...extra);
  if (countTokens(t) <= maxTok) return t;   // short answers are their own card
  return `[answer card] ${parts.join(" · ")}${artifactId ? ` · full: recall("${artifactId}")` : ""}`;
}

// --- fidelity -----------------------------------------------------------------------------

export interface FidelityResult { ok: boolean; missing: { turn: number; words: string }[] }

/** every word-segment of every user message must appear verbatim somewhere in the request */
export function checkUserFidelity(input: any[], userEntries: { turn: number; text: string }[]): FidelityResult {
  const hay = input.map((x) => x?.type === "message" || x?.role ? contentText(x.content) : "").join("\n\u0000\n");
  const missing: FidelityResult["missing"] = [];
  for (const e of userEntries) for (const w of userWords(e.text)) if (!hay.includes(w)) missing.push({ turn: e.turn, words: w.slice(0, 120) });
  return { ok: missing.length === 0, missing };
}
