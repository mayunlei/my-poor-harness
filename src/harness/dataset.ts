/**
 * Save a session, with its full context, into a dataset for later backtesting.
 *
 * 一句话：把真实用过的会话（含每轮的完整上下文）连同"它要解决什么问题"的注释存档，
 * 以后改了 harness 可以拿同一批真实对话重放、对比答复和 token。
 *
 * Layout: ~/.mph/datasets/<dataset>/
 *   index.jsonl                  one line per saved case: id, note, session, turns, saved_at
 *   <id>/case.json               the case: note, models, knobs, git state, and per turn the user's
 *                                words, the answer, files changed, usage, gate decision, git HEAD
 *   <id>/transcript.jsonl        the session's transcript (user words verbatim, answers, cards)
 *   <id>/turns/turn-<n>.json     everything the model saw and did in turn n: the assembled context,
 *                                every tool call and output (from the turn's transcript artifact)
 *   <id>/ledger.jsonl            the session's ledger rows (tokens, cache, gate, memory, folds)
 *   <id>/memory.jsonl            memories written during the session
 *   <id>/workspace.diff          uncommitted changes at save time (git diff HEAD), when in a repo
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessHome, knobsFor, resolveKnobs } from "../core/knobs.js";
import { ArtifactStore } from "../core/artifacts.js";
import { Ledger } from "../core/ledger.js";
import { readTranscript, transcriptPath, type AnswerEntry, type UserEntry } from "../transcript/index.js";
import { MemoryStore } from "../memory/store.js";
import { resolveModels } from "../upstream/config.js";
import type { SessionData } from "./session.js";

export function datasetsDir(): string { return join(harnessHome(), "datasets"); }

export interface GitState { root: string; head?: string; branch?: string; dirty?: boolean }

/** git root / HEAD / dirty for a directory; undefined outside a repository */
export function gitState(cwd: string): GitState | undefined {
  const git = (...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8", timeout: 5000 });
  const root = git("rev-parse", "--show-toplevel");
  if (root.status !== 0) return undefined;
  const head = git("rev-parse", "HEAD"); const branch = git("rev-parse", "--abbrev-ref", "HEAD"); const st = git("status", "--porcelain");
  return { root: root.stdout.trim(), head: head.status === 0 ? head.stdout.trim() : undefined, branch: branch.status === 0 ? branch.stdout.trim() : undefined, dirty: st.status === 0 ? st.stdout.trim().length > 0 : undefined };
}

function harnessVersion(): string | undefined {
  try {
    let d = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) { const p = join(d, "package.json"); if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")).version; d = dirname(d); }
  } catch { /* ignore */ }
  return undefined;
}

const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40);

export interface SaveOptions { note: string; dataset?: string; id?: string; store?: ArtifactStore; ledger?: Ledger; memory?: MemoryStore | null; now?: Date }
export interface SaveResult { dir: string; id: string; dataset: string; turns: number; contextFiles: number; ledgerRows: number; memories: number }

export function validateNote(note: string | undefined): string {
  const n = (note ?? "").trim().replace(/\s+/g, " ");
  if (!n) throw new Error('需要一句话注释，说明这个会话用来解决什么问题，例如 --note "复现：长日志粘贴后追问细节，模型找不到原文"');
  if (n.length > 300) throw new Error(`注释请控制在一句话（300 字以内），现在是 ${n.length} 字`);
  return n;
}

export function saveToDataset(session: SessionData, o: SaveOptions): SaveResult {
  const note = validateNote(o.note);
  const dataset = slug(o.dataset ?? "default") || "default";
  const now = o.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 13);   // 20261002T2130
  const id = slug(o.id ?? "") || `${stamp}-${session.id}`;
  const root = join(datasetsDir(), dataset);
  const dir = join(root, id);
  if (existsSync(join(dir, "case.json"))) throw new Error(`dataset ${dataset} already has a case ${id}; pass --id to name it differently`);
  mkdirSync(join(dir, "turns"), { recursive: true });
  const store = o.store ?? new ArtifactStore();
  const ledger = o.ledger ?? new Ledger();

  // transcript: copied verbatim; it is also the source of the user's words and full answers
  const entries = readTranscript(session.id);
  if (existsSync(transcriptPath(session.id))) copyFileSync(transcriptPath(session.id), join(dir, "transcript.jsonl"));
  const userByTurn = new Map(entries.filter((e): e is UserEntry => e.kind === "user").map((e) => [e.turn, e]));
  const answerByTurn = new Map(entries.filter((e): e is AnswerEntry => e.kind === "answer").map((e) => [e.turn, e]));

  // ledger rows of this session (and its delegate workers)
  const rows = ledger.readAll().filter((r: any) => r.session === session.id || String(r.session ?? "").startsWith(session.id + ":"));
  writeFileSync(join(dir, "ledger.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  const gateByTurn = new Map<number, any>();
  for (const r of rows as any[]) if (r.event === "gate" && r.session === session.id) gateByTurn.set(r.turn, { action: r.extra?.action, by: r.extra?.by, why: r.note });

  // per-turn full context
  let contextFiles = 0;
  const turns = session.turns.map((t) => {
    let contextFile: string | undefined;
    const items = t.transcriptArtifact ? store.get(t.transcriptArtifact) : undefined;
    if (items) { contextFile = `turns/turn-${t.idx}.json`; writeFileSync(join(dir, contextFile), items); contextFiles++; }
    const u = userByTurn.get(t.idx); const a = answerByTurn.get(t.idx);
    return {
      idx: t.idx, started_at: t.startedAt, ended_at: t.endedAt,
      user: u?.text ?? t.user,                                  // verbatim
      answer: a?.text ?? t.finalText ?? "", answer_card: a?.card, answer_status: a?.status, files_changed: a?.filesChanged ?? [],
      steps: t.steps, usage: t.usage, gate: gateByTurn.get(t.idx), git: (t as any).git, context_file: contextFile,
    };
  });

  // memories written during the session
  let memories: any[] = [];
  const mem = o.memory === undefined ? (() => { try { return new MemoryStore(); } catch { return null; } })() : o.memory;
  if (mem) {
    memories = mem.list({ status: "all", limit: 100000 }).filter((e) => e.source?.session === session.id).reverse();
    if (o.memory === undefined) mem.close();
  }
  writeFileSync(join(dir, "memory.jsonl"), memories.map((e) => JSON.stringify(e)).join("\n") + (memories.length ? "\n" : ""));

  // workspace state at save time
  const git = gitState(session.cwd);
  if (git) {
    const diff = spawnSync("git", ["diff", "HEAD"], { cwd: session.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (diff.status === 0 && diff.stdout) writeFileSync(join(dir, "workspace.diff"), diff.stdout);
  }

  const knobs = resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), session.knobs as any);
  const models = resolveModels(knobs);
  const kase = {
    id, dataset, note, saved_at: now.toISOString(), harness_version: harnessVersion(),
    session: { id: session.id, title: session.title, cwd: resolve(session.cwd), parent: session.parent, forked_at_turn: session.forkedAtTurn, created_at: session.createdAt, status: session.status },
    models: { main: models.main, mid: models.mid, small: models.small },
    // what actually answered, from the ledger (the settings above can differ from what a run passed in)
    models_used: [...new Set((rows as any[]).filter((r) => r.model && typeof r.input === "number").map((r) => String(r.model)))],
    knobs, git_at_save: git, workspace_diff: existsSync(join(dir, "workspace.diff")) ? "workspace.diff" : undefined,
    merged: session.merged.map((m) => ({ from: m.from, title: m.fromTitle, at: m.at })),
    turns,
    totals: turns.reduce((acc, t) => ({ input: acc.input + t.usage.input, cached: acc.cached + t.usage.cached, output: acc.output + t.usage.output, steps: acc.steps + t.steps }), { input: 0, cached: 0, output: 0, steps: 0 }),
  };
  writeFileSync(join(dir, "case.json"), JSON.stringify(kase, null, 2) + "\n");
  appendFileSync(join(root, "index.jsonl"), JSON.stringify({ id, note, session: session.id, title: session.title, cwd: kase.session.cwd, turns: turns.length, saved_at: kase.saved_at }) + "\n");
  return { dir, id, dataset, turns: turns.length, contextFiles, ledgerRows: rows.length, memories: memories.length };
}

export interface IndexLine { id: string; note: string; session: string; title?: string; cwd?: string; turns: number; saved_at: string }

export function listDatasets(): { name: string; cases: number }[] {
  if (!existsSync(datasetsDir())) return [];
  return readdirSync(datasetsDir()).filter((d) => existsSync(join(datasetsDir(), d, "index.jsonl"))).map((name) => ({ name, cases: readIndex(name).length }));
}

export function readIndex(dataset: string): IndexLine[] {
  const p = join(datasetsDir(), dataset, "index.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x: IndexLine) => existsSync(join(datasetsDir(), dataset, x.id, "case.json")));
}

export function readCase(dataset: string, id: string): any {
  return JSON.parse(readFileSync(join(datasetsDir(), dataset, id, "case.json"), "utf8"));
}
