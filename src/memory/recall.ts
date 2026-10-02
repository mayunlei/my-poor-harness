/**
 * Memory recall (docs/MEMORY_DESIGN.md §4.4–4.5).
 *   L0 pinned   always injected (goal, constraints, preferences, key decisions)
 *   L1 index    one line per recalled entry, with its id
 *   L2 detail   body + links; at most two preloaded, the rest via memory_get(id)
 * Candidates come from FTS (BM25), link overlap with files in play, type priors and
 * recency. The small model may rerank them (gate.ts); without it the score decides.
 */
import { countTokens } from "../core/tokens.js";
import type { MemoryEntry, MemoryStore, MemoryType } from "./store.js";

const TYPE_PRIOR: Record<MemoryType, number> = { constraint: 0.25, attempt: 0.2, preference: 0.15, decision: 0.15, goal: 0.1, open: 0.1, fact: 0.05, procedure: 0.05 };

export interface Candidate { entry: MemoryEntry; score: number; why: string[] }

export function candidates(store: MemoryStore, opts: { query: string; files?: string[]; project?: string; limit?: number; exclude?: Set<string> }): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const { entry, score } of store.search(opts.query, { limit: 120 })) byId.set(entry.id, { entry, score: score, why: ["text"] });
  const files = (opts.files ?? []).filter(Boolean);
  if (files.length) {
    const base = (f: string) => f.split("/").pop() ?? f;
    for (const e of store.list({ limit: 2000 })) {
      const hit = e.links.some((l) => l.kind === "file" && files.some((f) => f === l.ref || l.ref.endsWith("/" + base(f)) || f.endsWith("/" + base(l.ref))));
      if (!hit) continue;
      const c = byId.get(e.id) ?? { entry: e, score: 0, why: [] };
      c.score += 0.4; c.why.push("file"); byId.set(e.id, c);
    }
  }
  const now = Date.now();
  const out: Candidate[] = [];
  for (const c of byId.values()) {
    if (opts.exclude?.has(c.entry.id)) continue;
    c.score += TYPE_PRIOR[c.entry.type] ?? 0;
    if (opts.project && c.entry.project === opts.project) { c.score += 0.1; c.why.push("project"); }
    const t = Date.parse(c.entry.lastUsed ?? c.entry.updated);
    if (Number.isFinite(t)) c.score += 0.1 * Math.exp(-(now - t) / (14 * 86400_000));   // two-week decay, ranking only
    out.push(c);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 40);
}

/** pinned entries within a token budget; session-born and recently used first */
export function pinnedWithin(store: MemoryStore, budget: number, project?: string): { shown: MemoryEntry[]; overflow: MemoryEntry[] } {
  const all = store.list({ pinned: true, limit: 500 });
  const rank = (e: MemoryEntry) => (e.project === project ? 1 : 0) * 1e15 + Date.parse(e.lastUsed ?? e.updated);
  all.sort((a, b) => rank(b) - rank(a));
  const shown: MemoryEntry[] = []; const overflow: MemoryEntry[] = []; let used = 0;
  for (const e of all) { const t = countTokens(l0Line(e)); if (used + t <= budget) { shown.push(e); used += t; } else overflow.push(e); }
  return { shown, overflow };
}

export function l0Line(e: MemoryEntry): string {
  return `- [${e.id} ${e.type}] ${e.title}${e.quote && !e.title.includes(e.quote) ? ` — user said: "${e.quote.slice(0, 300)}"` : ""}`;
}
export function l1Line(e: MemoryEntry): string {
  const stale = e.status === "stale" ? " (stale: linked file changed, re-read it)" : "";
  return `- [${e.id} ${e.type}] ${e.title}${stale}`;
}
export function detailBlock(e: MemoryEntry): string {
  const links = e.links.length ? "\n  links: " + e.links.map((l) => `${l.kind}:${l.ref}`).join(", ") : "";
  const quote = e.quote ? `\n  user said: "${e.quote}"` : "";
  return `[${e.id} ${e.type}${e.status !== "active" ? " " + e.status : ""}] ${e.title}\n  ${e.body.replace(/\n/g, "\n  ")}${quote}${links}`;
}

export interface MemoryBriefing { text: string; pinned: string[]; index: string[]; detail: string[]; total: number }

export function renderMemoryBriefing(store: MemoryStore, sel: { pinned: MemoryEntry[]; index: MemoryEntry[]; detail: MemoryEntry[] }): MemoryBriefing {
  const lines: string[] = [];
  if (sel.pinned.length) lines.push("## Memory: always in force", ...sel.pinned.map(l0Line));
  if (sel.index.length) lines.push("## Memory: possibly relevant (memory_get(id) for details)", ...sel.index.map(l1Line));
  if (sel.detail.length) lines.push("## Memory: details", ...sel.detail.map(detailBlock));
  const total = store.count();
  const shown = new Set([...sel.pinned, ...sel.index, ...sel.detail].map((e) => e.id)).size;
  if (total > shown) lines.push(`(${total - shown} more memories not shown; memory_search(query) finds them)`);
  return { text: lines.join("\n"), pinned: sel.pinned.map((e) => e.id), index: sel.index.map((e) => e.id), detail: sel.detail.map((e) => e.id), total };
}
