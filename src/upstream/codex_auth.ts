/**
 * ChatGPT (Codex) OAuth credentials for the built-in reverse proxy.
 *
 * Credential sources, in order:
 *   1. env: CODEX_ACCESS_TOKEN (+ CODEX_REFRESH_TOKEN, CODEX_ACCOUNT_ID, CODEX_ID_TOKEN)
 *   2. ~/.mph/codex-auth.json   (written by `mph login` and by refreshes)
 *   3. ~/.codex/auth.json                  (an existing Codex CLI / Desktop login is reused as-is)
 *
 * Tokens are refreshed with the refresh_token before they expire (single-flight).
 * A refresh rotates the refresh_token, so the new pair is written to codex-auth.json
 * and, when the tokens came from ~/.codex/auth.json, synced back there too so the
 * Codex CLI keeps working with the same login.
 *
 * `login()` runs the same PKCE flow as the Codex CLI: it opens auth.openai.com in the
 * browser, receives the code on http://localhost:1455/auth/callback (fixed redirect
 * registered for the Codex client id), or accepts a pasted code / redirect URL.
 */
import { createServer } from "node:http";
import { mphEnv } from "../core/env.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { harnessHome } from "../core/knobs.js";

export type CredentialSource = "env" | "file" | "codex";
export interface CodexCredentials {
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  expiresAt?: number;       // ms epoch
  idToken?: string;
  source: CredentialSource;
}

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
export const DEFAULT_AUTH_BASE = "https://auth.openai.com";
export const CALLBACK_PORT = 1455;

export function authFilePath(): string { return join(harnessHome(), "codex-auth.json"); }
export function codexCliAuthPath(env: NodeJS.ProcessEnv = process.env): string { return mphEnv("CODEX_CLI_AUTH", env) ?? join(env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"); }

export function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return null; }
}
export function accountIdFromToken(token: string): string | undefined {
  const auth = decodeJwtPayload(token)?.[JWT_AUTH_CLAIM];
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id ? id : undefined;
}
export function expiryFromToken(token: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}
export function planFromToken(token: string): string | undefined {
  const auth = decodeJwtPayload(token)?.[JWT_AUTH_CLAIM];
  return typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
}

function complete(p: { accessToken: string; refreshToken?: string; accountId?: string; expiresAt?: number; idToken?: string; source: CredentialSource }): CodexCredentials {
  const accountId = p.accountId ?? accountIdFromToken(p.accessToken) ?? (p.idToken ? accountIdFromToken(p.idToken) : undefined);
  if (!accountId) throw new Error("cannot determine ChatGPT account id from the OAuth tokens");
  return { ...p, accountId, expiresAt: p.expiresAt ?? expiryFromToken(p.accessToken) };
}

export function loadCredentials(env: NodeJS.ProcessEnv = process.env): CodexCredentials | null {
  if (env.CODEX_ACCESS_TOKEN) {
    return complete({ accessToken: env.CODEX_ACCESS_TOKEN, refreshToken: env.CODEX_REFRESH_TOKEN, accountId: env.CODEX_ACCOUNT_ID, idToken: env.CODEX_ID_TOKEN, expiresAt: env.CODEX_EXPIRES_AT ? Number(env.CODEX_EXPIRES_AT) : undefined, source: "env" });
  }
  const own = authFilePath();
  if (existsSync(own)) {
    try {
      const j = JSON.parse(readFileSync(own, "utf8"));
      const c = j.credentials ?? j;
      if (typeof c.accessToken === "string" && c.accessToken) return complete({ accessToken: c.accessToken, refreshToken: c.refreshToken, accountId: c.accountId, expiresAt: c.expiresAt, idToken: c.idToken, source: "file" });
    } catch { /* fall through */ }
  }
  const cli = codexCliAuthPath(env);
  if (existsSync(cli)) {
    try {
      const j = JSON.parse(readFileSync(cli, "utf8"));
      const t = j.tokens ?? {};
      if (typeof t.access_token === "string" && t.access_token) return complete({ accessToken: t.access_token, refreshToken: t.refresh_token, accountId: t.account_id, idToken: t.id_token, source: "codex" });
    } catch { /* fall through */ }
  }
  return null;
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp"; writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, path);
}

export function saveCredentials(c: CodexCredentials, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(authFilePath(), { version: 1, updatedAt: new Date().toISOString(), credentials: { accessToken: c.accessToken, refreshToken: c.refreshToken, accountId: c.accountId, expiresAt: c.expiresAt, idToken: c.idToken } });
  if (c.source === "codex") {
    // keep the Codex CLI's own login usable after we rotated its refresh token
    const cli = codexCliAuthPath(env);
    try {
      const j = existsSync(cli) ? JSON.parse(readFileSync(cli, "utf8")) : {};
      j.tokens = { ...(j.tokens ?? {}), access_token: c.accessToken, refresh_token: c.refreshToken ?? j.tokens?.refresh_token, account_id: c.accountId, ...(c.idToken ? { id_token: c.idToken } : {}) };
      j.last_refresh = new Date().toISOString();
      writeJsonAtomic(cli, j);
    } catch { /* best effort */ }
  }
}

export function clearCredentials(): boolean {
  const p = authFilePath();
  if (!existsSync(p)) return false;
  renameSync(p, p + ".removed-" + Date.now());
  return true;
}

export interface LoginCallbacks {
  /** called with the URL to open; implementations usually open a browser and print it */
  onAuth: (url: string) => void;
  /** optional: resolves with a pasted code or redirect URL (races with the local callback) */
  manualInput?: () => Promise<string>;
  log?: (msg: string) => void;
  /** how long to wait for the browser callback before giving up (ms) */
  timeoutMs?: number;
}

export class CodexAuth {
  private inflight: Promise<CodexCredentials> | null = null;
  private cached: CodexCredentials | null = null;
  readonly authBase: string;
  readonly refreshSkewMs: number;
  constructor(readonly env: NodeJS.ProcessEnv = process.env, opts: { authBase?: string; refreshSkewMs?: number } = {}) {
    this.authBase = (opts.authBase ?? mphEnv("CODEX_AUTH_BASE", env) ?? DEFAULT_AUTH_BASE).replace(/\/$/, "");
    this.refreshSkewMs = opts.refreshSkewMs ?? 60_000;
  }

  /** current credentials, refreshed if they expire within the skew */
  async get(force = false): Promise<CodexCredentials> {
    const c = this.cached ?? loadCredentials(this.env);
    if (!c) throw new Error("no Codex credentials: run `mph login` (or log in with the Codex CLI so ~/.codex/auth.json exists), or set MPH_OPENAI_BASE_URL for an OpenAI-compatible upstream");
    this.cached = c;
    const expiring = c.expiresAt !== undefined && c.expiresAt <= Date.now() + this.refreshSkewMs;
    if (!force && !expiring) return c;
    if (!c.refreshToken) { if (force || (c.expiresAt ?? Infinity) <= Date.now()) throw new Error("Codex access token expired and no refresh token available: run `mph login`"); return c; }
    if (!this.inflight) this.inflight = this.refresh(c).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  invalidate(): void { this.cached = null; }

  async refresh(c: CodexCredentials): Promise<CodexCredentials> {
    const r = await fetch(`${this.authBase}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refreshToken!, client_id: CLIENT_ID }) });
    if (!r.ok) throw new Error(`Codex token refresh failed (${r.status}): ${(await r.text()).slice(0, 300)}; run \`mph login\``);
    const j: any = await r.json();
    if (!j.access_token) throw new Error("Codex token refresh returned no access_token");
    const next = complete({ accessToken: j.access_token, refreshToken: j.refresh_token ?? c.refreshToken, idToken: j.id_token ?? c.idToken, expiresAt: typeof j.expires_in === "number" ? Date.now() + j.expires_in * 1000 : undefined, accountId: accountIdFromToken(j.access_token) ?? c.accountId, source: c.source });
    saveCredentials(next, this.env);
    this.cached = { ...next, source: next.source === "env" ? "env" : next.source };
    return this.cached;
  }

  /** PKCE login; returns and persists the credentials */
  async login(cb: LoginCallbacks, callbackPort = Number(mphEnv("CODEX_CALLBACK_PORT", this.env) ?? CALLBACK_PORT)): Promise<CodexCredentials> {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = randomBytes(16).toString("hex");
    const redirectUri = `http://localhost:${callbackPort}/auth/callback`;
    const url = new URL(`${this.authBase}/oauth/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri, scope: SCOPE, code_challenge: challenge, code_challenge_method: "S256", state, id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "token_harness" })) url.searchParams.set(k, v);

    let resolveCode!: (c: string) => void, rejectCode!: (e: Error) => void;
    const codeP = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname !== "/auth/callback") { res.writeHead(404).end("not found"); return; }
      if (u.searchParams.get("state") !== state) { res.writeHead(400).end("state mismatch"); return; }
      const code = u.searchParams.get("code");
      if (!code) { res.writeHead(400).end("missing code"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>my-poor-harness</title><p>Login complete. You can close this tab and return to the terminal.</p>");
      resolveCode(code);
    });
    const bound = await new Promise<boolean>((res) => { server.once("error", () => res(false)); server.listen(callbackPort, "127.0.0.1", () => res(true)); });
    if (!bound) cb.log?.(`could not listen on port ${callbackPort}; paste the redirect URL manually`);
    cb.onAuth(url.toString());
    const timer = setTimeout(() => rejectCode(new Error("timed out waiting for the OAuth callback")), cb.timeoutMs ?? 10 * 60_000);
    try {
      const racers: Promise<string>[] = [codeP];
      if (cb.manualInput) racers.push(cb.manualInput().then((input) => {
        const parsed = parseAuthInput(input);
        if (parsed.state && parsed.state !== state) throw new Error("state mismatch in pasted input");
        if (!parsed.code) throw new Error("no authorization code in pasted input");
        return parsed.code;
      }));
      const code = await Promise.race(racers);
      const r = await fetch(`${this.authBase}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: redirectUri }) });
      if (!r.ok) throw new Error(`token exchange failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
      const j: any = await r.json();
      if (!j.access_token) throw new Error("token exchange returned no access_token");
      const creds = complete({ accessToken: j.access_token, refreshToken: j.refresh_token, idToken: j.id_token, expiresAt: typeof j.expires_in === "number" ? Date.now() + j.expires_in * 1000 : undefined, source: "file" });
      saveCredentials(creds, this.env);
      this.cached = creds;
      return creds;
    } finally {
      clearTimeout(timer);
      server.close(); server.closeAllConnections?.();
    }
  }
}

function b64url(b: Buffer): string { return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

export function parseAuthInput(input: string): { code?: string; state?: string } {
  const v = input.trim();
  if (!v) return {};
  try { const u = new URL(v); return { code: u.searchParams.get("code") ?? undefined, state: u.searchParams.get("state") ?? undefined }; } catch { /* not a URL */ }
  if (v.includes("code=")) { const p = new URLSearchParams(v); return { code: p.get("code") ?? undefined, state: p.get("state") ?? undefined }; }
  if (v.includes("#")) { const [code, state] = v.split("#", 2); return { code, state }; }
  return { code: v };
}
