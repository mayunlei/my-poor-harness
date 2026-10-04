/**
 * Codex CLI memory (src/memory/codex.ts): parsing ~/.codex/memories*, search with the
 * project boost, paged reads by ref, the briefing threshold, the codex_memory tool, and
 * the pointer lines a turn's briefing gets. Uses a fake CODEX_HOME, never the real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock, msg } from "./mock_model.js";

const HOME = mkdtempSync(join(tmpdir(), "mph-cx-"));
process.env.MPH_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith("MPH_") && k !== "MPH_HOME") delete process.env[k];
const CODEX = mkdtempSync(join(tmpdir(), "codex-home-"));
process.env.CODEX_HOME = CODEX;

const v1 = join(CODEX, "memories"); const v2 = join(CODEX, "memories_v2");
mkdirSync(join(v1, "rollout_summaries"), { recursive: true }); mkdirSync(join(v2, "rollout_summaries"), { recursive: true });
writeFileSync(join(v1, "MEMORY.md"), `# Task Group: /work/sql Cloudflare D1 rows_read incident remediation

applies_to: cwd=/work/sql; reuse_rule=point-in-time
- rollout_summaries/2026-09-03T00-30-28-ApCU-d1.md (cwd=/work/sql, updated_at=2026-09-06T10:00:00+00:00)

## Reusable knowledge
- D1 rows_read spiked because feed queries lacked an index on (user_id, created_at); adding it cut reads 40x.

# Task Group: /work/web OCI Always Free host operations

applies_to: cwd=/work/web
- Always Free A1 instance in PHX-AD-3, budget alerts are warnings not caps.
`);
writeFileSync(join(v1, "memory_summary.md"), `v1

## User preferences

- Keep secrets out of logs and memory.

### /work/sql

#### 2026-09-06

- D1 rows_read fix with a composite index
`);
writeFileSync(join(v1, "rollout_summaries", "2026-09-03T00-30-28-ApCU-d1.md"), "thread_id: a\nupdated_at: 2026-09-06T10:00:00+00:00\ncwd: /work/sql\n\n# Cloudflare D1 rows_read root cause (old copy)\n\nold text\n");
writeFileSync(join(v2, "rollout_summaries", "2026-09-03T00-30-28-ApCU-d1_renamed.md"), "thread_id: a\nupdated_at: 2026-09-07T10:00:00+00:00\ncwd: /work/sql\n\n## Cloudflare D1 rows_read root cause\n\n" + "index on user_id created_at; rows_read dropped. ".repeat(400));

const C = await import("../src/memory/codex.js");
const { extraHandler } = await import("../src/harness/tools_extra.js");

test("codex memory: groups, summary sections and rollouts become chunks; v2 wins a duplicated rollout", () => {
  assert.deepEqual(C.codexMemoryRoots(), [v2, v1]);
  const chunks = C.loadCodexMemory();
  const groups = chunks.filter((c) => c.kind === "group");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].ref, "memories/MEMORY.md#1"); assert.equal(groups[0].cwd, "/work/sql"); assert.equal(groups[0].updated, "2026-09-06T10:00:00+00:00");
  const rollouts = chunks.filter((c) => c.kind === "rollout");
  assert.equal(rollouts.length, 1, "same session prefix in both layouts is read once");
  assert.equal(rollouts[0].ref, "memories_v2/rollout_summaries/2026-09-03T00-30-28-ApCU-d1_renamed.md");
  assert.equal(rollouts[0].title, "Cloudflare D1 rows_read root cause");
  const sums = chunks.filter((c) => c.kind === "summary");
  assert.ok(sums.some((s) => s.title === "User preferences"));
  assert.ok(sums.some((s) => s.cwd === "/work/sql" && s.title === "2026-09-06"), "dated sections inherit the project heading above them");
});

test("codex memory: search ranks matching work first, boosts the current project, and reads refs in pages", () => {
  const hits = C.searchCodexMemory("D1 rows_read index", { limit: 5 });
  assert.ok(hits.length >= 2);
  assert.ok(hits.every((h) => h.chunk.cwd === "/work/sql"), "the OCI group does not match");
  assert.match(hits[0].snippet, /rows_read/);
  const oci = C.searchCodexMemory("Always Free budget alerts", { limit: 3 });
  assert.equal(oci[0].chunk.ref, "memories/MEMORY.md#2");
  // same query, project boost decides between equally matching chunks
  const a = C.searchCodexMemory("instance", { project: "/work/web", limit: 1 });
  assert.equal(a[0].chunk.cwd, "/work/web");
  assert.deepEqual(C.searchCodexMemory("zzqqxx nothing"), []);

  const page = C.readCodexMemory("rollout_summaries/2026-09-03T00-30-28-ApCU-d1_renamed.md", { max: 500 })!;
  assert.match(page, /^\[codex memory memories_v2\/rollout_summaries\/.*· rollout · cwd=\/work\/sql · updated 2026-09-07\]/);
  assert.match(page, /more chars; codex_memory\(ref="memories_v2\/rollout_summaries\/2026-09-03T00-30-28-ApCU-d1_renamed.md", offset=500\)/);
  assert.equal(C.readCodexMemory("../../auth.json"), undefined, "refs only name parsed chunks, never paths");
});

test("codex memory: the briefing only mentions strong matches", () => {
  assert.ok(C.codexBriefingHits("D1 的 rows_read 又涨了，index 还在吗", "/work/sql", 3).length >= 1);
  assert.deepEqual(C.codexBriefingHits("hello", "/work/sql", 3), [], "one-word messages get nothing");
  assert.deepEqual(C.codexBriefingHits("refactor the parser tokenizer module", "/work/sql", 3), []);
});

test("codex_memory tool: search, read, and off in settings", async () => {
  const h = extraHandler("codex_memory")!;
  const ctx: any = { cwd: HOME, codexMemory: true, project: "/work/sql" };
  const s = await h(ctx, { query: "rows_read index" }, "c1");
  assert.match(s, /^\[codex_memory "rows_read index"/);
  assert.match(s, /memories\/MEMORY.md#1 \[group 2026-09-06\]/);
  assert.match(await h(ctx, { ref: "memories/MEMORY.md#2" }, "c2"), /PHX-AD-3/);
  assert.match(await h(ctx, { ref: "nope" }, "c3"), /no ref "nope"/);
  assert.match(await h({ ...ctx, codexMemory: false }, { query: "x" }, "c4"), /turned off/);
});

test("a turn's briefing carries Codex memory pointers when settings allow it", async () => {
  const { resolveKnobs } = await import("../src/core/knobs.js");
  const { ArtifactStore } = await import("../src/core/artifacts.js");
  const { Ledger } = await import("../src/core/ledger.js");
  const { Router } = await import("../src/harness/router.js");
  const { MemoryStore } = await import("../src/memory/store.js");
  const { newSession, saveSession } = await import("../src/harness/session.js");
  const { runTurn } = await import("../src/harness/loop.js");
  const main: any[] = [];
  const mock = await startMock((body) => {
    const ins = String(body.instructions ?? "");
    if (ins.startsWith("You prepare the context")) return { output: [msg('{"action":"rebuild","memory_ids":[],"detail_ids":[],"skills":[]}')] };
    if (ins.startsWith("You maintain the long-term memory")) return { output: [msg('{"items":[]}')] };
    if (ins.startsWith("Condense")) return { output: [msg("card")] };
    main.push(body); return { output: [msg("ok")] };
  });
  process.env.MPH_OPENAI_BASE_URL = mock.url + "/v1";
  try {
    const knobs = resolveKnobs({ main_model: "mock-main", small_model: "mock-small" });
    const ledger = new Ledger(join(HOME, "ledger.jsonl"));
    const opts = { knobs, store: new ArtifactStore(join(HOME, "art")), ledger, router: new Router(knobs, ledger), memory: new MemoryStore(join(HOME, "mem.db")), skills: [] as any[] };
    const ws = mkdtempSync(join(tmpdir(), "mph-cx-ws-"));
    const s = newSession(ws, "cx"); saveSession(s);
    const q = "Cloudflare D1 rows_read 又上涨了，之前加的 index 是哪个？";
    await runTurn({ session: s, userText: q, ...opts, memorySettings: { recall: true, write: false, codex: true } });
    const text = (b: any) => JSON.stringify(b.input);
    assert.match(text(main.at(-1)), /Codex memory: possibly relevant past work/);
    assert.match(text(main.at(-1)), /memories\/MEMORY.md#1/);
    assert.ok(main.at(-1).tools.some((t: any) => t.name === "codex_memory"));
    await runTurn({ session: s, userText: q, ...opts, memorySettings: { recall: true, write: false } });
    assert.doesNotMatch(text(main.at(-1)), /Codex memory: possibly relevant/, "absent codex setting = off");
  } finally { await mock.close(); delete process.env.MPH_OPENAI_BASE_URL; }
});
