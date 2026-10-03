/**
 * Mock Responses API server for end-to-end tests. Scripted: each request's
 * reply is chosen by a handler that sees the request body.
 */
import { createServer, type Server } from "node:http";

export type Script = (body: any, n: number) => { output: any[]; usage?: any; headers?: Record<string, string> } | { status: number; body: string };

export function startMock(script: Script): Promise<{ server: Server; url: string; requests: any[]; close: () => Promise<void> }> {
  const requests: any[] = []; let n = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); requests.push(body);
      const r = script(body, n++);
      if ("status" in r) { res.writeHead(r.status, { "content-type": "application/json" }); res.end(r.body); return; }
      const inputTok = JSON.stringify(body.input ?? []).length / 4;
      const usage = r.usage ?? { input_tokens: Math.round(inputTok), input_tokens_details: { cached_tokens: Math.round(inputTok * 0.8) }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 10 } };
      const response = { id: "resp_" + n, object: "response", output: r.output, usage };
      // a reply may carry quota/billing headers, the way the Codex backend does
      const extra = r.headers ?? {};
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", ...extra });
        for (const o of r.output) if (o.type === "message") for (const c of o.content) res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: c.text })}\n\n`);
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`); res.end();
      } else { res.writeHead(200, { "content-type": "application/json", ...extra }); res.end(JSON.stringify(response)); }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { const a = server.address() as any; resolve({ server, url: `http://127.0.0.1:${a.port}`, requests, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) }); }));
}

export const msg = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
export const call = (name: string, args: any, id = "call_" + Math.random().toString(36).slice(2, 8)) => ({ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) });
