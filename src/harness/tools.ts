/**
 * Harness tools. Design points:
 *   run(cmd)         blocks until exit or timeout — the model never polls.
 *   run(background)  returns a job id; wait(job, until) blocks inside the harness.
 *   read(path)       per-session cache keyed by (path, range, mtime, hash).
 *   recall(id)       expands a folded artifact.
 *   edit/write       bounded file changes; files touched are tracked for the digest.
 *   delegate(...)    T3 subtask in a fresh context (wired by the loop).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { ArtifactStore } from "../core/artifacts.js";
import { shapeOutput } from "../core/shapers.js";
import { shaperKnobs, harnessHome, type Knobs } from "../core/knobs.js";
import { countTokens } from "../core/tokens.js";
import { sha1 } from "../core/items.js";
import type { ToolDef } from "./providers.js";
import { ALL_EXTRA_TOOLS, EXTRA_TOOLS, extraHandler, MULTI_TURN_ONLY, type MemoryToolContext } from "./tools_extra.js";

export interface Job { id: string; cmd: string; proc: ChildProcess; buf: string; readOffset: number; exitCode: number | null; startedAt: number; lastOutputAt: number; logPath: string }

export interface ToolContext extends Partial<MemoryToolContext> {
  cwd: string; knobs: Knobs; store: ArtifactStore; sessionId: string;
  filesTouched: Set<string>;
  readCache: Map<string, { hash: string; callId: string; verbatim: boolean }>;
  cmdCache: Map<string, { text: string; at: number }>;
  jobs: Map<string, Job>;
  delegate?: (task: string, inputs: string, acceptance?: string) => Promise<string>;
  onEvent?: (e: { kind: string; detail: string }) => void;
}

/** the original tool set */
export const CORE_TOOL_DEFS: ToolDef[] = [
  { name: "run", description: "Run a shell command in the workspace. Blocks until it exits (default timeout 600s) and returns shaped output; the full output is always saved and can be expanded with recall. Set background=true for long-running processes and use wait() instead of polling.", parameters: { type: "object", properties: { cmd: { type: "string" }, timeout_s: { type: "integer" }, background: { type: "boolean" }, cwd: { type: "string" } }, required: ["cmd"] } },
  { name: "wait", description: "Wait for a background job inside the harness (no polling). Returns when the job exits, when its output matches `until` (regex), after `silence_s` seconds without new output, or after `max_s`. Returns only output produced since the last wait.", parameters: { type: "object", properties: { job: { type: "string" }, until: { type: "string" }, silence_s: { type: "integer" }, max_s: { type: "integer" } }, required: ["job"] } },
  { name: "read", description: "Read a file (optionally a line range). Repeated identical reads of unchanged content return a short 'unchanged' note instead of the text.", parameters: { type: "object", properties: { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" }, max_tokens: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a file with the given content.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit", description: "Replace an exact substring in a file (old must occur exactly once unless count is given).", parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, count: { type: "integer" } }, required: ["path", "old", "new"] } },
  { name: "recall", description: "Expand a folded output/artifact by id (from a stub like [output #abc123 …]). Optional grep (regex), range [start,end], head, tail.", parameters: { type: "object", properties: { id: { type: "string" }, grep: { type: "string" }, range: { type: "array", items: { type: "integer" } }, head: { type: "integer" }, tail: { type: "integer" } }, required: ["id"] } },
  { name: "delegate", description: "Hand a bounded, self-contained subtask to a worker with a fresh context (cheaper model first, escalates on failure). Provide everything the worker needs in `inputs` (paths, commands, acceptance criteria); you get back a short report.", parameters: { type: "object", properties: { task: { type: "string" }, inputs: { type: "string" }, acceptance: { type: "string", description: "shell command that must exit 0 for success" } }, required: ["task"] } },
  { name: "state_update", description: "Record durable notes for the task state (decisions, facts with artifact ids, open questions, next step). Keep under 300 tokens; this replaces earlier notes.", parameters: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] } },
];

/** job logs live under the harness home, never inside the user's repository */
function jobsDir(_ctx: ToolContext): string { const d = join(harnessHome(), "jobs"); mkdirSync(d, { recursive: true }); return d; }

export function startJob(ctx: ToolContext, cmd: string, cwd: string): Job {
  const id = "job_" + sha1(cmd + Date.now()).slice(0, 6);
  const logPath = resolve(jobsDir(ctx), id + ".log");
  const proc = spawn("bash", ["-lc", cmd], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const job: Job = { id, cmd, proc, buf: "", readOffset: 0, exitCode: null, startedAt: Date.now(), lastOutputAt: Date.now(), logPath };
  const onData = (d: Buffer) => { const s = d.toString("utf8"); job.buf += s; job.lastOutputAt = Date.now(); appendFileSync(logPath, s); if (job.buf.length > 4_000_000) job.buf = job.buf.slice(-2_000_000); };
  proc.stdout?.on("data", onData); proc.stderr?.on("data", onData);
  proc.on("close", (code) => { job.exitCode = code ?? -1; });
  ctx.jobs.set(id, job);
  return job;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export async function waitJob(job: Job, opts: { until?: string; silenceS?: number; maxS: number }): Promise<{ text: string; status: string }> {
  const t0 = Date.now(); let re: RegExp | undefined;
  if (opts.until) { try { re = new RegExp(opts.until, "m"); } catch { re = undefined; } }
  for (;;) {
    const fresh = job.buf.slice(job.readOffset);
    if (job.exitCode !== null) return { text: fresh, status: `exited ${job.exitCode}` };
    if (re && re.test(fresh)) return { text: fresh, status: `matched /${opts.until}/` };
    if (opts.silenceS && Date.now() - job.lastOutputAt > opts.silenceS * 1000 && fresh.length > 0) return { text: fresh, status: `silent ${opts.silenceS}s` };
    if (Date.now() - t0 > opts.maxS * 1000) return { text: fresh, status: `still running after ${opts.maxS}s` };
    await sleep(300);
  }
}

function shaped(ctx: ToolContext, text: string, cmd: string | undefined): string {
  const r = shapeOutput(text, cmd, shaperKnobs(ctx.knobs));
  if (r.tokensAfter < r.tokensBefore - 50) { const meta = ctx.store.put(text, "output", cmd?.slice(0, 80)); return r.text + `\n[full output: ${meta.lines} lines, ${r.tokensBefore} tok → recall("${meta.id}")]`; }
  return r.text;
}

const IDEMPOTENT_RE = /^(?:\S*(?:py_compile|--version|-V)\b|git (?:status|log|diff --stat)|ls\b|wc\b|cat\b|head\b|tail\b|rg\b|grep\b|find\b)/;

export async function executeTool(ctx: ToolContext, name: string, args: any, callId: string): Promise<string> {
  try {
    switch (name) {
      case "run": {
        const cmd = String(args.cmd ?? ""); const cwd = args.cwd ? resolve(ctx.cwd, String(args.cwd)) : ctx.cwd;
        if (!cmd) return "[run] missing cmd";
        if (args.background) { const job = startJob(ctx, cmd, cwd); ctx.onEvent?.({ kind: "job", detail: `${job.id} started: ${cmd.slice(0, 80)}` }); return `[background job ${job.id} started; use wait(job="${job.id}")]`; }
        const key = cwd + "\u0000" + cmd;
        if (ctx.knobs.idempotent_cmd_cache && IDEMPOTENT_RE.test(cmd)) { const c = ctx.cmdCache.get(key); if (c && Date.now() - c.at < 120_000 && ctx.filesTouched.size === (c as any).touched) { ctx.onEvent?.({ kind: "dedupe", detail: cmd.slice(0, 60) }); return `[unchanged: same command ran ${Math.round((Date.now() - c.at) / 1000)}s ago with no edits since]\n` + c.text; } }
        const job = startJob(ctx, cmd, cwd);
        const r = await waitJob(job, { maxS: Number(args.timeout_s ?? ctx.knobs.blocking_exec_timeout_s) });
        ctx.jobs.delete(job.id);
        if (r.status.startsWith("still running")) { ctx.jobs.set(job.id, job); return `[timeout after ${args.timeout_s ?? ctx.knobs.blocking_exec_timeout_s}s; job ${job.id} still running — use wait(job="${job.id}") or run with background=true]\n` + shaped(ctx, r.text, cmd); }
        const text = `[exit ${job.exitCode}]\n` + r.text;
        const out = shaped(ctx, text, cmd);
        if (IDEMPOTENT_RE.test(cmd)) ctx.cmdCache.set(key, { text: out, at: Date.now(), touched: ctx.filesTouched.size } as any);
        return out;
      }
      case "wait": {
        const job = ctx.jobs.get(String(args.job)); if (!job) return `[wait] unknown job ${args.job}`;
        const r = await waitJob(job, { until: args.until ? String(args.until) : undefined, silenceS: Number(args.silence_s ?? ctx.knobs.wait_silence_s), maxS: Number(args.max_s ?? 1800) });
        job.readOffset = job.buf.length;
        if (job.exitCode !== null) ctx.jobs.delete(job.id);
        return `[${job.id} ${r.status}]\n` + shaped(ctx, r.text || "(no new output)", job.cmd);
      }
      case "read": {
        const p = resolve(ctx.cwd, String(args.path)); if (!existsSync(p)) return `[read] not found: ${p}`;
        const st = statSync(p); if (st.isDirectory()) return `[read] ${p} is a directory`;
        const content = readFileSync(p, "utf8"); const lines = content.split("\n");
        const a = Math.max(1, Number(args.start ?? 1)), b = Math.min(lines.length, Number(args.end ?? lines.length));
        const slice = lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join("\n");
        const key = `${p}:${a}-${b}`; const h = sha1(slice);
        const prev = ctx.readCache.get(key);
        if (ctx.knobs.dedupe_reads && prev && prev.hash === h && prev.verbatim) { ctx.onEvent?.({ kind: "dedupe", detail: key }); return `[unchanged: identical to earlier read of ${args.path} lines ${a}-${b}]`; }
        ctx.readCache.set(key, { hash: h, callId, verbatim: true });
        const cap = Number(args.max_tokens ?? ctx.knobs.per_output_cap * 2);
        if (countTokens(slice) > cap) { const meta = ctx.store.put(slice, "read", key); const keep = Math.floor(cap * 3.5); return slice.slice(0, keep) + `\n[... truncated: ${lines.length} lines total, ${countTokens(slice)} tok → read a narrower range or recall("${meta.id}")]`; }
        return slice;
      }
      case "write_file": {
        const p = resolve(ctx.cwd, String(args.path)); mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(args.content ?? "")); ctx.filesTouched.add(p); ctx.readCache.clear();
        return `[wrote ${p}: ${String(args.content ?? "").split("\n").length} lines]`;
      }
      case "edit": {
        const p = resolve(ctx.cwd, String(args.path)); if (!existsSync(p)) return `[edit] not found: ${p}`;
        const src = readFileSync(p, "utf8"); const oldS = String(args.old), newS = String(args.new);
        const n = src.split(oldS).length - 1;
        if (n === 0) return `[edit] old text not found in ${p}`;
        if (n > 1 && args.count !== n) return `[edit] old text occurs ${n} times; pass count=${n} to replace all or make it unique`;
        writeFileSync(p, src.split(oldS).join(newS)); ctx.filesTouched.add(p); ctx.readCache.clear();
        return `[edited ${p}: replaced ${n} occurrence(s)]`;
      }
      case "recall": {
        ctx.onEvent?.({ kind: "recall", detail: String(args.id) });
        return "[recall] " + ctx.store.recall(String(args.id ?? ""), { grep: args.grep, range: Array.isArray(args.range) && args.range.length === 2 ? [Number(args.range[0]), Number(args.range[1])] : undefined, head: args.head, tail: args.tail, maxChars: ctx.knobs.per_output_cap * 7 });
      }
      case "delegate": {
        if (!ctx.delegate) return "[delegate] not available in this context";
        ctx.onEvent?.({ kind: "delegate", detail: String(args.task).slice(0, 80) });
        return await ctx.delegate(String(args.task ?? ""), String(args.inputs ?? ""), args.acceptance ? String(args.acceptance) : undefined);
      }
      case "state_update": return "[state notes recorded]";
      default: {
        const h = extraHandler(name);
        return h ? await h(ctx, args, callId) : `[unknown tool ${name}]`;
      }
    }
  } catch (e: any) {
    return `[${name} error] ${e?.message ?? String(e)}`;
  }
}

/** single-task tool set (strategies, delegate workers): core + file/search tools */
export const TOOL_DEFS: ToolDef[] = [...CORE_TOOL_DEFS, ...EXTRA_TOOLS.filter((t) => !t.multiTurnOnly && !t.vibeOnly).map((t) => t.def)];

/** multi-turn tool set: state_update is replaced by remember (typed, appended, never overwritten) */
export const MULTI_TURN_TOOL_DEFS: ToolDef[] = [...CORE_TOOL_DEFS.filter((t) => t.name !== "state_update"), ...EXTRA_TOOLS.filter((t) => !t.vibeOnly).map((t) => t.def)];

/**
 * Every registered tool, which is what a caller's `toolNames` is resolved against.
 * The vibe tools are deliberately in no default set: a coding turn must not be able
 * to rewrite the harness's own configuration, so they only arrive by being named.
 */
export const ALL_TOOL_DEFS: ToolDef[] = [...CORE_TOOL_DEFS, ...ALL_EXTRA_TOOLS.map((t) => t.def)];

export { MULTI_TURN_ONLY };
