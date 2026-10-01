/**
 * Replay benchmark: rebuild the per-request `input` arrays from recorded Codex
 * rollout files and run them through rewrite() with persistent state, exactly as
 * the proxy would. Cache is simulated as the longest common item-prefix between
 * consecutive rewritten requests (cold if idle > TTL). Reports raw-token and
 * cost-equivalent savings. Zero model cost.
 *
 * usage: tsx src/bench/replay.ts [--limit N] [--min-bytes B] [--max-requests 400] [--profile name] [--knob.name=value] [--json out.json] [files...]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { rewrite, newRewriteState } from "../core/rewrite.js";
import { ArtifactStore } from "../core/artifacts.js";
import { resolveKnobs, PROFILES, type KnobOverrides } from "../core/knobs.js";
import { initTokenizer, countTokens, tokenizerName } from "../core/tokens.js";
import { PRICE } from "../core/ledger.js";
import { sha1 } from "../core/items.js";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out); else if (e.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

interface Req { input: any[]; ts: number; measured: { input: number; cached: number; output: number }; }

/** Reconstruct the sequence of requests (history snapshot at each token_count). */
function requestsFromRollout(path: string): { reqs: Req[]; model?: string } {
  const lines = readFileSync(path, "utf8").split("\n");
  const history: any[] = [];
  const reqs: Req[] = [];
  let prevIn = -1; let model: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    const t = d.type, p = d.payload ?? {};
    if (t === "session_meta" && p.base_instructions?.text) history.push({ type: "message", role: "developer", content: [{ type: "input_text", text: p.base_instructions.text }] });
    else if (t === "turn_context") model = p.model ?? model;
    else if (t === "compacted" && Array.isArray(p.replacement_history)) { history.length = 0; history.push(...p.replacement_history); }
    else if (t === "response_item") history.push(p);
    else if (t === "event_msg" && p.type === "token_count") {
      const lu = p.info?.last_token_usage; if (!lu?.input_tokens) continue;
      if (lu.input_tokens === prevIn) continue; // duplicate event
      prevIn = lu.input_tokens;
      reqs.push({ input: history.slice(), ts: Date.parse(d.timestamp), measured: { input: lu.input_tokens, cached: lu.cached_input_tokens ?? 0, output: lu.output_tokens ?? 0 } });
    }
  }
  return { reqs, model };
}

function itemHash(x: any): string { return sha1(JSON.stringify(x)); }

export interface SessionResult {
  file: string; requests: number; model?: string;
  measuredInput: number; measuredCached: number; measuredOutput: number;
  estBefore: number; estAfter: number;
  simCachedAfter: number; simUncachedAfter: number; compactions: number; folded: number; pollsCollapsed: number; readsDeduped: number; shapedSaved: number;
  costBaseline: number; costAfter: number; prefixTrimmed: number; byKind: Record<string, number>;
}

export async function replaySession(path: string, knobs = resolveKnobs(), ttlS = 1800, store?: ArtifactStore, maxRequests = 400): Promise<SessionResult | null> {
  let { reqs, model } = requestsFromRollout(path);
  if (reqs.length === 0) return null;
  if (reqs.length > maxRequests) reqs = reqs.slice(0, maxRequests); // bound the O(n²) replay on very long sessions
  const st = store ?? new ArtifactStore(join(process.env.TOKEN_HARNESS_HOME ?? join(homedir(), ".token_harness"), "bench-artifacts"));
  const state = newRewriteState(path);
  let prevHashes: string[] = []; let prevTs = 0;
  const res: SessionResult = { file: path, requests: reqs.length, model, measuredInput: 0, measuredCached: 0, measuredOutput: 0, estBefore: 0, estAfter: 0, simCachedAfter: 0, simUncachedAfter: 0, compactions: 0, folded: 0, pollsCollapsed: 0, readsDeduped: 0, shapedSaved: 0, costBaseline: 0, costAfter: 0, prefixTrimmed: 0, byKind: {} };
  for (const r of reqs) {
    const out = rewrite(r.input, { knobs, store: st, state, now: r.ts, settingsHash: model ?? "" });
    res.measuredInput += r.measured.input; res.measuredCached += r.measured.cached; res.measuredOutput += r.measured.output;
    res.estBefore += out.stats.tokensBefore; res.estAfter += out.stats.tokensAfter;
    if (out.stats.compacted) res.compactions++;
    res.prefixTrimmed += out.stats.prefixTrimmed;
    for (const it of out.items) { const kk = it.kind === 'system' ? 'fixed_prefix' : it.kind; res.byKind[kk] = (res.byKind[kk] ?? 0) + countTokens((it as any).text ?? (it as any).summary ?? (it as any).args ?? JSON.stringify(it.raw).slice(0, 2000)); }
    res.folded += out.stats.folded; res.pollsCollapsed += out.stats.pollsCollapsed; res.readsDeduped += out.stats.readsDeduped; res.shapedSaved += out.stats.shapedSaved;
    // simulate cache: common prefix with previous rewritten request, if warm
    const hashes = out.input.map(itemHash);
    const tokens = out.input.map((x) => countTokens(JSON.stringify(x)));
    let common = 0;
    const warm = prevTs && (r.ts - prevTs) / 1000 <= ttlS;
    if (warm) { while (common < hashes.length && common < prevHashes.length && hashes[common] === prevHashes[common]) common++; }
    let cachedTok = 0; for (let i = 0; i < common; i++) cachedTok += tokens[i];
    const total = tokens.reduce((a, b) => a + b, 0);
    // scale simulated split to the estimator's token count for the rewritten input
    const scale = total ? out.stats.tokensAfter / total : 1;
    res.simCachedAfter += cachedTok * scale; res.simUncachedAfter += (total - cachedTok) * scale;
    prevHashes = hashes; prevTs = r.ts;
  }
  // calibrate estimator against measured tokens (same scale applied to the rewritten side)
  const ratio = res.estBefore > 0 ? res.measuredInput / res.estBefore : 1;
  res.estAfter *= ratio; res.simCachedAfter *= ratio; res.simUncachedAfter *= ratio;
  res.costBaseline = res.measuredCached * PRICE.cached + (res.measuredInput - res.measuredCached) * PRICE.uncached + res.measuredOutput * PRICE.output;
  res.costAfter = res.simCachedAfter * PRICE.cached + res.simUncachedAfter * PRICE.uncached + res.measuredOutput * PRICE.output;
  return res;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string, def?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  const limit = Number(opt("--limit", "0")); const minBytes = Number(opt("--min-bytes", "200000"));
  const profile = opt("--profile", "default")!; const jsonOut = opt("--json"); const maxRequests = Number(opt("--max-requests", "400"));
  const overrides: KnobOverrides = {};
  for (const a of args) { const m = /^--knob\.([a-z_]+)=(.+)$/.exec(a); if (m) (overrides as any)[m[1]] = m[2]; }
  const files = args.filter((a) => a.endsWith(".jsonl"));
  const root = join(homedir(), ".codex", "sessions");
  let list = files.length ? files : walk(root).filter((f) => statSync(f).size >= minBytes).sort((a, b) => statSync(b).size - statSync(a).size);
  if (limit > 0) list = list.slice(0, limit);
  await initTokenizer();
  const knobs = resolveKnobs(PROFILES[profile], overrides);
  console.error(`replaying ${list.length} sessions, tokenizer=${tokenizerName()}, profile=${profile}, overrides=${JSON.stringify(overrides)}`);
  const results: SessionResult[] = [];
  const store = new ArtifactStore(join(process.env.TOKEN_HARNESS_HOME ?? join(homedir(), ".token_harness"), "bench-artifacts"));
  let i = 0;
  for (const f of list) {
    const r = await replaySession(f, knobs, knobs.cache_ttl_estimate_s, store, maxRequests);
    if (r) results.push(r);
    if (++i % 10 === 0) console.error(`  ${i}/${list.length}`);
  }
  const sum = (k: keyof SessionResult) => results.reduce((a, r) => a + (r[k] as number), 0);
  const estBefore = sum("estBefore"), estAfter = sum("estAfter"), measured = sum("measuredInput");
  const costB = sum("costBaseline"), costA = sum("costAfter");
  const table = {
    sessions: results.length, requests: sum("requests"),
    measured_input_tokens: measured, estimated_input_tokens: estBefore, estimator_ratio: +(estBefore / Math.max(1, measured)).toFixed(3),
    rewritten_input_tokens: Math.round(estAfter), raw_savings: +(1 - estAfter / Math.max(1, measured)).toFixed(3), raw_multiple: +(measured / Math.max(1, estAfter)).toFixed(2),
    cost_equiv_baseline: Math.round(costB), cost_equiv_after: Math.round(costA), cost_multiple: +(costB / Math.max(1, costA)).toFixed(2),
    sim_cached_share_after: +(sum("simCachedAfter") / Math.max(1, sum("simCachedAfter") + sum("simUncachedAfter"))).toFixed(3),
    prefix_trimmed_tokens: sum("prefixTrimmed"),
    rewritten_by_kind: Object.fromEntries(Object.entries(results.reduce((acc: Record<string, number>, r) => { for (const [k, v] of Object.entries(r.byKind)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)])),
    compactions: sum("compactions"), folded_outputs: sum("folded"), polls_collapsed: sum("pollsCollapsed"), reads_deduped: sum("readsDeduped"), shaped_tokens_saved: sum("shapedSaved"),
  };
  console.log(JSON.stringify(table, null, 2));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary: table, knobs, sessions: results }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith("replay.ts")) main().catch((e) => { console.error(e); process.exit(1); });
