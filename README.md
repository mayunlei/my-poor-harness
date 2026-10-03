# my-poor-harness

> **I am poor, so I invented this harness to squeeze every last drop out of every single token.**

A token-saving harness for coding agents. Put it in front of a Codex / OpenAI-compatible
`/responses` endpoint, or let it run the agent loop itself, and the same task costs roughly an
order of magnitude fewer input tokens — with a live dashboard that shows you the savings as
they happen.

## The week my quota got cut in half

I did not write this because token efficiency is an interesting engineering problem. I wrote it
because the subscription I was living on got quietly worth half as much. Same price, same
model, half the work per week. The quota that used to last me until Sunday started running dry
on Wednesday afternoon — mid-task, mid-debug, with the agent one tool call away from the fix.

You know the feeling. You stop asking the agent the follow-up question you wanted to ask. You
stop letting it explore. You start rationing: *is this question worth 2% of my week?* An agent
you're afraid to use is not an agent, it's an expensive chat window.

So before buying a bigger plan I did the obvious thing: I went and looked at where the tokens
actually went. Every Codex session on my two machines — **4,056 sessions**, 2026-03 to 2026-10.
The answer was not subtle:

| | laptop | second machine | **both** |
|---|---|---|---|
| sessions | 2,268 | 1,788 | **4,056** |
| input tokens | 10.5B | 14.9B | **25.4B** |
| output tokens (of which reasoning) | 51M (18M) | 55M (17M) | **106M (35M)** |
| input : output | 204 : 1 | 271 : 1 | **239 : 1** |
| cache hit rate | 94.6% | 95.7% | **95.2%** — and the limit still ran out |
| first request of a brand-new session (median) | 23K | 25K | |
| steps per turn (mean / p50 / p90) | 21 / 9 / 42 | 21 / 8 / 47 | |
| context already there when a turn starts (mean) | 81K | 100K | |
| growth per step (mean) | 1.8K | 2.1K | |
| input per turn (mean) | 2.5M | 2.5M | |
| share of input spent in turns of 50+ steps | 52% | 57% | |

Counted once: a forked session begins by copying its parent's whole history — token records
included — and counting that copy again inflates everything by about half (16.5B instead of
10.5B on the laptop). `bench/session_report.py` skips the copied block; the laptop column is its
output (`python3 bench/session_report.py`, `CODEX_HOME` for another directory), the second
machine's numbers come from the same method run there.

And on the second machine, the steps that never needed a model at all:

| | |
|---|---|
| background-process polls that came back empty | 29% |
| reads of a file already in context | 45% |
| commands re-run verbatim in the same session | 10% |
| tool outputs over 10KB, share of all tool-output bytes | 73% |
| weekly windows that hit 99%+ of the limit | 9 |
| cache misses after <1 min idle / after >1 h idle | 10% / 84–93% |

**I was not paying the model to think. I was paying, 239 times over, to re-send the same
conversation it had already read.** My "expensive AI coding bill" was almost entirely postage.

One turn costs about

```
T_in  ≈  n·C0  +  n²/2 · (o + a)
          ▲        ▲
          │        └── every step re-sends every earlier step: quadratic
          └── history already in context when the turn starts: 81–100K on my machines
```

With the second machine's averages (`n` = 21 steps, `C0` = 100K, `o+a` = 2.1K/step) that is
21 × 100K + 21²/2 × 2.1K ≈ **2.6M input tokens for one ordinary turn** — the measured mean is
2.5M on both machines — and 2.1M of it is the first term: history, re-sent. The top 1% of turns
pass 24M; the biggest single turn on record took 234M.

That is the whole thesis. **Kill `C0`. Then kill `n`. Then kill `o + a`.** Nobody needs a
bigger plan; they need to stop paying postage.

## Design principles

**1. Rebuild the working context each turn — but never the user's words.**
The dominant cost is linear in `C0`, so old tool output is not carried raw. What *is* carried is
the conversation: every message the user wrote, verbatim, in every later request of the session
(only big pasted logs/code turn into a stub with `recall(id)`, and only after a few turns). Each
turn is laid out most-stable-first — instructions and skill index, the transcript, then a small
briefing (workspace state, memories) and the new message — so the prefix cache survives from one
turn to the next. A gate decides per turn whether to carry the previous turn's tool work
(a follow-up) or start from the briefing (a new topic, or the cache went cold); rules decide the
clear cases, a small model only the ambiguous ones.

**2. Remember what the code can't tell you.**
Long-term memory is global and typed — constraints, preferences, decisions and why, approaches
that failed, non-obvious code facts linked to their file — with the user's own sentence quoted
for every constraint. It is written by rules ("记住…", "不要…", "always…"), by the model
(`remember`), and by a small model at turn end; recalled in three layers (always-on, an index,
details on demand). A recall that misses is visible: the model can search, and the ledger
counts it. A new session starts with what the last one decided.

**3. Fold, never delete — and always leave a way back.**
Every folded tool output becomes a one-line stub with an id; the real bytes go to an artifact
store the model can pull back with `recall(id)`. Folding preserves what matters when things
fail: the failing command, the exception type, the assertion diff, the tail of the traceback.
A compressor that can silently drop the one line that mattered isn't a compressor, it's a bug.

**4. Fewer steps beats shorter steps.**
The `n²` term means a step never taken is worth more than a step made smaller. So: blocking
`run`/`wait` instead of one-second polling (the model is never woken up by an empty result),
read dedupe with ranges, command-result reuse, and `delegate` to do a subtask in a *fresh*
context instead of growing this one.

**5. Prefix-cache stability is a hard constraint, not an optimization.**
A rewrite that changes its mind between two requests destroys a 95% cache hit and costs more
than it ever saved. So rewrites are pure and idempotent, fold boundaries are persisted per
conversation, and knobs that would break the prefix (model, effort, prefix trim) only change at
a fold event or a turn boundary.

**6. Cheap tokens for cheap work.**
Deterministic shapers handle what needs no model at all. A small model runs the turn gate,
memory extraction and answer cards (`gpt-5.6-luna` on a ChatGPT login, your main model on your
own endpoint; `mph config small_model=…` to change it). A mid model takes delegated subtasks and map items, escalating to the main
model only when an explicit acceptance command fails. The main loop keeps one model, and
therefore one warm prefix.

**7. Never trade accuracy for tokens.**
An earlier round of ablations showed plain truncation and aggressive summarization lose task
success; those variants were rejected and stay rejected. Anything that compresses here has to
survive a quality regression before it goes on by default — SWE-bench Lite dev, 23 tasks,
compression off vs on vs tight, same model, graded by the hidden tests. It has: **8 / 10 / 10
accepted**, no task ever going from pass to fail because of compression. Multi-turn behaviour
has its own scripted set (references back, constraints that must still hold ten turns later,
preferences, a detail from a long paste, decisions across sessions) — see Status. Cheap and
wrong is not cheap — you pay for the retry.

**8. Measure offline, on real trajectories, before spending a cent.**
4,056 recorded sessions are a free benchmark. The replay harness rebuilds every request of a
real session, runs it through the rewriter with persistent state, simulates the prefix cache and
reports tokens and cost-equivalent — zero model calls. In production every response appends a
ledger row; the sidecar reads the ledger to report savings, tune knobs within bounds, and keep
provenance for every change it makes.

**9. Show me the money, live.**
A saving you can't see is a saving you won't trust. `mph dash` tails the ledger and shows the
quota stretch, the tokens that were never sent, and every fold as it happens — see below.

**10. ReAct is a default, not a law.**
Think/act/observe in one growing context became universal when models could not hold a plan
together for more than a few steps. That constraint has moved, and the cost model says the
topology is worth revisiting: once per-turn rebuild has fixed `C0`, the `n²` term is what
is left, and splitting a task across k independently verified steps divides it by k — each
worker's context carries n/k steps instead of n. So `plan_verify` has a strong model plan
and write the acceptance criteria, cheap models execute each step in a fresh context, and
an **independent verifier** — which never sees the worker's self-report and runs the
commands itself — argues with the worker until the evidence holds. Acceptance is a command,
not an opinion; a verifier that reads "I fixed it, all tests pass" is a rubber stamp.
`python3 bench/topology.py` puts the crossover near 15-20 steps: below it the verification
overhead is pure loss, at the average 21-step turn it is about break-even (~0.9×), at the
p90 turn of 42–47 steps ~0.45×, at 100 steps ~0.22×.
Those are token estimates, not proof that the cheap worker succeeds — so `mph compare` runs
the same tasks under every strategy and scores them with each task's own acceptance
command, never with the strategy's own claim. Strategies are a knob because the answer is
task-dependent and should be measured, not argued about.

## The commands

One command, `mph`. `mph help` prints all of it; `mph <command> --help` has the flags.

| command | what it does |
|---|---|
| `chat` · `run` | the agent loop, interactive or one-shot: the user's words kept verbatim, a turn gate, long-term memory, skills, `fork` / `merge` |
| `save` · `dataset` | keep a real session, with its full per-turn context and a one-line note, in a dataset for backtesting |
| `vibe` | configure the harness by talking to it — it reads and writes its own settings |
| `proxy` | transparent `/v1/responses` proxy — keep your current client, send fewer tokens |
| `dash` | live dashboard: what you are saving, and what it is costing in credits |
| `report` · `tune` · `watch` · `history` | read the ledger, move the knobs within bounds, with provenance |
| `price` · `price-probe` | what a model really costs: fitted from the ledger, or measured with a burst |
| `map` · `compare` · `strategies` | map-reduce over items; A/B two agent topologies on the same tasks |
| `knobs` · `memory` · `skill` · `config` · `login` | settings, long-term memory, SKILL.md folders, upstream |

## Install

Either grab a release, or build from source. Node ≥ 24 either way: the memory store uses the
built-in `node:sqlite`, and its FTS5 full-text index is only compiled in from Node 24 (Node 22
has `node:sqlite` but answers `no such module: fts5`).

```bash
# a) the standalone release: no toolchain, no npm install, no network
gh release download --repo mayunlei/my-poor-harness --pattern '*standalone.tar.gz'
tar xzf my-poor-harness-*-standalone.tar.gz && cd my-poor-harness-*/
node bin/mph.js help

# b) the npm tarball, if you want the commands on your PATH
gh release download --repo mayunlei/my-poor-harness --pattern '*.tgz'
npm install -g ./my-poor-harness-*.tgz        # puts one command, `mph`, on your PATH
```

Check what you downloaded: `shasum -a 256 -c SHA256SUMS.txt`.

## Build from source

```bash
git clone https://github.com/mayunlei/my-poor-harness && cd my-poor-harness
npm install                   # one runtime dependency (js-tiktoken), the rest is dev-only
npm test                      # 58 tests, mock model only: no network, no API key, no quota
npm run build                 # TypeScript → dist/ ; the bin/ commands then run on plain node
```

That is the whole build. Nothing is generated or vendored, and `dist/` is the only output.

| script | what it does |
|---|---|
| `npm run build` | compile to `dist/` |
| `npm run typecheck` | compile with no output |
| `npm test` | the full suite |
| `npm run package` | typecheck + test + build + the two release tarballs into `release/` |
| `npm run release` | package, tag, push, create the GitHub release (see below) |

Without a build, the `bin/mph*` commands fall back to running the TypeScript through `tsx`; with
`dist/` present they use it. So `node bin/mph.js …` works in a fresh clone, and gets faster once
you have built. During development you can also skip `bin/` entirely:

```bash
npm run proxy -- --port 8791        # = npx tsx src/proxy/cli.ts
npm run dash -- --open
npm run harness -- run "…"
npm run sidecar -- report
```

## Usage

### 1. Point it at a model

By default both `mph chat` and `mph proxy` talk to the ChatGPT Codex backend with your ChatGPT
login — the same thing the Codex CLI does. No API key.

```bash
mph whoami        # which credentials would be used (an existing ~/.codex/auth.json is reused)
mph login         # browser PKCE login, if you have none
mph config        # show the effective upstream
```

Any OpenAI-compatible endpoint works instead, including ones that only speak Chat Completions
(DashScope/Qwen, vLLM, Ollama, most gateways):

```bash
mph config provider=openai_compatible base_url=https://api.openai.com/v1 api_key=sk-...
# or per shell, and wire_api=chat for a /chat/completions-only endpoint:
MPH_OPENAI_BASE_URL=https://coding.dashscope.aliyuncs.com/v1 MPH_OPENAI_API_KEY=sk-... \
  MPH_OPENAI_WIRE_API=chat mph run --model qwen3.7-plus "…"
```

### 2. Or just say what you want

```bash
mph vibe "把记忆关掉，这个项目的上下文给小一点"
mph vibe                            # no argument: a session that starts in vibe mode
```

Configuration is the part of a tool like this that nobody reads the manual for. There are
fifty-odd knobs, three model tiers and a dozen config keys, and the useful question is never
"what is `gate_sim_high`" — it is "stop spending so much on short questions". So vibe mode is
the same agent loop with a different prompt and a different tool set: it can read its own
settings and write them, and it cannot touch your files or run commands.

```
[my-project · vibe] you> 现在是什么配置
  ⚙ settings_read overview
Codex (your ChatGPT login), gpt-5.6-sol for the conversation and gpt-5.6-luna for the gate and
memory. Memory on, 12 entries. Everything else is at its default.

[my-project · vibe] you> 短问题别花那么多钟
  ⚙ settings_read knobs effort
  ◇ effort_execute: "medium" -> "low" (global)
effort_execute medium → low, and turn_budget 60k → 40k so a long turn folds sooner.
Both are cache-breaking: they apply from the next turn. Undo with `mph history`.
```

Inside a chat session it is `/vibe` to enter and `/vibe off` to leave; `/vibe <sentence>` does
one thing without changing mode. Every write goes through the same validators the CLI uses, so a
bad value writes *nothing* and says why, rather than quietly falling back to a default. Each
change lands in the knob history with your own words as the reason:

```bash
mph history            # 2026-10-02T12:40:11Z  vibe  global  {"effort_execute":"low"}  短问题别花那么多钟
mph knobs effort_execute=medium                                              # and that is the undo
```

It will not paste an API key for you — it tells you to run `mph config api_key=...` yourself,
because anything you type into the conversation is sent to the model.

### 3. Keep your current client (proxy mode)

The lowest-effort win: nothing about your workflow changes except the token bill.

```bash
mph proxy --port 8791 --verbose
```

Then point Codex at it in `~/.codex/config.toml`:

```toml
chatgpt_base_url = "http://127.0.0.1:8791"
```

Every request gets rewritten on the way out — big tool outputs folded to one-line stubs the
model can expand with `recall(id)`, duplicate reads collapsed, poll chains merged — and a ledger
row is written per response. `curl localhost:8791/health` and `/stats` if you want to look.

### 4. Or use the harness's own loop

A long conversation that keeps every word you wrote, remembers across sessions, and stays cheap:

```bash
mph chat --cwd ~/myproject            # interactive
mph run --cwd . "fix the failing test in tests/test_x.py"
echo "what changed since yesterday?" | mph run - --resume-last --json   # scriptable: JSON events + a result line
mph map --task "analyse {item}" --items AAPL,MSFT,NVDA --parallel 3    # fresh context per item
```

In `chat`:

| | |
|---|---|
| `/continue` · `/new` | force the next turn to carry the previous turn's work, or start from the briefing only |
| `/memory list\|search\|get\|pin\|forget` · `/skills` | look at and steer long-term memory; list the skills it can load |
| `/fork <name>` · `/merge <branch>` · `/discard` | branch for a side question; bring the branch back (its user messages verbatim) |
| `/save <一句话注释>` | keep this session in the backtest dataset (see 9.) |
| `/strategy plan_verify` · `/stats` · `/vibe` | switch execution strategy; this session's tokens; configure by talking |

Tools: `read`, `write_file`, `edit`, `multi_edit`, `ls`, `grep`, `run` / `wait` (blocking, no
polling), `recall`, `delegate`, `memory_search` / `memory_get` / `remember`, `skill`. Skills are
`SKILL.md` folders found in the project (`.agents/skills`, `.claude/skills`, `.codex/skills`) and
in `~/.mph/skills`, `~/.claude/skills`, `~/.codex/skills` — existing ones work unchanged; external
capabilities are CLIs the skills document, run with `run`. Memory can be switched off:
`mph config memory_recall=off` (stop using it) or `memory_write=off` (stop recording).
There is no command approval or sandbox: commands run with your permissions.

### 5. Watch what it is doing

```bash
mph dash --open
```

The layout, with example numbers (what your own run shows depends entirely on your sessions):

```
   ┌ credits spent ──┬ quota stretch ───┬ tokens not sent ─┬ cache hit ─┐
   │     3.750       │      ×3.99       │      395.6K      │     94%    │
   │ 55,969 left ·   │ same work, 75%   │ 543.6K wanted →  │  2.0M/2.1M │
   │  29.3 per 1M in │  less paid for   │   148.0K sent    │   cached   │
   └─────────────────┴──────────────────┴──────────────────┴────────────┘

   context per step        ╭─╮      ╭──╮        ── client would send
   ▁▂▃▄▅▆▇█ sawtooth ─────╯ ╰──────╯  ╰───      ── actually sent (flat, folded)

   sessions                            savings feed
   s_cde9705a  qwen3.7-plus  ×3.67     14:42:54  compact   t0·s12  −80.1K tok
   s_11f0a2e1  gpt-5.6-sol   ×8.21     14:42:51  dedupe    t0·s11  −9.4K tok

   by strategy    runs  pass  calls  cost-equiv  credits  cr/pass
   plan_verify       3   3/3     41     466,320     7.41     2.47
   react             3   2/3     29     713,400    11.02     5.51
```

Quota stretch is what you would have paid ÷ what you did pay. **Credits spent** is real money
when the upstream meters it, with what is left and the rate per 1M input. Per session you get
the two context curves — what the client wanted to send vs what went out, and the gap is the
whole product — and per strategy the cost of *every* agent it ran, so overhead cannot hide.
Read-only, so leave it running next to everything else. `--once` prints the same snapshot as
JSON for scripts and CI.

The credits meter is eventually consistent and the pool is shared across your devices, so the
totals are sound and a single row is not. The page says so, in place.

### 6. Report, tune, and measure the price

```bash
mph report                         # cost, credits, cache, compaction net effect, pass rates, tool batching
mph tune --dry-run                 # what it would change to the knobs, and why
mph watch --every 900              # report + tune on a loop
mph price                           # per-model price from the ledger — refuses when it cannot
mph price-probe                     # measure it with a controlled burst (dry run unless --go)
mph knobs                          # every knob and its current value
mph history                        # every knob change: when, by whom, why
```

### 7. Try a different agent topology

```bash
mph strategies
mph run --strategy plan_verify "…"                  # planner → cheap workers → independent verifier
mph compare --tasks tasks.jsonl --strategies react,plan_verify --copy
```

`compare` scores each strategy with the task's own acceptance command — never with the
strategy's own claim — in a private copy of the workspace. See
[docs/USAGE.md](docs/USAGE.md#7-strategies-how-a-turn-is-organised).

### 8. Measure the savings for free, on your own history

```bash
npm run bench:replay -- --limit 30 --min-bytes 200000
```

Replays your recorded Codex sessions through the rewriter with a simulated prefix cache and
reports what would have been saved. Zero model calls, so it costs nothing.

`python3 bench/session_report.py` prints the fork-aware totals behind the table at the top of
this page for your own `~/.codex` (`CODEX_HOME` for another directory).

### 9. Keep real sessions for backtesting

A conversation you actually had is the best test case there is. Save it, with one sentence on
what problem it is about, and replay the same conversations against the next version:

```bash
mph save --note "复现：长日志粘贴后过几轮再追问细节，模型找不到原文"     # latest session in this directory
mph save s_1a2b3c4d --note "..." --dataset memory-regressions --id paste-followup
mph dataset                                   # datasets and how many cases each holds
mph dataset memory-regressions                # id · turns · note, one line per case
mph dataset show memory-regressions/paste-followup
```

The note is required. Each case keeps the user's words verbatim, every answer, everything the
model saw and did in each turn (assembled context, tool calls and outputs), the ledger rows, the
memories written, the git HEAD each turn started on, and the uncommitted diff at save time —
under `~/.mph/datasets/<dataset>/<id>/`.

## Making a release

```bash
npm run package                  # → release/: npm tarball, standalone tarball, SHA256SUMS.txt
npm run release -- --dry-run     # show the tag, artifacts and notes; change nothing
npm run release -- 0.4.0         # bump + commit, tag, push both, create the release, upload
```

`release.sh` refuses a dirty tree, so commit your work first; the version bump itself is
committed as `v<version>` and the branch is pushed along with the tag, because CI checks the tag
against the `package.json` of the commit it points at.

| artifact | what it is |
|---|---|
| `my-poor-harness-<v>.tgz` | npm-installable (`npm i -g`), dependency from the registry |
| `my-poor-harness-<v>-standalone.tar.gz` | `dist/` + `bin/` + the runtime dependency — plain node, offline |
| `SHA256SUMS.txt` | checksums for both |

The staged standalone tree is smoke-tested with plain `node` before it is tarred, so a broken
build fails packaging instead of failing you. `release.sh` also refuses an existing tag, and
creates the release before uploading assets (the combined `gh release create` form
404s). Pushing a `v*` tag is enough on its own:
[`.github/workflows/release.yml`](.github/workflows/release.yml) rebuilds the same artifacts in
CI, checks the tag matches `package.json`, and attaches them.
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs typecheck, tests and build on Node
20/22/24 for every push.

Data lives in `~/.mph/` (ledger, artifacts, sessions, knobs, config, credentials). Override with
`MPH_HOME`. All environment variables are `MPH_*`.

## The rest

| | |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | every flag and knob: upstream config, the proxy, the harness loop, the dashboard, the sidecar, strategies and how to A/B them, price metering, the replay bench |
| [docs/DESIGN.md](docs/DESIGN.md) | the design doc (Chinese): the session analysis, the token arithmetic, the layer-by-layer plan, the R6 regression results |
| [docs/MEMORY_DESIGN.md](docs/MEMORY_DESIGN.md) | multi-turn design (Chinese): the transcript and user-words fidelity, the turn gate, memory, skills and CLI, the multi-turn golden set |

Five layers, each usable on its own: `src/core` (the pure rewrite), `src/proxy` (transparent
`/v1/responses` proxy — point Codex Desktop/CLI at it and nothing else changes), `src/harness`
(own loop, turn gate, session fork/merge, map-reduce, `mph save`), `src/transcript` (the
append-only transcript and its fidelity check), `src/memory` (SQLite + FTS5 store, recall,
writes), `src/skills` (SKILL.md discovery), `src/sidecar` (reads the ledger, tunes the knobs),
plus `src/harness/strategies` (ReAct vs planner/worker/verifier, with `mph compare` to settle
it), `src/dashboard` (the live view) and `src/upstream` (built-in ChatGPT-OAuth Codex transport,
or any OpenAI-compatible endpoint, Chat Completions included).

## Status

Working and tested, no network needed for the suite: rewrite core, proxy, agent loop with the
multi-turn transcript, gate, memory and skills, session datasets, strategies, sidecar,
dashboard, replay bench, price metering, and the Codex/Chat upstreams.

**What is measured, and what is not:**

- *Quality gate (principle 7) — passed.* SWE-bench Lite dev, 23 tasks, one run each,
  qwen3.7-plus: 8 accepted with compression off, 10 with defaults, 10 with aggressive knobs.
  Nothing regressed from pass to fail. Details in [docs/DESIGN.md](docs/DESIGN.md).
- *Token savings — shown on real sessions, not on SWE-bench.* Replaying recorded Codex
  sessions gives 1.4-1.8× in proxy mode. On SWE-bench Lite it is unmeasurable, and the honest
  reason is that those tasks are small: average ~9-10K per step, so only 2 of 23 tasks even
  triggered a fold at the default 60K budget, and cost-equivalent differed by 5%. Compression
  pays off on long sessions, which is where the bill came from in the first place.
- *Multi-turn — partly measured.* A scripted set of 15 conversations (`bench/multiturn/`), run
  31 of 45 times on qwen3.7-plus before that endpoint's quota and then its key ran out. On the 9
  conversations every arm finished: the default mode passed 14/14 checkpoints, keeping the whole
  context without memory 12/14 — both misses were "what did we decide last session?" — and no
  user message was ever missing from a request. On those 2–4-turn conversations the default mode
  cost ~20% *more* (the per-turn briefing and small-model calls); the savings are designed for
  long sessions, which the set does not have yet. Real use is the test now: `mph save` keeps the
  conversations worth replaying.
- *Per-model price — not measured, and not measurable from the logs.* See
  [docs/USAGE.md](docs/USAGE.md): the quota percentage is an integer and is shared with other
  devices, so it cannot identify a price. The credits balance can, under a controlled probe.
  Until that probe has run, `PRICE` in the ledger is a placeholder, and price-based routing
  stays off.
- *plan_verify vs ReAct — modelled, not yet measured on real tasks.* The crossover estimate
  comes from `bench/topology.py`; `mph compare` is the thing that settles it.
