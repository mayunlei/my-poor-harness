# my-poor-harness

**I am poor, so I invented this harness to squeeze every last drop out of every single token.**

A token-saving harness for coding agents. It sits in front of a Codex/OpenAI-compatible
`/responses` endpoint — or replaces the agent loop entirely — and tries to get the same task
done with an order of magnitude fewer input tokens.

- 📖 [docs/USAGE.md](docs/USAGE.md) — install, login, proxy, harness, sidecar, replay bench
- 📐 [docs/DESIGN.md](docs/DESIGN.md) — the full design doc (Chinese), with the data behind it

## Why

I kept burning through my weekly limit and I wanted to know *where* the tokens actually went.
So I parsed every Codex session on my laptop — 2,128 sessions, 2026-03 to 2026-10 — and the
answer was not what I expected:

| | |
|---|---|
| input tokens | **16.9 billion** |
| output tokens | 72 million |
| cache hit rate | 95% — and the weekly limit still ran out |
| share of input sent while context was >100K | 84% |
| fixed prompt re-sent on *every* request | ~60KB ≈ 15K tokens |
| empty background-process polls | 16K of 33K polls returned nothing |
| duplicate reads of a file already in context | 14.5K of 29K reads |
| commands re-run verbatim in the same session | 11K (12%) |

**I was not paying for the model to think. I was paying to re-send the same conversation,
over and over, hundreds of times per task.**

One turn costs roughly

```
T_in  ≈  n·C0  +  n²/2 · (o + a)
```

where `C0` is the history already in context when the turn starts (mean 94K on my machine),
`n` is the number of model steps in the turn (mean 29), and `o + a` is what each step appends
(~1.4K). On my averages that is **3.3M input tokens for one turn** — and 2.7M of it is the
first term: history, re-sent. A heavy turn hits 10M.

That is the whole thesis. Attack `C0`, then attack `n`, then attack `o + a`.

## Design principles

**1. Rebuild the context each turn; don't append to it.**
The dominant cost is linear in `C0`, so the fix is not to compress history — it is to not carry
raw history at all. Each turn gets a fixed prompt (~450 tokens), a state digest (goal, files
touched, last test status, errors seen, decisions), and the last few observations. Everything
else is folded.

**2. Fold, never delete — and always leave a way back.**
Every folded tool output becomes a one-line stub plus an id, and the real bytes go to an
artifact store that the model can pull back with `recall(id)`. Folding keeps the fields that
actually matter when something fails: the failing command, exception type, assertion diff,
the tail of the traceback. A compressor that can silently lose the one line that mattered is
not a compressor, it's a bug.

**3. Fewer steps beats shorter steps.**
The `n²` term means a step you never take is worth more than a step you shrink. So: blocking
`run`/`wait` instead of one-second polling (the model is never woken by an empty result),
read dedupe with ranges, command-result reuse, and `delegate` to run a subtask in a *fresh*
context instead of growing the current one.

**4. Prefix-cache stability is a hard constraint, not an optimization.**
A rewrite that changes its mind between two requests destroys the 95% cache hit and costs more
than it saves. So rewrites are pure and idempotent, fold boundaries are persisted per
conversation, and knobs that would break the prefix (model, effort, prefix trim) only ever
change at a fold event or a turn boundary.

**5. Cheap tokens for cheap work.**
Deterministic shapers do what doesn't need a model at all. A small model calibrates the
compaction judge. A mid model does delegated subtasks and map items, escalating to the main
model only when an explicit acceptance command fails. The main loop keeps one model, and
therefore one prefix cache.

**6. Never trade accuracy for tokens.**
An earlier round of ablations showed plain truncation and aggressive summarization lose task
success — those variants were rejected. Any compression here has to survive a quality
regression (SWE-bench Lite, compression off vs on, same model, judged by hidden tests) before
it is turned on by default.

**7. Measure offline, with real trajectories, before spending a cent.**
2,128 recorded sessions are a free benchmark. The replay harness rebuilds every request of a
real session, runs it through the rewriter with persistent state, simulates the prefix cache,
and reports tokens and cost-equivalent — zero model calls. In production every response writes
a ledger row, and a sidecar reads the ledger to report savings, tune knobs within bounds, and
record provenance for every change it makes.

**8. Work with the client you already have.**
Three layers, each usable alone: a pure rewrite library, a transparent `/v1/responses` proxy
(point Codex Desktop/CLI at it and nothing else changes), and a full agent loop with session
fork/merge and map-reduce for when you want the rest.

## Quick start

```bash
npm install && npm test

# A) transparent proxy in front of your existing Codex client
npx tsx src/proxy/cli.ts --port 8791 --verbose

# B) the harness's own loop
npx tsx src/harness/cli.ts login
npx tsx src/harness/cli.ts chat --cwd . --model gpt-5.6-sol

# C) free offline benchmark against your own recorded sessions
npx tsx src/bench/replay.ts --limit 30 --min-bytes 200000
```

Details, configuration and the other entry points: [docs/USAGE.md](docs/USAGE.md).

## Status

Working and tested: the rewrite core, the proxy (with the built-in ChatGPT-OAuth Codex
upstream and a Chat Completions adapter for Qwen/vLLM/Ollama-style endpoints), the agent loop,
the sidecar, and the replay bench. The SWE-bench quality regression (principle 6) is the piece
still being run.
