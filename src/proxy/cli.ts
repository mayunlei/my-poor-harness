/**
 * `mph proxy` — the transparent /v1/responses proxy. One of the subcommands of the
 * single `mph` CLI; this module only exports, so importing it starts nothing.
 */
import { Proxy } from "./server.js";
import { mphEnv } from "../core/env.js";
import { resolveUpstream, describeUpstream, type Provider } from "../upstream/index.js";

export const PROXY_HELP = `mph proxy [--port 8791] [--provider codex|openai_compatible] [--upstream http://host/v1-origin] [--upstream-key KEY]
          [--wire-api responses|chat] [--upstream-path /v1/responses] [--recall substitute|loop|off] [--project PATH] [--verbose]

Keep your current client and send fewer tokens. Default upstream: ~/.mph/config.json,
else the built-in Codex (ChatGPT OAuth) reverse proxy -- log in with \`mph login\`, inspect
the resolved upstream with \`mph config\`.
Point Codex at it:  chatgpt_base_url = "http://127.0.0.1:8791"
                or  model_providers.<x>.base_url = "http://127.0.0.1:8791/v1"`;

export function proxyMain(args: string[]): void {
  const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  if (args.includes("--help") || args.includes("-h")) { console.log(PROXY_HELP); return; }
  if (args[0] === "status") { console.log(describeUpstream(resolveUpstream())); return; }
  new Proxy({
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
}
