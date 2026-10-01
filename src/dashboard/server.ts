/**
 * Dashboard server: tails the ledger and pushes snapshots to the browser over
 * SSE. Read-only — it never writes to the ledger or the knobs, so running it
 * alongside the proxy / harness / sidecar is free of side effects.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { LedgerTail, LiveState, defaultLedgerPath, type LiveSnapshot } from "./live.js";
import { UI_HTML } from "./ui.js";

export interface DashboardOptions {
  port?: number;
  host?: string;
  ledger?: string;
  /** Minimum ms between pushes to a client. */
  throttleMs?: number;
  /** Fallback poll interval; also covers filesystems where watch() is unreliable. */
  pollMs?: number;
  /** Weekly token budget for the budget gauge (0 = hide it). */
  weeklyBudget?: number;
  verbose?: boolean;
}

export interface DashboardHandle {
  server: Server;
  port: number;
  url: string;
  state: LiveState;
  snapshot(): LiveSnapshot;
  close(): Promise<void>;
}

export async function startDashboard(opts: DashboardOptions = {}): Promise<DashboardHandle> {
  const ledgerPath = opts.ledger ?? defaultLedgerPath();
  const throttleMs = opts.throttleMs ?? 400;
  const pollMs = opts.pollMs ?? 1000;
  const state = new LiveState(ledgerPath);
  state.weeklyBudget = opts.weeklyBudget ?? 0;
  const tail = new LedgerTail(ledgerPath);

  // Backfill everything already on disk, then follow.
  let dirty = true;
  const pump = (): number => {
    let n = 0;
    for (const row of tail.read()) { state.ingest(row); n++; }
    if (n) dirty = true;
    return n;
  };
  pump();

  const clients = new Set<ServerResponse>();
  let lastPush = 0;
  const push = (force = false) => {
    if (!clients.size) return;
    const now = Date.now();
    if (!force && (!dirty || now - lastPush < throttleMs)) return;
    dirty = false; lastPush = now;
    const payload = `data: ${JSON.stringify(state.snapshot(now))}\n\n`;
    for (const res of clients) { try { res.write(payload); } catch { clients.delete(res); } }
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(UI_HTML);
    } else if (path === "/api/snapshot") {
      pump();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(state.snapshot()));
    } else if (path === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(`retry: 2000\n\n`);
      clients.add(res);
      pump();
      res.write(`data: ${JSON.stringify(state.snapshot())}\n\n`);
      req.on("close", () => clients.delete(res));
    } else if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ledger: ledgerPath, rows: state.rows, clients: clients.size }));
    } else {
      res.writeHead(404, { "content-type": "text/plain" }); res.end("not found\n");
    }
  });

  // fs.watch on the directory (the file may not exist yet); poll as the safety net.
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(ledgerPath), { persistent: false }, () => { if (pump()) push(); });
  } catch { /* fall back to polling only */ }
  const timer = setInterval(() => { pump(); push(); }, pollMs);
  // Keep SSE connections alive through proxies, and refresh idle counters.
  const beat = setInterval(() => push(true), 10_000);
  timer.unref?.(); beat.unref?.();

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8792, opts.host ?? "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : (opts.port ?? 8792));
    });
  });

  const url = `http://${opts.host ?? "127.0.0.1"}:${port}`;
  if (opts.verbose) console.error(`[dash] ${url} → ${ledgerPath} (${state.rows} rows)`);

  return {
    server, port, url, state,
    snapshot: () => { pump(); return state.snapshot(); },
    close: () => new Promise<void>((resolve) => {
      clearInterval(timer); clearInterval(beat); watcher?.close();
      for (const res of clients) { try { res.end(); } catch { /* already gone */ } }
      clients.clear();
      server.close(() => resolve());
    }),
  };
}
