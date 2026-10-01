/**
 * Compaction judge: at a user-turn boundary decide compact | keep | fork.
 * Inputs: context size, predicted remaining steps k_hat, cache state, topic
 * relevance. Deliberately cheap (rules + optional calibrated table), no main-model call.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Knobs } from "./knobs.js";
import { harnessHome } from "./knobs.js";
import type { CacheState } from "./cache_state.js";

export interface JudgeFeatures {
  C: number;                 // current context tokens
  F: number;                 // fixed prefix tokens
  targetC: number;           // context after compaction (F + S + window)
  userText: string;
  prevTurnSteps: number;
  turnIndex: number;
  cacheState: CacheState;
  idleS: number;
  stepsSinceLastCompact: number;
  topicSimilarity?: number;  // 0..1, optional (embedding or small-model score)
}

export interface JudgeDecision {
  action: "compact" | "keep" | "fork";
  kHat: number;
  kStar: number;
  reason: string;
}

const QUESTION_RE = /[?？]|^(为什么|是否|什么|怎么看|解释|说明|why|what|how|is |does |can |should )/i;
const TASK_RE = /(实现|修复|重构|改|加|写|跑|测试|部署|fix|implement|refactor|add|write|run|test|deploy|build|create|update)/i;

export interface KHatTable {
  question_short: number; task: number; prev_ge_50: number; prev_ge_10: number; first_turn: number; default: number;
}
const DEFAULT_TABLE: KHatTable = { question_short: 3, task: 13, prev_ge_50: 40, prev_ge_10: 20, first_turn: 8, default: 9 };

export function loadKHatTable(): KHatTable {
  const p = join(harnessHome(), "judge_model.json");
  if (existsSync(p)) { try { return { ...DEFAULT_TABLE, ...JSON.parse(readFileSync(p, "utf8")) }; } catch { /* ignore */ } }
  return DEFAULT_TABLE;
}

export function predictSteps(f: Pick<JudgeFeatures, "userText" | "prevTurnSteps" | "turnIndex">, table: KHatTable = loadKHatTable()): number {
  const u = f.userText.slice(0, 300);
  const questionShort = QUESTION_RE.test(u) && f.userText.length < 300 && !TASK_RE.test(u);
  if (questionShort) return table.question_short;
  if (f.prevTurnSteps >= 50) return table.prev_ge_50;
  if (f.prevTurnSteps >= 10) return table.prev_ge_10;
  if (TASK_RE.test(u)) return table.task;
  if (f.turnIndex === 0) return table.first_turn;
  return table.default;
}

export function kStar(f: Pick<JudgeFeatures, "C" | "F" | "targetC" | "cacheState">, k: Knobs, priceCached = 0.1, priceWrite = 1.0): number {
  const X = f.C - f.targetC;
  if (X <= 0) return Infinity;
  const L = k.summary_cost_tokens, R = k.recall_penalty_tokens;
  const write = f.cacheState === "cold" ? 0 : Math.max(0, f.targetC - f.F) * priceWrite;
  return (write + L + R) / (X * priceCached);
}

export function judge(f: JudgeFeatures, k: Knobs): JudgeDecision {
  const kHat = predictSteps(f);
  const ks = kStar(f, k);
  if (k.compact_on_turn_start === "never") return { action: "keep", kHat, kStar: ks, reason: "compact_on_turn_start=never" };
  if (f.C <= k.turn_start_threshold) return { action: "keep", kHat, kStar: ks, reason: `C ${f.C} <= threshold ${k.turn_start_threshold}` };
  if (f.topicSimilarity !== undefined && f.topicSimilarity < 0.2 && f.C > k.turn_start_threshold) {
    return { action: "fork", kHat, kStar: ks, reason: `topic similarity ${f.topicSimilarity.toFixed(2)} < 0.2` };
  }
  if (k.compact_on_turn_start === "always_if_over") return { action: "compact", kHat, kStar: ks, reason: "always_if_over" };
  if (k.cold_cache_compact && f.cacheState === "cold") return { action: "compact", kHat, kStar: ks, reason: `cache cold (${Math.round(f.idleS)}s idle): rewrite is free` };
  if (f.stepsSinceLastCompact < 3) return { action: "keep", kHat, kStar: ks, reason: "compacted very recently" };
  if (kHat >= ks * k.kstar_margin) return { action: "compact", kHat, kStar: ks, reason: `k_hat ${kHat} >= k* ${ks.toFixed(1)} x ${k.kstar_margin}` };
  return { action: "keep", kHat, kStar: ks, reason: `k_hat ${kHat} < k* ${ks.toFixed(1)} x ${k.kstar_margin}` };
}

/** Cheap lexical topic similarity (Jaccard over word/char-bigram sets); used when no embedding is available. */
export function lexicalSimilarity(a: string, b: string): number {
  const toks = (t: string) => { const out = new Set<string>(); for (const w of t.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) { if (!w) continue; if (/^[\u4e00-\u9fff]+$/.test(w)) { for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2)); if (w.length === 1) out.add(w); } else if (w.length > 2) out.add(w); } return out; };
  const A = toks(a), B = toks(b); if (A.size === 0 || B.size === 0) return 1;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
