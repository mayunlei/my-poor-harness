/**
 * The quota/credits meter: parsing the x-codex-* response headers, the delta arithmetic, that
 * the Codex transport does not lose the headers when it aggregates SSE into JSON, and that the
 * proxy records the meter on the ledger row for the response it belongs to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "mph-meter-"));
process.env.MPH_HOME = HOME;
process.env.MPH_CODEX_CLI_AUTH = join(HOME, "no-cli-auth.json");
delete process.env.MPH_OPENAI_BASE_URL; delete process.env.OPENAI_BASE_URL; delete process.env.MPH_PROVIDER; delete process.env.CODEX_ACCESS_TOKEN;

const { parseMeter, meterDelta, meterHeaders, METER_HEADERS } = await import("../src/upstream/meter.js");
const { CodexAuth, authFilePath } = await import("../src/upstream/codex_auth.js");
const { CodexTransport } = await import("../src/upstream/codex.js");

const ACC = "acct-meter-1";
function jwt(payload: any): string {
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}
const token = () => jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: ACC, chatgpt_plan_type: "pro" } });

function listen(handler: (req: any, res: any, body: string) => void): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => { const ch: Buffer[] = []; req.on("data", (c) => ch.push(c)); req.on("end", () => handler(req, res, Buffer.concat(ch).toString())); });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, server, close: () => new Promise((d) => { server.closeAllConnections(); server.close(() => d()); }) })));
}

/** the header set a real Codex response carries, verbatim shapes from recorded sessions */
const REAL: Record<string, string> = {
  "x-codex-plan-type": "pro",
  "x-codex-active-limit": "premium",
  "x-codex-primary-used-percent": "37",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": "1790000000",
  "x-codex-primary-reset-after-seconds": "7200",
  "x-codex-secondary-used-percent": "12",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": "1790500000",
  "x-codex-secondary-reset-after-seconds": "400000",
  "x-codex-primary-over-secondary-limit-percent": "3",
  "x-codex-credits-balance": "55969.6180495000",
  "x-codex-credits-has-credits": "True",
  "x-codex-credits-unlimited": "False",
};

test("parseMeter: a real header set, a partial one, garbage, and none at all", () => {
  const m = parseMeter(REAL, Date.parse("2026-10-02T00:00:00Z"))!;
  assert.ok(m, "a real header set parses");
  assert.equal(m.at, "2026-10-02T00:00:00.000Z");
  assert.equal(m.planType, "pro"); assert.equal(m.activeLimit, "premium");
  assert.equal(m.primary?.usedPercent, 37); assert.equal(m.primary?.windowMinutes, 300);
  assert.equal(m.primary?.resetsAt, 1790000000000, "epoch seconds scaled to ms");
  assert.equal(m.secondary?.usedPercent, 12); assert.equal(m.secondary?.windowMinutes, 10080);
  assert.equal(m.primaryOverSecondaryPercent, 3);
  assert.equal(m.credits?.balance, 55969.618049_5);
  assert.equal(m.credits?.hasCredits, true); assert.equal(m.credits?.unlimited, false);
  // a Headers object and a node-style record with array values are both accepted, case-insensitively
  const viaHeaders = parseMeter(new Headers(REAL))!;
  assert.equal(viaHeaders.credits?.balance, m.credits?.balance);
  assert.equal(parseMeter({ "X-Codex-Credits-Balance": ["12.5"], "x-codex-credits-has-credits": "true" })!.credits?.balance, 12.5);

  // partial: only the primary window, no credits (the shape of a non-credits account)
  const p = parseMeter({ "x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "60", "x-codex-plan-type": "plus" }, 1_000_000)!;
  assert.equal(p.primary?.usedPercent, 100); assert.equal(p.primary?.windowMinutes, undefined);
  assert.equal(p.primary?.resetsAt, 1_060_000, "reset-after-seconds used when reset-at is absent");
  assert.equal(p.secondary, undefined); assert.equal(p.credits, undefined); assert.equal(p.planType, "plus");

  // garbage: present but unparseable → a snapshot with undefined fields, never a throw
  const g = parseMeter({ "x-codex-primary-used-percent": "banana", "x-codex-credits-balance": "", "x-codex-credits-has-credits": "maybe", "x-codex-plan-type": "   " })!;
  assert.ok(g, "present-but-garbage still means the backend answered");
  assert.equal(g.primary, undefined); assert.equal(g.credits, undefined); assert.equal(g.planType, undefined);
  // ISO reset-at is accepted too; a nonsense one is simply dropped
  assert.equal(parseMeter({ "x-codex-primary-used-percent": "1", "x-codex-primary-reset-at": "2026-10-02T12:00:00Z" })!.primary?.resetsAt, Date.parse("2026-10-02T12:00:00Z"));
  assert.equal(parseMeter({ "x-codex-primary-used-percent": "1", "x-codex-primary-reset-at": "soon" })!.primary?.resetsAt, undefined);

  // none: no x-codex meter header at all
  assert.equal(parseMeter({}), undefined);
  assert.equal(parseMeter({ "content-type": "application/json", "x-request-id": "abc", "x-codex-something-else": "1" }), undefined);
  assert.equal(parseMeter(new Headers({ "content-type": "text/event-stream" })), undefined);
  assert.equal(METER_HEADERS.length, 14);

  // "True" / "true" / "1" / "yes" are all truthy; anything else is false
  for (const v of ["True", "true", "1", "yes"]) assert.equal(parseMeter({ "x-codex-credits-balance": "1", "x-codex-credits-unlimited": v })!.credits?.unlimited, true, v);
  for (const v of ["False", "false", "0", "", "no", "garbage"]) assert.equal(parseMeter({ "x-codex-credits-balance": "1", "x-codex-credits-unlimited": v })!.credits?.unlimited, false, v);
});

test("meterDelta: credits spent is clamped, percentages are signed, missing fields stay undefined", () => {
  const a = parseMeter({ ...REAL, "x-codex-credits-balance": "100.5", "x-codex-primary-used-percent": "10", "x-codex-secondary-used-percent": "5" })!;
  const b = parseMeter({ ...REAL, "x-codex-credits-balance": "100.25", "x-codex-primary-used-percent": "13", "x-codex-secondary-used-percent": "5" })!;
  const d = meterDelta(a, b);
  assert.ok(Math.abs(d.creditsSpent! - 0.25) < 1e-9);
  assert.equal(d.primaryPercent, 3); assert.equal(d.secondaryPercent, 0);
  // a top-up (balance went up) is not negative spend
  assert.equal(meterDelta(b, a).creditsSpent, 0);
  // a window reset shows as a negative percentage, which is information, not an error
  assert.equal(meterDelta(b, parseMeter({ ...REAL, "x-codex-primary-used-percent": "1" })!).primaryPercent, -12);
  // missing on either side → undefined, never guessed as 0
  const noCredits = parseMeter({ "x-codex-primary-used-percent": "10" })!;
  assert.equal(meterDelta(a, noCredits).creditsSpent, undefined);
  assert.equal(meterDelta(noCredits, a).creditsSpent, undefined);
  assert.equal(meterDelta(noCredits, noCredits).secondaryPercent, undefined);
  assert.deepEqual(meterDelta(parseMeter({ "x-codex-plan-type": "pro" })!, a), {});
});

test("meterHeaders / codex transport: the meter survives SSE aggregation into a JSON response", async () => {
  const codex = await listen((req, res) => {
    if (req.url !== "/codex/responses") { res.writeHead(404).end(); return; }
    const resp = { id: "resp_m", object: "response", output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 90 }, output_tokens: 7 } };
    res.writeHead(200, { ...REAL, "x-oai-request-id": "req-1", "x-other": "dropped" });   // the real backend omits content-type on SSE
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: resp })}\n\n`);
    res.end();
  });
  writeFileSync(authFilePath(), JSON.stringify({ credentials: { accessToken: token(), refreshToken: "rt", accountId: ACC } }));
  const t = new CodexTransport(new CodexAuth({ ...process.env }), codex.url, "token_harness_test");
  const body = { model: "gpt-5.6-sol", instructions: "x", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] };

  // streaming caller: the upstream Response is handed through, headers intact
  const streamed = await t.responses(body, { stream: true });
  assert.equal(parseMeter(streamed.headers)!.credits!.balance, 55969.618_049_5);
  await streamed.text();
  assert.equal(t.lastMeter?.planType, "pro");

  // non-streaming caller: we synthesize the JSON Response, and must not drop the only billing signal
  const agg = await t.responses(body, { stream: false });
  assert.equal(agg.headers.get("content-type"), "application/json");
  const m = parseMeter(agg.headers)!;
  assert.equal(m.credits!.balance, 55969.618_049_5);
  assert.equal(m.primary!.usedPercent, 37);
  assert.equal(agg.headers.get("x-oai-request-id"), "req-1");
  assert.equal(agg.headers.get("x-other"), null, "only x-codex-* and the request id are carried");
  assert.equal(((await agg.json()) as any).usage.input_tokens, 100);
  // meterHeaders lowercases and filters
  const only = meterHeaders(new Headers({ "X-Codex-Plan-Type": "pro", "Content-Type": "x" }));
  assert.deepEqual(only, { "x-codex-plan-type": "pro" });
  await codex.close();
});

test("mph-proxy writes the meter onto the ledger row, and credits_spent is the drop since the previous response", async () => {
  let balance = 1000;
  const codex = await listen((req, res) => {
    balance -= 1.5;
    const resp = { id: "resp_p", object: "response", output: [], usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 150 }, output_tokens: 10 } };
    res.writeHead(200, { ...REAL, "x-codex-credits-balance": balance.toFixed(10) });
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: resp })}\n\n`);
    res.end();
  });
  writeFileSync(authFilePath(), JSON.stringify({ credentials: { accessToken: token(), refreshToken: "rt", accountId: ACC } }));
  process.env.MPH_CODEX_BASE_URL = codex.url;
  const ledgerPath = join(HOME, "proxy-meter.jsonl");
  const { Proxy } = await import("../src/proxy/server.js");
  const p = new Proxy({ port: 0, recallMode: "off" });
  (p as any).ledger = new (await import("../src/core/ledger.js")).Ledger(ledgerPath);
  const srv = createServer((req, res) => { const ch: Buffer[] = []; req.on("data", (c) => ch.push(c)); req.on("end", () => p.handleResponses(req, res, Buffer.concat(ch).toString())); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const post = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", instructions: "x", reasoning: { effort: "high" }, prompt_cache_key: "pk-meter", stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }) });
    await r.text();
    return r;
  };
  const first = await post();
  assert.equal(parseMeter(first.headers)!.credits!.balance, 998.5, "the proxy forwards the meter to its client too");
  await post();

  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].plan_type, "pro"); assert.equal(rows[0].active_limit, "premium");
  assert.equal(rows[0].primary_used_percent, 37); assert.equal(rows[0].secondary_used_percent, 12);
  assert.equal(rows[0].effort, "high");
  assert.equal(rows[0].credits_balance, 998.5);
  assert.equal(rows[0].credits_spent, undefined, "nothing to diff against on the first response of a session");
  assert.equal(rows[1].credits_balance, 997);
  assert.ok(Math.abs(rows[1].credits_spent - 1.5) < 1e-9);
  srv.closeAllConnections(); srv.close(); await codex.close();
  delete process.env.MPH_CODEX_BASE_URL;
});
