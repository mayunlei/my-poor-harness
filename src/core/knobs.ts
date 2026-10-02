/**
 * Knobs: every threshold is a tunable with default/min/max/step, resolved by
 * layered overrides (global -> profile -> project -> session -> turn).
 * Cache-breaking knobs only take effect at turn boundaries or when the cache is cold.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface KnobSpec<T = number | boolean | string> {
  default: T; min?: number; max?: number; step?: number; choices?: string[];
  cacheBreaking?: boolean; description: string;
}

export const KNOB_SPECS = {
  // compaction timing
  compact_on_turn_start: { default: "judge", choices: ["never", "judge", "always_if_over"], description: "turn-start compaction mode" } as KnobSpec<string>,
  turn_start_threshold: { default: 50000, min: 10000, max: 200000, step: 10000, description: "C0 above which turn-start compaction is considered" } as KnobSpec<number>,
  turn_budget: { default: 60000, min: 20000, max: 200000, step: 10000, description: "mid-turn context budget; exceeding triggers batch fold" } as KnobSpec<number>,
  cold_cache_compact: { default: true, description: "compact without k* check when cache is cold" } as KnobSpec<boolean>,
  cache_ttl_estimate_s: { default: 1800, min: 300, max: 86400, step: 300, description: "estimated server cache TTL" } as KnobSpec<number>,
  kstar_margin: { default: 1.2, min: 0.5, max: 3, step: 0.1, description: "compact when k_hat >= k* * margin" } as KnobSpec<number>,
  summary_cost_tokens: { default: 3000, min: 500, max: 40000, step: 500, description: "L: cost of generating summary (uncached-equivalent)" } as KnobSpec<number>,
  recall_penalty_tokens: { default: 10000, min: 0, max: 100000, step: 1000, description: "R: expected recall penalty after compaction" } as KnobSpec<number>,
  // window and shaping
  window: { default: 10, min: 3, max: 40, step: 1, description: "recent outputs kept verbatim" } as KnobSpec<number>,
  per_output_cap: { default: 2000, min: 500, max: 8000, step: 250, description: "max tokens per tool output" } as KnobSpec<number>,
  head_share: { default: 0.6, min: 0.2, max: 0.9, step: 0.1, description: "head share for head/tail truncation" } as KnobSpec<number>,
  rg_max_hits: { default: 50, min: 10, max: 200, step: 10, description: "max grep hits" } as KnobSpec<number>,
  log_tail_lines: { default: 40, min: 10, max: 200, step: 10, description: "log tail lines kept" } as KnobSpec<number>,
  traceback_tail_lines: { default: 20, min: 5, max: 60, step: 5, description: "traceback tail lines kept" } as KnobSpec<number>,
  strip_exec_header: { default: true, description: "strip Chunk ID / Wall time headers" } as KnobSpec<boolean>,
  prefix_trim: { default: "codex_desktop", choices: ["none", "codex_desktop"], cacheBreaking: true, description: "trim known client boilerplate from the fixed prefix" } as KnobSpec<string>,
  stub_old_outputs: { default: true, description: "fold outputs outside the window into stubs at compaction" } as KnobSpec<boolean>,
  // steps
  blocking_exec_timeout_s: { default: 600, min: 30, max: 3600, step: 30, description: "default blocking exec timeout" } as KnobSpec<number>,
  wait_silence_s: { default: 30, min: 5, max: 600, step: 5, description: "wait() wakes after this much output silence" } as KnobSpec<number>,
  dedupe_reads: { default: true, description: "return unchanged-stub for repeated identical reads" } as KnobSpec<boolean>,
  idempotent_cmd_cache: { default: true, description: "cache idempotent command results within a turn" } as KnobSpec<boolean>,
  collapse_poll_chains: { default: true, description: "fold consecutive empty polls into one stub" } as KnobSpec<boolean>,
  reasoning_keep_last: { default: 4, min: 1, max: 40, step: 1, cacheBreaking: true, description: "at a fold, keep only the last N reasoning items" } as KnobSpec<number>,
  compaction_item_cap: { default: 4000, min: 1000, max: 20000, step: 500, description: "cap tokens of a client-side compaction summary item" } as KnobSpec<number>,
  drop_reasoning_outside_window: { default: true, cacheBreaking: true, description: "drop reasoning items older than window at compaction" } as KnobSpec<boolean>,
  // model
  main_model: { default: "gpt-5.6-sol", cacheBreaking: true, description: "T4 main loop model" } as KnobSpec<string>,
  small_model: { default: "gpt-5.4-mini", description: "T1/T2 model" } as KnobSpec<string>,
  mid_model: { default: "gpt-5.5", description: "T3 model" } as KnobSpec<string>,
  effort_plan: { default: "high", choices: ["low", "medium", "high", "xhigh"], cacheBreaking: true, description: "reasoning effort for plan phase" } as KnobSpec<string>,
  effort_execute: { default: "medium", choices: ["low", "medium", "high", "xhigh"], cacheBreaking: true, description: "reasoning effort for execute phase" } as KnobSpec<string>,
  effort_summarize: { default: "low", choices: ["low", "medium", "high", "xhigh"], description: "reasoning effort for summaries" } as KnobSpec<string>,
  use_model_summary: { default: false, description: "at turn end, ask the small model for a 150-token summary (T2)" } as KnobSpec<boolean>,
  t3_escalate_pass_rate: { default: 0.7, min: 0.3, max: 0.95, step: 0.05, description: "escalate a task class when cheap-model pass rate drops below this" } as KnobSpec<number>,
  // strategy: how a turn is organised (see src/harness/strategies)
  strategy: { default: "react", choices: ["react", "plan_verify"], description: "turn execution strategy" } as KnobSpec<string>,
  plan_max_steps: { default: 12, min: 1, max: 60, step: 1, description: "model steps the planner may spend looking at the repo before it must emit a plan" } as KnobSpec<number>,
  plan_min_tasks: { default: 2, min: 1, max: 10, step: 1, description: "fewest steps a plan may contain" } as KnobSpec<number>,
  plan_max_tasks: { default: 8, min: 2, max: 30, step: 1, description: "most steps a plan may contain; more means more verification overhead" } as KnobSpec<number>,
  plan_parallel: { default: 2, min: 1, max: 8, step: 1, description: "independent plan steps executed concurrently" } as KnobSpec<number>,
  worker_tier: { default: "T3", choices: ["T3", "T4"], description: "tier a plan step runs on unless the planner asks for more" } as KnobSpec<string>,
  verifier_tier: { default: "T3", choices: ["T1", "T2", "T3", "T4"], description: "tier of the independent verifier; T4 verifies better but doubles the per-step price of the strong model" } as KnobSpec<string>,
  argue_rounds: { default: 2, min: 0, max: 6, step: 1, description: "worker/verifier argue rounds before the worker is escalated" } as KnobSpec<number>,
  replan_limit: { default: 1, min: 0, max: 4, step: 1, description: "times the planner may revise the remaining plan after a step cannot be made to pass" } as KnobSpec<number>,
  verify_requires_command: { default: true, description: "a step with no acceptance command is reported unverified instead of passed" } as KnobSpec<boolean>,
} as const;

export type KnobName = keyof typeof KNOB_SPECS;
export type Knobs = { [K in KnobName]: (typeof KNOB_SPECS)[K] extends KnobSpec<infer T> ? T : never };
export type KnobOverrides = Partial<Knobs>;

export const PROFILES: Record<string, KnobOverrides> = {
  default: {},
  long_task: { turn_budget: 40000, window: 8, per_output_cap: 1500 },
  qa_only: { compact_on_turn_start: "never", per_output_cap: 8000, stub_old_outputs: false, collapse_poll_chains: false },
  batch: { turn_budget: 30000, window: 6, per_output_cap: 1200, compact_on_turn_start: "always_if_over" },
};

export function defaultKnobs(): Knobs {
  const out: any = {};
  for (const [k, spec] of Object.entries(KNOB_SPECS)) out[k] = (spec as KnobSpec).default;
  return out as Knobs;
}

export function clampKnob(name: KnobName, value: any): any {
  const spec = KNOB_SPECS[name] as KnobSpec;
  if (typeof spec.default === "number") {
    let v = Number(value);
    if (Number.isNaN(v)) return spec.default;
    if (spec.min !== undefined) v = Math.max(spec.min, v);
    if (spec.max !== undefined) v = Math.min(spec.max, v);
    return v;
  }
  if (typeof spec.default === "boolean") return value === true || value === "true";
  if (spec.choices && !spec.choices.includes(String(value))) return spec.default;
  return String(value);
}

export function resolveKnobs(...layers: (KnobOverrides | undefined)[]): Knobs {
  const out: any = defaultKnobs();
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (k in KNOB_SPECS) out[k] = clampKnob(k as KnobName, v);
    }
  }
  return out as Knobs;
}

/** pre-rename names, kept out of the literals so a rename sweep cannot silently drop them */
const LEGACY_HOME_ENV = "TOKEN_" + "HARNESS_HOME";
const LEGACY_HOME_DIR = "." + "token_harness";

/**
 * Where the ledger, sessions, artifacts, knobs and credentials live.
 *
 * The default is ~/.mph, but an existing ~/.token_harness from before the rename
 * wins: that directory holds the ledger history and the Codex OAuth tokens, and
 * silently starting a fresh empty one would look like data loss. Nothing is
 * migrated automatically — `mv ~/.token_harness ~/.mph` if you want the new name.
 */
export function harnessHome(): string {
  // LEGACY_HOME and the old env var are deliberate: see the comment above.
  const explicit = process.env.MPH_HOME ?? process.env[LEGACY_HOME_ENV];
  if (explicit) return explicit;
  const legacy = join(homedir(), LEGACY_HOME_DIR);
  return existsSync(legacy) ? legacy : join(homedir(), ".mph");
}

export interface KnobFile {
  global?: KnobOverrides;
  profile?: string;
  projects?: Record<string, KnobOverrides & { profile?: string }>;
  sessions?: Record<string, KnobOverrides & { profile?: string }>;
  history?: { at: string; who: string; why: string; scope: string; changes: KnobOverrides }[];
}

export function knobFilePath(): string { return join(harnessHome(), "knobs.json"); }

export function loadKnobFile(): KnobFile {
  const p = knobFilePath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

export function saveKnobFile(f: KnobFile): void {
  const p = knobFilePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(f, null, 2));
}

/** Resolve knobs for a (project, session), applying profile and layered overrides. */
export function knobsFor(opts: { project?: string; session?: string; turn?: KnobOverrides; file?: KnobFile } = {}): Knobs {
  const f = opts.file ?? loadKnobFile();
  const proj = opts.project ? f.projects?.[opts.project] : undefined;
  const sess = opts.session ? f.sessions?.[opts.session] : undefined;
  const profileName = sess?.profile ?? proj?.profile ?? f.profile ?? "default";
  const { profile: _p, ...projRest } = proj ?? ({} as any);
  const { profile: _s, ...sessRest } = sess ?? ({} as any);
  return resolveKnobs(f.global, PROFILES[profileName], projRest, sessRest, opts.turn);
}

/** Record a knob change with provenance; scope = "global" | "project:<path>" | "session:<id>" */
export function applyKnobChange(scope: string, changes: KnobOverrides, who: string, why: string, file?: KnobFile): KnobFile {
  const f = file ?? loadKnobFile();
  const clamped: KnobOverrides = {};
  for (const [k, v] of Object.entries(changes)) if (k in KNOB_SPECS) (clamped as any)[k] = clampKnob(k as KnobName, v);
  if (scope === "global") f.global = { ...(f.global ?? {}), ...clamped };
  else if (scope.startsWith("project:")) { f.projects ??= {}; const key = scope.slice(8); f.projects[key] = { ...(f.projects[key] ?? {}), ...clamped }; }
  else if (scope.startsWith("session:")) { f.sessions ??= {}; const key = scope.slice(8); f.sessions[key] = { ...(f.sessions[key] ?? {}), ...clamped }; }
  f.history ??= [];
  f.history.push({ at: new Date().toISOString(), who, why, scope, changes: clamped });
  if (f.history.length > 500) f.history = f.history.slice(-500);
  saveKnobFile(f);
  return f;
}

export function shaperKnobs(k: Knobs) {
  return { perOutputCap: k.per_output_cap, headShare: k.head_share, rgMaxHits: k.rg_max_hits, logTailLines: k.log_tail_lines, tracebackTailLines: k.traceback_tail_lines, stripExecHeader: k.strip_exec_header };
}
