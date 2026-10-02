/**
 * Upstream configuration: where the harness and mph-proxy send Responses requests.
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
