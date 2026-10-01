/**
 * Token counting. Uses js-tiktoken (o200k_base) when available, falls back to a
 * CJK-aware heuristic. Counting is cached by string hash because the rewrite
 * pass re-measures the same items on every request.
 */
import { createHash } from "node:crypto";

let encoder: { encode(s: string, allowedSpecial?: any, disallowedSpecial?: any): number[] } | null = null;
let triedLoad = false;

async function loadEncoder(): Promise<void> {
  if (triedLoad) return;
  triedLoad = true;
  try {
    const mod = await import("js-tiktoken");
    encoder = mod.getEncoding("o200k_base");
  } catch {
    encoder = null;
  }
}

const cache = new Map<string, number>();
const CACHE_MAX = 20000;

export function heuristicTokens(text: string): number {
  // ~4 chars/token for ASCII, ~1.3 chars/token for CJK, punctuation-heavy code ~3.
  let ascii = 0, cjk = 0, other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 128) ascii++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
    else other++;
  }
  return Math.ceil(ascii / 3.6 + cjk / 1.3 + other / 2);
}

export function countTokens(text: string): number {
  if (!text) return 0;
  const key = text.length > 64 ? createHash("sha1").update(text).digest("hex") : text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let n: number;
  if (encoder) { try { n = encoder.encode(text, "all", []).length; } catch { n = heuristicTokens(text); } } else n = heuristicTokens(text);
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(key, n);
  return n;
}

export async function initTokenizer(): Promise<boolean> {
  await loadEncoder();
  return encoder !== null;
}

export function tokenizerName(): string {
  return encoder ? "o200k_base" : "heuristic";
}
