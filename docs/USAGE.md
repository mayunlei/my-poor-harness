# Usage

A token-saving harness for coding agents, built from the analysis of 2,128 local Codex sessions
(see [DESIGN.md](DESIGN.md)). Three layers, usable independently:

| layer | what it does | entry |
|---|---|---|
| **ctx-core** | pure, idempotent rewrite of a Responses API `input` array: output shaping that keeps failure fields, stubs for folded outputs (`recall(id)` to expand), poll-chain collapse, read dedupe, fixed-prefix diet, batch folding with hysteresis, cache-aware compaction judge | `src/core` |
| **ctx-proxy** | transparent `/v1/responses` proxy: rewrites every request with ctx-core, injects a `recall` tool, streams SSE through, logs a ledger row per response. Works with Codex Desktop / CLI pointed at it | `th-proxy` |
| **harness** | own agent loop: per-turn rebuild (fixed prompt + state digest + folded window), blocking `run`/`wait` instead of polling, read cache, `delegate` to cheaper models with escalation, session **fork / merge / discard**, map-reduce with fresh contexts | `th` |
| **sidecar** | reads the ledger, reports cost / compaction net effect / cache behaviour / delegate pass rates, tunes knobs within bounds (hill-climb + Thompson sampling), refits the cache TTL and the step predictor; every change has provenance and a quality guard | `th-sidecar` |
| **upstream** | where requests go: the built-in **Codex reverse proxy** (ChatGPT OAuth login, token refresh, `chatgpt.com/backend-api/codex/responses`) or any OpenAI-compatible `/responses` endpoint with your own URL + key | `th login`, `th config` |

## Install

```bash
git clone https://github.com/mayunlei/my-poor-harness && cd my-poor-harness
npm install
npm test                                  # 28 tests: core, harness loop (mock model), proxy, upstream (OAuth/transport, chat adapter), sidecar
```

## 0. Upstream: login and config

By default both `th` and `th-proxy` talk to the ChatGPT Codex backend directly with your ChatGPT login (the same thing the Codex CLI does). No codex_api bridge, no API key.

```bash
npx tsx src/harness/cli.ts whoami     # which credentials would be used (an existing ~/.codex/auth.json is reused as-is)
npx tsx src/harness/cli.ts login      # browser PKCE login → ~/.token_harness/codex-auth.json (or paste the redirect URL)
npx tsx src/harness/cli.ts logout
npx tsx src/harness/cli.ts config     # show ~/.token_harness/config.json and the effective upstream
```

Credential order: `CODEX_ACCESS_TOKEN` env → `~/.token_harness/codex-auth.json` → `~/.codex/auth.json`. Tokens are refreshed before expiry; a refresh rotates the refresh token, so the new pair is written to codex-auth.json and synced back to `~/.codex/auth.json` when that is where it came from (the Codex CLI keeps working).

Own endpoint instead (any OpenAI-compatible `/responses` server, or api.openai.com):

```bash
npx tsx src/harness/cli.ts config provider=openai_compatible base_url=https://api.openai.com/v1 api_key=sk-...
# or per shell: TH_OPENAI_BASE_URL=... TH_OPENAI_API_KEY=...   (env overrides config.json; TH_PROVIDER=codex forces the built-in proxy)
```

Resolution: CLI flags → env → `config.json` → default `codex`.

Endpoints that only speak **Chat Completions** (DashScope / Qwen, vLLM, Ollama, most gateways) work too: set `wire_api=chat` (or `TH_OPENAI_WIRE_API=chat`, or `th-proxy --wire-api chat`). The upstream translates each Responses request to `/chat/completions` (tool calls, tool outputs, custom tools, folded stubs) and the reply back to Responses items, streaming included, so the harness and th-proxy are unchanged. Without an explicit setting, a 404 on `/responses` switches that upstream to chat automatically. Encrypted reasoning cannot be sent back over chat and is dropped.

```bash
TH_OPENAI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1 TH_OPENAI_API_KEY=sk-... TH_OPENAI_WIRE_API=chat \
  npx tsx src/harness/cli.ts run --model qwen3.7-plus --max-steps 40 --prompt-file task.txt
```

## 1. Proxy in front of Codex

```
Codex Desktop / CLI  →  th-proxy :8791  →  chatgpt.com/backend-api/codex/responses (your ChatGPT login)
                                        └→  or any OpenAI-compatible /responses endpoint (--upstream / config.json)
```

```bash
npx tsx src/proxy/cli.ts --port 8791 --verbose          # built-in Codex upstream (default)
npx tsx src/proxy/cli.ts --upstream http://127.0.0.1:8790 --upstream-path /v1/responses   # e.g. the old codex_api bridge
npx tsx src/proxy/cli.ts status | login
curl -s localhost:8791/health; curl -s localhost:8791/stats; curl -s localhost:8791/v1/models
```

Point Codex at it. Two options in `~/.codex/config.toml`:

```toml
# A) ChatGPT-login Codex (Desktop / CLI): Codex posts to {chatgpt_base_url}/codex/responses with its own
#    OAuth token; th-proxy accepts any */responses path and forwards to codex_api's /v1/responses.
chatgpt_base_url = "http://127.0.0.1:8791"

# B) API-key style provider (uses the codex_api OAuth bridge behind the proxy)
[model_providers.th]
name = "token-harness"
base_url = "http://127.0.0.1:8791/v1"
wire_api = "responses"
model_provider = "th"
```

Notes
- The proxy identifies a conversation by `prompt_cache_key` (Codex sets it) and persists the fold boundary per conversation under `~/.token_harness/proxy/sessions/`, so rewrites stay identical across requests (prefix-cache stable).
- `recall` modes: `substitute` (default; the client reports the unknown tool, the proxy swaps in the real artifact slice on the next request — streaming untouched), `loop` (proxy resolves recalls itself, buffered), `off`.
- Codex backend specifics handled by the built-in upstream: requests are always `stream: true, store: false`; non-streaming clients get the SSE aggregated into JSON; `response.completed` comes with an empty `output`, so items are rebuilt from `response.output_item.done`; the SSE has no content-type header; `x-codex-*` rate-limit headers are forwarded to the client; HTTP 429/5xx and network errors are retried with backoff, a 401 refreshes the token once.
- Model names are passed through unchanged (`gpt-5.6-sol` etc.). `/v1/models` lists `codex.models` from config.json.

## 2. The harness

```bash
npx tsx src/harness/cli.ts chat --cwd ~/Program/sql --model gpt-5.6-sol     # built-in Codex upstream by default; see §0 for your own endpoint
```

Inside `chat`: `/fork <name>` (branch for a side question), `/merge <branch>` (bring the branch's state delta back as a merged block), `/discard`, `/switch`, `/sessions`, `/knobs k=v`, `/profile long_task|qa_only|batch`, `/compact`, `/stats`.

One-shot and batch:

```bash
npx tsx src/harness/cli.ts run --cwd . "fix the failing test in tests/test_x.py"
npx tsx src/harness/cli.ts map --task "analyze ticker {item} and write report_{item}.md" --items AAPL,MSFT,NVDA --parallel 3
```

What the model sees each turn: a ~450-token fixed prompt, the state digest (files touched, last test status, errors seen, notes from `state_update`, merged blocks), the last `window` observations of the previous turn as stubs, and the new message. Inside a turn the history is append-only; ctx-core folds in batches when the variable part exceeds `turn_budget`.

Tools: `run` (blocking, timeout; `background=true` returns a job), `wait(job, until|silence_s|max_s)` (waits inside the harness; the model is never woken by empty polls), `read` (range, dedupe), `edit`, `write_file`, `recall`, `delegate(task, inputs, acceptance)` (T3 worker in a fresh context on `mid_model`, escalates to `main_model` if the acceptance command fails), `state_update`.

Model tiers (`src/harness/router.ts`): T0 deterministic (shapers, dedupe), T1/T2 `small_model` (judge calibration, optional turn summary with `use_model_summary=true`), T3 `mid_model` (delegated subtasks, map items), T4 `main_model` (main loop). Routing only happens at task boundaries so the main loop keeps one model and its prefix cache.

Anthropic models work too (`--model claude-...` with `ANTHROPIC_API_KEY`); the adapter maps items to Messages API blocks.

## 3. Sidecar

```bash
npx tsx src/sidecar/cli.ts report            # cost, cache, compaction net effect, judge, delegate pass rates
npx tsx src/sidecar/cli.ts tune --dry-run    # what it would change and why
npx tsx src/sidecar/cli.ts watch --every 900 # report + tune every 15 min
npx tsx src/sidecar/cli.ts history           # every knob change with who/why/scope
```

Knobs live in `~/.token_harness/knobs.json` with layers `global → profile → project → session → turn`; all have bounds and steps (`src/core/knobs.ts`). Cache-breaking knobs (`main_model`, `effort_*`, `prefix_trim`, `reasoning_keep_last`) are only applied at fold events or turn boundaries.

## 4. Replay benchmark (zero model cost)

```bash
npx tsx src/bench/replay.ts --limit 30 --min-bytes 200000            # largest sessions (use --max-requests 300 to bound very long ones)
npx tsx src/bench/replay.ts file1.jsonl file2.jsonl --profile long_task --knob.window=6 --json out.json
```

It rebuilds every request of a recorded Codex session, runs it through `rewrite()` with persistent state, simulates the prefix cache as the common item-prefix with the previous request (cold after `cache_ttl_estimate_s` idle), and reports raw tokens and cost-equivalent (cached ×0.1, output ×8). The estimator is calibrated against the measured `input_tokens` (ratio 0.99 on the 30-session sample).

## Layout

```
src/core      items, tokens, artifacts, shapers, knobs, ledger, cache_state, judge, summary, rewrite
src/proxy     server (Responses proxy + recall), cli
src/harness   providers (OpenAI Responses / Anthropic), tools, session (DAG, fork/merge), router, loop, cli
src/sidecar   metrics, tuner, cli
src/upstream  config (provider resolution), codex_auth (OAuth PKCE login, refresh, credential files), codex (transport), chat (Responses ⇄ Chat Completions adapter), sse (collector), login_cli
bench/swe_regress.py   R6 quality regression on SWE-bench Lite dev: compression off vs on, same model, judged with hidden tests
src/bench     replay
bench/        codex_session_stats.py (the analysis that produced DESIGN.md §2)
test/         node:test suites with a mock Responses server
```

Data lives under `~/.token_harness/` (`artifacts/`, `ledger.jsonl`, `knobs.json`, `config.json`, `codex-auth.json`, `proxy/sessions/`, `harness/sessions/`, `sidecar/`). Override with `TOKEN_HARNESS_HOME`.

Multi-agent Codex sessions: `agent_message` items (spawn_agent / send_message traffic, payload encrypted) are folded outside the window like tool outputs: a one-line stub with the message header; text payloads go to the artifact store and are recallable, encrypted payloads are dropped.
