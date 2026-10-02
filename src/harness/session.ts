/**
 * Session DAG: nodes are turn boundaries (state summary + folded window).
 * fork() starts a branch from the current state; merge() brings a branch's state
 * delta back as a merged block (a few hundred tokens), never its token history.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { harnessHome } from "../core/knobs.js";
import { newRewriteState, type RewriteState } from "../core/rewrite.js";
import type { StateSummary } from "../core/summary.js";
import { sha1 } from "../core/items.js";
import { countTokens } from "../core/tokens.js";
import { copyTranscript, readTranscript, userWords } from "../transcript/index.js";

export interface TurnRecord {
  idx: number; user: string; steps: number; startedAt: string; endedAt?: string;
  usage: { input: number; cached: number; output: number; reasoning: number };
  transcriptArtifact?: string; finalText?: string; outcome?: "success" | "fail" | "unknown";
}
export interface MergedBlock { from: string; fromTitle: string; at: string; text: string; transcriptArtifact?: string }
export interface SessionData {
  id: string; title: string; cwd: string; createdAt: string; updatedAt: string;
  parent?: string; forkedAtTurn?: number; status: "active" | "discarded" | "merged";
  state: StateSummary; merged: MergedBlock[];
  window: any[];              // folded items (Responses format) carried into the next turn
  rewriteState: RewriteState; // stub cache etc.
  turns: TurnRecord[];
  knobs?: Record<string, unknown>;
}

function dir(): string { const d = join(harnessHome(), "harness", "sessions"); mkdirSync(d, { recursive: true }); return d; }
function pathOf(id: string): string { return join(dir(), id + ".json"); }

export function newSession(cwd: string, title?: string): SessionData {
  const id = "s_" + sha1(cwd + Date.now() + Math.random()).slice(0, 8);
  return { id, title: title ?? id, cwd, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "active", state: { filesTouched: [], commandsByKind: {}, errorsSeen: [], turns: 0 }, merged: [], window: [], rewriteState: newRewriteState(id), turns: [] };
}
export function saveSession(s: SessionData): void { s.updatedAt = new Date().toISOString(); writeFileSync(pathOf(s.id), JSON.stringify(s)); }
export function loadSession(id: string): SessionData | undefined { const p = pathOf(id); if (!existsSync(p)) return undefined; return JSON.parse(readFileSync(p, "utf8")); }
export function listSessions(): SessionData[] {
  return readdirSync(dir()).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(readFileSync(join(dir(), f), "utf8")) as SessionData; } catch { return undefined; } }).filter((x): x is SessionData => !!x).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function findSession(ref: string): SessionData | undefined {
  return loadSession(ref) ?? listSessions().find((s) => s.title === ref || s.id.startsWith(ref));
}

export function forkSession(parent: SessionData, title: string): SessionData {
  const child = newSession(parent.cwd, title);
  child.parent = parent.id; child.forkedAtTurn = parent.turns.length;
  child.state = JSON.parse(JSON.stringify(parent.state));
  child.window = JSON.parse(JSON.stringify(parent.window));
  child.rewriteState = { ...newRewriteState(child.id), stubs: { ...parent.rewriteState.stubs } };
  child.merged = [...parent.merged];
  // the branch continues the conversation: same transcript, same turn numbering
  child.turns = JSON.parse(JSON.stringify(parent.turns));
  copyTranscript(parent.id, child.id);
  saveSession(child); return child;
}

/** Compute the branch's delta relative to the fork point and append it to main as a merged block. */
export function mergeSession(branch: SessionData, main: SessionData, maxTokens = 600): MergedBlock {
  const since = branch.forkedAtTurn ?? 0;
  const turns = branch.turns.slice(branch.parent === main.id ? since : 0);   // turns before the fork point are main's own
  const newFiles = branch.state.filesTouched.filter((f) => !main.state.filesTouched.includes(f));
  const newErrors = branch.state.errorsSeen.filter((e) => !main.state.errorsSeen.includes(e));
  const lines: string[] = [];
  // the user's words on the branch come back verbatim (never truncated); answers come back as cards
  const tr = readTranscript(branch.id);
  const userWordsOnBranch: string[] = [];
  for (const t of turns) {
    const u = tr.find((e) => e.kind === "user" && e.turn === t.idx);
    const a = tr.find((e) => e.kind === "answer" && e.turn === t.idx) as any;
    const words = u ? userWords((u as any).text).join("\n") : t.user;
    userWordsOnBranch.push(words);
    lines.push(`- turn ${t.idx}: user said:\n${words.split("\n").map((l) => "    " + l).join("\n")}\n  → ${(a?.card || t.finalText || "").slice(0, 400).replace(/\s+/g, " ")}${t.transcriptArtifact ? ` [recall("${t.transcriptArtifact}")]` : ""}`);
  }
  if (newFiles.length) lines.push(`- files edited on branch: ${newFiles.join(", ")}`);
  if (branch.state.lastTestStatus) lines.push(`- last test status on branch: ${branch.state.lastTestStatus}`);
  if (newErrors.length) lines.push(`- errors seen: ${newErrors.slice(0, 5).join("; ")}`);
  if (branch.state.notes) lines.push(`- branch notes: ${branch.state.notes}`);
  let text = lines.join("\n");
  if (countTokens(text) > maxTokens) {
    // shrink everything except the user's words
    const meta = lines.filter((l) => !l.startsWith("- turn ")).join("\n").slice(0, maxTokens * 2);
    text = turns.map((t, i) => `- turn ${t.idx}: user said:\n${userWordsOnBranch[i].split("\n").map((l) => "    " + l).join("\n")}`).join("\n") + (meta ? "\n" + meta : "") + "\n- [answers omitted for size; recall the branch transcript]";
  }
  const block: MergedBlock = { from: branch.id, fromTitle: branch.title, at: new Date().toISOString(), text, transcriptArtifact: turns.at(-1)?.transcriptArtifact };
  main.merged.push(block);
  for (const f of newFiles) main.state.filesTouched.push(f);
  for (const e of newErrors) main.state.errorsSeen.push(e);
  if (branch.state.lastTestStatus) main.state.lastTestStatus = branch.state.lastTestStatus;
  branch.status = "merged"; saveSession(branch); saveSession(main);
  void since;
  return block;
}

export function discardSession(s: SessionData): void { s.status = "discarded"; saveSession(s); }
