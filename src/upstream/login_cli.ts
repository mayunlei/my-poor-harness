/** Interactive `login` shared by `th` and `th-proxy`: browser PKCE flow with manual paste fallback. */
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { CodexAuth, loadCredentials, planFromToken, authFilePath, clearCredentials } from "./codex_auth.js";

function openBrowser(url: string): void {
  const [bin, argv]: [string, string[]] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { execFile(bin, argv, () => { /* best effort */ }); } catch { /* ignore */ }
}

export async function runLogin(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const auth = new CodexAuth();
  try {
    const creds = await auth.login({
      onAuth: (url) => { console.log(`Opening the browser for ChatGPT login. If it does not open, visit:\n\n  ${url}\n\nAfter approving, this terminal continues automatically; or paste the redirect URL / code here and press Enter.`); openBrowser(url); },
      manualInput: () => new Promise<string>((res) => rl.question("", (a) => res(a))),
      log: (m) => console.log(m),
    });
    console.log(`Logged in: account ${creds.accountId}${planFromToken(creds.accessToken) ? ` (${planFromToken(creds.accessToken)})` : ""}; expires ${creds.expiresAt ? new Date(creds.expiresAt).toISOString() : "unknown"}; saved to ${authFilePath()}`);
  } finally { rl.close(); }
}

export function printWhoami(): void {
  const c = loadCredentials();
  if (!c) { console.log("not logged in: run `th login` (or log in with the Codex CLI)"); return; }
  const left = c.expiresAt ? Math.round((c.expiresAt - Date.now()) / 60000) : undefined;
  console.log(`account ${c.accountId}${planFromToken(c.accessToken) ? ` (${planFromToken(c.accessToken)})` : ""} · source ${c.source}${c.source === "codex" ? " (~/.codex/auth.json)" : c.source === "file" ? ` (${authFilePath()})` : ""} · access token ${left === undefined ? "expiry unknown" : left > 0 ? `valid ${left} min` : `expired ${-left} min ago`}${c.refreshToken ? " · refresh token present" : " · no refresh token"}`);
}

export function runLogout(): void {
  console.log(clearCredentials() ? `removed ${authFilePath()}` : `nothing to remove at ${authFilePath()} (a Codex CLI login in ~/.codex/auth.json is left untouched)`);
}
