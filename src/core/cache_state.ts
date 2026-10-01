/**
 * Cache state estimate: the server-side prefix cache is "warm" only if the last
 * request was recent (within TTL) and nothing cache-breaking changed.
 */
import { sha1 } from "./items.js";

export type CacheState = "warm" | "cold" | "unknown";

export interface CacheProbe {
  lastRequestAt?: number;       // epoch ms
  lastSettingsHash?: string;
  lastPrefixHash?: string;
}

export function settingsHash(body: any): string {
  const keys = ["model", "tools", "parallel_tool_calls", "reasoning", "text", "context_management", "instructions"];
  const o: any = {};
  for (const k of keys) if (body?.[k] !== undefined) o[k] = body[k];
  return sha1(JSON.stringify(o));
}

export function estimateCacheState(probe: CacheProbe, now: number, ttlSeconds: number, currentSettingsHash: string, currentPrefixHash: string): { state: CacheState; idleS: number; reason: string } {
  if (probe.lastRequestAt === undefined) return { state: "unknown", idleS: Infinity, reason: "no previous request" };
  const idleS = (now - probe.lastRequestAt) / 1000;
  if (idleS > ttlSeconds) return { state: "cold", idleS, reason: `idle ${Math.round(idleS)}s > ttl ${ttlSeconds}s` };
  if (probe.lastSettingsHash && probe.lastSettingsHash !== currentSettingsHash) return { state: "cold", idleS, reason: "settings changed" };
  if (probe.lastPrefixHash && probe.lastPrefixHash !== currentPrefixHash) return { state: "cold", idleS, reason: "fixed prefix changed" };
  return { state: "warm", idleS, reason: "recent request, same settings" };
}

/**
 * Fit a crude TTL from observed (idle seconds, cached share) samples: the idle
 * bucket where median cached share drops below 0.5 is the TTL estimate.
 */
export function fitTtl(samples: { idleS: number; cachedShare: number }[], fallback = 1800): number {
  const buckets: [number, number][] = [[60, 0], [300, 0], [600, 0], [1800, 0], [3600, 0], [86400, 0]];
  const acc = new Map<number, number[]>();
  for (const s of samples) {
    const b = buckets.find(([lim]) => s.idleS <= lim)?.[0] ?? 86400;
    if (!acc.has(b)) acc.set(b, []);
    acc.get(b)!.push(s.cachedShare);
  }
  let prev = 60;
  for (const [lim] of buckets) {
    const xs = acc.get(lim);
    if (!xs || xs.length < 5) continue;
    const sorted = [...xs].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    if (med < 0.5) return prev;
    prev = lim;
  }
  return samples.length >= 5 ? prev : fallback;
}
