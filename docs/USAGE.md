# Usage

A token-saving harness for coding agents, built from the analysis of 4,056 Codex sessions on two machines (fork copies counted once; `bench/session_report.py`)
(see [DESIGN.md](DESIGN.md)). Each layer is usable on its own:

There is one command, `mph`; every layer below is one of its subcommands (`mph help` lists them).

| layer | what it does | entry |
|---|---|---|
| **ctx-core** | pure, idempotent rewrite of a Responses API `input` array: output shaping that keeps failure fields, stubs for folded outputs (`recall(id)` to expand), poll-chain collapse, read dedupe, fixed-prefix diet, batch folding with hysteresis, cache-aware compaction judge | `src/core` |
| **ctx-proxy** | transparent `/v1/responses` proxy: rewrites every request with ctx-core, injects a `recall` tool, streams SSE through, logs a ledger row per response. Works with Codex Desktop / CLI pointed at it | `mph proxy` |
| **harness** | own agent loop for long conversations: an append-only transcript that keeps every user word, a turn gate (carry the last turn's work or rebuild), global long-term **memory** with recall, **skills** (SKILL.md) and CLI tools, blocking `run`/`wait` instead of polling, `delegate` to cheaper models, session **fork / merge / discard** | `mph` |
| **sidecar** | reads the ledger, reports cost / compaction net effect / cache behaviour / delegate pass rates, tunes knobs within bounds (hill-climb + Thompson sampling), refits the cache TTL and the step predictor; every change has provenance and a quality guard | `mph report`, `mph tune` |
| **metering** | the quota/billing headers Codex puts on every response, an aggregate price estimator that refuses to guess, and a controlled probe that measures what a model actually costs | `mph price`, `mph price-probe` |
| **strategies** | how a turn is organised: `react` (one agent, growing context) or `plan_verify` (strong planner writes acceptance commands, cheap workers in fresh contexts, independent verifier argues until the evidence holds); `mph compare` scores them on an external oracle | `mph run --strategy`, `mph compare` |
| **dashboard** | live view over the ledger: quota stretch, tokens never sent, per-session context curves, a feed of every fold as it happens. Read-only, SSE, no dependencies | `mph dash` |
| **vibe** | configuring the harness by talking to it: the agent loop with a prompt and tool set for reading and writing the harness's own knobs and config, and nothing else | `mph vibe`, `/vibe` |
| **upstream** | where requests go: the built-in **Codex reverse proxy** (ChatGPT OAuth login, token refresh, `chatgpt.com/backend-api/codex/responses`) or any OpenAI-compatible `/responses` endpoint with your own URL + key | `mph login`, `mph config` |

## Install

```bash
git clone https://github.com/mayunlei/my-poor-harness && cd my-poor-harness
npm install
npm test                                  # 82 tests: core, harness loop, multi-turn (transcript, memory, gate, skills), strategies, vibe, the single CLI, proxy, upstream, meter, price, sidecar, dashboard
```

## 0. Upstream: login and config

By default both `mph chat` and `mph proxy` talk to the ChatGPT Codex backend directly with your ChatGPT login (the same thing the Codex CLI does). No codex_api bridge, no API key.

```bash
npx tsx src/harness/cli.ts whoami     # which credentials would be used (an existing ~/.codex/auth.json is reused as-is)
npx tsx src/harness/cli.ts login      # browser PKCE login → ~/.mph/codex-auth.json (or paste the redirect URL)
npx tsx src/harness/cli.ts logout
npx tsx src/harness/cli.ts config     # show ~/.mph/config.json and the effective upstream
```

Credential order: `CODEX_ACCESS_TOKEN` env → `~/.mph/codex-auth.json` → `~/.codex/auth.json`. Tokens are refreshed before expiry; a refresh rotates the refresh token, so the new pair is written to codex-auth.json and synced back to `~/.codex/auth.json` when that is where it came from (the Codex CLI keeps working).

Own endpoint instead (any OpenAI-compatible `/responses` server, or api.openai.com):

```bash
npx tsx src/harness/cli.ts config provider=openai_compatible base_url=https://api.openai.com/v1 api_key=sk-...
# or per shell: MPH_OPENAI_BASE_URL=... MPH_OPENAI_API_KEY=...   (env overrides config.json; MPH_PROVIDER=codex forces the built-in proxy)
```

Resolution: CLI flags → env → `config.json` → default `codex`.

Endpoints that only speak **Chat Completions** (DashScope / Qwen, vLLM, Ollama, most gateways) work too: set `wire_api=chat` (or `MPH_OPENAI_WIRE_API=chat`, or `mph proxy --wire-api chat`). The upstream translates each Responses request to `/chat/completions` (tool calls, tool outputs, custom tools, folded stubs) and the reply back to Responses items, streaming included, so the harness and the proxy are unchanged. Without an explicit setting, a 404 on `/responses` switches that upstream to chat automatically. Encrypted reasoning cannot be sent back over chat and is dropped.

```bash
MPH_OPENAI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1 MPH_OPENAI_API_KEY=sk-... MPH_OPENAI_WIRE_API=chat \
  npx tsx src/harness/cli.ts run --model qwen3.7-plus --max-steps 40 --prompt-file task.txt
```

## 1. Proxy in front of Codex

```
Codex Desktop / CLI  →  mph proxy :8791  →  chatgpt.com/backend-api/codex/responses (your ChatGPT login)
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
#    OAuth token; mph proxy accepts any */responses path and forwards to codex_api's /v1/responses.
chatgpt_base_url = "http://127.0.0.1:8791"

# B) API-key style provider (uses the codex_api OAuth bridge behind the proxy)
[model_providers.mph]
name = "my-poor-harness"
base_url = "http://127.0.0.1:8791/v1"
wire_api = "responses"
model_provider = "mph"
```

Notes
- The proxy identifies a conversation by `prompt_cache_key` (Codex sets it) and persists the fold boundary per conversation under `~/.mph/proxy/sessions/`, so rewrites stay identical across requests (prefix-cache stable).
- `recall` modes: `substitute` (default; the client reports the unknown tool, the proxy swaps in the real artifact slice on the next request — streaming untouched), `loop` (proxy resolves recalls itself, buffered), `off`.
- Codex backend specifics handled by the built-in upstream: requests are always `stream: true, store: false`; non-streaming clients get the SSE aggregated into JSON; `response.completed` comes with an empty `output`, so items are rebuilt from `response.output_item.done`; the SSE has no content-type header; `x-codex-*` rate-limit headers are forwarded to the client; HTTP 429/5xx and network errors are retried with backoff, a 401 refreshes the token once.
- Model names are passed through unchanged (`gpt-5.6-sol` etc.). `/v1/models` lists `codex.models` from config.json.

## 2. The harness

```bash
mph chat --cwd ~/Program/sql                       # interactive; built-in Codex upstream by default (§0 for your own endpoint)
mph run --cwd . "fix the failing test in tests/test_x.py"
echo "what changed since yesterday?" | mph run - --resume-last --json   # scriptable: JSON events + a result line
mph map --task "analyze ticker {item} and write report_{item}.md" --items AAPL,MSFT,NVDA --parallel 3
```

`mph run` exit codes: 0 done · 2 step limit · 3 model error · 4 a user message was not verbatim in a request (should never happen).

### What the model sees each turn

Design: [MEMORY_DESIGN.md](MEMORY_DESIGN.md). Segments, most stable first so the prefix cache survives across turns:

| segment | content | changes |
|---|---|---|
| S1 instructions | fixed prompt, skill index, AGENTS.md / CLAUDE.md | almost never |
| S2 transcript | every earlier user message **verbatim**; recent answers verbatim, older ones as cards with `recall(id)` | append-only, re-cut once per epoch (`answer_verbatim_turns`) |
| S3 carried work | the previous turn's tool calls and outputs (folded) | only when the gate says *continue* |
| S4 briefing | workspace state, merged branches, memories, preloaded skills | every turn, small |
| S5 | the new message, verbatim | |
| S6 | this turn's tool steps, append-only, batch-folded over `turn_budget` | |

**User words are never lost.** Every message is written to `~/.mph/harness/transcripts/<session>.jsonl` before anything else runs; the user's own words stay verbatim in every later request of the session. Only large pasted blocks (code fences, logs, tracebacks over `paste_externalize_tokens`) become a stub with head/tail preview and `recall(id)`, and only after their epoch has passed. Each request is checked; a violation is logged as a `fidelity` ledger row and makes `mph run` exit 4.

**The gate** decides at the start of each turn. Rules first: a user command (`/continue`, `/new`, `--continue`, `--new`), nothing to carry, a cold cache (rebuild), a back-reference or the same files (continue), clear topic overlap or a clear new topic. Only the ambiguous zone, or more memory candidates than slots, calls the small model once (decision + memory rerank + skill pick). On timeout or bad output the rules decide; ambiguous means continue.

### Memory

Global (shared by every project), in `~/.mph/memory.db` (SQLite + FTS5, Chinese and English). Typed entries: goal, constraint, preference, decision, fact, attempt, open, procedure; each with links (files, artifacts, URLs) and, for the user's constraints and preferences, the user's exact sentence.

- Written three ways: rules turn explicit user instructions ("记住…", "不要…", "always…") into pinned constraints/preferences with the quote; the model calls `remember(...)`; the small model extracts up to 5 items at turn end, deduplicated against similar entries (new / update / supersede).
- Recalled in three layers: pinned entries always (`memory_l0_budget`), up to `memory_l1_max` one-line index entries picked for the message, at most two full entries; the model looks up the rest with `memory_search` / `memory_get`. A lookup of an entry that was not shown is logged as a recall miss.
- Code facts linked to a file are marked stale when the file changes.

```bash
mph config memory_recall=off        # stop injecting and searching memory (writes continue)
mph config memory_write=off         # stop recording
mph memory list | search <q> | get <id> | pin <id> | unpin <id> | forget <id> | export [file] | import <file> | gc
```

In `chat`: `/memory …` (same subcommands), `/skills`, `/continue`, `/new`.

### Skills and CLI tools

Skills are folders with a `SKILL.md` (`name`, `description` frontmatter; optional `requires: [gh, jq]`). Found in the project (`.agents/skills`, `.claude/skills`, `.codex/skills`, `.mph/skills`) and for the user (`~/.mph/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, plus `MPH_SKILLS_PATH`); project wins on a name clash. The index sits in the static prefix; `skill(name)` loads the body, which stays unfolded for the rest of the turn; the gate may preload one. External capabilities are CLIs the model runs with `run`, documented by skills, so adding one never changes the cached prefix.

```bash
mph skill list | show <name>
```

### Models

| tier | used for | default on ChatGPT OAuth | default on your own endpoint |
|---|---|---|---|
| main | the conversation | `gpt-5.6-sol` | `main_model` in config, else `MPH_MODEL` |
| mid | `delegate` workers, `map` items | `gpt-5.5` | the main model |
| small | gate, memory extraction, answer cards | `gpt-5.6-luna` | the main model |

ChatGPT accounts reject `gpt-5.4`, `gpt-5.4-mini` and the other `*-mini` models on the Codex backend (checked 2026-10-02), so the small model there is `gpt-5.6-luna`. Change any tier with `mph config main_model=… mid_model=… small_model=…` or per session with `/knobs small_model=…`. On DashScope, low-effort calls (all small-model work) run with Qwen thinking off.

### Tools

`read` (range, dedupe), `write_file`, `edit`, `multi_edit` (several replacements, all or nothing), `ls`, `grep` (ripgrep, grouped by file, capped), `run` (blocking; `background=true` + `wait` for long jobs), `recall`, `delegate`, `memory_search`, `memory_get`, `remember`, `skill`. No command approval or sandbox: commands run with your permissions.

Strategies (`plan_verify`) and `delegate` workers keep the single-task loop: fixed prompt, state digest, folded window, no transcript or memory.

#### Several calls per response, and what a command costs

One model response can carry many tool calls, and they all run — concurrently, at most
`tool_parallel` (default 8) in flight, results handed back in call order. Three reads in one
response cost one round trip, not three. Both prompts tell the model to do this; whether it
actually does is in `mph report`:

```
tool batching: 318 calls over 141 responses = 2.26 per round trip (widest 7)
```

The ledger carries `tool_calls` and `tool_kinds` per response, so that number comes out of your
own history. One call per response is not automatically bad: a model that merges three shell
commands into one `run` is doing better than one that returns three calls.

`run(cmd)` used to spawn `bash -lc`, which sources your profile **every time** — 682ms per
command on the machine this was measured on (conda's init block), against 2ms for `bash -c`. A
turn with thirty commands spent twenty seconds starting shells. The profile cannot simply be
dropped: it is what puts conda, nvm and pyenv on `PATH`, and `conda` is a shell *function*. So
`shell_login` (default `cached`) captures the login shell's environment and its function
definitions once per process, writes the functions to `~/.mph/shell-functions.sh`, and runs every
command with plain `bash -c`, that environment and `BASH_ENV` pointing at the functions —
`conda activate env && pytest` still works. `always` is the old behaviour, `never` skips the
profile entirely, and a failed capture falls back to `always` rather than to a broken `PATH`.

Waiting for a command is event-driven: a job wakes its waiter on output and on exit, with a 300ms
tick left only to re-check the silence and deadline conditions. It used to poll, so every command
— `echo hi` included — cost up to 300ms of waiting for the next poll. Measured on five
sequential commands: 4,527ms before, 18ms after.

### Saving sessions for backtesting

一句话：把亲身用过、值得复测的真实会话连同完整上下文存进数据集，以后改了 harness 拿同一批对话重放对比。

```bash
mph save --note "复现：长日志粘贴后过几轮再追问细节，模型找不到原文"            # the latest session in this directory
mph save s_1a2b3c4d --note "..." --dataset memory-regressions [--id paste-followup]
mph dataset                      # datasets and how many cases each has
mph dataset memory-regressions   # one line per case: id, turns, note
mph dataset show memory-regressions/paste-followup
```

In `chat`: `/save <一句话注释>` saves the current session to the `default` dataset.

The note is required: one sentence (up to 300 characters) saying what problem the session is about. Each case is a directory under `~/.mph/datasets/<dataset>/<id>/`:

| file | content |
|---|---|
| `case.json` | the note, models configured and actually used, knobs, git state at save time, and per turn: the user's words verbatim, the full answer and its card, files changed, steps and tokens, the gate decision, the git HEAD the turn started on |
| `transcript.jsonl` | the session's transcript |
| `turns/turn-<n>.json` | everything the model saw and did in that turn: the assembled context, every tool call and output |
| `ledger.jsonl` | the session's ledger rows |
| `memory.jsonl` | memories written during the session |
| `workspace.diff` | uncommitted changes at save time (`git diff HEAD`) |

`<dataset>/index.jsonl` lists the cases with their notes.

### Multi-turn golden set

```bash
MPH_OPENAI_BASE_URL=… MPH_OPENAI_API_KEY=… MPH_OPENAI_WIRE_API=chat \
  npx tsx bench/multiturn/run.ts --model qwen3.7-plus [--arms full,hybrid,hybrid-nomem] [--cases id,…] [--parallel 4]
```

15 scripted conversations (`bench/multiturn/cases.json`): references back, constraints that must hold later, preferences, topic switch and return, a detail from a long paste several turns later, a failed approach not to repeat, decisions and preferences across sessions, verbatim recall of the user's first sentence, following a skill. Checks run commands in the workspace, match the answer, or ask a judge (majority of 3). Arms: `full` (keep everything, no memory), `hybrid` (default), `hybrid-nomem`.

## 3. Vibe mode: configuring it by talking to it

```bash
mph vibe "换成我自己的 qwen 端点，小模型也用它"     # one request
mph vibe                                           # a session that starts in vibe mode
# inside a chat session:  /vibe        /vibe <sentence>        /vibe off
```

The same loop as a coding turn, with `VIBE_PROMPT` instead of `FIXED_PROMPT` and this tool set:

| tool | what it does |
|---|---|
| `settings_read` | sections `overview` (upstream, models, memory, skills, non-default knobs), `knobs` (every knob with default, range, where it is set; `filter` is a regex), `config` (config.json and the keys that may be written), `skills`, `usage` (the ledger report) |
| `settings_write` | knobs and/or config.json, scope `global` / `project` / `session`. All or nothing, and `why` is required |
| `upstream_probe` | which credentials and endpoint a request would really use; `check_endpoint=true` also does one free `GET /models` |
| `read`, `ls`, `grep` | read-only, for when the right setting depends on the project |

It has no `run`, no `write_file`, no `edit` and no `delegate`: vibe mode cannot change your
workspace or execute anything. The settings tools are in no other tool set either, so an
ordinary coding turn cannot reach them — they arrive only by being named in `toolNames`
(`ALL_TOOL_DEFS` in `src/harness/tools.ts`).

Writes are strict on purpose. The CLI's `clampKnob` silently falls back to the default on a bad
value, which for an agent would mean reporting a change that never happened; `validateKnobs`
rejects instead, with the range or the list of choices, and one bad value in a call writes
nothing at all. Every applied change is recorded with `who: "vibe"` and the user's own sentence
as `why`, so:

```bash
mph history                        # what the conversation changed, when, and why
mph knobs <name>=<old value>       # the undo
```

An API key is never requested in the conversation and never echoed back: the prompt tells the
agent to have you run `mph config api_key=...` in your own shell instead.

## 4. Sidecar

```bash
mph report            # cost, credits spent and left, cache, tool batching, compaction net effect, judge, pass rates
mph tune --dry-run    # what it would change and why
mph watch --every 900 # report + tune every 15 min
mph history           # every knob change with who/why/scope
```

Knobs live in `~/.mph/knobs.json` with layers `global → profile → project → session → turn`; all have bounds and steps (`src/core/knobs.ts`). Cache-breaking knobs (`main_model`, `effort_*`, `prefix_trim`, `reasoning_keep_last`) are only applied at fold events or turn boundaries.

### What the harness records, and why it matters

The sidecar, the dashboard and the tuner are only as honest as the ledger. Reviewing
`~/.mph` after real use showed a turn with 71 model calls and twenty `recall()`
expansions that `mph report` summarized as **"recalls 0"** — `recall_count`, the credits
meter and `task_outcome` were all written by the proxy and by nothing else. Three things
downstream were reading those fields:

| field | who reads it | what it did while unwritten |
|---|---|---|
| `recall_count` | `compactionEffects` prices a fold against the recalls it caused; the tuner rolls a trial back above 0.15 recalls/step and reverses its hill-climb above 0.1 | the penalty was always zero, so folds looked free and the tuner kept folding harder — a loop pointing the wrong way |
| `credits_balance` / `credits_spent` | the dashboard's money panel, `mph price` | no harness turn cost anything, which is now most of the real use |
| `task_outcome` | the tuner's quality guard | an empty window scored a perfect `1.0`, so every cost cut passed its own exam |

All three are written per response now, plus one `event: "turn"` row carrying the
outcome. A react turn has no acceptance command, so only hard failures (a model error,
the step limit, a user-words violation) are claimed as `fail`; everything else is
`unknown` rather than quietly counted as a win. The guard **fails closed**: a trial with
no pass/fail evidence in its window is rolled back, not kept.

A recall is also priced from measurement rather than a constant. The flat 2,000
cost-equivalent per recall was about half of what one really costs (a whole extra round
trip: ~20k cached + ~5k uncached + output on the session reviewed), so `mph report` now
shows the unit it used and where it came from:

```
compactions: 9, net 1,215,752 cost-equiv (median 100,318, 2 negative), each recall it caused priced at 4,210 (measured)
```

Two behavioural consequences of the same review:

- `recall_keep_last` (default 2) keeps the newest `recall()` outputs out of the next
  fold. Stubbing what the model just asked to see back is a fold → recall → fold loop,
  and each lap costs a model round trip.
- `mph sessions --prune` deletes sessions that never ran a turn, and a one-shot `mph run`
  no longer writes a session file before it has anything to put in it. 127 files had
  accumulated for about eleven real conversations.

Memory extraction got the same treatment: every item must now say, in `durable`, why it
will still matter in a different session next week, and items without a reason are
dropped and counted in the ledger's memory row. The five memories in the real store were
"the build succeeded", "the installed version is 0.5.0" and the like — all `use_count=0`,
none ever recalled. The prompt now names those as non-examples, and a title that contains
an existing one updates it instead of sitting beside it.

## 5. Replay benchmark (zero model cost)

```bash
npx tsx src/bench/replay.ts --limit 30 --min-bytes 200000            # largest sessions (use --max-requests 300 to bound very long ones)
npx tsx src/bench/replay.ts file1.jsonl file2.jsonl --profile long_task --knob.window=6 --json out.json
```

It rebuilds every request of a recorded Codex session, runs it through `rewrite()` with persistent state, simulates the prefix cache as the common item-prefix with the previous request (cold after `cache_ttl_estimate_s` idle), and reports raw tokens and cost-equivalent (cached ×0.1, output ×8). The estimator is calibrated against the measured `input_tokens` (ratio 0.99 on the 30-session sample).

## 6. Live dashboard

```bash
npx tsx src/dashboard/cli.ts                      # http://127.0.0.1:8792
npx tsx src/dashboard/cli.ts --open --weekly-budget 50M
npx tsx src/dashboard/cli.ts --once | jq .totals  # one JSON snapshot, then exit
```

| flag | meaning |
|---|---|
| `--port 8792` / `--host 127.0.0.1` | where to listen |
| `--ledger PATH` | a ledger other than `~/.mph/ledger.jsonl` (e.g. one copied off a server) |
| `--weekly-budget 50M` | draws the quota gauge; accepts `50000000`, `50M`, `1.5B`, or `MPH_WEEKLY_BUDGET` |
| `--poll-ms 1000` | how often to re-check the ledger (it also watches the directory) |
| `--open` | open a browser at the dashboard |
| `--once` | print a JSON snapshot and exit — for scripts, CI and regression checks |
| `--quiet` | no banner on stdout |

Endpoints: `/` (the page), `/api/snapshot` (JSON), `/api/stream` (SSE, one frame per change,
throttled, with a 10s heartbeat), `/healthz`.

What it shows
- **credits spent** — real money, when the upstream reports a credits meter: the summed
  balance drops, what is left, and credits per 1M input tokens. Per session and per strategy
  too, so you can see what a `plan_verify` run actually cost versus a `react` run. The meter
  is eventually consistent and the pool is shared across your devices, so **the totals are
  sound and a single row is not** — the page says so, in place.
- **quota stretch** — what the unmodified client would have paid divided by what was paid. The
  baseline prices the tokens the rewrite removed (`ctx_before − ctx_after`) at the uncached rate
  and leaves the rest of the row as billed, which is the conservative reading.
- **tokens not sent**, **cost-equivalent saved**, **cache hit**, **output tokens**, sessions and
  how many are active (a session is active if it wrote a ledger row in the last 120s).
- **context per step** — the two curves per session: what the client wanted to send vs what
  actually went out. The gap is the product.
- **sessions** — steps, would-send vs sent, ratio, cache share, folds, recalls, idle time. Click
  a row to chart it.
- **savings feed** — every `compact` / `shape` / `dedupe` / `poll_collapse` / `wait` / `recall` /
  `delegate` / `fork` / `merge` / `knob_change` event with the tokens it removed.
- **where the savings came from** — the same events as a ranked breakdown.

It only ever reads the ledger: run it next to the proxy, a chat session and `mph watch`
without interference. The tailer reads just the appended bytes, holds back half-written lines,
and re-reads from the start if the ledger is truncated or rotated.

## 7. Build and release

```bash
npm run build                    # tsc → dist/ (the mph* commands prefer dist/ when it exists)
npm run package                  # typecheck + test + build + tarballs into release/
SKIP_TESTS=1 npm run package     # when CI already ran them
npm run release -- --dry-run     # show the tag, artifacts and notes; change nothing
npm run release -- 0.2.0         # bump, tag, push, create the GitHub release, upload
```

`npm run package` produces `release/my-poor-harness-<v>.tgz` (npm-installable),
`release/my-poor-harness-<v>-standalone.tar.gz` (compiled `dist/` plus the installed runtime
dependency tree — plain `node`, no npm install, no network) and `release/SHA256SUMS.txt`. The
staged standalone tree is smoke-tested with plain node before being tarred.

`bin/_launch.js` runs `dist/` when present and falls back to `tsx` on `src/` otherwise, so the
same `bin/mph*` entry points work in a source checkout and in a release tarball.

CI: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (typecheck + test + build on Node
20/22/24), [`.github/workflows/release.yml`](../.github/workflows/release.yml) (on a `v*` tag:
verifies the tag matches `package.json`, packages, and attaches the artifacts to the release;
also runnable by hand with `workflow_dispatch` for an existing tag).

## 8. Strategies: how a turn is organised

ReAct — one agent, one growing context, think/act/observe until done — is the default
because it is what every client does, not because it is best. `src/harness/strategies`
makes it one option among several.

```bash
npx tsx src/harness/cli.ts strategies                      # what is available
npx tsx src/harness/cli.ts run --strategy plan_verify "make the failing test pass"
# in chat:  /strategy plan_verify
# or persist it:  npx tsx src/harness/cli.ts knobs strategy=plan_verify
```

### plan_verify

A strong model plans, cheap models execute in fresh contexts, and an independent agent
verifies:

```
planner (T4, reads the repo, no edit tools)
   └─ plan: steps, each with inputs, an ACCEPTANCE COMMAND, and what to check
        ├─ worker s1 (T3, fresh context: sees only its own step contract)
        │     ├─ acceptance command runs → non-zero? the worker is sent back with the output
        │     └─ verifier s1 (fresh context, no edit tools, never sees the worker's report)
        │           └─ objections? the worker is sent back with them (argue_rounds)
        │              still failing? the worker escalates to T4, then the step fails
        ├─ worker s2 … (independent steps run in parallel, plan_parallel)
        └─ a step that cannot pass triggers one bounded replan of the remainder
```

Two rules are structural, not stylistic:
- **Acceptance is a command, not an opinion.** A step is done when something exits 0.
  With `verify_requires_command=true` (default) a step with no command is reported
  unverified rather than passed.
- **The verifier never sees the worker's reasoning or self-report** — only the contract,
  the files that changed and the command output, and it runs the command itself. A
  verifier reading "I fixed it, all tests pass" is a rubber stamp that costs money and
  buys nothing. An unparseable verdict fails closed.

Knobs: `plan_max_steps` (how long the planner may look before planning), `plan_min_tasks` /
`plan_max_tasks`, `plan_parallel`, `worker_tier`, `verifier_tier`, `argue_rounds`,
`replan_limit`, `verify_requires_command`.

### Why it is cheaper, and when it is not

Per-turn rebuild fixes `C0`. Once `C0` is small, the `n²/2·(o+a)` term is what is left,
and splitting n steps across k verified steps divides it by k — each worker's context
carries n/k steps, not n:

```
ReAct        n·C0 + n²/2·(o+a)                  one context, pays the quadratic in full
plan_verify  n·C0_worker + n²/(2k)·(o+a)        plus a planner and k verifiers
```

`python3 bench/topology.py` prints the crossover from this machine's measured averages:

```
 steps n   k         ReAct   plan_verify   ratio  cheaper
      10   2       113,000       209,440    1.85  ReAct
      20   4       366,000       337,880    0.92  plan_verify
      29   6       713,400       466,320    0.65  plan_verify
     100   8     7,430,000     1,628,520    0.22  plan_verify
```

So: **below ~15-20 steps the planning and verification overhead is pure loss; above it
plan_verify wins, and the gap keeps widening.** The planner (~81K at n=29) and the
verifiers (~122K) are a fixed cost that does not shrink with the task.

These are estimates of token flow, not of whether the cheap worker actually succeeds —
which is the part that decides if the strategy is worth it at all. That is what `compare`
measures.

### Comparing strategies on real tasks

```bash
cat > tasks.jsonl <<'EOF'
{"name":"fix-parser","prompt":"make tests/test_parser.py pass","acceptance":"pytest -q tests/test_parser.py","cwd":"/path/to/repo"}
{"name":"add-flag","prompt":"add a --dry-run flag to cli.py and test it","acceptance":"pytest -q tests/test_cli.py","setup":"pip install -e ."}
EOF
npx tsx src/harness/cli.ts compare --tasks tasks.jsonl --strategies react,plan_verify --copy
```

The scoring rule is the point: a strategy is **never asked whether it succeeded**. The
task's own `acceptance` command is run afterwards and that exit code is the only verdict,
so plan_verify cannot score itself on the verifier it paid for. `--copy` gives every run
its own workspace copy, so run order cannot let one strategy inherit another's edits.

The report gives pass rate, model calls, cost-equivalent across *every* agent the strategy
ran (planner, workers, verifiers, argue rounds — overhead cannot hide), cost per pass, and
wall time. It also flags the dangerous case explicitly: a run that **claimed verified but
failed the oracle** — the verifier was fooled, which is worse than a plain failure.

Results are written to `~/.mph/compare-<ts>.json`, and every model call carries
`extra.strategy` in the ledger, so `mph report` and the dashboard break down by
strategy too.

## 9. Measuring the real price

Everything else in this repo optimises a cost model whose weights are a guess. `PRICE` in
`src/core/ledger.ts` is `0.1 / 1 / 8` — the public pay-as-you-go *shape* — and a subscription
is not billed that way. Worse, the cheapest model might be several times cheaper than the
default and nothing here would know. So: measure it.

### What the backend actually tells you

Every Codex response carries these headers, and `mph proxy` now records them per ledger row
(`credits_balance`, `credits_spent`, `primary_used_percent`, `secondary_used_percent`,
`plan_type`, `active_limit`, `effort`):

| header | what it is | useful for pricing? |
|---|---|---|
| `x-codex-{primary,secondary}-used-percent` | **integer** 0..100 of a window (5h / weekly) | **no** |
| `x-codex-credits-balance` | credit balance, 10 decimal places | yes, in aggregate |
| `x-codex-credits-has-credits` / `-unlimited` | whether credits are in play | precondition |
| `x-codex-plan-type`, `x-codex-active-limit` | `pro`, `premium`, … | segmentation |

Why the percentage is not usable, measured over 2,155 local sessions:

- it is an integer, so one observation is a 1% quantum of a window;
- fitting `%quota = a·cached + b·uncached + c·output` tick-to-tick gives a **negative R²**
  (−4.0 weekly, −2.7 on the 5h window) — worse than predicting the mean;
- the spread *within* one model/effort is as large as the spread *between* models
  (`gpt-5.4/xhigh`: IQR 0.02M–1.15M cost-equivalent per 1%), so price is not identified;
- **15% of ticks moved with zero local responses** — other devices spend the same quota, and
  that term is unobservable from here.

The credits balance is the only fine-grained meter, but it is **eventually consistent**:
consecutive responses often show a delta of 0 and then a lump (lag-0 correlation with
cost-equivalent 0.61, lag-1 0.08). Per-request attribution is impossible; only the sum over a
burst means anything, and even per session it varied 9× for one model because concurrent
sessions share the pool.

### Passive estimate, with refusals

```bash
npx tsx src/sidecar/cli.ts price [--since ISO] [--min-bursts 4] [--max-gap 120] [--json]
```

Groups ledger rows into bursts (cut by a model/effort change, a balance increase, or a gap over
`--max-gap` seconds) and estimates credits per 1M cost-equivalent per model. It **refuses**
rather than guessing: no meter headers, too few bursts, a model switch inside the balance lag
window, or any foreign session overlapping a burst. It also refuses to split cached / uncached /
output unless the token mix actually varies across bursts — on normal traffic every burst is
~95% cached, the three regressors are collinear, and any split would be fiction. A refusal
exits **1**, so a script cannot mistake it for a price.

### The controlled experiment

```bash
npx tsx src/sidecar/cli.ts price-probe --models gpt-5.6-sol,gpt-5.4-mini --n 8 --settle 20
npx tsx src/sidecar/cli.ts price-probe --models gpt-5.6-sol --n 8 --go      # spends real credits
```

Dry run unless `--go` (and `--dry-run` beats `--go`). The protocol is what makes the number
trustworthy:

1. **Quiet account.** Reading the meter is itself a request — the backend publishes it on
   response headers and nowhere else — so "sample with no traffic" is impossible. Instead two
   consecutive idle windows of `--settle` seconds run the same number of identical polls: they
   calibrate what one poll costs (subtracted from every phase), and if they disagree by more
   than 50% something else is spending and the probe aborts.
2. **Three shapes** to separate the weights: a long repeated prefix (cached), a unique long
   input every call (uncached), a tiny input with a long forced output (output).
3. **Burst, then wait for the balance to settle** before reading it. This is the step that
   defeats eventual consistency.
4. Solve the 3×3 per model with non-negative least squares, write `~/.mph/prices.json`
   with provenance: when, account, plan, n, settle, per-shape token counts and credits,
   residual, and the poll overhead that was subtracted.

Until that file exists, price-based model routing stays off — a router acting on invented
prices is worse than no router.

## Layout

```
src/core      items, tokens, artifacts, shapers, knobs, ledger, cache_state, judge, summary, rewrite
src/proxy     server (Responses proxy + recall), cli (`mph proxy`)
src/harness   providers (OpenAI Responses / Anthropic), tools + tools_extra, session (DAG, fork/merge), router, gate, assemble, loop, vibe (settings tools + prompt), cli (the one entry point)
src/transcript  append-only transcript, paste detection, epoch rendering, answer cards, user-words fidelity check
src/memory    store (node:sqlite + FTS5), recall (candidates, L0/L1/L2), write (rules, extraction, dedupe)
src/skills    discovery, frontmatter, index, project instructions
src/harness/strategies  react (baseline), plan_verify (planner / worker / independent verifier)
src/harness/compare.ts  strategy A/B scored by each task's own acceptance command
src/sidecar   metrics, tuner, price (aggregate estimator with refusals), commands (names only), cli
src/dashboard live (ledger fold + tailer), ui (the page), server (SSE + a portless snapshot), cli (`mph dash`)
src/upstream  meter (quota/billing headers), price_probe (the controlled experiment), config (provider resolution), codex_auth (OAuth PKCE login, refresh, credential files), codex (transport), chat (Responses ⇄ Chat Completions adapter), sse (collector), login_cli
bench/multiturn/       multi-turn golden set: cases.json + run.ts (arms full / hybrid / hybrid-nomem)
bench/swe_regress.py   R6 quality regression on SWE-bench Lite dev: arms off / on / tight, same model, judged with hidden tests
src/bench     replay
bench/        codex_session_stats.py (the analysis that produced DESIGN.md §2; counts fork copies twice)
bench/session_report.py  fork-aware token statistics over ~/.codex (CODEX_HOME to override): the README numbers
bench/topology.py      ReAct vs plan_verify token arithmetic and the crossover
test/         node:test suites with a mock Responses server
scripts/      package.sh (release artifacts), release.sh (tag + GitHub release)
.github/      ci and release workflows
```

Data lives under `~/.mph/` (`artifacts/`, `ledger.jsonl`, `knobs.json`, `config.json`, `codex-auth.json`, `memory.db`, `skills/`, `proxy/sessions/`, `harness/sessions/`, `harness/transcripts/`, `datasets/`, `jobs/`, `sidecar/`). Override with `MPH_HOME`.

Multi-agent Codex sessions: `agent_message` items (spawn_agent / send_message traffic, payload encrypted) are folded outside the window like tool outputs: a one-line stub with the message header; text payloads go to the artifact store and are recallable, encrypted payloads are dropped.
