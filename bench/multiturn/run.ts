/**
 * Multi-turn golden set (docs/MEMORY_DESIGN.md §8). Scripted conversations with fixed user
 * messages and per-turn checkpoints, run under several context arms on the same model:
 *
 *   full          keep everything: every turn continues, answers verbatim, no paste stubs,
 *                 no memory — the "carry the whole context" baseline
 *   hybrid        the default multi-turn mode (gate, transcript epochs, memory recall + writes)
 *   hybrid-nomem  hybrid with memory recall and writes off
 *
 * Checks: cmd (exit 0 in the workspace), contains / not_contains (final answer), judge (the
 * model grades against a rubric, majority of 3). Tokens come from each job's own ledger, so
 * small-model work (gate, memory extraction, cards) is included.
 *
 *   npx tsx bench/multiturn/run.ts --model qwen3.7-plus [--arms full,hybrid,hybrid-nomem] [--cases a,b] [--parallel 3] [--out dir]
 * Endpoint from the usual settings (MPH_OPENAI_BASE_URL / MPH_OPENAI_API_KEY / MPH_OPENAI_WIRE_API or config.json).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initTokenizer } from "../../src/core/tokens.js";
import { resolveKnobs, harnessHome, type Knobs } from "../../src/core/knobs.js";
import { ArtifactStore } from "../../src/core/artifacts.js";
import { Ledger } from "../../src/core/ledger.js";
import { Router } from "../../src/harness/router.js";
import { runTurn } from "../../src/harness/loop.js";
import { newSession, saveSession, type SessionData } from "../../src/harness/session.js";
import { MemoryStore } from "../../src/memory/store.js";
import { discoverSkills } from "../../src/skills/index.js";
import { parseJsonObject } from "../../src/memory/write.js";
import type { GateAction } from "../../src/harness/gate.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Check { cmd?: string; contains?: string[]; not_contains?: string[]; judge?: string }
interface CaseTurn { user: string; session?: "new"; check?: Check[] }
interface Case { id: string; category: string; files: Record<string, string>; turns: CaseTurn[]; skills?: Record<string, { description: string; body: string }>; paste?: { turn: number; lines: number; needle_line: number; needle: string } }

interface Arm { name: string; knobs: Partial<Knobs>; memory: { recall: boolean; write: boolean }; gate?: GateAction }
const ARMS: Record<string, Arm> = {
  full: { name: "full", knobs: { answer_verbatim_turns: 12, paste_externalize_tokens: 20000, continue_budget: 100000, stub_old_outputs: false, collapse_poll_chains: false }, memory: { recall: false, write: false }, gate: "continue" },
  hybrid: { name: "hybrid", knobs: {}, memory: { recall: true, write: true } },
  "hybrid-nomem": { name: "hybrid-nomem", knobs: {}, memory: { recall: false, write: false } },
};

/** the endpoint's hourly/daily quota ran out: the case is re-run from scratch once it is back, never scored */
class QuotaError extends Error {}
const QUOTA_RE = /quota exceeded|allocated quota|insufficient_quota|usage limit|rate_limit_exceeded/i;

async function waitForQuota(router: Router, model: string): Promise<void> {
  for (let i = 0; ; i++) {
    try { await router.client(model).respond({ model, instructions: "Reply ok.", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] }], tools: [], reasoningEffort: "low", maxOutputTokens: 5 }); return; }
    catch (e: any) { if (!QUOTA_RE.test(String(e?.message ?? e))) return; console.error(`[multiturn] quota exhausted; waiting (${i * 5} min so far)`); await new Promise((r) => setTimeout(r, 300_000)); }
  }
}

const JUDGE_PROMPT = `You grade one turn of a coding assistant against a rubric. Read the rubric, the conversation excerpt, the assistant's answer and the workspace files. Reply with ONLY JSON: {"pass": true|false, "why": "<20 words"}`;

function opt(n: string, d?: string) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; }

function makeLog(p: NonNullable<Case["paste"]>): string {
  const kinds = ["WARN cache miss ratio high", "ERROR upstream timeout after 30s", "INFO request served", "ERROR db write retry", "WARN slow query 1.2s"];
  const lines: string[] = [];
  for (let i = 1; i <= p.lines; i++) lines.push(i === p.needle_line ? `2026-10-01 09:${String(i % 60).padStart(2, "0")}:13 ${p.needle}` : `2026-10-01 09:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")} ${kinds[i % kinds.length]} req=${100000 + i}`);
  return "```log\n" + lines.join("\n") + "\n```";
}

function workspaceSnapshot(ws: string, max = 12000): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      if (n.startsWith(".") || n === "__pycache__") continue;
      const p = join(d, n); const st = statSync(p);
      if (st.isDirectory()) walk(p); else if (st.size < 20000) out.push(`--- ${p.slice(ws.length + 1)}\n${readFileSync(p, "utf8")}`);
    }
  };
  walk(ws);
  return out.join("\n").slice(0, max);
}

async function judge(router: Router, model: string, rubric: string, excerpt: string, answer: string, ws: string): Promise<{ pass: boolean; why: string; votes: boolean[] }> {
  const text = `RUBRIC:\n${rubric}\n\nCONVERSATION EXCERPT (earlier turns):\n${excerpt}\n\nASSISTANT ANSWER (this turn):\n${answer}\n\nWORKSPACE FILES AFTER THIS TURN:\n${workspaceSnapshot(ws)}`;
  // sequential votes with retries: the endpoint throttles concurrency, and an errored vote abstains instead of failing
  const votes: { pass: boolean | null; why: string }[] = [];
  for (let v = 0; v < 3; v++) {
    let vote: { pass: boolean | null; why: string } = { pass: null, why: "abstain" };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await router.client(model).respond({ model, instructions: JUDGE_PROMPT, input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }], tools: [], reasoningEffort: "low", maxOutputTokens: 300 });
        const j = parseJsonObject(r.text);
        if (typeof j?.pass === "boolean") { vote = { pass: j.pass, why: String(j.why ?? "") }; break; }
        vote = { pass: null, why: `unparseable: ${r.text.slice(0, 60)}` };
      } catch (e: any) {
        if (QUOTA_RE.test(String(e?.message ?? e))) throw new QuotaError(String(e?.message ?? e));
        vote = { pass: null, why: `judge error: ${String(e?.message ?? e).slice(0, 80)}` }; await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
      }
    }
    votes.push(vote);
  }
  const valid = votes.filter((x) => x.pass !== null);
  const yes = valid.filter((x) => x.pass).length;
  return { pass: valid.length > 0 && yes * 2 > valid.length, why: votes.map((x) => x.why).join(" | ").slice(0, 400), votes: votes.map((x) => x.pass === true) };
}

interface TurnRecord { arm: string; case: string; category: string; turn: number; session: string; gate?: string; gateBy?: string; fidelity?: boolean; steps: number; answer: string; checks: { kind: string; pass: boolean; detail: string }[]; memory?: { recalled: number; written: number; misses: number } }

async function runCase(arm: Arm, c: Case, model: string, judgeModel: string, out: string, maxSteps: number): Promise<{ turns: TurnRecord[]; tokens: { input: number; cached: number; output: number; cost: number } }> {
  const ws = mkdtempSync(join(tmpdir(), `mt-${arm.name}-${c.id}-`));
  for (const [p, content] of Object.entries(c.files)) { mkdirSync(dirname(join(ws, p)), { recursive: true }); writeFileSync(join(ws, p), content); }
  for (const [name, sk] of Object.entries(c.skills ?? {})) { const d = join(ws, ".agents", "skills", name); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${sk.description}\n---\n${sk.body}\n`); }
  const knobs = resolveKnobs({ main_model: model, mid_model: model, small_model: model, ...arm.knobs } as any);
  const ledgerPath = join(out, "ledgers", `${arm.name}__${c.id}.jsonl`); mkdirSync(dirname(ledgerPath), { recursive: true });
  try { rmSync(ledgerPath); } catch { /* none */ }   // a re-run after a quota stop starts clean
  const ledger = new Ledger(ledgerPath);
  const router = new Router(knobs, ledger);
  const judgeRouter = new Router(knobs, new Ledger(join(out, "ledgers", `judge__${arm.name}__${c.id}.jsonl`)));
  const store = new ArtifactStore(join(harnessHome(), "artifacts"));
  mkdirSync(join(out, "memory"), { recursive: true });
  const dbPath = join(out, "memory", `${arm.name}__${c.id}.db`);
  for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(dbPath + suffix); } catch { /* none */ } }
  const memory = new MemoryStore(dbPath);
  const skills = discoverSkills(ws, ws, { ...process.env, HOME: join(ws, ".nohome") });   // only the case's own skills
  let session: SessionData = newSession(ws, `${arm.name}:${c.id}`); saveSession(session);
  const records: TurnRecord[] = [];
  const history: string[] = [];
  for (const [i, t] of c.turns.entries()) {
    if (t.session === "new") { session = newSession(ws, `${arm.name}:${c.id}:s2`); saveSession(session); history.length = 0; }
    const userText = c.paste && c.paste.turn === i ? t.user.replace("{{PASTE}}", makeLog(c.paste)) : t.user;
    const r = await runTurn({ session, userText, knobs, store, ledger, router, maxSteps, memory, memorySettings: arm.memory, skills, gateAction: arm.gate && session.turns.length > 0 ? arm.gate : undefined, quiet: true });
    if (r.text.startsWith("[model error]") && QUOTA_RE.test(r.text)) { memory.close(); throw new QuotaError(r.text.slice(0, 200)); }
    const checks: TurnRecord["checks"] = [];
    for (const ch of t.check ?? []) {
      if (ch.cmd) { const p = spawnSync("bash", ["-c", ch.cmd], { cwd: ws, encoding: "utf8", timeout: 60_000 }); checks.push({ kind: "cmd", pass: p.status === 0, detail: ch.cmd.slice(0, 120) + (p.status === 0 ? "" : ` → ${(p.stderr || p.stdout).slice(-200)}`) }); }
      if (ch.contains) checks.push({ kind: "contains", pass: ch.contains.every((s) => r.text.includes(s)), detail: ch.contains.join(", ") });
      if (ch.not_contains) checks.push({ kind: "not_contains", pass: ch.not_contains.every((s) => !r.text.includes(s)), detail: ch.not_contains.join(", ") });
      if (ch.judge) { const j = await judge(judgeRouter, judgeModel, ch.judge, history.slice(-4).join("\n\n").slice(-8000), r.text, ws); checks.push({ kind: "judge", pass: j.pass, detail: `${j.votes.map((v) => (v ? "Y" : "N")).join("")} ${j.why}` }); }
    }
    records.push({ arm: arm.name, case: c.id, category: c.category, turn: i, session: session.id, gate: r.gate?.action, gateBy: r.gate?.by, fidelity: r.fidelity, steps: r.steps, answer: r.text.slice(0, 2000), checks, memory: r.memory ? { recalled: r.memory.recalled.length, written: r.memory.written.length, misses: r.memory.misses.length } : undefined });
    history.push(`USER: ${t.user.slice(0, 1500)}\nASSISTANT: ${r.text.slice(0, 2000)}`);
  }
  memory.close();
  const tokens = { input: 0, cached: 0, output: 0, cost: 0 };
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (!line.trim()) continue; const d = JSON.parse(line);
    if (typeof d.input !== "number") continue;
    tokens.input += d.input; tokens.cached += d.cached ?? 0; tokens.output += d.output ?? 0;
  }
  tokens.cost = Math.round(tokens.cached * 0.1 + (tokens.input - tokens.cached) + tokens.output * 8);
  return { turns: records, tokens };
}

function summarize(out: string, arms: string[]): string {
  const rows = readFileSync(join(out, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const lines = ["# Multi-turn golden set", "", `output: ${out}`, "", "| arm | checkpoints passed | turns | fidelity violations | input tok | cached | output | cost equiv |", "|---|---|---|---|---|---|---|---|"];
  const byArm: Record<string, any> = {};
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm);
    const turns = rs.flatMap((r) => r.turns);
    const checks = turns.flatMap((t: any) => t.checks);
    const pass = checks.filter((c: any) => c.pass).length;
    const tok = rs.reduce((a, r) => ({ input: a.input + r.tokens.input, cached: a.cached + r.tokens.cached, output: a.output + r.tokens.output, cost: a.cost + r.tokens.cost }), { input: 0, cached: 0, output: 0, cost: 0 });
    const fv = turns.filter((t: any) => t.fidelity === false).length;
    byArm[arm] = { pass, total: checks.length, ...tok };
    lines.push(`| ${arm} | ${pass}/${checks.length} | ${turns.length} | ${fv} | ${tok.input.toLocaleString()} | ${tok.cached.toLocaleString()} | ${tok.output.toLocaleString()} | ${tok.cost.toLocaleString()} |`);
  }
  const cats = [...new Set(rows.map((r) => r.turns[0]?.category))].sort();
  lines.push("", "| category | " + arms.join(" | ") + " |", "|---|" + arms.map(() => "---|").join(""));
  for (const cat of cats) lines.push(`| ${cat} | ` + arms.map((a) => { const cs = rows.filter((r) => r.arm === a && r.turns[0]?.category === cat).flatMap((r) => r.turns.flatMap((t: any) => t.checks)); return `${cs.filter((c: any) => c.pass).length}/${cs.length}`; }).join(" | ") + " |");
  lines.push("", "| case | " + arms.join(" | ") + " |", "|---|" + arms.map(() => "---|").join(""));
  for (const id of [...new Set(rows.map((r) => r.case))].sort()) lines.push(`| ${id} | ` + arms.map((a) => { const r = rows.find((x) => x.arm === a && x.case === id); if (!r) return "-"; const cs = r.turns.flatMap((t: any) => t.checks); return `${cs.filter((c: any) => c.pass).length}/${cs.length} · ${Math.round(r.tokens.input / 1000)}K`; }).join(" | ") + " |");
  const failed = rows.flatMap((r) => r.turns.flatMap((t: any) => t.checks.filter((c: any) => !c.pass).map((c: any) => `- ${r.arm} · ${r.case} turn ${t.turn} · ${c.kind}: ${c.detail.slice(0, 200)}`)));
  if (failed.length) lines.push("", "Failed checks:", ...failed);
  const text = lines.join("\n") + "\n";
  writeFileSync(join(out, "summary.md"), text); writeFileSync(join(out, "summary.json"), JSON.stringify(byArm, null, 2));
  return text;
}

async function main() {
  await initTokenizer();
  const model = opt("--model") ?? process.env.MPH_MODEL;
  if (!model) throw new Error("--model required");
  const judgeModel = opt("--judge-model", model)!;
  const arms = (opt("--arms") ?? "full,hybrid,hybrid-nomem").split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of arms) if (!ARMS[a]) throw new Error(`unknown arm ${a}`);
  const out = resolve(opt("--out") ?? join(harnessHome(), "multiturn", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)));
  mkdirSync(out, { recursive: true });
  if (process.argv.includes("--summarize")) { console.log(summarize(out, arms)); return; }
  const all: Case[] = JSON.parse(readFileSync(opt("--cases-file", join(HERE, "cases.json"))!, "utf8"));
  const want = (opt("--cases") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cases = want.length ? all.filter((c) => want.includes(c.id)) : all;
  const maxSteps = Number(opt("--max-steps", "30"));
  const resultsPath = join(out, "results.jsonl");
  const done = new Set(existsSync(resultsPath) ? readFileSync(resultsPath, "utf8").trim().split("\n").filter(Boolean).map((l) => { const d = JSON.parse(l); return `${d.arm}/${d.case}`; }) : []);
  const jobs = cases.flatMap((c) => arms.map((a) => ({ arm: ARMS[a], c }))).filter((j) => !done.has(`${j.arm.name}/${j.c.id}`));
  console.error(`[multiturn] ${jobs.length} jobs (${done.size} done) · model ${model} · out ${out}`);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const j = jobs[next++]; if (!j) return;
      const t0 = Date.now();
      try {
        const r = await runCase(j.arm, j.c, model, judgeModel, out, maxSteps);
        appendFileSync(resultsPath, JSON.stringify({ arm: j.arm.name, case: j.c.id, ...r, seconds: Math.round((Date.now() - t0) / 1000) }) + "\n");
        const cs = r.turns.flatMap((t) => t.checks);
        console.error(`[multiturn] ${j.arm.name.padEnd(12)} ${j.c.id.padEnd(26)} ${cs.filter((x) => x.pass).length}/${cs.length} checks · in ${r.tokens.input} · ${Math.round((Date.now() - t0) / 1000)}s · gates ${r.turns.map((t) => t.gate?.[0] ?? "-").join("")}`);
      } catch (e: any) {
        if (e instanceof QuotaError) {
          console.error(`[multiturn] ${j.arm.name} ${j.c.id}: quota hit, will re-run the whole case`);
          jobs.push(j);   // back of the queue; runs again from a fresh workspace and memory
          const probe = new Router(resolveKnobs({ main_model: model } as any), new Ledger(join(out, "ledgers", "quota-probe.jsonl")));
          await waitForQuota(probe, model);
          continue;
        }
        console.error(`[multiturn] ${j.arm.name} ${j.c.id} FAILED: ${e?.stack ?? e}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(opt("--parallel", "3"))) }, worker));
  console.log(summarize(out, arms));
}

main().catch((e) => { console.error(e); process.exit(1); });
