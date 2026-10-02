/**
 * Memory store (docs/MEMORY_DESIGN.md §4): typed entries with links, global across
 * projects, in SQLite (node:sqlite, no dependency) with an FTS5 trigram index so
 * Chinese and English both match. Entries are never deleted automatically.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { harnessHome } from "../core/knobs.js";
import { sha1 } from "../core/items.js";

export const MEMORY_TYPES = ["goal", "constraint", "preference", "decision", "fact", "attempt", "open", "procedure"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryStatus = "active" | "superseded" | "stale" | "done";

export interface MemoryLink { kind: "file" | "turn" | "artifact" | "commit" | "skill" | "url"; ref: string; hash?: string }
export interface MemorySource { session: string; turn: number; by: "user" | "model" | "rule" }

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  /** git root or cwd the entry came from: used to rank, never to filter (memory is global) */
  project: string;
  title: string;
  body: string;
  links: MemoryLink[];
  source: MemorySource;
  quote?: string;
  status: MemoryStatus;
  supersedes?: string;
  pinned: boolean;
  created: string;
  updated: string;
  lastUsed?: string;
  useCount: number;
}

export type NewMemory = Pick<MemoryEntry, "type" | "title" | "source"> & Partial<Pick<MemoryEntry, "project" | "body" | "links" | "quote" | "pinned" | "supersedes">>;

let sqliteMod: any;
function sqlite(): any {
  if (sqliteMod) return sqliteMod;
  // node:sqlite prints an ExperimentalWarning on first load; it is noise for a CLI
  const orig = process.emitWarning;
  (process as any).emitWarning = (w: any, ...rest: any[]) => { if (String((w as any)?.message ?? w).includes("SQLite")) return; return (orig as any).call(process, w, ...rest); };
  try { sqliteMod = (process as any).getBuiltinModule("node:sqlite"); } finally { (process as any).emitWarning = orig; }
  return sqliteMod;
}

export function memoryDbPath(): string { return join(harnessHome(), "memory.db"); }

export function fileHash(path: string): string | undefined {
  try { if (!existsSync(path) || statSync(path).isDirectory()) return undefined; return sha1(readFileSync(path, "utf8")).slice(0, 12); } catch { return undefined; }
}

const CJK = /[㐀-鿿豈-﫿]/;

/** FTS5 query terms: words of >= 3 chars, and 3-char windows over CJK runs (trigram tokenizer) */
export function ftsTerms(query: string, max = 48): { fts: string[]; short: string[] } {
  const fts = new Set<string>(); const short = new Set<string>();
  for (const raw of query.toLowerCase().split(/[\s,.;:!?，。；：！？、()（）\[\]{}<>"'`/\\|=+*&^%$#@~]+/)) {
    if (!raw) continue;
    for (const run of raw.split(/([㐀-鿿豈-﫿]+)/)) {
      if (!run) continue;
      if (CJK.test(run)) {
        if (run.length < 3) { short.add(run); continue; }
        for (let i = 0; i + 3 <= run.length; i++) fts.add(run.slice(i, i + 3));
      } else if (run.length >= 3) fts.add(run);
      else if (run.length === 2) short.add(run);
    }
  }
  return { fts: [...fts].slice(0, max), short: [...short].slice(0, 8) };
}

function rowToEntry(r: any): MemoryEntry {
  return { id: r.id, type: r.type, project: r.project, title: r.title, body: r.body, links: JSON.parse(r.links || "[]"), source: JSON.parse(r.source || "{}"), quote: r.quote || undefined, status: r.status, supersedes: r.supersedes || undefined, pinned: !!r.pinned, created: r.created, updated: r.updated, lastUsed: r.last_used || undefined, useCount: r.use_count };
}

export class MemoryStore {
  readonly db: any;
  constructor(readonly path = memoryDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = sqlite();
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS memories (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, project TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT '{}',
        quote TEXT, status TEXT NOT NULL DEFAULT 'active', supersedes TEXT, pinned INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL, updated TEXT NOT NULL, last_used TEXT, use_count INTEGER NOT NULL DEFAULT 0);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, body, quote, tokenize='trigram');
    `);
  }

  close(): void { try { this.db.close(); } catch { /* ignore */ } }

  add(m: NewMemory): MemoryEntry {
    const now = new Date().toISOString();
    const seq = (this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM memories").get() as any).n as number;
    const id = "m" + seq;
    const links = (m.links ?? []).map((l) => (l.kind === "file" && !l.hash ? { ...l, hash: fileHash(l.ref) } : l));
    this.db.prepare(`INSERT INTO memories (id,type,project,title,body,links,source,quote,status,supersedes,pinned,created,updated,use_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
      .run(id, m.type, m.project ?? "", m.title.slice(0, 160), m.body ?? "", JSON.stringify(links), JSON.stringify(m.source), m.quote ?? null, "active", m.supersedes ?? null, m.pinned ? 1 : 0, now, now);
    this.db.prepare("INSERT INTO memories_fts (id,title,body,quote) VALUES (?,?,?,?)").run(id, m.title, m.body ?? "", m.quote ?? "");
    if (m.supersedes) this.setStatus(m.supersedes, "superseded");
    return this.get(id)!;
  }

  get(id: string): MemoryEntry | undefined {
    const r = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return r ? rowToEntry(r) : undefined;
  }

  update(id: string, patch: Partial<Pick<MemoryEntry, "title" | "body" | "links" | "quote" | "pinned" | "type">>): MemoryEntry | undefined {
    const cur = this.get(id); if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.db.prepare("UPDATE memories SET type=?, title=?, body=?, links=?, quote=?, pinned=?, updated=? WHERE id=?")
      .run(next.type, next.title.slice(0, 160), next.body, JSON.stringify(next.links), next.quote ?? null, next.pinned ? 1 : 0, new Date().toISOString(), id);
    this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO memories_fts (id,title,body,quote) VALUES (?,?,?,?)").run(id, next.title, next.body, next.quote ?? "");
    return this.get(id);
  }

  setStatus(id: string, status: MemoryStatus): void { this.db.prepare("UPDATE memories SET status=?, updated=? WHERE id=?").run(status, new Date().toISOString(), id); }
  setPinned(id: string, pinned: boolean): void { this.db.prepare("UPDATE memories SET pinned=?, updated=? WHERE id=?").run(pinned ? 1 : 0, new Date().toISOString(), id); }
  touch(id: string): void { this.db.prepare("UPDATE memories SET use_count = use_count + 1, last_used = ? WHERE id = ?").run(new Date().toISOString(), id); }

  list(opts: { status?: MemoryStatus | "all"; type?: MemoryType; pinned?: boolean; limit?: number } = {}): MemoryEntry[] {
    const where: string[] = []; const args: any[] = [];
    if (opts.status !== "all") { where.push("status = ?"); args.push(opts.status ?? "active"); }
    if (opts.type) { where.push("type = ?"); args.push(opts.type); }
    if (opts.pinned !== undefined) { where.push("pinned = ?"); args.push(opts.pinned ? 1 : 0); }
    const sql = `SELECT * FROM memories ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, opts.limit ?? 1000).map(rowToEntry);
  }

  count(status: MemoryStatus | "all" = "active"): number {
    return (status === "all" ? this.db.prepare("SELECT COUNT(*) n FROM memories").get() : this.db.prepare("SELECT COUNT(*) n FROM memories WHERE status = ?").get(status)).n;
  }

  /** full-text search; returns entries with a relevance score in [0,1] (higher is better) */
  search(query: string, opts: { limit?: number; includeInactive?: boolean; type?: MemoryType } = {}): { entry: MemoryEntry; score: number }[] {
    const { fts, short } = ftsTerms(query);
    const scores = new Map<string, number>();
    if (fts.length) {
      const match = fts.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
      try {
        const rows = this.db.prepare("SELECT id, bm25(memories_fts, 0, 3.0, 1.0, 2.0) AS s FROM memories_fts WHERE memories_fts MATCH ? ORDER BY s LIMIT 200").all(match) as any[];
        // bm25 is negative, lower = better; map to (0,1]
        const best = rows.length ? Math.min(...rows.map((r) => r.s)) : -1;
        for (const r of rows) scores.set(r.id, best < 0 ? Math.max(0.05, r.s / best) : 0.5);
      } catch { /* malformed query: fall back to LIKE */ }
    }
    for (const s of [...short, ...(fts.length ? [] : [query.trim()])].filter((x) => x.length >= 1).slice(0, 8)) {
      const rows = this.db.prepare("SELECT id FROM memories WHERE title LIKE ? OR body LIKE ? OR quote LIKE ? LIMIT 50").all(`%${s}%`, `%${s}%`, `%${s}%`) as any[];
      for (const r of rows) scores.set(r.id, Math.max(scores.get(r.id) ?? 0, 0.3));
    }
    const out: { entry: MemoryEntry; score: number }[] = [];
    for (const [id, score] of scores) {
      const e = this.get(id); if (!e) continue;
      if (!opts.includeInactive && e.status !== "active") continue;
      if (opts.type && e.type !== opts.type) continue;
      out.push({ entry: e, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 40);
  }

  /** mark file-linked facts stale when the linked file changed; returns ids marked */
  refreshStaleness(entries: MemoryEntry[]): string[] {
    const marked: string[] = [];
    for (const e of entries) {
      if (e.status !== "active") continue;
      const fileLinks = e.links.filter((l) => l.kind === "file" && l.hash);
      if (!fileLinks.length) continue;
      if (fileLinks.some((l) => { const h = fileHash(l.ref); return h !== undefined && h !== l.hash; })) { this.setStatus(e.id, "stale"); marked.push(e.id); }
    }
    return marked;
  }

  exportJsonl(): string { return this.list({ status: "all", limit: 1e9 }).reverse().map((e) => JSON.stringify(e)).join("\n") + "\n"; }

  importJsonl(text: string): number {
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e: MemoryEntry; try { e = JSON.parse(line); } catch { continue; }
      if (!e.title || !MEMORY_TYPES.includes(e.type)) continue;
      const dup = this.list({ status: "all", limit: 1e9 }).find((x) => x.type === e.type && x.title === e.title && x.body === e.body);
      if (dup) continue;
      const added = this.add({ type: e.type, title: e.title, body: e.body, links: e.links, quote: e.quote, pinned: e.pinned, project: e.project, source: e.source ?? { session: "import", turn: 0, by: "rule" } });
      if (e.status && e.status !== "active") this.setStatus(added.id, e.status);
      n++;
    }
    return n;
  }
}

/** git root of a directory, else the directory itself */
export function projectOf(cwd: string): string {
  let d = resolve(cwd);
  for (let i = 0; i < 40; i++) { if (existsSync(join(d, ".git"))) return d; const up = dirname(d); if (up === d) break; d = up; }
  return resolve(cwd);
}
