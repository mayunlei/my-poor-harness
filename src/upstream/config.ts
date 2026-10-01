/**
 * Upstream configuration: where the harness and th-proxy send Responses requests.
 *
 *   ~/.token_harness/config.json
 *   {
 *     "provider": "codex" | "openai_compatible",
 *     "base_url": "https://api.openai.com/v1",      // openai_compatible only
 *     "api_key": "sk-...",                            // openai_compatible only
 *     "codex": { "base_url": "https://chatgpt.com/backend-api", "models": ["gpt-5.6-sol"] }
 *   }
 *
 * Resolution order (highest first): explicit overrides (CLI flags) → environment
 * (TH_PROVIDER, TH_OPENAI_BASE_URL / OPENAI_BASE_URL, TH_OPENAI_API_KEY / OPENAI_API_KEY)
 * → config.json → default (codex, i.e. the built-in ChatGPT OAuth reverse proxy).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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
export const DEFAULT_CODEX_MODELS = ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];

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
  const w = overrides.wireApi ?? (env.TH_OPENAI_WIRE_API as WireApi | undefined) ?? (r.source === "config" ? file.wire_api : undefined);
  return { ...r, wireApi: w === "chat" ? "chat" : "responses", wireApiExplicit: w === "chat" || w === "responses" };
}

function resolveBase(overrides: UpstreamOverrides, env: NodeJS.ProcessEnv): Omit<ResolvedUpstream, "wireApi" | "wireApiExplicit"> {
  const file = loadConfigFile();
  const codexBase = env.TH_CODEX_BASE_URL ?? file.codex?.base_url ?? DEFAULT_CODEX_BASE;
  const codexModels = file.codex?.models?.length ? file.codex.models : DEFAULT_CODEX_MODELS;
  const originator = file.codex?.originator ?? env.TH_CODEX_ORIGINATOR ?? "codex_cli_rs";
  const envBase = env.TH_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL;
  const envKey = env.TH_OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  const envProvider = env.TH_PROVIDER as Provider | undefined;

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
