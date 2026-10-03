/**
 * Memory writes (docs/MEMORY_DESIGN.md §4.6):
 *   1. rules: explicit user instructions ("记住…", "不要…", "always…") become pinned
 *      constraints / preferences with the user's sentence quoted verbatim
 *   2. the main model: remember(type, title, body, links)
 *   3. the small model at turn end: up to 5 typed entries, deduplicated against
 *      similar existing ones in the same call (new / update / supersede / skip)
 */
import { resolve } from "node:path";
import type { ModelClient } from "../harness/providers.js";
import { userWords } from "../transcript/index.js";
import { MEMORY_TYPES, type MemoryEntry, type MemoryLink, type MemoryStore, type MemoryType, type NewMemory } from "./store.js";

const INSTRUCTION_RE = /(记住|记得|以后|今后|一律|总是|始终|永远|每次|不要|不准|不许|别再|别用|别改|禁止|务必|必须|一定要|优先|偏好|\balways\b|\bnever\b|\bdon'?t\b|\bdo not\b|\bmust\b|\bremember\b|\bprefer\b|\bfrom now on\b)/i;
const PREF_RE = /(回答|回复|输出|语言|中文|英文|格式|风格|语气|简洁|详细|markdown|表格|answer|reply|respond|language|format|style|tone|concise|verbose)/i;

/** split the user's words into sentences, keeping punctuation */
function sentences(text: string): string[] {
  return text.split(/(?<=[。！？!?；;])|\n+/).map((s) => s.trim()).filter((s) => s.length >= 4);
}

export function ruleExtract(userText: string): Omit<NewMemory, "source" | "project">[] {
  const out: Omit<NewMemory, "source" | "project">[] = [];
  for (const w of userWords(userText)) for (const s of sentences(w)) {
    if (!INSTRUCTION_RE.test(s)) continue;
    if (/[?？]\s*$/.test(s)) continue;   // a question, not an instruction
    const type: MemoryType = PREF_RE.test(s) ? "preference" : "constraint";
    out.push({ type, title: s.length > 80 ? s.slice(0, 78) + "…" : s, body: s, quote: s, pinned: true });
  }
  return out.slice(0, 5);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[。.!！?？,，;；:：]+$/g, "").trim();

/** exact duplicate (same type and same normalized title or quote) */
export function findDuplicate(store: MemoryStore, m: Pick<NewMemory, "type" | "title" | "quote">): MemoryEntry | undefined {
  const hits = store.search(m.quote ?? m.title, { limit: 20, type: m.type });
  const a = norm(m.title);
  return hits.map((h) => h.entry).find((e) => {
    const b = norm(e.title);
    // exact, or one title fully inside the other ("X installed" vs "X installed globally"):
    // two entries about the same thing are worse than one slightly stale entry
    if (b === a || (a.length >= 8 && b.length >= 8 && (b.includes(a) || a.includes(b)))) return true;
    return !!m.quote && !!e.quote && norm(e.quote) === norm(m.quote);
  });
}

export function addUnlessDuplicate(store: MemoryStore, m: NewMemory): { entry: MemoryEntry; created: boolean } {
  const dup = findDuplicate(store, m);
  if (dup) { store.touch(dup.id); if (m.pinned && !dup.pinned) store.setPinned(dup.id, true); return { entry: dup, created: false }; }
  return { entry: store.add(m), created: true };
}

export function normalizeLinks(links: any, cwd: string): MemoryLink[] {
  if (!Array.isArray(links)) return [];
  const out: MemoryLink[] = [];
  for (const l of links) {
    if (typeof l === "string") { out.push(/^https?:\/\//.test(l) ? { kind: "url", ref: l } : { kind: "file", ref: resolve(cwd, l) }); continue; }
    if (l && typeof l.ref === "string") {
      const kind = ["file", "turn", "artifact", "commit", "skill", "url"].includes(l.kind) ? l.kind : "file";
      out.push({ kind, ref: kind === "file" ? resolve(cwd, l.ref) : l.ref });
    }
  }
  return out.slice(0, 8);
}

export const EXTRACT_PROMPT = `You maintain the long-term memory of a coding assistant. From one finished turn, extract at most 5 memories worth keeping for future turns and future sessions.
Keep only what is NOT recoverable from the code or git: decisions and why, user constraints and preferences, approaches that failed and why, non-obvious facts about the code (with the file), open questions, reusable procedures.

The test every item must pass: would this still be true, and still worth telling the assistant, in a different session a week from now? Write that reason in "durable" (<=15 words). An item without a real reason is dropped, so do not invent one -- return fewer items instead.

The answer to the user's question is almost never a memory. These are NOT memories:
- "the build succeeded", "the tests pass", "the commit is <hash>" -- true for minutes
- "the installed version is 0.5.0", "the data lives in ~/.mph" -- re-checkable in one command, and wrong as soon as it changes
- a restatement of what a file or function does -- reading the file is cheaper and current
- the fact that you did what you were asked
Save instead WHY a choice was made, what the user insists on, what was tried and failed, and what the code does not say about itself.

Types: goal, constraint, preference, decision, fact, attempt, open, procedure.
For each item choose op: "new"; "update" (refine existing id with the same meaning); "supersede" (replaces existing id that is now wrong); or omit it.
Prefer "update" or "supersede" over a second entry about the same thing.
Return ONLY JSON: {"items":[{"op":"new|update|supersede","id":"m12 (for update/supersede)","type":"...","title":"<=80 chars","body":"<=60 words","durable":"why this still matters next week","links":["path/to/file"],"quote":"exact user sentence, only for constraint/preference"}]}
Return {"items":[]} when nothing is worth keeping. That is the common case for a short factual exchange.`;

export interface ExtractInput { userText: string; answer: string; toolSummary: string; existing: MemoryEntry[] }

export function parseJsonObject(text: string): any {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* ignore */ } }
  return undefined;
}

/** an item has to say why it will still matter; `kept` and `dropped` are reported so the ledger can show the filter working */
export function durableOnly(items: any[]): { kept: any[]; dropped: any[] } {
  const kept: any[] = []; const dropped: any[] = [];
  for (const x of items) {
    const ok = x && typeof x.title === "string" && MEMORY_TYPES.includes(x.type) && typeof x.durable === "string" && x.durable.trim().length >= 4;
    (ok ? kept : dropped).push(x);
  }
  return { kept: kept.slice(0, 5), dropped };
}

export async function modelExtract(client: ModelClient, model: string, inp: ExtractInput, effort = "low"): Promise<{ items: any[]; dropped: number; usage: { input: number; cached: number; output: number } }> {
  const existing = inp.existing.slice(0, 20).map((e) => `[${e.id} ${e.type}] ${e.title}`).join("\n") || "(none)";
  const text = `Existing related memories:\n${existing}\n\nUser message:\n${inp.userText.slice(0, 6000)}\n\nAssistant final answer:\n${inp.answer.slice(0, 6000)}\n\nTools used this turn:\n${inp.toolSummary.slice(0, 4000)}`;
  const r = await client.respond({ model, instructions: EXTRACT_PROMPT, input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }], tools: [], reasoningEffort: effort, maxOutputTokens: 1200 });
  const j = parseJsonObject(r.text);
  const items = Array.isArray(j?.items) ? j.items : [];
  const { kept, dropped } = durableOnly(items);
  return { items: kept, dropped: dropped.length, usage: r.usage };
}

/** apply extracted items; returns ids touched */
export function applyExtracted(store: MemoryStore, items: any[], base: { session: string; turn: number; project: string; cwd: string }): string[] {
  const ids: string[] = [];
  for (const it of items) {
    const links = normalizeLinks(it.links, base.cwd);
    const entry: NewMemory = { type: it.type, title: String(it.title).slice(0, 160), body: String(it.body ?? ""), links, quote: it.quote ? String(it.quote) : undefined, project: base.project, source: { session: base.session, turn: base.turn, by: "model" }, pinned: it.type === "goal" || it.type === "constraint" };
    const target = typeof it.id === "string" ? store.get(it.id) : undefined;
    if (it.op === "update" && target && target.type === it.type) { store.update(target.id, { title: entry.title, body: entry.body, links: links.length ? links : target.links, quote: entry.quote ?? target.quote }); ids.push(target.id); continue; }
    if (it.op === "supersede" && target) { ids.push(store.add({ ...entry, supersedes: target.id, pinned: target.pinned || entry.pinned }).id); continue; }
    ids.push(addUnlessDuplicate(store, entry).entry.id);
  }
  return ids;
}
