/**
 * Multi-turn mode (docs/MEMORY_DESIGN.md): transcript and user-words fidelity, memory store /
 * recall / writes, the turn gate, skills, model resolution, the new tools, and an end-to-end
 * multi-turn conversation against a mock model that tells the main loop, the gate, the
 * memory extractor and the answer-card writer apart by their instructions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startMock, msg, call } from "./mock_model.js";

const HOME = mkdtempSync(join(tmpdir(), "mph-mt-"));
process.env.MPH_HOME = HOME;
for (const k of Object.keys(process.env)) if (k.startsWith("MPH_") && k !== "MPH_HOME") delete process.env[k];

const T = await import("../src/transcript/index.js");
const { MemoryStore, ftsTerms } = await import("../src/memory/store.js");
const { candidates, pinnedWithin, renderMemoryBriefing } = await import("../src/memory/recall.js");
const { ruleExtract, addUnlessDuplicate, applyExtracted } = await import("../src/memory/write.js");
const { gateFeatures, ruleDecision, decideTurn, topicOverlap } = await import("../src/harness/gate.js");
const { discoverSkills, renderSkillIndex, parseFrontmatter, projectInstructions } = await import("../src/skills/index.js");
const { resolveModels, memorySettings, saveConfigFile } = await import("../src/upstream/config.js");
const { ArtifactStore } = await import("../src/core/artifacts.js");
const { resolveKnobs } = await import("../src/core/knobs.js");
const { executeTool } = await import("../src/harness/tools.js");
const { grepTree, globToRe } = await import("../src/harness/tools_extra.js");
const { runTurn } = await import("../src/harness/loop.js");
const { newSession, saveSession, forkSession, mergeSession } = await import("../src/harness/session.js");
const { Router } = await import("../src/harness/router.js");
const { Ledger } = await import("../src/core/ledger.js");

const store = new ArtifactStore(join(HOME, "art"));
const K = resolveKnobs({});
const bigLog = "```log\n" + Array.from({ length: 400 }, (_, i) => `2026-10-02 10:00:${String(i % 60).padStart(2, "0")} ERROR worker-${i} failed to connect to db shard ${i}`).join("\n") + "\n```";

test("transcript: pasted blocks are told apart from the user's words", () => {
  const segs = T.splitUserText("帮我看看这个报错\n" + bigLog + "\n是不是连接池的问题？");
  assert.deepEqual(segs.map((s) => s.kind), ["words", "paste", "words"]);
  assert.equal(segs[1].label, "log");
  const trace = "it fails:\nTraceback (most recent call last):\n" + Array.from({ length: 10 }, (_, i) => `  File "a.py", line ${i}, in f\n    x()`).join("\n") + "\nValueError: bad";
  assert.ok(T.splitUserText(trace).some((s) => s.kind === "paste" && s.label === "traceback"));
  // short or ambiguous content stays words
  assert.deepEqual(T.splitUserText("2026-10-02 one line that looks like a log").map((s) => s.kind), ["words"]);
  assert.deepEqual(T.userWords("a\n```py\nx=1\n```\nb"), ["a", "b"]);
});

test("transcript: epochs change rarely; old answers become cards; old big pastes become stubs; user words never change", () => {
  // epoch boundaries
  const starts = Array.from({ length: 10 }, (_, n) => T.epochStart(n, 3));
  assert.deepEqual(starts, [0, 0, 0, 0, 0, 0, 3, 3, 3, 6]);
  const sid = "s_tr1";
  const longAnswer = "Fixed the pool size in db.py; the connection errors are gone.\n\n" + "details ".repeat(400) + "\n\nVerified: pytest -q passes.";
  T.appendUser(sid, 0, "第一句话：请帮我检查 db.py 的连接池。");
  T.appendAnswer(sid, { turn: 0, text: longAnswer, card: T.ruleCard(longAnswer, ["db.py"], "abc123")!, filesChanged: ["db.py"], status: "done" });
  T.appendUser(sid, 1, "看日志：\n" + bigLog + "\n为什么会报错？");
  T.appendAnswer(sid, { turn: 1, text: "Because of X.", card: "Because of X.", filesChanged: [], status: "done" });
  T.appendUser(sid, 2, "那改成 20 呢");      // interrupted: no answer
  const k = { answer_verbatim_turns: 1, paste_externalize_tokens: 500 };
  const items = T.renderTranscript(T.readTranscript(sid), k, store);
  assert.equal(items.length, 6);
  const texts = items.map((x: any) => x.content[0].text);
  assert.ok(texts[1].startsWith("[answer card]") && texts[1].includes("files: db.py") && texts[1].includes('recall("abc123")'), texts[1].slice(0, 200));
  assert.ok(texts[2].includes("[pasted log") && texts[2].includes("看日志：") && texts[2].includes("为什么会报错？") && !texts[2].includes("worker-200 "), "old paste stubbed, words kept");
  assert.equal(texts[5], "(turn interrupted; no answer was recorded)");
  assert.equal(texts[4], "那改成 20 呢");
  // rendering is deterministic (cache-stable)
  assert.deepEqual(T.renderTranscript(T.readTranscript(sid), k, store), items);
  // fidelity: every user word segment is present; removing one is caught
  const users = T.readTranscript(sid).filter((e: any) => e.kind === "user") as any[];
  assert.equal(T.checkUserFidelity(items, users).ok, true);
  const broken = items.map((x: any, i: number) => (i === 2 ? { ...x, content: [{ type: "input_text", text: "summary of the log question" }] } : x));
  const f = T.checkUserFidelity(broken, users);
  assert.equal(f.ok, false); assert.equal(f.missing[0].turn, 1);
});

test("memory store: Chinese and English search, dedupe, supersede, stale file facts, export/import", () => {
  const m = new MemoryStore(join(HOME, "mem1.db"));
  const src = { session: "s", turn: 0, by: "model" as const };
  const a = m.add({ type: "constraint", title: "不要修改 add 函数的签名", quote: "不要修改 add 函数的签名", pinned: true, source: src });
  m.add({ type: "decision", title: "use pytest -q for tests", body: "faster output", source: src });
  assert.equal(m.search("add 函数")[0].entry.id, a.id);
  assert.equal(m.search("pytest")[0].entry.title, "use pytest -q for tests");
  assert.ok(m.search("签名").length >= 1, "2-char CJK query falls back to LIKE");
  assert.ok(ftsTerms("连接池问题").fts.includes("连接池"));
  // dedupe
  const d = addUnlessDuplicate(m, { type: "constraint", title: "不要修改 add 函数的签名。", source: src });
  assert.equal(d.created, false); assert.equal(d.entry.id, a.id);
  // supersede
  const b = m.add({ type: "decision", title: "use pytest -x", supersedes: m.search("pytest -q")[0].entry.id, source: src });
  assert.equal(m.search("pytest").map((h) => h.entry.id)[0], b.id);
  assert.equal(m.list({ status: "superseded" }).length, 1);
  // stale facts
  const f = join(HOME, "code.py"); writeFileSync(f, "x = 1\n");
  const fact = m.add({ type: "fact", title: "x is the retry count", links: [{ kind: "file", ref: f }], source: src });
  assert.deepEqual(m.refreshStaleness([fact]), []);
  writeFileSync(f, "x = 2\n");
  assert.deepEqual(m.refreshStaleness([m.get(fact.id)!]), [fact.id]);
  assert.equal(m.get(fact.id)!.status, "stale");
  // export / import into a fresh store
  const m2 = new MemoryStore(join(HOME, "mem2.db"));
  assert.equal(m2.importJsonl(m.exportJsonl()), 4);
  assert.equal(m2.importJsonl(m.exportJsonl()), 0, "idempotent");
  assert.equal(m2.list({ pinned: true }).length, 1);
  m.close(); m2.close();
});

test("memory writes: user instructions become pinned quotes; extracted items create, update and supersede", () => {
  const r = ruleExtract("记住：回答一律用中文。帮我看看 db.py。以后不要改公共 API！你觉得要不要加缓存？");
  assert.deepEqual(r.map((x) => [x.type, x.quote]), [["preference", "记住：回答一律用中文。"], ["constraint", "以后不要改公共 API！"]]);
  assert.ok(r.every((x) => x.pinned));
  assert.equal(ruleExtract("Please always run the linter before committing.")[0].type, "constraint");
  const m = new MemoryStore(join(HOME, "mem3.db"));
  const base = { session: "s", turn: 1, project: "/p", cwd: "/p" };
  const [id1] = applyExtracted(m, [{ op: "new", type: "decision", title: "cache with lru", body: "x", links: ["src/a.py"] }], base);
  assert.equal(m.get(id1)!.links[0].ref, "/p/src/a.py");
  applyExtracted(m, [{ op: "update", id: id1, type: "decision", title: "cache with lru, size 128", body: "y" }], base);
  assert.equal(m.get(id1)!.title, "cache with lru, size 128");
  const [id2] = applyExtracted(m, [{ op: "supersede", id: id1, type: "decision", title: "no cache after all", body: "z" }], base);
  assert.equal(m.get(id1)!.status, "superseded"); assert.equal(m.get(id2)!.supersedes, id1);
  assert.equal(applyExtracted(m, [{ op: "new", type: "decision", title: "no cache after all" }], base)[0], id2, "duplicate skipped");
  // recall: pinned within budget, candidates by text and file
  m.add({ type: "constraint", title: "never touch migrations/", pinned: true, source: { session: "s", turn: 0, by: "user" } });
  m.add({ type: "fact", title: "retry loop lives in worker", links: [{ kind: "file", ref: "/p/src/worker.py" }], source: { session: "s", turn: 0, by: "model" } });
  assert.equal(pinnedWithin(m, 800).shown.length, 1);
  assert.equal(pinnedWithin(m, 5).shown.length, 0);
  const c = candidates(m, { query: "why does the worker crash", files: ["src/worker.py"] });
  assert.equal(c[0].entry.title, "retry loop lives in worker");
  const b = renderMemoryBriefing(m, { pinned: pinnedWithin(m, 800).shown, index: c.slice(0, 1).map((x) => x.entry), detail: [] });
  assert.ok(b.text.includes("always in force") && b.text.includes("never touch migrations/") && b.text.includes("memory_search"));
  m.close();
});

test("gate: rules decide clear cases; the model decides the ambiguous zone and reranks; failures fall back", async () => {
  const k = { gate_sim_low: 0.15, gate_sim_high: 0.45, gate_use_model: true, gate_timeout_s: 2, memory_l1_max: 2 };
  const base = { prevUser: "fix the parser bug in parser.py", prevAnswer: "fixed parser.py", lastEndedAt: new Date().toISOString(), hasWindow: true, filesTouched: ["/w/parser.py"], ttlS: 1800 };
  assert.equal(ruleDecision(gateFeatures({ ...base, userText: "刚才那个也改一下" }), k)!.action, "continue");
  assert.equal(ruleDecision(gateFeatures({ ...base, userText: "now update parser.py docs" }), k)!.action, "continue");
  assert.equal(ruleDecision(gateFeatures({ ...base, userText: "write a release note for the dashboard" }), k)!.action, "rebuild");
  assert.match(ruleDecision(gateFeatures({ ...base, lastEndedAt: new Date(Date.now() - 3600_000).toISOString(), userText: "刚才那个也改一下" }), k)!.why, /cache cold/);
  assert.equal(ruleDecision(gateFeatures({ ...base, userText: "x", explicit: "rebuild" }), k)!.by, "explicit");
  assert.equal(ruleDecision(gateFeatures({ ...base, prevUser: undefined, userText: "hello" }), k)!.action, "rebuild");
  assert.ok(topicOverlap("parser tests failing", "fix the parser bug") > 0.3);
  const ambiguous = gateFeatures({ ...base, userText: "make the parser faster with a cache" });
  assert.equal(ruleDecision(ambiguous, k), undefined);
  const cands = ["m1", "m2", "m3"].map((id, i) => ({ entry: { id, type: "decision", title: `t${i}` } as any, score: 1 - i * 0.1, why: [] }));
  const client = (text: string, delay = 0) => ({ respond: async () => { await new Promise((r) => setTimeout(r, delay)); return { text, output: [], calls: [], usage: { input: 10, cached: 0, output: 5, reasoning: 0 } }; } });
  const d = await decideTurn({ userText: "make the parser faster with a cache", features: ambiguous, candidates: cands, skills: [], knobs: k, client: client('{"action":"rebuild","why":"new feature","memory_ids":["m3","zz"],"detail_ids":["m3"]}') as any, model: "small" });
  assert.deepEqual([d.action, d.by, d.memoryIds, d.detailIds], ["rebuild", "model", ["m3"], ["m3"]]);
  const bad = await decideTurn({ userText: "make the parser faster with a cache", features: ambiguous, candidates: cands, skills: [], knobs: k, client: client("sure!") as any, model: "small" });
  assert.deepEqual([bad.action, bad.by, bad.memoryIds], ["continue", "fallback", ["m1", "m2"]]);
  const slow = await decideTurn({ userText: "make the parser faster with a cache", features: ambiguous, candidates: cands, skills: [], knobs: { ...k, gate_timeout_s: 0.05 } as any, client: client("{}", 500) as any, model: "small" });
  assert.match(slow.why, /timeout/);
  // a rule decision with few candidates does not call the model at all
  const quick = await decideTurn({ userText: "刚才那个也改一下", features: gateFeatures({ ...base, userText: "刚才那个也改一下" }), candidates: cands.slice(0, 1), skills: [], knobs: k, client: client("{}") as any, model: "small" });
  assert.equal(quick.modelCalled, false);
});

test("skills: discovery across roots, frontmatter, missing CLIs, index budget, project instructions", () => {
  const proj = mkdtempSync(join(tmpdir(), "mph-proj-"));
  const home = mkdtempSync(join(tmpdir(), "mph-home-"));
  const mk = (root: string, name: string, fm: string, body = "Do the thing.") => { mkdirSync(join(root, name), { recursive: true }); writeFileSync(join(root, name, "SKILL.md"), `---\n${fm}\n---\n${body}\n`); };
  mk(join(proj, ".agents/skills"), "ck-query", "name: ck-query\ndescription: Query ClickHouse via the ck CLI");
  mk(join(home, ".claude/skills"), "ck-query", "name: ck-query\ndescription: user copy (shadowed)");
  mk(join(home, ".codex/skills"), "release", "name: release\ndescription: >\n  Cut a release\n  with notes\nrequires: [definitely-not-a-cli-xyz]");
  mk(join(home, ".claude/skills/synced"), "grouped", "name: grouped\ndescription: in a group folder");
  writeFileSync(join(proj, "AGENTS.md"), "Use pnpm, not npm.");
  const skills = discoverSkills(proj, proj, { ...process.env, HOME: home });
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.ok(byName["ck-query"].description.startsWith("Query ClickHouse") && byName["ck-query"].origin === "project");
  assert.equal(byName.release.description, "Cut a release with notes");
  assert.deepEqual(byName.release.missing, ["definitely-not-a-cli-xyz"]);
  assert.ok(byName.grouped);
  const idx = renderSkillIndex(skills, 10_000);
  assert.ok(idx.includes("- release: Cut a release with notes (unavailable: missing definitely-not-a-cli-xyz)"));
  assert.ok(renderSkillIndex(skills, 60).includes("also available"));
  assert.deepEqual(parseFrontmatter("---\nrequires:\n  - gh\n  - jq\n---\nx").meta.requires, ["gh", "jq"]);
  assert.ok(projectInstructions(proj, proj, 1000).includes("Use pnpm, not npm."));
});

test("models: gpt-5.6-luna is the small model on ChatGPT OAuth; own endpoints default to the main model; settings override", () => {
  saveConfigFile({});
  const codex = resolveModels({}, {});
  assert.deepEqual([codex.main, codex.mid, codex.small], ["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-luna"]);
  const own = resolveModels({}, { MPH_OPENAI_BASE_URL: "http://x/v1", MPH_MODEL: "qwen3.7-plus" });
  assert.deepEqual([own.main, own.small], ["qwen3.7-plus", "qwen3.7-plus"]);
  saveConfigFile({ small_model: "gpt-5.4-nano", memory: { recall: false } });
  assert.equal(resolveModels({}, {}).small, "gpt-5.4-nano");
  assert.equal(resolveModels({ small_model: "knob-wins" }, {}).small, "knob-wins");
  assert.deepEqual(memorySettings({}), { recall: false, write: true, codex: true });
  assert.deepEqual(memorySettings({ MPH_MEMORY_RECALL: "1", MPH_MEMORY_WRITE: "off", MPH_MEMORY_CODEX: "0" }), { recall: true, write: false, codex: false });
  saveConfigFile({});
});

test("tools: multi_edit is all-or-nothing; ls skips noise; grep groups by file", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mph-tools-"));
  mkdirSync(join(ws, "node_modules/x"), { recursive: true }); mkdirSync(join(ws, "src"));
  writeFileSync(join(ws, "src/a.py"), "a = 1\nb = 2\nc = 3\n"); writeFileSync(join(ws, "node_modules/x/i.js"), "a = 1");
  const ctx: any = { cwd: ws, knobs: K, store, sessionId: "t", filesTouched: new Set(), readCache: new Map(), cmdCache: new Map(), jobs: new Map() };
  assert.match(await executeTool(ctx, "multi_edit", { path: "src/a.py", edits: [{ old: "a = 1", new: "a = 10" }, { old: "nope", new: "x" }] }, "1"), /nothing written/);
  assert.equal(readFileSync(join(ws, "src/a.py"), "utf8"), "a = 1\nb = 2\nc = 3\n");
  assert.match(await executeTool(ctx, "multi_edit", { path: "src/a.py", edits: [{ old: "a = 1", new: "a = 10" }, { old: "c = 3", new: "c = 30" }] }, "2"), /2 edit/);
  assert.equal(readFileSync(join(ws, "src/a.py"), "utf8"), "a = 10\nb = 2\nc = 30\n");
  const ls = await executeTool(ctx, "ls", {}, "3");
  assert.ok(ls.includes("src/a.py") && !ls.includes("node_modules"));
  const g = await executeTool(ctx, "grep", { pattern: "b = \\d" }, "4");
  assert.ok(g.includes("src/a.py (1)") && g.includes("2: b = 2") && !g.includes("node_modules"), g);
  // the grep tool uses ripgrep when it is installed, so the path taken without it
  // needs its own test: shelling out to grep instead made `\d` match on macOS and
  // not under GNU grep, which passed here and failed in CI
  const fb = grepTree(ws, /b = \d/);
  assert.equal(fb.length, 1, fb.join("|"));
  assert.match(fb[0], /src\/a\.py:2:b = 2$/);
  assert.equal(grepTree(ws, /a = /).length, 1, "node_modules is skipped here too");
  assert.equal(grepTree(ws, /= /, globToRe("*.js")).length, 0, "the glob is applied");
  assert.equal(grepTree(ws, /= /, globToRe("*.py")).length, 3);
  assert.match(await executeTool(ctx, "remember", { type: "fact", title: "x" }, "5"), /turned off/);
});

/** mock that serves the main loop, the gate, the memory extractor and the card writer */
function multiMock(main: (body: any, n: number) => { output: any[] }, extra: { gate?: (body: any) => string; extract?: (body: any) => string } = {}) {
  const seen = { main: [] as any[], gate: [] as any[], extract: [] as any[], card: [] as any[] };
  let n = 0;
  return startMock((body) => {
    const ins = String(body.instructions ?? "");
    if (ins.startsWith("You prepare the context")) { seen.gate.push(body); return { output: [msg(extra.gate?.(body) ?? '{"action":"continue","memory_ids":[],"detail_ids":[],"skills":[]}')] }; }
    if (ins.startsWith("You maintain the long-term memory")) { seen.extract.push(body); return { output: [msg(extra.extract?.(body) ?? '{"items":[]}')] }; }
    if (ins.startsWith("Condense")) { seen.card.push(body); return { output: [msg("card")] }; }
    seen.main.push(body);
    return main(body, n++);
  }).then((m) => ({ ...m, seen }));
}

test("multi-turn conversation: user words in every request, pinned constraints carried, gate carries or rebuilds, memory tools, fork keeps the transcript", async () => {
  const ws = mkdtempSync(join(tmpdir(), "mph-conv-"));
  writeFileSync(join(ws, "calc.py"), "def add(a, b):\n    return a + b\n");
  const mock = await multiMock((body, n) => {
    if (n === 0) return { output: [call("edit", { path: "calc.py", old: "return a + b", new: "return a + b  # checked" }, "c1"), call("remember", { type: "decision", title: "calc.add keeps two positional args", body: "user forbids signature changes", links: ["calc.py"] }, "c2")] };
    if (n === 1) return { output: [msg("Done: calc.py annotated; add signature unchanged.")] };
    if (n === 2) return { output: [msg("The log shows the db shard connection failing.")] };
    if (n === 3) return { output: [call("memory_search", { query: "calc.add" }, "c3")] };
    if (n === 4) { const id = /\[(m\d+) decision\]/.exec(JSON.stringify(body.input))?.[1] ?? "m1"; return { output: [call("memory_get", { ids: [id] }, "c4")] }; }
    if (n === 5) return { output: [msg("We decided to keep two positional args.")] };
    return { output: [msg("ok")] };
  }, { extract: () => '{"items":[{"op":"new","type":"attempt","title":"annotating add with a comment was enough","body":"no refactor needed"}]}' });
  process.env.MPH_OPENAI_BASE_URL = mock.url + "/v1";
  const knobs = resolveKnobs({ main_model: "mock-main", small_model: "mock-small", answer_verbatim_turns: 1, paste_externalize_tokens: 500 });
  const ledger = new Ledger(join(HOME, "ledger-mt.jsonl"));
  const router = new Router(knobs, ledger);
  const memory = new MemoryStore(join(HOME, "mem-conv.db"));
  const opts = { knobs, store, ledger, router, memory, memorySettings: { recall: true, write: true }, skills: [] as any[] };
  const s = newSession(ws, "conv"); saveSession(s);

  const u0 = "记住：回答一律用中文。不要修改 add 的签名。请给 calc.py 的 add 加个注释。";
  const r0 = await runTurn({ session: s, userText: u0, ...opts });
  assert.equal(r0.gate!.action, "rebuild"); assert.equal(r0.fidelity, true);
  assert.ok(r0.memory!.written.length >= 3, `written ${r0.memory!.written}`);   // 2 rule quotes + remember + extract
  assert.ok(memory.list({ pinned: true }).some((e) => e.quote === "不要修改 add 的签名。"));

  const u1 = "帮我看看这个日志：\n" + bigLog + "\n是哪里出的问题？";
  const r1 = await runTurn({ session: s, userText: u1, ...opts });
  assert.equal(r1.fidelity, true);
  const req1 = mock.seen.main.at(-1);
  const req1Text = JSON.stringify(req1.input);
  assert.ok(req1Text.includes("always in force") && req1Text.includes("不要修改 add 的签名。"), "pinned constraint in the briefing");
  assert.ok(req1Text.includes("worker-399"), "the paste is verbatim in its own turn");

  // turn 2 refers back -> continue; the previous turn had no tools, so nothing to carry from it but the rule still says continue
  const u2 = "刚才那个 calc.add 我们是怎么决定的？";
  const r2 = await runTurn({ session: s, userText: u2, ...opts });
  assert.equal(r2.gate!.action, "continue"); assert.equal(r2.fidelity, true);
  assert.equal(r2.text, "We decided to keep two positional args.");
  const req2 = mock.seen.main.at(-1); const req2Text = JSON.stringify(req2.input);
  // user words of every turn present; turn 1 is still inside the epoch (the last completed turn), so its paste is verbatim
  for (const u of [u0, "帮我看看这个日志：", "是哪里出的问题？", u2]) assert.ok(req2Text.includes(JSON.stringify(u).slice(1, -1)), `missing: ${u.slice(0, 30)}`);
  assert.ok(req2Text.includes("worker-200 "));
  // turn 0's answer is a card now (epoch 1)
  assert.ok(req2.input.some((x: any) => x.role === "assistant" && /Done: calc.py annotated/.test(x.content[0].text)));
  // memory_get of an entry that was not in the briefing counts as a miss only if it was not shown
  assert.ok(Array.isArray(r2.memory!.misses));
  const toolNames = req2.tools.map((t: any) => t.name);
  for (const t of ["remember", "memory_search", "memory_get", "skill", "grep", "ls", "multi_edit"]) assert.ok(toolNames.includes(t), t);
  assert.ok(!toolNames.includes("state_update"));

  // ledger has gate / memory rows and no fidelity violation
  const rows = readFileSync(join(HOME, "ledger-mt.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.filter((r) => r.event === "gate").length, 3);
  assert.equal(rows.filter((r) => r.event === "memory").length, 3);
  assert.equal(rows.filter((r) => r.event === "fidelity").length, 0);

  // cold cache -> rebuild even with a back-reference
  s.turns.at(-1)!.endedAt = new Date(Date.now() - 4 * 3600_000).toISOString();
  const r3 = await runTurn({ session: s, userText: "刚才那个再确认一下", ...opts });
  assert.equal(r3.gate!.action, "rebuild"); assert.match(r3.gate!.why, /cache cold/);
  // now turn 1 is outside the epoch: its big paste is a stub, the user's words around it are verbatim
  const req3Text = JSON.stringify(mock.seen.main.at(-1).input);
  assert.ok(req3Text.includes("[pasted log") && !req3Text.includes("worker-200 ") && req3Text.includes("帮我看看这个日志：") && req3Text.includes("是哪里出的问题？"));
  assert.equal(r3.fidelity, true);

  // recall off: no memory in the briefing, memory tools say so; writes still allowed
  const r4 = await runTurn({ session: s, userText: "随便说点什么", ...opts, memorySettings: { recall: false, write: true } });
  assert.equal(r4.memory!.recalled.length, 0);
  assert.ok(!JSON.stringify(mock.seen.main.at(-1).input).includes("always in force"));

  // fork keeps the transcript and the turn numbering; merge brings back the branch's words verbatim
  const b = forkSession(s, "side");
  const rb = await runTurn({ session: b, userText: "分支上的一个问题：add 能处理字符串吗？", ...opts });
  assert.equal(rb.fidelity, true);
  assert.ok(JSON.stringify(mock.seen.main.at(-1).input).includes(JSON.stringify(u0).slice(1, -1)), "branch sees the parent's words");
  const blk = mergeSession(b, s);
  assert.ok(blk.text.includes("分支上的一个问题：add 能处理字符串吗？"));
  memory.close(); await mock.close();
});

test("mph run --json reads stdin, emits events and a result line, exit code 0", async () => {
  const mock = await multiMock(() => ({ output: [msg("pong")] }));
  const ws = mkdtempSync(join(tmpdir(), "mph-cli-"));
  // async spawn: the mock server lives in this process, so a blocking spawnSync would deadlock it
  const r = await new Promise<{ stdout: string; stderr: string; status: number | null }>((res) => {
    const p = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src/harness/cli.ts"), "run", "-", "--json", "--cwd", ws, "--model", "mock-main"], {
      env: { ...process.env, MPH_HOME: mkdtempSync(join(tmpdir(), "mph-cli-home-")), MPH_OPENAI_BASE_URL: mock.url + "/v1", MPH_MEMORY_WRITE: "0" },
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => res({ stdout, stderr, status }));
    p.stdin.end("ping");
  });
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  const result = lines.at(-1);
  assert.equal(result.type, "result"); assert.equal(result.text, "pong"); assert.equal(result.exit, 0); assert.equal(result.fidelity, true);
  assert.equal(result.gate.action, "rebuild");
  assert.ok(lines.some((l) => l.type === "text" && l.delta === "pong"));
  assert.equal(r.status, 0, r.stderr.slice(-500));
  assert.ok(!existsSync(join(ws, ".mph")), "nothing written into the workspace");
  await mock.close();
});
