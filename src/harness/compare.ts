/**
 * Strategy A/B: run the same tasks under several strategies and score them on an
 * oracle neither strategy can touch.
 *
 * The scoring rule is the whole point. A strategy is never asked whether it
 * succeeded — the task's own `acceptance` command is run afterwards, in a fresh
 * copy of the workspace, and that exit code is the only verdict. Otherwise
 * plan_verify would score itself on the verifier it paid for, which measures
 * confidence rather than correctness.
 *
 * Fairness notes that matter when reading the numbers:
 *   - each run gets its own copy of the workspace (--copy), so run order cannot
 *     let one strategy inherit another's edits;
 *   - cost is cost-equivalent across EVERY agent a strategy ran (planner,
 *     workers, verifiers, argue rounds), so a cheap-worker strategy does not get
 *     to hide its overhead;
 *   - wall time is reported because parallel steps buy latency that tokens do
 *     not show.
 */
import { cpSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../core/artifacts.js";
import { Ledger } from "../core/ledger.js";
import { harnessHome, resolveKnobs, type Knobs } from "../core/knobs.js";
import { executeTool, type ToolContext } from "./tools.js";
import { Router } from "./router.js";
import { newSession, saveSession } from "./session.js";
import { strategyFor, type StrategyResult } from "./strategies/index.js";

export interface BenchTask {
  name: string;
  prompt: string;
  /** the oracle: exits 0 iff the task is genuinely done. Without it the run is unscored. */
  acceptance?: string;
  cwd?: string;
  /** optional command to prepare the copied workspace (install, build fixtures) */
  setup?: string;
}

export interface RunResult {
  task: string;
  strategy: string;
  /** the oracle's verdict, not the strategy's */
  passed: boolean | undefined;
  claimed: boolean | undefined;
  steps: number;
  input: number; cached: number; output: number;
  costEquiv: number;
  wallMs: number;
  cwd: string;
  text: string;
  oracleOutput?: string;
}

export interface CompareReport {
  at: string;
  tasks: number;
  byStrategy: Record<string, { runs: number; passed: number; unscored: number; costEquiv: number; steps: number; input: number; output: number; wallMs: number; costPerPass?: number }>;
  runs: RunResult[];
}

export function loadTasks(path: string): BenchTask[] {
  const raw = readFileSync(path, "utf8").trim();
  if (raw.startsWith("[")) return JSON.parse(raw);
  return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));   // jsonl
}

export async function compareStrategies(o: {
  tasks: BenchTask[];
  strategies: string[];
  knobs?: Knobs;
  ledger?: Ledger;
  store?: ArtifactStore;
  cwd?: string;
  copy?: boolean;
  maxSteps?: number;
  onEvent?: (e: { kind: string; detail: string }) => void;
}): Promise<CompareReport> {
  const ledger = o.ledger ?? new Ledger();
  const store = o.store ?? new ArtifactStore();
  const runs: RunResult[] = [];

  for (const task of o.tasks) {
    for (const name of o.strategies) {
      const strategy = strategyFor(name);
      const srcCwd = task.cwd ?? o.cwd ?? process.cwd();
      // a private copy per run: strategies must not inherit each other's edits
      const cwd = o.copy ? join(mkdtempSync(join(tmpdir(), "th-cmp-")), "ws") : srcCwd;
      if (o.copy) cpSync(srcCwd, cwd, { recursive: true, dereference: false, filter: (s) => !/\/(node_modules|\.git)(\/|$)/.test(s) });

      const knobs = resolveKnobs({ ...(o.knobs ?? {}), strategy: name } as any);
      const router = new Router(knobs, ledger);
      const session = newSession(cwd, `cmp:${name}:${task.name}`);
      saveSession(session);
      const tctx = (): ToolContext => ({ cwd, knobs, store, sessionId: session.id, filesTouched: new Set(), readCache: new Map(), cmdCache: new Map(), jobs: new Map() });

      if (task.setup) await executeTool(tctx(), "run", { cmd: task.setup, timeout_s: 1800 }, "setup");

      o.onEvent?.({ kind: "compare", detail: `${task.name} × ${name} starting` });
      const t0 = Date.now();
      let r: StrategyResult;
      try {
        r = await strategy.run({ session, userText: task.prompt, knobs, store, ledger, router, maxSteps: o.maxSteps, quiet: true, onEvent: o.onEvent, tag: { compare: task.name } });
      } catch (e: any) {
        r = { strategy: name, text: `[strategy error] ${e?.message ?? e}`, steps: 0, usage: { input: 0, cached: 0, output: 0, reasoning: 0 }, costEquiv: 0 };
      }
      const wallMs = Date.now() - t0;

      // the oracle runs last, in the same workspace, and decides
      let passed: boolean | undefined; let oracleOutput: string | undefined;
      if (task.acceptance) {
        const out = await executeTool(tctx(), "run", { cmd: task.acceptance, timeout_s: 1800 }, "oracle");
        passed = out.startsWith("[exit 0]");
        oracleOutput = out.slice(0, 1200);
      }

      runs.push({
        task: task.name, strategy: name, passed, claimed: r.verified, steps: r.steps,
        input: r.usage.input, cached: r.usage.cached, output: r.usage.output,
        costEquiv: r.costEquiv, wallMs, cwd, text: r.text.slice(0, 2000), oracleOutput,
      });
      ledger.append({
        source: "bench", session: session.id, turn: 0, step: r.steps, event: "strategy",
        note: `${name} on ${task.name}: ${passed === undefined ? "unscored" : passed ? "pass" : "fail"}`,
        task_outcome: passed === undefined ? "unknown" : passed ? "success" : "fail",
        cost_equiv: r.costEquiv,
        extra: { strategy: name, compare: task.name, claimed: r.verified, wall_ms: wallMs },
      });
      o.onEvent?.({ kind: "compare", detail: `${task.name} × ${name}: ${passed === undefined ? "unscored" : passed ? "PASS" : "FAIL"} · ${r.steps} calls · cost-equiv ${Math.round(r.costEquiv).toLocaleString("en-US")} · ${(wallMs / 1000).toFixed(0)}s` });
    }
  }

  const byStrategy: CompareReport["byStrategy"] = {};
  for (const run of runs) {
    const b = byStrategy[run.strategy] ??= { runs: 0, passed: 0, unscored: 0, costEquiv: 0, steps: 0, input: 0, output: 0, wallMs: 0 };
    b.runs++; if (run.passed) b.passed++; if (run.passed === undefined) b.unscored++;
    b.costEquiv += run.costEquiv; b.steps += run.steps; b.input += run.input; b.output += run.output; b.wallMs += run.wallMs;
  }
  for (const b of Object.values(byStrategy)) b.costPerPass = b.passed ? b.costEquiv / b.passed : undefined;

  return { at: new Date().toISOString(), tasks: o.tasks.length, byStrategy, runs };
}

export function formatCompare(rep: CompareReport): string {
  const f = (n: number) => Math.round(n).toLocaleString("en-US");
  const L: string[] = [];
  L.push(`strategy comparison over ${rep.tasks} task(s), ${rep.at.slice(0, 19)}`);
  L.push("");
  L.push(`${"strategy".padEnd(16)} ${"pass".padStart(7)} ${"calls".padStart(6)} ${"cost-equiv".padStart(12)} ${"per pass".padStart(12)} ${"in".padStart(10)} ${"out".padStart(8)} ${"wall".padStart(7)}`);
  for (const [name, b] of Object.entries(rep.byStrategy).sort((a, b2) => (a[1].costPerPass ?? Infinity) - (b2[1].costPerPass ?? Infinity))) {
    L.push(`${name.padEnd(16)} ${`${b.passed}/${b.runs - b.unscored}`.padStart(7)} ${String(b.steps).padStart(6)} ${f(b.costEquiv).padStart(12)} ${(b.costPerPass ? f(b.costPerPass) : "-").padStart(12)} ${f(b.input).padStart(10)} ${f(b.output).padStart(8)} ${(b.wallMs / 1000).toFixed(0) + "s"}`.padStart(8));
  }
  const unscored = Object.values(rep.byStrategy).reduce((a, b) => a + b.unscored, 0);
  if (unscored) L.push(`\n${unscored} run(s) unscored: those tasks have no acceptance command, so nothing independent decided whether they worked.`);
  L.push("");
  L.push(`${"task".padEnd(24)} ${"strategy".padEnd(14)} ${"oracle".padEnd(8)} ${"claimed".padEnd(8)} ${"calls".padStart(6)} ${"cost-equiv".padStart(12)}`);
  for (const r of rep.runs) {
    L.push(`${r.task.slice(0, 23).padEnd(24)} ${r.strategy.padEnd(14)} ${(r.passed === undefined ? "-" : r.passed ? "pass" : "FAIL").padEnd(8)} ${(r.claimed === undefined ? "-" : r.claimed ? "yes" : "no").padEnd(8)} ${String(r.steps).padStart(6)} ${f(r.costEquiv).padStart(12)}`);
  }
  // a strategy that says "verified" when the oracle disagrees is the dangerous failure
  const lying = rep.runs.filter((r) => r.claimed === true && r.passed === false);
  if (lying.length) L.push(`\n${lying.length} run(s) claimed verified but failed the oracle: ${lying.map((r) => `${r.strategy}/${r.task}`).join(", ")} — the verifier was fooled.`);
  return L.join("\n");
}

export function saveCompare(rep: CompareReport): string {
  const p = join(harnessHome(), `compare-${rep.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(p, JSON.stringify(rep, null, 2));
  return p;
}
