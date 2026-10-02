/**
 * Meter: the quota/billing numbers the Codex backend puts on every response header.
 *
 * Observed on 2,155 real sessions, and the reason this file exists at all:
 *   - `x-codex-{primary,secondary}-used-percent` is an INTEGER 0..100. It is useless as a
 *     per-request price signal: fitted tick-to-tick against the tokens we sent it gives a
 *     negative R², and 15% of the ticks moved with zero local responses (other devices share
 *     the same quota window).
 *   - `x-codex-credits-balance` has 10 decimal places and is the only fine-grained meter, but
 *     it is eventually consistent: consecutive responses often show a delta of 0 followed by a
 *     lump. Per-response attribution fails (lag-0 correlation with cost-equivalent 0.61,
 *     lag-1 0.08); only the SUM over a burst of responses is trustworthy.
 *   - Even aggregated, credits-per-token varied 9x within one session for the same
 *     model/effort, because concurrent sessions draw on the same credit pool.
 * So: parse the headers, record them per response, and leave the actual pricing to an
 * aggregate estimator (src/sidecar/price.ts) or a controlled experiment (price_probe.ts).
 *
 * Everything here is tolerant by construction. These headers are undocumented, they change,
 * and a parse failure must never cost the caller its response.
 */

export interface MeterWindow {
  /** integer 0..100 as the backend reports it; see the note above before trusting a delta */
  usedPercent: number;
  windowMinutes?: number;
  /** epoch ms, from reset-at (epoch s/ms or ISO) or now + reset-after-seconds */
  resetsAt?: number;
}

export interface MeterCredits {
  balance: number;
  hasCredits: boolean;
  unlimited: boolean;
}

export interface MeterSnapshot {
  /** when we read it, not when the backend computed it (it lags; see the note above) */
  at: string;
  planType?: string;
  activeLimit?: string;
  primary?: MeterWindow;
  secondary?: MeterWindow;
  /** x-codex-primary-over-secondary-limit-percent, kept verbatim for diagnostics */
  primaryOverSecondaryPercent?: number;
  credits?: MeterCredits;
}

/** the header names we look at; presence of any one of them is what makes a snapshot exist */
export const METER_HEADERS = [
  "x-codex-plan-type",
  "x-codex-active-limit",
  "x-codex-primary-used-percent",
  "x-codex-primary-window-minutes",
  "x-codex-primary-reset-at",
  "x-codex-primary-reset-after-seconds",
  "x-codex-secondary-used-percent",
  "x-codex-secondary-window-minutes",
  "x-codex-secondary-reset-at",
  "x-codex-secondary-reset-after-seconds",
  "x-codex-primary-over-secondary-limit-percent",
  "x-codex-credits-balance",
  "x-codex-credits-has-credits",
  "x-codex-credits-unlimited",
] as const;

type HeaderLike = Headers | Record<string, string | string[] | undefined>;

function getter(h: HeaderLike): (name: string) => string | undefined {
  if (typeof (h as Headers)?.get === "function") return (n) => (h as Headers).get(n) ?? undefined;
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) {
    if (v === undefined) continue;
    lower.set(k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v));
  }
  return (n) => lower.get(n.toLowerCase());
}

function num(s: string | undefined): number | undefined {
  const t = s?.trim();
  if (!t) return undefined;          // Number("") is 0, which would turn a blank header into a real reading
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

/** "True" / "true" / "1" / "yes" are all truthy; anything else (including garbage) is false */
function bool(s: string | undefined): boolean {
  const v = String(s ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function str(s: string | undefined): string | undefined {
  const v = s?.trim();
  return v ? v : undefined;
}

/** reset-at can be epoch seconds, epoch ms or ISO; fall back to now + reset-after-seconds */
function resetsAt(at: string | undefined, afterS: number | undefined, now: number): number | undefined {
  const n = num(at);
  if (n !== undefined && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  if (at) { const p = Date.parse(at); if (Number.isFinite(p)) return p; }
  if (afterS !== undefined && afterS >= 0) return now + Math.round(afterS * 1000);
  return undefined;
}

function window(get: (n: string) => string | undefined, which: "primary" | "secondary", now: number): MeterWindow | undefined {
  const used = num(get(`x-codex-${which}-used-percent`));
  if (used === undefined) return undefined;    // without a percent the rest of the window means nothing
  const w: MeterWindow = { usedPercent: used };
  const mins = num(get(`x-codex-${which}-window-minutes`));
  if (mins !== undefined) w.windowMinutes = mins;
  const r = resetsAt(get(`x-codex-${which}-reset-at`), num(get(`x-codex-${which}-reset-after-seconds`)), now);
  if (r !== undefined) w.resetsAt = r;
  return w;
}

/**
 * Parse the meter headers off a response. Returns undefined when the response carried no
 * x-codex meter header at all (a non-Codex upstream, or an error before the backend ran);
 * a response with present-but-unparseable headers yields a snapshot with undefined fields,
 * because "the backend answered and the meter was garbage" is a different fact from "no meter".
 */
export function parseMeter(headers: HeaderLike, now = Date.now()): MeterSnapshot | undefined {
  const get = getter(headers);
  if (!METER_HEADERS.some((h) => get(h) !== undefined)) return undefined;
  const snap: MeterSnapshot = { at: new Date(now).toISOString() };
  snap.planType = str(get("x-codex-plan-type"));
  snap.activeLimit = str(get("x-codex-active-limit"));
  const primary = window(get, "primary", now); if (primary) snap.primary = primary;
  const secondary = window(get, "secondary", now); if (secondary) snap.secondary = secondary;
  const pos = num(get("x-codex-primary-over-secondary-limit-percent")); if (pos !== undefined) snap.primaryOverSecondaryPercent = pos;
  const balance = num(get("x-codex-credits-balance"));
  if (balance !== undefined) snap.credits = { balance, hasCredits: bool(get("x-codex-credits-has-credits")), unlimited: bool(get("x-codex-credits-unlimited")) };
  return snap;
}

export interface MeterDelta {
  /** a.balance - b.balance, clamped at >= 0: a top-up must not read as negative spend */
  creditsSpent?: number;
  primaryPercent?: number;
  secondaryPercent?: number;
}

/** b minus a. Any field missing on either side is left undefined rather than guessed at 0. */
export function meterDelta(a: MeterSnapshot, b: MeterSnapshot): MeterDelta {
  const d: MeterDelta = {};
  if (a.credits && b.credits) d.creditsSpent = Math.max(0, a.credits.balance - b.credits.balance);
  if (a.primary && b.primary) d.primaryPercent = b.primary.usedPercent - a.primary.usedPercent;
  if (a.secondary && b.secondary) d.secondaryPercent = b.secondary.usedPercent - a.secondary.usedPercent;
  return d;
}

/**
 * The x-codex-* subset of a response's headers, for carrying the meter across a Response we
 * synthesize ourselves (the non-streaming path aggregates SSE into fresh JSON, which would
 * otherwise drop the only billing signal the backend gives us).
 */
export function meterHeaders(from: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  from.forEach((v, k) => { if (k.toLowerCase().startsWith("x-codex-") || k.toLowerCase() === "x-oai-request-id") out[k.toLowerCase()] = v; });
  return out;
}
