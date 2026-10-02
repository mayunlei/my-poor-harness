import { Proxy } from "./server.js";
import { mphEnv } from "../core/env.js";
import { runLogin } from "../upstream/login_cli.js";
import { resolveUpstream, describeUpstream, type Provider } from "../upstream/index.js";
const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
if (args.includes("--help")) {
  console.log(`mph-proxy [--port 8791] [--provider codex|openai_compatible] [--upstream http://host/v1-origin] [--upstream-key KEY] [--wire-api responses|chat] [--upstream-path /v1/responses] [--recall substitute|loop|off] [--project PATH] [--verbose]
mph-proxy login        log in to ChatGPT (Codex OAuth) for the built-in upstream
mph-proxy status       show the resolved upstream
Default upstream: ~/.mph/config.json, else the built-in Codex (ChatGPT OAuth) reverse proxy.
Point Codex at it:  chatgpt_base_url = "http://127.0.0.1:8791"   or   model_providers.<x>.base_url = "http://127.0.0.1:8791/v1"`);
  process.exit(0);
}
if (args[0] === "login") { runLogin().then(() => process.exit(0), (e) => { console.error(e?.message ?? e); process.exit(1); }); }
else if (args[0] === "status") { console.log(describeUpstream(resolveUpstream())); }
else new Proxy({
  port: Number(opt("--port", mphEnv("PROXY_PORT") ?? "8791")),
  provider: opt("--provider", mphEnv("PROVIDER")) as Provider | undefined,
  wireApi: opt("--wire-api", mphEnv("OPENAI_WIRE_API")) as any,
  upstream: opt("--upstream", mphEnv("UPSTREAM")),
  upstreamKey: opt("--upstream-key", mphEnv("UPSTREAM_KEY")),
  recallMode: (opt("--recall", mphEnv("RECALL") ?? "substitute") as any),
  upstreamPath: opt("--upstream-path", mphEnv("UPSTREAM_PATH") ?? "/v1/responses"),
  project: opt("--project", mphEnv("PROJECT")),
  verbose: args.includes("--verbose") || mphEnv("VERBOSE") === "1",
}).listen();
