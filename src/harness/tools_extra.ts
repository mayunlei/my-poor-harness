/**
 * Tools added for multi-turn sessions (docs/MEMORY_DESIGN.md §6), registered next to
 * the core tools in tools.ts: multi_edit, ls, grep, memory_search, memory_get, remember,
 * skill. Each tool is a definition plus a handler; tools.ts dispatches unknown names here.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolDef } from "./providers.js";
import type { ToolContext } from "./tools.js";
import { MEMORY_TYPES, type MemoryStore, type MemoryType } from "../memory/store.js";
import { detailBlock, l1Line } from "../memory/recall.js";
import { addUnlessDuplicate, normalizeLinks } from "../memory/write.js";
import { loadSkillBody, onPath, type Skill } from "../skills/index.js";
import { VIBE_TOOLS } from "./vibe.js";

/** what the multi-turn loop adds to a ToolContext */
export interface MemoryToolContext {
  memory?: MemoryStore;
  memoryRecall: boolean;
  memoryWrite: boolean;
  /** ids the model was shown this turn (pinned, index, detail) — a get outside it is a recall miss */
  memoryShown: Set<string>;
  memoryUsed: Set<string>;
  memoryMisses: string[];
  remembered: string[];
  project: string;
  turn: number;
  skills: Skill[];
  skillsLoaded: string[];
}

export type Handler = (ctx: ToolContext & Partial<MemoryToolContext>, args: any, callId: string) => Promise<string> | string;
export interface RegisteredTool { def: ToolDef; handler: Handler; multiTurnOnly?: boolean; vibeOnly?: boolean }

const IGNORE = new Set([".git", "node_modules", "dist", "build", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".tox", ".next", "target", ".idea", ".DS_Store"]);

/**
 * Fallback for when ripgrep is not installed: search here rather than shelling out
 * to grep, whose dialect is not portable. BSD grep -E matches `\d`, GNU grep -E
 * reads it as a literal `d`, and the model writes PCRE/JS patterns -- so the same
 * call found matches on a laptop and none in CI. JS RegExp is one dialect
 * everywhere, and the one the patterns are written in.
 */
const GREP_FILE_MAX = 2 * 1024 * 1024;
const GREP_HIT_MAX = 4000;

/** a shell glob ('*.py', 'src/**\/*.ts') as a regex, tested against basename and relative path */
export function globToRe(glob?: unknown): RegExp | undefined {
  if (!glob) return undefined;
  const body = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  try { return new RegExp(`^${body}$`); } catch { return undefined; }
}

export function grepTree(root: string, re: RegExp, globRe?: RegExp): string[] {
  const hits: string[] = [];
  const scan = (file: string) => {
    let st; try { st = statSync(file); } catch { return; }
    if (st.size > GREP_FILE_MAX) return;
    let text; try { text = readFileSync(file, "utf8"); } catch { return; }
    if (text.includes("\0")) return;                      // binary
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push(`${file}:${i + 1}:${lines[i]}`);
        if (hits.length >= GREP_HIT_MAX) return;
      }
    }
  };
  const walk = (dir: string) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (hits.length >= GREP_HIT_MAX) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORE.has(e.name)) walk(p); continue; }
      if (!e.isFile()) continue;
      if (globRe && !globRe.test(e.name) && !globRe.test(relative(root, p))) continue;
      scan(p);
    }
  };
  try { statSync(root).isFile() ? scan(root) : walk(root); } catch { /* gone */ }
  return hits;
}

function walk(root: string, depth: number, max: number): string[] {
  const out: string[] = [];
  const rec = (dir: string, d: number) => {
    if (out.length >= max) return;
    let names: string[] = []; try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (out.length >= max) return;
      if (IGNORE.has(n)) continue;
      const p = join(dir, n); let st; try { st = statSync(p); } catch { continue; }
      const rel = relative(root, p) || n;
      if (st.isDirectory()) { out.push(rel + "/"); if (d < depth) rec(p, d + 1); }
      else out.push(rel + (st.size > 200_000 ? `  (${Math.round(st.size / 1024)}K)` : ""));
    }
  };
  rec(root, 1);
  return out;
}

export const EXTRA_TOOLS: RegisteredTool[] = [
  {
    def: { name: "multi_edit", description: "Apply several exact-substring replacements to one file in order, all or nothing. Each edit's old text must occur exactly once (or pass count).", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" }, count: { type: "integer" } }, required: ["old", "new"] } } }, required: ["path", "edits"] } },
    handler: (ctx, args) => {
      const p = resolve(ctx.cwd, String(args.path)); if (!existsSync(p)) return `[multi_edit] not found: ${p}`;
      let src = readFileSync(p, "utf8");
      const edits = Array.isArray(args.edits) ? args.edits : [];
      for (const [i, e] of edits.entries()) {
        const oldS = String(e.old ?? ""), newS = String(e.new ?? "");
        const n = oldS ? src.split(oldS).length - 1 : 0;
        if (n === 0) return `[multi_edit] edit ${i + 1}: old text not found; nothing written`;
        if (n > 1 && e.count !== n) return `[multi_edit] edit ${i + 1}: old text occurs ${n} times; pass count=${n} or make it unique; nothing written`;
        src = src.split(oldS).join(newS);
      }
      writeFileSync(p, src); ctx.filesTouched.add(p); ctx.readCache.clear();
      return `[multi_edit ${p}: ${edits.length} edit(s) applied]`;
    },
  },
  {
    def: { name: "ls", description: "List a directory tree (skips .git, node_modules, build output). depth defaults to 2; at most 300 entries.", parameters: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer" } } } },
    handler: (ctx, args) => {
      const root = resolve(ctx.cwd, String(args.path ?? ".")); if (!existsSync(root)) return `[ls] not found: ${root}`;
      if (!statSync(root).isDirectory()) return `[ls] ${root} is a file`;
      const items = walk(root, Math.min(6, Math.max(1, Number(args.depth ?? 2))), 300);
      return `[ls ${root}]\n${items.join("\n")}${items.length >= 300 ? "\n[... truncated at 300 entries; narrow the path or depth]" : ""}`;
    },
  },
  {
    def: { name: "grep", description: "Search file contents with a regex (ripgrep when available). Results grouped by file, at most `max` matches (default 60). Optional path and glob (e.g. '*.py').", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, max: { type: "integer" }, ignore_case: { type: "boolean" } }, required: ["pattern"] } },
    handler: (ctx, args) => {
      const root = resolve(ctx.cwd, String(args.path ?? ".")); const max = Math.min(400, Math.max(1, Number(args.max ?? 60)));
      const pat = String(args.pattern ?? ""); if (!pat) return "[grep] missing pattern";
      let stdout: string;
      if (onPath("rg")) {
        const argv = ["--line-number", "--no-heading", "--color=never", "--max-columns=240", ...(args.ignore_case ? ["-i"] : []), ...(args.glob ? ["--glob", String(args.glob)] : []), "-e", pat, root];
        const r = spawnSync("rg", argv, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
        if (r.status === 1) return `[grep] no matches for /${pat}/`;
        if (r.status !== 0 && !r.stdout) return `[grep error] ${(r.stderr || "").slice(0, 400)}`;
        stdout = r.stdout;
      } else {
        let re: RegExp;
        try { re = new RegExp(pat, args.ignore_case ? "i" : ""); } catch (e) { return `[grep error] bad pattern: ${(e as Error).message}`; }
        const hits = grepTree(root, re, globToRe(args.glob));
        if (!hits.length) return `[grep] no matches for /${pat}/`;
        stdout = hits.join("\n");
      }
      const lines = stdout.split("\n").filter(Boolean);
      const byFile = new Map<string, string[]>();
      for (const l of lines) { const m = /^(.*?):(\d+):(.*)$/.exec(l); if (!m) continue; const f = relative(ctx.cwd, m[1]) || m[1]; const arr = byFile.get(f) ?? []; arr.push(`  ${m[2]}: ${m[3].slice(0, 240)}`); byFile.set(f, arr); }
      const out: string[] = []; let shown = 0;
      for (const [f, ms] of byFile) { if (shown >= max) break; const take = ms.slice(0, Math.max(1, Math.min(ms.length, max - shown))); out.push(`${f} (${ms.length})`, ...take); shown += take.length; }
      const total = lines.length;
      return `[grep /${pat}/ · ${total} matches in ${byFile.size} files${total > shown ? ` · showing ${shown}` : ""}]\n${out.join("\n")}`;
    },
  },
  {
    multiTurnOnly: true,
    def: { name: "memory_search", description: "Search long-term memory (decisions, constraints, preferences, failed attempts, code facts, procedures from earlier turns and sessions). Returns one line per entry; use memory_get(id) for details.", parameters: { type: "object", properties: { query: { type: "string" }, type: { type: "string", enum: [...MEMORY_TYPES] } }, required: ["query"] } },
    handler: (ctx, args) => {
      if (!ctx.memory || !ctx.memoryRecall) return "[memory_search] memory recall is turned off in settings";
      const hits = ctx.memory.search(String(args.query ?? ""), { limit: 15, type: MEMORY_TYPES.includes(args.type) ? args.type : undefined });
      if (!hits.length) return `[memory_search] nothing for "${args.query}"`;
      return `[memory_search "${args.query}"]\n` + hits.map((h) => l1Line(h.entry)).join("\n");
    },
  },
  {
    multiTurnOnly: true,
    def: { name: "memory_get", description: "Full text and links of memory entries by id (e.g. m12). Facts linked to files are checked: a changed file marks the entry stale.", parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
    handler: (ctx, args) => {
      if (!ctx.memory || !ctx.memoryRecall) return "[memory_get] memory recall is turned off in settings";
      const ids = (Array.isArray(args.ids) ? args.ids : [args.ids ?? args.id]).map(String).filter(Boolean).slice(0, 10);
      const out: string[] = [];
      for (const id of ids) {
        const e = ctx.memory.get(id); if (!e) { out.push(`[${id}] not found`); continue; }
        ctx.memory.refreshStaleness([e]);
        const fresh = ctx.memory.get(id)!;
        ctx.memory.touch(id); ctx.memoryUsed?.add(id);
        if (ctx.memoryShown && !ctx.memoryShown.has(id)) { ctx.memoryMisses?.push(id); ctx.onEvent?.({ kind: "memory_miss", detail: id }); }
        out.push(detailBlock(fresh));
      }
      return out.join("\n\n");
    },
  },
  {
    multiTurnOnly: true,
    def: { name: "remember", description: "Save a memory for future turns and sessions: a decision and why, a user constraint or preference (quote the user's exact sentence), an approach that failed and why, a non-obvious code fact (link the file), an open question, or a reusable procedure. One fact per call; skip what the code itself shows.", parameters: { type: "object", properties: { type: { type: "string", enum: [...MEMORY_TYPES] }, title: { type: "string", description: "one line, <= 80 chars" }, body: { type: "string", description: "<= 60 words" }, links: { type: "array", items: { type: "string" }, description: "file paths or URLs" }, quote: { type: "string", description: "the user's exact words, for constraints and preferences" } }, required: ["type", "title"] } },
    handler: (ctx, args) => {
      if (!ctx.memory || !ctx.memoryWrite) return "[remember] memory writing is turned off in settings; nothing saved";
      const type = (MEMORY_TYPES.includes(args.type) ? args.type : "fact") as MemoryType;
      const r = addUnlessDuplicate(ctx.memory, { type, title: String(args.title ?? "").slice(0, 160), body: String(args.body ?? ""), links: normalizeLinks(args.links, ctx.cwd), quote: args.quote ? String(args.quote) : undefined, project: ctx.project ?? ctx.cwd, source: { session: ctx.sessionId, turn: ctx.turn ?? 0, by: "model" }, pinned: type === "goal" || type === "constraint" });
      ctx.remembered?.push(r.entry.id);
      return r.created ? `[remembered ${r.entry.id}]` : `[already known as ${r.entry.id}]`;
    },
  },
  {
    multiTurnOnly: true,
    def: { name: "skill", description: "Load a skill's instructions (SKILL.md) by name, from the skill list in your instructions. Then follow it: read its files with read(), run its scripts with run().", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    handler: (ctx, args) => {
      const s = (ctx.skills ?? []).find((x) => x.name === String(args.name)) ?? (ctx.skills ?? []).find((x) => x.name.toLowerCase() === String(args.name).toLowerCase());
      if (!s) return `[skill] unknown skill "${args.name}"; available: ${(ctx.skills ?? []).map((x) => x.name).join(", ") || "none"}`;
      ctx.skillsLoaded?.push(s.name);
      ctx.onEvent?.({ kind: "skill", detail: s.name });
      return loadSkillBody(s);
    },
  },
];

/** vibe-mode tools live in vibe.ts but dispatch through the same table */
export const ALL_EXTRA_TOOLS: RegisteredTool[] = [...EXTRA_TOOLS, ...VIBE_TOOLS];
export const EXTRA_TOOL_DEFS: ToolDef[] = EXTRA_TOOLS.map((t) => t.def);
export const MULTI_TURN_ONLY = new Set(EXTRA_TOOLS.filter((t) => t.multiTurnOnly).map((t) => t.def.name));
export function extraHandler(name: string): Handler | undefined { return ALL_EXTRA_TOOLS.find((t) => t.def.name === name)?.handler; }
