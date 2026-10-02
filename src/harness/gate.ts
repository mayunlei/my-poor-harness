/**
 * Turn gate (docs/MEMORY_DESIGN.md §3.1): at the start of each user turn decide whether
 * to carry the previous turn's working set (continue) or start from the briefing alone
 * (rebuild), and which memories / skills to put in front of the main model.
 *
 * Rules first; the small model is asked once, for both the decision and the memory
 * rerank, only when the rules cannot decide or there are more candidates than slots.
 * Any model failure falls back to the rules (ambiguous → continue, which never loses
 * information) and to the candidate scores.
 */
import type { ModelClient } from "./providers.js";
import type { Knobs } from "../core/knobs.js";
import type { Candidate } from "../memory/recall.js";
import type { Skill } from "../skills/index.js";
import { parseJsonObject } from "../memory/write.js";

export type GateAction = "continue" | "rebuild";

export interface GateFeatures {
  firstTurn: boolean;
  hasWindow: boolean;
  idleS: number;
  cacheWarm: boolean;
  topicSim: number;
  backRef: boolean;
  filesOverlap: string[];
  explicit?: GateAction;
}

export interface GateDecision {
  action: GateAction;
  by: "explicit" | "rule" | "model" | "fallback";
  why: string;
  memoryIds: string[];
  detailIds: string[];
  skills: string[];
  features: GateFeatures;
  modelCalled: boolean;
  usage?: { input: number; cached: number; output: number };
  latencyMs?: number;
}

const BACK_REF_RE = /(刚才|刚刚|上面|上述|之前|前面|那个|这个|那段|这段|那里|继续|接着|再来|再试|再加|再改|再把|再给|再写|再做|再去|再跑|还是|同样|顺便|也改|也加|也要|也把|也一样|然后呢|回到|改回|撤销|你说的|你提到|你刚|按你|照你|第[一二三四五六七八九十0-9]+个|上一个|上次|\bcontinue\b|\bagain\b|\balso\b|\bthat\b|\bthose\b|\bit\b|\bthe same\b|\bas before\b|\bprevious\b|\babove\b|\bundo\b|\brevert\b|\bgo back\b)/i;
const FILE_RE = /[\w./-]+\.(?:py|ts|tsx|js|jsx|mjs|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|sql|md|json|ya?ml|toml|sh|css|html|vue|swift)\b/g;

const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "are", "was", "were", "can", "you", "your", "please", "what", "how", "why", "not", "but", "all", "any", "now", "then", "also", "just", "let", "make", "use", "add", "get", "set", "new", "one", "some", "should", "would", "could", "will", "about", "there", "here", "have", "has", "had", "does", "did", "our", "its",
  "一下", "这个", "那个", "我们", "你们", "什么", "怎么", "可以", "需要", "一个", "是不", "不是", "然后", "现在", "帮我", "请你", "看看", "如何", "为什", "么样"]);

function toks(t: string): Set<string> {
  const out = new Set<string>();
  for (const w of t.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (!w || STOP.has(w)) continue;
    if (/[\u4e00-\u9fff]/.test(w)) { for (let i = 0; i + 1 < w.length; i++) { const bi = w.slice(i, i + 2); if (!STOP.has(bi)) out.add(bi); } if (w.length === 1) out.add(w); }
    else if (w.length > 2) out.add(w);
  }
  return out;
}

/** share of the new message's tokens that already appeared in the previous turn */
export function topicOverlap(newText: string, prevText: string): number {
  const A = toks(newText), B = toks(prevText);
  if (A.size === 0) return 1;
  if (B.size === 0) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / A.size;
}

export function mentionedFiles(text: string): string[] { return [...new Set(text.match(FILE_RE) ?? [])]; }

export function gateFeatures(o: { userText: string; prevUser?: string; prevAnswer?: string; lastEndedAt?: string; hasWindow: boolean; filesTouched: string[]; ttlS: number; now?: number; explicit?: GateAction }): GateFeatures {
  const now = o.now ?? Date.now();
  const idleS = o.lastEndedAt ? Math.max(0, (now - Date.parse(o.lastEndedAt)) / 1000) : Infinity;
  const base = (f: string) => f.split("/").pop() ?? f;
  const touched = new Set(o.filesTouched.map(base));
  return {
    firstTurn: o.prevUser === undefined,
    hasWindow: o.hasWindow,
    idleS,
    cacheWarm: idleS < o.ttlS,
    topicSim: o.prevUser === undefined ? 0 : topicOverlap(o.userText, `${o.prevUser}\n${o.prevAnswer ?? ""}`),
    backRef: BACK_REF_RE.test(o.userText),
    filesOverlap: mentionedFiles(o.userText).filter((f) => touched.has(base(f))),
    explicit: o.explicit,
  };
}

/** the rule part; undefined = ambiguous */
export function ruleDecision(f: GateFeatures, k: Pick<Knobs, "gate_sim_low" | "gate_sim_high">): { action: GateAction; why: string; by: GateDecision["by"] } | undefined {
  if (f.explicit) return { action: f.explicit, why: "user command", by: "explicit" };
  if (f.firstTurn || !f.hasWindow) return { action: "rebuild", why: "nothing to carry", by: "rule" };
  if (!f.cacheWarm) return { action: "rebuild", why: `cache cold (idle ${Math.round(f.idleS)}s)`, by: "rule" };
  if (f.backRef || f.filesOverlap.length) return { action: "continue", why: f.backRef ? "refers back to the previous turn" : `same files: ${f.filesOverlap.join(", ")}`, by: "rule" };
  if (f.topicSim >= k.gate_sim_high) return { action: "continue", why: `same topic (${f.topicSim.toFixed(2)})`, by: "rule" };
  if (f.topicSim < k.gate_sim_low) return { action: "rebuild", why: `new topic (${f.topicSim.toFixed(2)})`, by: "rule" };
  return undefined;
}

export const GATE_PROMPT = `You prepare the context for a coding assistant's next turn. Answer with ONLY JSON:
{"action":"continue|rebuild","why":"<10 words","memory_ids":["m3"],"detail_ids":["m3"],"skills":["name"]}
- action: "continue" if the new message builds on the previous turn's work (follow-up, fix, refinement, same files); "rebuild" if it starts something else. When unsure, choose "continue".
- memory_ids: candidate memories that could matter for the new message (at most MAXIDX). Prefer constraints and failed attempts that apply.
- detail_ids: at most 2 of those whose full text the assistant needs right away.
- skills: skills whose instructions the assistant should load for this message (usually none).`;

export interface GateInput {
  userText: string; prevUser?: string; prevAnswer?: string;
  features: GateFeatures; candidates: Candidate[]; skills: Skill[];
  knobs: Pick<Knobs, "gate_sim_low" | "gate_sim_high" | "gate_use_model" | "gate_timeout_s" | "memory_l1_max">;
  client?: ModelClient; model?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`gate timeout after ${ms}ms`)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
}

export async function decideTurn(g: GateInput): Promise<GateDecision> {
  const t0 = Date.now();
  const rule = ruleDecision(g.features, g.knobs);
  const l1 = g.knobs.memory_l1_max;
  const byScore = g.candidates.slice(0, l1).map((c) => c.entry.id);
  const needRerank = g.candidates.length > l1;
  const skillWords = toks(g.userText);
  const skillHits = g.skills.filter((s) => !s.missing.length && (g.userText.toLowerCase().includes(s.name.toLowerCase()) || [...toks(s.name.replace(/[-_]/g, " "))].some((w) => w.length > 3 && skillWords.has(w))));
  const base: GateDecision = { action: rule?.action ?? "continue", by: rule?.by ?? "fallback", why: rule?.why ?? "ambiguous; continue keeps everything", memoryIds: byScore, detailIds: [], skills: skillHits.slice(0, 2).map((s) => s.name), features: g.features, modelCalled: false };

  const ask = g.knobs.gate_use_model && !!g.client && !!g.model && (rule === undefined || needRerank || (g.skills.length > 0 && !rule));
  if (!ask) return { ...base, latencyMs: Date.now() - t0 };

  const cand = g.candidates.map((c) => `[${c.entry.id} ${c.entry.type}] ${c.entry.title}`).join("\n") || "(none)";
  const skills = g.skills.filter((s) => !s.missing.length).slice(0, 40).map((s) => `- ${s.name}: ${s.description.slice(0, 160)}`).join("\n") || "(none)";
  const text = `Previous user message:\n${(g.prevUser ?? "(none — first turn)").slice(0, 3000)}\n\nPrevious answer (card):\n${(g.prevAnswer ?? "").slice(0, 1500)}\n\nNEW user message:\n${g.userText.slice(0, 6000)}\n\nCandidate memories:\n${cand}\n\nSkills:\n${skills}${rule ? `\n\n(The action is already decided: ${rule.action}. Only select memories and skills.)` : ""}`;
  try {
    const r = await withTimeout(g.client!.respond({ model: g.model!, instructions: GATE_PROMPT.replace("MAXIDX", String(l1)), input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }], tools: [], reasoningEffort: "low", maxOutputTokens: 400 }), g.knobs.gate_timeout_s * 1000);
    const j = parseJsonObject(r.text);
    if (!j) throw new Error("unparseable gate output: " + r.text.slice(0, 120));
    const known = new Set(g.candidates.map((c) => c.entry.id));
    const ids = (Array.isArray(j.memory_ids) ? j.memory_ids : []).map(String).filter((x: string) => known.has(x)).slice(0, l1);
    const detail = (Array.isArray(j.detail_ids) ? j.detail_ids : []).map(String).filter((x: string) => ids.includes(x)).slice(0, 2);
    const skillNames = new Set(g.skills.map((s) => s.name));
    const sk = (Array.isArray(j.skills) ? j.skills : []).map(String).filter((x: string) => skillNames.has(x)).slice(0, 2);
    const modelAction: GateAction = j.action === "rebuild" ? "rebuild" : "continue";
    return {
      action: rule?.action ?? modelAction, by: rule?.by ?? "model", why: rule?.why ?? String(j.why ?? "").slice(0, 120),
      memoryIds: needRerank ? ids : byScore, detailIds: detail, skills: sk.length ? sk : base.skills, features: g.features,
      modelCalled: true, usage: r.usage, latencyMs: Date.now() - t0,
    };
  } catch (e: any) {
    return { ...base, why: `${base.why} (gate model failed: ${String(e?.message ?? e).slice(0, 80)})`, modelCalled: true, latencyMs: Date.now() - t0 };
  }
}
