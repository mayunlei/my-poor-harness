/**
 * Built-in Codex (ChatGPT OAuth) upstream: config resolution, credential loading /
 * refresh / persistence, PKCE login against a mock auth server, the transport's
 * headers and SSE aggregation, and th-proxy + harness client going through it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "th-up-"));
process.env.TOKEN_HARNESS_HOME = HOME;
const CLI_AUTH = join(HOME, "codex-cli", "auth.json");
process.env.TH_CODEX_CLI_AUTH = CLI_AUTH;
delete process.env.TH_OPENAI_BASE_URL; delete process.env.OPENAI_BASE_URL; delete process.env.TH_PROVIDER; delete process.env.CODEX_ACCESS_TOKEN;

const { resolveUpstream, saveConfigFile } = await import("../src/upstream/config.js");
const { CodexAuth, loadCredentials, authFilePath, accountIdFromToken } = await import("../src/upstream/codex_auth.js");
const { CodexTransport, prepareCodexBody, aggregateSse } = await import("../src/upstream/codex.js");
const { upstreamFor } = await import("../src/upstream/index.js");

function jwt(payload: any): string {
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}
const ACC = "acct-test-1";
const token = (expInS: number, tag = "a") => jwt({ exp: Math.floor(Date.now() / 1000) + expInS, tag, "https://api.openai.com/auth": { chatgpt_account_id: ACC, chatgpt_plan_type: "pro" } });

function listen(handler: (req: any, res: any, body: string) => void): Promise<{ url: string; port: number; close: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => { const ch: Buffer[] = []; req.on("data", (c) => ch.push(c)); req.on("end", () => handler(req, res, Buffer.concat(ch).toString())); });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => { const port = (server.address() as any).port; r({ url: `http://127.0.0.1:${port}`, port, server, close: () => new Promise((d) => { server.closeAllConnections(); server.close(() => d()); }) }); }));
}

/** mock auth.openai.com: /oauth/token for refresh + code exchange */
async function mockAuth() {
  const calls: any[] = [];
  const m = await listen((req, res, body) => {
    const p = new URLSearchParams(body); const o = Object.fromEntries(p.entries()); calls.push({ url: req.url, ...o });
    if (req.url !== "/oauth/token") { res.writeHead(404).end(); return; }
    if (o.grant_type === "refresh_token" && o.refresh_token === "rt-dead") { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" })); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token(3600, o.grant_type === "authorization_code" ? "login" : "refreshed"), refresh_token: "rt-" + (o.grant_type === "authorization_code" ? "login" : "rotated"), id_token: jwt({ email: "u@example.com" }), expires_in: 3600 }));
  });
  return { ...m, calls };
}

/** mock chatgpt.com/backend-api/codex/responses */
async function mockCodex(opts: { reject401Once?: boolean } = {}) {
  const requests: { headers: any; body: any; url: string }[] = [];
  let rejected = false;
  const m = await listen((req, res, raw) => {
    const body = JSON.parse(raw || "{}"); requests.push({ headers: req.headers, body, url: req.url });
    if (req.url !== "/codex/responses") { res.writeHead(404).end("nope"); return; }
    if (opts.reject401Once && !rejected) { rejected = true; res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "token expired" } })); return; }
    if (body.stream !== true || body.store !== false) { res.writeHead(400).end("stream/store"); return; }
    if (typeof body.instructions !== "string") { res.writeHead(400).end("instructions required"); return; }
    const text = "hello from codex";
    const response = { id: "resp_1", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`);
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
    // like the real backend with store:false: items only in output_item.done, completed carries output: []
    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: response.output[0] })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { ...response, output: [] } })}\n\n`);
    res.end();
  });
  return { ...m, requests };
}

function writeCliAuth(access: string, refresh = "rt-cli") {
  mkdirSync(join(HOME, "codex-cli"), { recursive: true });
  writeFileSync(CLI_AUTH, JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: jwt({ email: "u@example.com" }), access_token: access, refresh_token: refresh, account_id: ACC }, last_refresh: "2026-09-24T13:51:29Z" }));
}

test("upstream config: default codex; env base url → openai_compatible; overrides win; config file respected", () => {
  const env: any = {};
  assert.equal(resolveUpstream({}, env).provider, "codex");
  assert.equal(resolveUpstream({}, { TH_OPENAI_BASE_URL: "http://x/v1", TH_OPENAI_API_KEY: "k" }).provider, "openai_compatible");
  assert.equal(resolveUpstream({}, { TH_OPENAI_BASE_URL: "http://x/v1" }).baseUrl, "http://x/v1");
  assert.equal(resolveUpstream({ provider: "codex" }, { TH_OPENAI_BASE_URL: "http://x/v1" }).provider, "codex");
  assert.equal(resolveUpstream({ baseUrl: "http://y/v1", apiKey: "z" }, { TH_PROVIDER: "codex" }).apiKey, "z");
  saveConfigFile({ provider: "openai_compatible", base_url: "http://cfg/v1", api_key: "cfgkey", codex: { models: ["m1"] } });
  const r = resolveUpstream({}, env);
  assert.equal(r.provider, "openai_compatible"); assert.equal(r.baseUrl, "http://cfg/v1"); assert.equal(r.apiKey, "cfgkey"); assert.equal(r.source, "config");
  assert.deepEqual(resolveUpstream({ provider: "codex" }, env).codexModels, ["m1"]);
  saveConfigFile({ provider: "codex" });
  assert.equal(resolveUpstream({}, env).provider, "codex");
});

test("codex credentials: reused from the Codex CLI auth file, refreshed before expiry, rotated tokens persisted and synced back", async () => {
  const auth = await mockAuth();
  writeCliAuth(token(30), "rt-cli");            // expires in 30s → within the 60s skew
  const a = new CodexAuth({ ...process.env, TH_CODEX_AUTH_BASE: auth.url }, { refreshSkewMs: 60_000 });
  const c0 = loadCredentials(process.env);
  assert.equal(c0?.source, "codex"); assert.equal(c0?.accountId, ACC);
  const c1 = await a.get();
  assert.equal(auth.calls.length, 1); assert.equal(auth.calls[0].grant_type, "refresh_token"); assert.equal(auth.calls[0].refresh_token, "rt-cli");
  assert.equal(c1.refreshToken, "rt-rotated"); assert.equal(accountIdFromToken(c1.accessToken), ACC);
  assert.ok(existsSync(authFilePath()), "own auth file written");
  assert.equal(JSON.parse(readFileSync(CLI_AUTH, "utf8")).tokens.refresh_token, "rt-rotated", "Codex CLI file synced");
  // second get: no refresh (fresh token), single object cached
  const c2 = await a.get(); assert.equal(auth.calls.length, 1); assert.equal(c2.accessToken, c1.accessToken);
  // own file now takes precedence over the CLI file
  assert.equal(loadCredentials(process.env)?.source, "file");
  // dead refresh token → clear error pointing at `th login`
  writeFileSync(authFilePath(), JSON.stringify({ credentials: { accessToken: token(-10), refreshToken: "rt-dead", accountId: ACC } }));
  const b = new CodexAuth({ ...process.env, TH_CODEX_AUTH_BASE: auth.url });
  await assert.rejects(() => b.get(), /refresh failed.*th login/);
  await auth.close();
});

test("codex login: PKCE authorize URL, local callback, code exchange, credentials saved", async () => {
  const auth = await mockAuth();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const a = new CodexAuth({ ...process.env, TH_CODEX_AUTH_BASE: auth.url, TH_CODEX_CALLBACK_PORT: String(port) });
  let authUrl = "";
  const creds = await a.login({
    onAuth: (url) => {
      authUrl = url;
      const u = new URL(url);
      // "browser": the IdP redirects to the local callback with the state and a code
      setTimeout(() => { fetch(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=${u.searchParams.get("state")}`).then((r) => r.text()).catch(() => {}); }, 20);
    },
    timeoutMs: 5000,
  });
  const u = new URL(authUrl);
  assert.equal(u.origin + u.pathname, auth.url + "/oauth/authorize");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("redirect_uri"), `http://localhost:${port}/auth/callback`);
  assert.ok(u.searchParams.get("client_id")?.startsWith("app_"));
  const ex = auth.calls.find((c) => c.grant_type === "authorization_code");
  assert.ok(ex, "code exchanged"); assert.equal(ex.code, "the-code"); assert.ok(ex.code_verifier.length >= 40);
  assert.equal(creds.refreshToken, "rt-login"); assert.equal(creds.accountId, ACC); assert.equal(creds.source, "file");
  assert.equal(JSON.parse(readFileSync(authFilePath(), "utf8")).credentials.refreshToken, "rt-login");
  // state mismatch on the callback is rejected (server answers 400, login keeps waiting → manual input wins)
  const b = new CodexAuth({ ...process.env, TH_CODEX_AUTH_BASE: auth.url, TH_CODEX_CALLBACK_PORT: String(port + 1) });
  const c2 = await b.login({
    onAuth: () => { fetch(`http://127.0.0.1:${port + 1}/auth/callback?code=bad&state=wrong`).then((r) => assert.equal(r.status, 400)).catch(() => {}); },
    manualInput: () => new Promise((r) => setTimeout(() => r(`http://localhost:${port + 1}/auth/callback?code=pasted-code`), 100)),
    timeoutMs: 5000,
  });
  assert.equal(c2.source, "file"); assert.equal(auth.calls.filter((c) => c.grant_type === "authorization_code").at(-1).code, "pasted-code");
  await auth.close();
});

test("codex transport: headers, stream/store forced, instructions hoisted, SSE aggregated for non-stream callers, 401 → refresh → retry", async () => {
  const auth = await mockAuth(); const codex = await mockCodex({ reject401Once: true });
  writeFileSync(authFilePath(), JSON.stringify({ credentials: { accessToken: token(3600, "cur"), refreshToken: "rt-cur", accountId: ACC } }));
  const a = new CodexAuth({ ...process.env, TH_CODEX_AUTH_BASE: auth.url });
  const t = new CodexTransport(a, codex.url, "token_harness_test");
  const body = { model: "gpt-5.6-sol", input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "be brief" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: false, store: true, metadata: { th_compact: "1" }, prompt_cache_key: "sess-9" };
  const r = await t.responses(body, { stream: false });
  assert.equal(r.status, 200);
  const j: any = await r.json();
  assert.equal(j.output[0].content[0].text, "hello from codex"); assert.equal(j.usage.input_tokens, 120);
  assert.equal(codex.requests.length, 2, "401 then retry");
  const h1 = codex.requests[0].headers, h2 = codex.requests[1].headers;
  assert.ok(h1.authorization.startsWith("Bearer ")); assert.equal(h1["chatgpt-account-id"], ACC); assert.equal(h1["openai-beta"], "responses=experimental"); assert.equal(h1.originator, "token_harness_test"); assert.equal(h1.session_id, "sess-9");
  assert.notEqual(h2.authorization, h1.authorization, "retried with the refreshed token");
  assert.equal(auth.calls.filter((c) => c.grant_type === "refresh_token").length, 1);
  const sent = codex.requests[1].body;
  assert.equal(sent.stream, true); assert.equal(sent.store, false); assert.equal(sent.instructions, "be brief"); assert.equal(sent.input.length, 1); assert.equal(sent.metadata, undefined);
  assert.deepEqual(sent.include, ["reasoning.encrypted_content"]);
  // streaming callers get the SSE untouched
  const r2 = await t.responses(body, { stream: true });
  assert.ok((r2.headers.get("content-type") ?? "").includes("text/event-stream"));
  const txt = await r2.text(); assert.ok(txt.includes("response.completed"));
  // aggregateSse surfaces failures
  const agg = await aggregateSse(new Response(`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "usage limit" } } })}\n\n`));
  assert.equal(agg.status, 502); assert.equal(agg.json.error.message, "usage limit");
  assert.equal(prepareCodexBody({ input: [] }).instructions.length > 0, true);
  await auth.close(); await codex.close();
});

test("th-proxy and the harness client go through the built-in codex upstream", async () => {
  const codex = await mockCodex();
  writeFileSync(authFilePath(), JSON.stringify({ credentials: { accessToken: token(3600, "cur"), refreshToken: "rt-cur", accountId: ACC } }));
  process.env.TH_CODEX_BASE_URL = codex.url;
  const { Proxy } = await import("../src/proxy/server.js");
  const p = new Proxy({ port: 0, recallMode: "substitute" });
  assert.equal(p.up.provider, "codex");
  const srv = createServer((req, res) => { const ch: Buffer[] = []; req.on("data", (c) => ch.push(c)); req.on("end", () => { const raw = Buffer.concat(ch).toString(); if (req.url?.endsWith("/responses")) p.handleResponses(req, res, raw); else p.passthrough(req, res, raw); }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
  // Codex Desktop style: POST {chatgpt_base_url}/codex/responses with its own auth header, streaming
  const s = await fetch(`http://127.0.0.1:${port}/codex/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer client-token", "chatgpt-account-id": "client-acct" }, body: JSON.stringify({ model: "gpt-5.6-sol", instructions: "x", input, stream: true, prompt_cache_key: "pk-1" }) });
  assert.ok((s.headers.get("content-type") ?? "").includes("text/event-stream"));
  assert.ok((await s.text()).includes("hello from codex"));
  const upReq = codex.requests.at(-1)!;
  assert.equal(upReq.headers["chatgpt-account-id"], ACC, "proxy uses its own credentials, not the client's");
  assert.ok(upReq.body.tools.some((t: any) => t.name === "recall"));
  // API-key style client, non-streaming: gets aggregated JSON
  const n = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", instructions: "x", input, stream: false }) });
  const j: any = await n.json(); assert.equal(j.output[0].content[0].text, "hello from codex");
  // /v1/models is synthesized for codex
  const models: any = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
  assert.ok(models.data.some((m: any) => m.id === "gpt-5.6-sol"));
  assert.equal(p.stats().responses, 2);
  // harness client
  const { clientFor } = await import("../src/harness/providers.js");
  const c = clientFor("gpt-5.6-sol", { ...process.env });
  let streamed = "";
  const resp = await c.respond({ model: "gpt-5.6-sol", instructions: "x", input, tools: [], onText: (t) => { streamed += t; } });
  assert.equal(resp.text, "hello from codex"); assert.equal(streamed, "hello from codex"); assert.equal(resp.usage.cached, 100);
  // openai_compatible via overrides still works (upstream = codex mock pretending to be /v1 is not valid; use env base url to a plain mock)
  const plain = await listen((req, res, raw) => { const b = JSON.parse(raw); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "plain:" + req.headers.authorization + ":" + b.stream }] }], usage: {} })); });
  const u = upstreamFor({}, { TH_OPENAI_BASE_URL: plain.url + "/v1", TH_OPENAI_API_KEY: "sk-test" });
  assert.equal(u.provider, "openai_compatible");
  const pr: any = await (await u.responses({ model: "m", input }, { stream: false })).json();
  assert.equal(pr.output[0].content[0].text, "plain:Bearer sk-test:false");
  delete process.env.TH_CODEX_BASE_URL;
  srv.closeAllConnections(); srv.close(); await codex.close(); await plain.close();
});
