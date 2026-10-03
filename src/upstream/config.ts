/**
 * Upstream configuration: where the harness and `mph proxy` send Responses requests.
 *
 *   ~/.mph/config.json
 *   {
 *     "provider": "codex" | "openai_compatible",
 *     "base_url": "https://api.openai.com/v1",      // openai_compatible only
 *     "api_key": "sk-...",                            // openai_compatible only
 *     "codex": { "base_url": "https://chatgpt.com/backend-api", "models": ["gpt-5.6-sol"] }
 *   }
 *
 * Resolution order (highest first): explicit overrides (CLI flags) → environment
 * (MPH_PROVIDER, MPH_OPENAI_BASE_URL / OPENAI_BASE_URL, MPH_OPENAI_API_KEY / OPENAI_API_KEY)
 * → config.json → default (codex, i.e. the built-in ChatGPT OAuth reverse proxy).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { mphEnv } from "../core/env.js";
import { dirname, join } from "node:path";
import { harnessHome } from "../core/knobs.js";
import { UI_DEFAULTS, type UiSettings } from "../harness/render.js";

export type Provider = "codex" | "openai_compatible";
export type WireApi = "responses" | "chat";

export interface UpstreamConfigFile {
  provider?: Provider;
  base_url?: string;
  api_key?: string;
  /** openai_compatible only: "responses" (default; falls back to chat on 404) or "chat" (/chat/completions) */
  wire_api?: WireApi;
  codex?: { base_url?: string; models?: string[]; originator?: string };
  /** model choices; unset means "pick for the provider" (see resolveModels) */
  main_model?: string;
  mid_model?: string;
  small_model?: string;
  /** memory is global (shared by every project); recall=false stops injecting and searching it, write=false stops recording */
  memory?: { recall?: boolean; write?: boolean };
  /** terminal output: status bar, folded tool calls, and the write discipline that
   *  keeps Apple Terminal alive (see src/harness/render.ts) */
  ui?: { status_bar?: boolean; fold_tools?: boolean; wrap?: boolean; flush_ms?: number; glyphs?: "ascii" | "unicode"; color?: boolean };
}

export interface ResolvedUpstream {
  provider: Provider;
  /** openai_compatible: base URL ending in /v1 (or whatever the server uses); codex: backend base */
  baseUrl: string;
  apiKey?: string;
  /** openai_compatible: which API the endpoint speaks; `wireApiExplicit` false means auto-fallback to chat on 404 */
  wireApi: WireApi;
  wireApiExplicit: boolean;
  /** model ids advertised on /models for codex (the backend has no list endpoint) */
  codexModels: string[];
  originator: string;
  /** where the choice came from, for diagnostics */
  source: "override" | "env" | "config" | "default";
}

export const DEFAULT_CODEX_BASE = "https://chatgpt.com/backend-api";
/** models a ChatGPT account accepts on the Codex backend (probed 2026-10-02; gpt-5.4, gpt-5.4-mini and the *-mini line are rejected) */
export const DEFAULT_CODEX_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"];

export function configPath(): string { return join(harnessHome(), "config.json"); }

export function loadConfigFile(): UpstreamConfigFile {
  const p = configPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")) as UpstreamConfigFile; } catch { return {}; }
}

export function saveConfigFile(cfg: UpstreamConfigFile): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp"; writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, p);
}

export interface UpstreamOverrides { provider?: Provider; baseUrl?: string; apiKey?: string; wireApi?: WireApi }

export function resolveUpstream(overrides: UpstreamOverrides = {}, env: NodeJS.ProcessEnv = process.env): ResolvedUpstream {
  const r = resolveBase(overrides, env);
  const file = loadConfigFile();
  const w = overrides.wireApi ?? (mphEnv("OPENAI_WIRE_API", env) as WireApi | undefined) ?? (r.source === "config" ? file.wire_api : undefined);
  return { ...r, wireApi: w === "chat" ? "chat" : "responses", wireApiExplicit: w === "chat" || w === "responses" };
}

function resolveBase(overrides: UpstreamOverrides, env: NodeJS.ProcessEnv): Omit<ResolvedUpstream, "wireApi" | "wireApiExplicit"> {
  const file = loadConfigFile();
  const codexBase = mphEnv("CODEX_BASE_URL", env) ?? file.codex?.base_url ?? DEFAULT_CODEX_BASE;
  const codexModels = file.codex?.models?.length ? file.codex.models : DEFAULT_CODEX_MODELS;
  const originator = file.codex?.originator ?? mphEnv("CODEX_ORIGINATOR", env) ?? "codex_cli_rs";
  const envBase = mphEnv("OPENAI_BASE_URL", env) ?? env.OPENAI_BASE_URL;
  const envKey = mphEnv("OPENAI_API_KEY", env) ?? env.OPENAI_API_KEY;
  const envProvider = mphEnv("PROVIDER", env) as Provider | undefined;

  if (overrides.provider === "codex") return { provider: "codex", baseUrl: overrides.baseUrl ?? codexBase, codexModels, originator, source: "override" };
  if (overrides.baseUrl || overrides.provider === "openai_compatible") {
    return { provider: "openai_compatible", baseUrl: overrides.baseUrl ?? envBase ?? file.base_url ?? "http://127.0.0.1:8790/v1", apiKey: overrides.apiKey ?? envKey ?? file.api_key, codexModels, originator, source: "override" };
  }
  if (envProvider === "codex") return { provider: "codex", baseUrl: codexBase, codexModels, originator, source: "env" };
  if (envProvider === "openai_compatible" || envBase) {
    return { provider: "openai_compatible", baseUrl: envBase ?? file.base_url ?? "http://127.0.0.1:8790/v1", apiKey: envKey ?? file.api_key, codexModels, originator, source: "env" };
  }
  if (file.provider === "openai_compatible") {
    return { provider: "openai_compatible", baseUrl: file.base_url ?? "http://127.0.0.1:8790/v1", apiKey: envKey ?? file.api_key, codexModels, originator, source: "config" };
  }
  return { provider: "codex", baseUrl: codexBase, codexModels, originator, source: file.provider ? "config" : "default" };
}

export function describeUpstream(u: ResolvedUpstream): string {
  return u.provider === "codex" ? `codex (ChatGPT OAuth, ${u.baseUrl}, via ${u.source})` : `openai_compatible (${u.baseUrl}, wire=${u.wireApi}${u.wireApiExplicit ? "" : "+auto"}${u.apiKey ? ", key set" : ", no key"}, via ${u.source})`;
}

/** Defaults per provider. ChatGPT OAuth has the gpt family; an own endpoint may not, so its tiers default to the main model. */
/** gpt-5.4-mini is not accepted with a ChatGPT account; gpt-5.6-luna is the backend's own "faster model" */
export const CODEX_MODEL_DEFAULTS = { main: "gpt-5.6-sol", mid: "gpt-5.5", small: "gpt-5.6-luna" };

export interface ResolvedModels { main: string; mid: string; small: string; source: { main: string; mid: string; small: string } }

/**
 * Model per tier. Order: knob explicitly set (session/project/global/--model) → config.json
 * → env MPH_MODEL (main only) → provider default. An empty knob means "auto".
 */
export function resolveModels(knobs: { main_model?: string; mid_model?: string; small_model?: string }, env: NodeJS.ProcessEnv = process.env, upstream?: ResolvedUpstream): ResolvedModels {
  const file = loadConfigFile();
  const provider = (upstream ?? resolveUpstream({}, env)).provider;
  const src: ResolvedModels["source"] = { main: "", mid: "", small: "" };
  const pick = (tier: "main" | "mid" | "small", knob: string | undefined, cfg: string | undefined, fallback: () => string) => {
    if (knob) { src[tier] = "knob"; return knob; }
    if (cfg) { src[tier] = "config"; return cfg; }
    src[tier] = "default"; return fallback();
  };
  const main = pick("main", knobs.main_model, file.main_model ?? mphEnv("MODEL", env), () => CODEX_MODEL_DEFAULTS.main);
  const mid = pick("mid", knobs.mid_model, file.mid_model, () => provider === "codex" ? CODEX_MODEL_DEFAULTS.mid : main);
  const small = pick("small", knobs.small_model, file.small_model, () => provider === "codex" ? CODEX_MODEL_DEFAULTS.small : main);
  return { main, mid, small, source: src };
}

export interface MemorySettings { recall: boolean; write: boolean }

/** global memory switches: config.json `memory`, overridable with MPH_MEMORY_RECALL / MPH_MEMORY_WRITE = 0|1 */
export function memorySettings(env: NodeJS.ProcessEnv = process.env): MemorySettings {
  const m = loadConfigFile().memory ?? {};
  const flag = (v: string | undefined, d: boolean) => v === undefined ? d : !["0", "false", "off", "no"].includes(v.toLowerCase());
  return { recall: flag(mphEnv("MEMORY_RECALL", env), m.recall !== false), write: flag(mphEnv("MEMORY_WRITE", env), m.write !== false) };
}

/**
 * Terminal output settings: config.json `ui`, each overridable with
 * MPH_UI_STATUS_BAR / MPH_UI_FOLD_TOOLS / MPH_UI_WRAP / MPH_UI_FLUSH_MS /
 * MPH_UI_GLYPHS / MPH_UI_COLOR. NO_COLOR and TERM=dumb are honoured.
 */
export function uiSettings(env: NodeJS.ProcessEnv = process.env): UiSettings {
  const u = loadConfigFile().ui ?? {};
  const dumb = env.TERM === "dumb";
  const bool = (name: string, cfg: boolean | undefined, d: boolean) => {
    const v = mphEnv(name, env);
    if (v !== undefined) return !BOOL_OFF.includes(v.toLowerCase());
    return cfg ?? d;
  };
  const flushEnv = Number(mphEnv("UI_FLUSH_MS", env));
  const glyphs = (mphEnv("UI_GLYPHS", env) ?? u.glyphs) === "unicode" && !dumb ? "unicode" : "ascii";
  return {
    statusBar: bool("UI_STATUS_BAR", u.status_bar, !dumb),
    foldTools: bool("UI_FOLD_TOOLS", u.fold_tools, true),
    wrap: bool("UI_WRAP", u.wrap, true),
    flushMs: Number.isFinite(flushEnv) && mphEnv("UI_FLUSH_MS", env) !== undefined ? Math.max(0, Math.min(500, flushEnv)) : Math.max(0, Math.min(500, u.flush_ms ?? UI_DEFAULTS.flushMs)),
    glyphs,
    color: bool("UI_COLOR", u.color, !env.NO_COLOR && !dumb),
  };
}

/** every key `mph config k=v` and the vibe agent's settings_write accept, with what they take */
export const CONFIG_KEYS: Record<string, string> = {
  provider: "codex | openai_compatible",
  base_url: "URL of an OpenAI-compatible endpoint (empty clears it)",
  api_key: "key for that endpoint (empty clears it); never printed back",
  wire_api: "responses | chat (empty = auto: responses, falling back to chat on 404)",
  codex_base_url: "override the Codex backend base URL",
  codex_models: "comma-separated models the Codex backend accepts",
  main_model: "model for the conversation (empty = provider default)",
  mid_model: "model for delegate workers and map items (empty = auto)",
  small_model: "model for the gate, memory extraction and answer cards (empty = auto)",
  memory_recall: "on | off — inject and search long-term memory",
  memory_write: "on | off — record new memory entries",
  ui_status_bar: "on | off — bottom status line (task title, tokens, latency)",
  ui_fold_tools: "on | off — collapse a step's tool calls into one line",
  ui_wrap: "on | off — hard-wrap output at the window width (keep on: long lines crash Apple Terminal)",
  ui_flush_ms: "0-500 — coalesce terminal writes into one syscall per N ms (0 = every write)",
  ui_glyphs: "ascii | unicode — event tags; ascii avoids ambiguous-width glyphs",
  ui_color: "on | off — reverse video on the status line",
};

const BOOL_ON = ["on", "true", "1", "yes"];
const BOOL_OFF = ["off", "false", "0", "no"];

/** mask anything that must not be echoed back into a transcript or a log */
export function maskConfig(cfg: UpstreamConfigFile): UpstreamConfigFile {
  return { ...cfg, api_key: cfg.api_key ? "***" : undefined };
}

/**
 * Apply `key=value` settings to config.json. One validator for both `mph config` and
 * the vibe agent, so the two can never disagree about what is allowed. Throws on an
 * unknown key or an invalid value instead of silently falling back to a default.
 */
export function setConfigValues(entries: [string, string][]): { changed: Record<string, string>; config: UpstreamConfigFile } {
  const cfg = loadConfigFile();
  const changed: Record<string, string> = {};
  const note = (k: string, v: string) => { changed[k] = k === "api_key" ? (v ? "***" : "(cleared)") : v || "(cleared)"; };
  for (const [k, v] of entries) {
    if (k === "provider") { if (v !== "codex" && v !== "openai_compatible") throw new Error("provider must be codex or openai_compatible"); cfg.provider = v; }
    else if (k === "base_url") cfg.base_url = v || undefined;
    else if (k === "api_key") cfg.api_key = v || undefined;
    else if (k === "wire_api") { if (v && v !== "responses" && v !== "chat") throw new Error("wire_api must be responses or chat"); cfg.wire_api = (v || undefined) as WireApi | undefined; }
    else if (k === "codex_base_url") cfg.codex = { ...(cfg.codex ?? {}), base_url: v || undefined };
    else if (k === "codex_models") cfg.codex = { ...(cfg.codex ?? {}), models: v.split(",").map((m) => m.trim()).filter(Boolean) };
    else if (k === "main_model" || k === "mid_model" || k === "small_model") cfg[k] = v || undefined;
    else if (k === "memory_recall" || k === "memory_write") {
      const on = BOOL_ON.includes(v.toLowerCase());
      if (!on && !BOOL_OFF.includes(v.toLowerCase())) throw new Error(`${k} must be on or off`);
      cfg.memory = { ...(cfg.memory ?? {}), [k === "memory_recall" ? "recall" : "write"]: on };
    }
    else if (k === "ui_glyphs") { if (v && v !== "ascii" && v !== "unicode") throw new Error("ui_glyphs must be ascii or unicode"); cfg.ui = { ...(cfg.ui ?? {}), glyphs: (v || undefined) as "ascii" | "unicode" | undefined }; }
    else if (k === "ui_flush_ms") { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 500) throw new Error("ui_flush_ms must be 0-500"); cfg.ui = { ...(cfg.ui ?? {}), flush_ms: n }; }
    else if (k.startsWith("ui_")) {
      const on = BOOL_ON.includes(v.toLowerCase());
      if (!on && !BOOL_OFF.includes(v.toLowerCase())) throw new Error(`${k} must be on or off`);
      const field = { ui_status_bar: "status_bar", ui_fold_tools: "fold_tools", ui_wrap: "wrap", ui_color: "color" }[k];
      if (!field) throw new Error(`unknown config key ${k}; valid keys: ${Object.keys(CONFIG_KEYS).join(", ")}`);
      cfg.ui = { ...(cfg.ui ?? {}), [field]: on };
    }
    else throw new Error(`unknown config key ${k}; valid keys: ${Object.keys(CONFIG_KEYS).join(", ")}`);
    note(k, v);
  }
  if (entries.length) saveConfigFile(cfg);
  return { changed, config: cfg };
}
