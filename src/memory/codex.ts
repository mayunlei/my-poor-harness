/**
 * Read-only access to Codex CLI's own memory (~/.codex/memories and memories_v2):
 * the consolidated MEMORY.md (one "# Task Group" per project/topic), memory_summary.md,
 * and the per-session rollout_summaries/*.md. Codex keeps months of task history there;
 * the harness searches it and reads from it, and never writes to it.
 *
 * Search is in-process term scoring over chunks (the files are a few hundred KB), with
 * the same tokenisation as the FTS index so Chinese and English queries both match.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ftsTerms } from "./store.js";

export type CodexChunkKind = "group" | "summary" | "rollout";

export interface CodexChunk {
  /** what codex_memory(ref=...) takes: "rollout_summaries/<file>.md", "MEMORY.md#3", "memory_summary.md#2" */
  ref: string;
  kind: CodexChunkKind;
  title: string;
  cwd?: string;
  updated?: string;
  text: string;
  /** lowercased text, for scoring */
  lower: string;
}

/** matched / terms: of the query terms that say something about the corpus (found somewhere, not everywhere), how many this chunk has */
export interface CodexHit { chunk: CodexChunk; score: number; matched: number; terms: number; snippet: string }

export function codexHome(env: NodeJS.ProcessEnv = process.env): string { return env.CODEX_HOME ?? join(homedir(), ".codex"); }

/** memory directories, newest layout first; a rollout summary in both is read from the first */
export function codexMemoryRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = codexHome(env);
  return ["memories_v2", "memories"].map((d) => join(home, d)).filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
}

const header = (text: string, key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim();

/** split on markdown headings of the given depths, keeping each heading with its body */
function sections(text: string, re: RegExp): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  const lines = text.split("\n");
  let cur: { title: string; lines: string[] } | undefined;
  for (const l of lines) {
    const m = re.exec(l);
    if (m) { if (cur) out.push({ title: cur.title, body: cur.lines.join("\n").trim() }); cur = { title: m[1].trim(), lines: [l] }; }
    else cur?.lines.push(l);
  }
  if (cur) out.push({ title: cur.title, body: cur.lines.join("\n").trim() });
  return out;
}

function chunk(ref: string, kind: CodexChunkKind, title: string, text: string, cwd?: string, updated?: string): CodexChunk {
  return { ref, kind, title, cwd, updated, text, lower: text.toLowerCase() };
}

function loadRoot(root: string, seenRollouts: Set<string>, multi: boolean): CodexChunk[] {
  const out: CodexChunk[] = [];
  const tag = (ref: string) => (multi ? `${basename(root)}/${ref}` : ref);
  const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } };
  const mem = read(join(root, "MEMORY.md"));
  if (mem) sections(mem, /^# Task Group:\s*(.+)$/).forEach((s, i) => {
    const cwd = /cwd=([^\s;]+)/.exec(s.body)?.[1] ?? /^(\/\S+)/.exec(s.title)?.[1];
    const updated = [...s.body.matchAll(/updated_at=([0-9T:\-+]+)/g)].map((m) => m[1]).sort().at(-1);
    out.push(chunk(tag(`MEMORY.md#${i + 1}`), "group", s.title, s.body, cwd, updated));
  });
  const sum = read(join(root, "memory_summary.md"));
  if (sum) {
    let project: string | undefined;
    sections(sum, /^#{2,4} (.+)$/).forEach((s, i) => {
      if (s.title.startsWith("/")) project = s.title;
      if (s.body.split("\n").length <= 1) return;   // a bare project heading; its dates follow
      out.push(chunk(tag(`memory_summary.md#${i + 1}`), "summary", s.title, s.body, s.title.startsWith("/") ? s.title : project));
    });
  }
  const dir = join(root, "rollout_summaries");
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { /* none */ }
  for (const f of files) {
    const key = f.split("-").slice(0, 4).join("-");   // 2026-07-20T14-58-49-uL0P: same session, renamed slug
    if (seenRollouts.has(key)) continue;
    const text = read(join(dir, f)); if (!text) continue;
    seenRollouts.add(key);
    out.push(chunk(tag(`rollout_summaries/${f}`), "rollout", /^#{1,2} (.+)$/m.exec(text)?.[1]?.trim() ?? f, text, header(text, "cwd"), header(text, "updated_at")));
  }
  return out;
}

let cache: { key: string; chunks: CodexChunk[] } | undefined;

/** all chunks, cached until a memory file changes */
export function loadCodexMemory(roots = codexMemoryRoots()): CodexChunk[] {
  const stamp = roots.map((r) => {
    const m = (p: string) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
    return `${r}:${m(join(r, "MEMORY.md"))}:${m(join(r, "memory_summary.md"))}:${m(join(r, "rollout_summaries"))}`;
  }).join("|");
  if (cache?.key === stamp) return cache.chunks;
  const seen = new Set<string>();
  const chunks = roots.flatMap((r) => loadRoot(r, seen, roots.length > 1));
  cache = { key: stamp, chunks };
  return chunks;
}

function count(hay: string, needle: string, cap = 20): number {
  let n = 0; let i = hay.indexOf(needle);
  while (i >= 0 && n < cap) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

function snippetAround(c: CodexChunk, term: string | undefined, width = 220): string {
  const at = term ? c.lower.indexOf(term) : -1;
  const start = Math.max(0, (at < 0 ? 0 : at) - width / 2);
  const s = c.text.slice(start, start + width).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + s + (start + width < c.text.length ? "…" : "");
}

/**
 * Rank chunks against a query: idf-weighted log term frequency, length-damped, plus a
 * boost when the chunk's cwd is the current project (or contains it).
 */
export function searchCodexMemory(query: string, opts: { project?: string; limit?: number; kind?: CodexChunkKind; chunks?: CodexChunk[] } = {}): CodexHit[] {
  const chunks = (opts.chunks ?? loadCodexMemory()).filter((c) => !opts.kind || c.kind === opts.kind);
  const { fts, short } = ftsTerms(query);
  const terms = [...new Set([...fts, ...short])];
  if (!terms.length || !chunks.length) return [];
  const df = new Map(terms.map((t) => [t, chunks.filter((c) => c.lower.includes(t)).length]));
  const idf = (t: string) => Math.log(1 + chunks.length / (1 + (df.get(t) ?? 0)));
  // chatter ("又上涨了", "the") is either nowhere or everywhere; it should not dilute coverage
  const telling = new Set(terms.filter((t) => { const d = df.get(t) ?? 0; return d > 0 && (chunks.length < 10 || d <= chunks.length * 0.6); }));
  const hits: CodexHit[] = [];
  for (const c of chunks) {
    let score = 0; let matched = 0; let best: string | undefined; let bestW = -1;
    for (const t of terms) {
      const tf = count(c.lower, t); if (!tf) continue;
      if (telling.has(t)) matched++;
      const w = idf(t) * (t.length < 3 ? 0.5 : 1);
      score += w * (1 + Math.log(tf));
      if (w > bestW) { bestW = w; best = t; }
    }
    if (!score) continue;
    score /= 1 + Math.log(1 + c.text.length / 6000);
    score *= 0.5 + matched / Math.max(1, telling.size);   // covering more of the query beats repeating one word
    if (opts.project && c.cwd && (opts.project === c.cwd || opts.project.startsWith(c.cwd + "/") || c.cwd.startsWith(opts.project + "/"))) score *= 1.5;
    hits.push({ chunk: c, score, matched, terms: telling.size, snippet: snippetAround(c, best) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
}

/** one chunk's text by ref, paged; refs never resolve outside the memory roots */
export function readCodexMemory(ref: string, opts: { offset?: number; max?: number; chunks?: CodexChunk[] } = {}): string | undefined {
  const r = ref.trim().replace(/^\.?\//, "");
  const chunks = opts.chunks ?? loadCodexMemory();
  const c = chunks.find((x) => x.ref === r) ?? chunks.find((x) => x.ref.endsWith("/" + r)) ?? chunks.find((x) => x.kind === "rollout" && basename(x.ref) === basename(r));
  if (!c) return undefined;
  const max = opts.max ?? 8000; const off = Math.max(0, opts.offset ?? 0);
  const body = c.text.slice(off, off + max);
  const more = off + max < c.text.length ? `\n[… ${c.text.length - off - max} more chars; codex_memory(ref="${c.ref}", offset=${off + max})]` : "";
  return `[codex memory ${c.ref} · ${c.kind}${c.cwd ? ` · cwd=${c.cwd}` : ""}${c.updated ? ` · updated ${c.updated.slice(0, 10)}` : ""}]\n${body}${more}`;
}

/**
 * Hits strong enough to mention unasked in the turn briefing: most of the message's
 * terms present, and close to the best hit. A short or generic message gets none --
 * the model can still search on demand.
 */
export function codexBriefingHits(text: string, project: string | undefined, limit: number, chunks?: CodexChunk[]): CodexHit[] {
  const hits = searchCodexMemory(text, { project, limit: limit * 3, chunks });
  if (!hits.length || hits[0].terms < 2) return [];
  const top = hits[0].score;
  return hits.filter((h) => h.matched >= 2 && h.matched / h.terms >= 0.5 && h.score >= top * 0.6).slice(0, limit);
}

export function codexHitLine(h: CodexHit): string {
  const c = h.chunk;
  return `- ${c.ref} [${c.kind}${c.updated ? " " + c.updated.slice(0, 10) : ""}] ${c.title.slice(0, 140)}`;
}
