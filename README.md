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
actually went. Every Codex session on my laptop — **2,128 sessions**, 2026-03 to 2026-10. The
answer was not subtle:

| | |
|---|---|
| input tokens | **16,900,000,000** |
| output tokens | 72,000,000 |
| ratio | **235 : 1** |
| cache hit rate | 95% — and the limit still ran out |
| share of input sent while context was >100K | 84% |
| fixed prompt re-sent on *every single* request | ~60KB ≈ 15K tokens |
| background-process polls that returned nothing | 16K of 33K |
| file reads of a file already in context | 14.5K of 29K |
| commands re-run verbatim in the same session | 11K (12%) |

**I was not paying the model to think. I was paying, 235 times over, to re-send the same
conversation it had already read.** My "expensive AI coding bill" was almost entirely postage.

One turn costs about

```
T_in  ≈  n·C0  +  n²/2 · (o + a)
          ▲        ▲
          │        └── every step re-sends every earlier step: quadratic
          └── history already in context when the turn starts: 94K on my machine
```

With my own averages (`n` = 29 steps, `C0` = 94K, `o+a` = 1.4K/step) that is **3.3M input
tokens for one ordinary turn**, of which 2.7M is the first term — history, re-sent. A heavy
turn hits 10M. Three batch sessions one night cost 330M tokens between them.

That is the whole thesis. **Kill `C0`. Then kill `n`. Then kill `o + a`.** Nobody needs a
bigger plan; they need to stop paying postage.

## Design principles

**1. Rebuild the context each turn — don't append to it.**
The dominant cost is linear in `C0`, so the answer isn't to compress history, it's to not carry
raw history at all. Each turn gets a fixed prompt (~450 tokens), a state digest (goal, files
touched, last test status, errors seen, decisions), and the last few observations. Everything
older is folded.

**2. Fold, never delete — and always leave a way back.**
Every folded tool output becomes a one-line stub with an id; the real bytes go to an artifact
store the model can pull back with `recall(id)`. Folding preserves what matters when things
fail: the failing command, the exception type, the assertion diff, the tail of the traceback.
A compressor that can silently drop the one line that mattered isn't a compressor, it's a bug.

**3. Fewer steps beats shorter steps.**
The `n²` term means a step never taken is worth more than a step made smaller. So: blocking
`run`/`wait` instead of one-second polling (the model is never woken up by an empty result),
read dedupe with ranges, command-result reuse, and `delegate` to do a subtask in a *fresh*
context instead of growing this one.

**4. Prefix-cache stability is a hard constraint, not an optimization.**
A rewrite that changes its mind between two requests destroys a 95% cache hit and costs more
than it ever saved. So rewrites are pure and idempotent, fold boundaries are persisted per
conversation, and knobs that would break the prefix (model, effort, prefix trim) only change at
a fold event or a turn boundary.

**5. Cheap tokens for cheap work.**
Deterministic shapers handle what needs no model at all. A small model calibrates the
compaction judge. A mid model takes delegated subtasks and map items, escalating to the main
model only when an explicit acceptance command fails. The main loop keeps one model, and
therefore one warm prefix.

**6. Never trade accuracy for tokens.**
An earlier round of ablations showed plain truncation and aggressive summarization lose task
success; those variants were rejected and stay rejected. Anything that compresses here has to
survive a quality regression (SWE-bench Lite, compression off vs on, same model, judged by
hidden tests) before it goes on by default. Cheap and wrong is not cheap — you pay for the
retry.

**7. Measure offline, on real trajectories, before spending a cent.**
2,128 recorded sessions are a free benchmark. The replay harness rebuilds every request of a
real session, runs it through the rewriter with persistent state, simulates the prefix cache and
reports tokens and cost-equivalent — zero model calls. In production every response appends a
ledger row; the sidecar reads the ledger to report savings, tune knobs within bounds, and keep
provenance for every change it makes.

**8. Show me the money, live.**
A saving you can't see is a saving you won't trust. `th-dash` tails the ledger and shows the
quota stretch, the tokens that were never sent, and every fold as it happens — see below.

## Quickstart

### Run a release build (no toolchain needed)

```bash
# grab the latest release
gh release download --repo mayunlei/my-poor-harness --pattern '*standalone.tar.gz'
tar xzf token-harness-*-standalone.tar.gz && cd token-harness-*/

node bin/th-dash.js --open          # dashboard, straight away
node bin/th-proxy.js --port 8791    # proxy in front of your existing Codex client
```

The standalone tarball carries the compiled `dist/` and its one runtime dependency, so it runs
on plain `node` ≥20.11 with no `npm install` and no network. Prefer npm?

```bash
gh release download --repo mayunlei/my-poor-harness --pattern '*.tgz' --exclude '*standalone*'
npm install -g ./token-harness-*.tgz     # puts th, th-proxy, th-sidecar, th-dash on PATH
```

Verify what you downloaded: `shasum -a 256 -c SHA256SUMS.txt`.

### From source

```bash
git clone https://github.com/mayunlei/my-poor-harness && cd my-poor-harness
npm install
npm test                      # 32 tests, no network, no API key
npm run dash -- --open        # live dashboard
npm run proxy                 # th-proxy on :8791
npm run bench:replay -- --limit 30 --min-bytes 200000   # offline savings on your own sessions
```

### See it working: the live dashboard

```bash
npm run dash -- --open --weekly-budget 50M    # or: th-dash --open
```

The layout, with the headline numbers off a short local run and the lower rows sketched in
(`th-dash --once` prints the same snapshot as JSON):

```
   ┌ quota stretch ──┬ tokens not sent ─┬ cost-equiv saved ┬ sessions ──┐
   │     ×3.99       │      395.6K      │      395.6K      │     13     │
   │ same work, 75%  │ 543.6K wanted →  │ paid 132.5K of   │  1 active  │
   │  less paid for  │   148.0K sent    │      528.1K      │    now     │
   └─────────────────┴──────────────────┴──────────────────┴────────────┘
   weekly budget  ░░░░░░░░░░░░░░░░░░░░░░  128.8K / 50M  ·  unmodified client would be at 544.4K

   context per step        ╭─╮      ╭──╮        ── client would send
   ▁▂▃▄▅▆▇█ sawtooth ─────╯ ╰──────╯  ╰───      ── actually sent (flat, folded)

   sessions                            savings feed
   s_cde9705a  qwen3.7-plus  ×3.67     14:42:54  compact   t0·s12  −80.1K tok
   s_11f0a2e1  gpt-5.6-sol   ×8.21     14:42:51  dedupe    t0·s11  −9.4K tok
```

It tails `~/.token_harness/ledger.jsonl` and pushes updates over SSE, so numbers move while the
agent works. **Quota stretch** is the headline: what you would have paid divided by what you
did pay. Per session you get the context curve (what the client wanted to send vs what actually
went out — the gap is the whole point), steps, cache share, folds and recalls; alongside it a
feed of every fold with its token saving, and a breakdown of which mechanism earned what.
It is strictly read-only, so it is safe to leave running next to the proxy, the harness and the
sidecar. `--once` prints a JSON snapshot instead, for scripts and CI.

### Build a release package

```bash
npm run package
```

Typechecks, runs the tests, compiles to `dist/`, then writes into `release/`:

| artifact | what it is |
|---|---|
| `token-harness-<v>.tgz` | npm-installable package (`npm i -g`), deps from the registry |
| `token-harness-<v>-standalone.tar.gz` | `dist/` + `bin/` + runtime deps — runs offline on plain node |
| `SHA256SUMS.txt` | checksums for both |

The staged standalone copy is smoke-tested with plain `node` before it is tarred, so a broken
build fails the package step instead of the user.

### Publish a release on GitHub

```bash
npm run release -- --dry-run     # build + show the tag, artifacts and notes; touches nothing
npm run release -- 0.2.0         # bump to 0.2.0, tag, push, create the release, upload
npm run release                  # release the version already in package.json
```

It refuses a dirty tree or an existing tag, generates notes from the commits since the previous
tag, and uploads all three artifacts with `gh`. Pushing a `v*` tag is enough on its own:
[`.github/workflows/release.yml`](.github/workflows/release.yml) builds the identical artifacts
in CI, checks the tag matches `package.json`, and attaches them to the release.
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs typecheck, tests and build on Node
20/22/24 for every push.

## The rest

| | |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | login and config, the proxy, the harness loop, the sidecar, the replay bench, all the knobs |
| [docs/DESIGN.md](docs/DESIGN.md) | the full design doc (Chinese): the session analysis, the token arithmetic, the layer-by-layer plan |

Four layers, each usable on its own: `src/core` (the pure rewrite), `src/proxy` (transparent
`/v1/responses` proxy — point Codex Desktop/CLI at it and nothing else changes), `src/harness`
(own loop, session fork/merge, map-reduce), `src/sidecar` (reads the ledger, tunes the knobs),
plus `src/dashboard` (the live view) and `src/upstream` (built-in ChatGPT-OAuth Codex transport,
or any OpenAI-compatible endpoint, Chat Completions included).

## Status

Working and tested (32 tests, no network needed): rewrite core, proxy, agent loop, sidecar,
dashboard, replay bench, and the Codex/Chat upstreams. The SWE-bench quality regression that
principle 6 demands is the piece still being run — until it passes, treat the aggressive knobs
as experimental.
