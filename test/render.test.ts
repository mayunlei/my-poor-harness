/**
 * The renderer's job is to keep Apple Terminal alive while mph streams, so these
 * tests are mostly invariants about what reaches the pty: one write per flush, no
 * half-written lines, nothing wider than the window, no escape sequences except the
 * ones we emit ourselves for the status line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Renderer, cutToWidth, displayWidth, ellipsize, sanitize, wrapToWidth } from "../src/harness/render.js";
import { uiSettings } from "../src/upstream/config.js";

/** a pty stand-in that records every write separately */
function fakeTty(columns = 40) {
  const writes: string[] = [];
  return {
    out: { write: (s: string) => { writes.push(s); return true; }, isTTY: true, columns, on: () => {} },
    writes,
    get text() { return writes.join(""); },
    /** what the terminal would show, with our own control sequences taken back out */
    get visible() { return writes.join("").replace(/\r\u001b\[2K/g, "").replace(/\u001b\[[0-9;]*m/g, ""); },
  };
}

function mk(f: ReturnType<typeof fakeTty>, ui: Partial<import("../src/harness/render.js").UiSettings> = {}) {
  return new Renderer({ out: f.out, tty: true, width: f.out.columns, ui: { flushMs: 0, ...ui } });
}

test("displayWidth counts CJK as two columns and marks as none", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("当前的cli"), 9);          // 3 wide + 3 narrow
  assert.equal(displayWidth("é"), 1);
  assert.equal(displayWidth("工具列表太长"), 12);
});

test("cutToWidth and ellipsize never exceed the budget or split a pair", () => {
  assert.equal(displayWidth(cutToWidth("当前的cli不是很友好", 7)), 7);   // 当前的 + c
  assert.equal(cutToWidth("ab\u{1F600}", 3), "ab");      // the emoji is 2 wide: dropped
  assert.ok(displayWidth(ellipsize("当前的cli不是很友好，比如工具列表太长", 10)) <= 10);
  assert.equal(ellipsize("short", 10), "short");
});

test("wrapToWidth bounds every line, which is what stops Terminal reflowing", () => {
  const long = "状态栏需要展示 token 消耗、延时和任务标题，".repeat(6);
  for (const l of wrapToWidth(long, 38)) assert.ok(displayWidth(l) <= 38, JSON.stringify(l));
  assert.deepEqual(wrapToWidth("a b c", 80), ["a b c"]);
  assert.deepEqual(wrapToWidth("hello world again", 11), ["hello world", "again"]);
});

test("sanitize strips escapes, C0 controls and lone surrogates", () => {
  assert.equal(sanitize("a\u001b[2Kb"), "ab");
  assert.equal(sanitize("a\u001b]0;title\u0007b"), "ab");
  assert.equal(sanitize("a\u001b[?1049hb"), "ab");
  assert.equal(sanitize("a\u0000\u0007b\tc\nd"), "ab\tc\nd");
  // what JSON.stringify(args).slice(0, 120) produces all by itself
  assert.equal(sanitize("ok \ud83d"), "ok �");
  assert.equal(sanitize("\ude00 ok"), "� ok");
  assert.equal(sanitize("\u{1F600}"), "\u{1F600}");
});

test("streamed text is emitted a whole line at a time, never a fragment", () => {
  const f = fakeTty(40);
  const r = mk(f, { statusBar: false });
  for (const ch of "hello world") r.text(ch);
  assert.equal(f.text, "", "no newline yet: nothing may reach the terminal");
  r.text("\n");
  assert.equal(f.text, "hello world\n");
  r.text("tail with no newline");
  assert.equal(f.text, "hello world\n");
  r.endText();
  assert.equal(f.text, "hello world\ntail with no newline\n");
});

test("a long unbroken paragraph still appears, wrapped to the window", () => {
  const f = fakeTty(20);
  const r = mk(f, { statusBar: false });
  r.text("当前的cli不是很友好，比如工具列表太长，没有折叠；");
  r.endText();
  for (const l of f.visible.split("\n")) assert.ok(displayWidth(l) <= 19, JSON.stringify(l));
  assert.equal(f.visible.replace(/\n/g, ""), "当前的cli不是很友好，比如工具列表太长，没有折叠；");
});

test("one write per flush, so the text storage mutates once per batch", () => {
  const f = fakeTty(60);
  const r = new Renderer({ out: f.out, tty: true, width: 60, ui: { flushMs: 1000, statusBar: false } });
  for (const ch of "a line of streamed text\n".repeat(5)) r.text(ch);
  assert.equal(f.writes.length, 0, "nothing until the flush window closes");
  r.flushNow();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].split("\n").length - 1, 5);
});

test("tool calls fold into one line per step, and /verbose expands them", () => {
  const f = fakeTty(80);
  const r = mk(f, { statusBar: false });
  r.turnStart({ title: "fold the tool list", model: "m", maxSteps: 24 });
  r.stepStart(1);
  for (const t of ["read", "read", "grep", "ls"]) r.event({ kind: "tool", detail: `${t} {"path":"src"}` });
  r.event({ kind: "dedupe", detail: "src/a.ts:1-20" });
  r.stepStart(2);
  const folded = f.visible;
  assert.match(folded, /step 1\s+4 tools \(read x2, grep, ls\)\s+1 dedupe/);
  assert.ok(!folded.includes('{"path":"src"}'), "folded mode must not print the arguments");

  const g = fakeTty(80);
  const v = new Renderer({ out: g.out, tty: true, width: 80, ui: { flushMs: 0, statusBar: false }, verbose: true });
  v.turnStart({ title: "t", model: "m", maxSteps: 1 });
  v.stepStart(1);
  v.event({ kind: "tool", detail: 'read {"path":"src/harness/cli.ts"}' });
  assert.match(g.visible, /> read \{"path":"src\/harness\/cli\.ts"\}/);
});

test("the batch line is dropped when the fold line already says the same thing", () => {
  const f = fakeTty(80);
  const r = mk(f, { statusBar: false });
  r.turnStart({ title: "t", model: "m", maxSteps: 2 });
  r.stepStart(1);
  r.event({ kind: "batch", detail: "4 tool calls in one response (4 at a time): ls, grep, read ×2" });
  for (const t of ["ls", "grep", "read", "read"]) r.event({ kind: "tool", detail: t + " {}" });
  r.turnEnd();
  assert.ok(!f.visible.includes("in one response"), f.visible);
  assert.match(f.visible, /4 tools \(ls, grep, read x2\)/);

  const g = fakeTty(80);
  const v = new Renderer({ out: g.out, tty: true, width: 80, ui: { flushMs: 0, statusBar: false }, verbose: true });
  v.event({ kind: "batch", detail: "4 tool calls in one response" });
  assert.match(g.visible, /4 tool calls in one response/);
});

test("loud events are never folded away", () => {
  const f = fakeTty(80);
  const r = mk(f, { statusBar: false });
  r.turnStart({ title: "t", model: "m", maxSteps: 1 });
  r.event({ kind: "warn", detail: "memory extraction failed: 400" });
  r.event({ kind: "gate", detail: "rebuild (rule: nothing to carry)" });
  assert.match(f.visible, /! memory extraction failed: 400/);
  assert.match(f.visible, /\? rebuild \(rule: nothing to carry\)/);
});

test("the status bar carries the title, tokens and latency, and fits the window", () => {
  for (const cols of [120, 80, 60, 40, 24]) {
    const f = fakeTty(cols);
    const r = mk(f, { color: false });
    r.turnStart({ title: "当前的cli不是很友好，比如工具列表太长", model: "gpt-5.6-sol", maxSteps: 24 });
    r.stepStart(3);
    r.status({ input: 12345, cached: 9000, output: 1200, lastLatencyMs: 2400, phase: "tools" });
    const bar = r.statusText();
    assert.ok(displayWidth(bar) <= cols - 1, `${cols}: ${displayWidth(bar)} ${bar}`);
    assert.ok(bar.includes("12.3k"), bar);                      // shortened, never dropped
    assert.ok(bar.includes("当前"), `the task must survive at ${cols}: ${bar}`);
    if (cols >= 60) assert.match(bar, /73% cached/);
    if (cols >= 80) assert.ok(bar.includes("last 2.4s"), bar);
    if (cols >= 120) assert.ok(bar.includes("step 3/24") && bar.includes("gpt-5.6-sol"), bar);
  }
});

test("the bar is erased before anything prints above it and when it is put away", () => {
  const f = fakeTty(50);
  const r = mk(f, { color: false });
  r.turnStart({ title: "task", model: "m", maxSteps: 4 });
  r.flushNow();
  const first = f.writes.at(-1)!;
  assert.ok(first.startsWith(" task"), first);
  r.line("a result line");
  const second = f.writes.at(-1)!;
  assert.ok(second.startsWith("\r\u001b[2K"), "the bar must be erased first");
  assert.ok(second.includes("a result line\n"));
  assert.ok(second.split("\n").at(-1)!.startsWith(" task"), "and redrawn last");
  r.suspend();
  assert.equal(f.writes.at(-1), "\r\u001b[2K");
  assert.ok(!f.visible.includes("\u001b"), "nothing but the erase and SGR may be escapes");
});

test("no status bar, no wrapping and no escapes when the output is not a tty", () => {
  const writes: string[] = [];
  const r = new Renderer({ out: { write: (s: string) => { writes.push(s); return true; }, isTTY: false } });
  r.turnStart({ title: "piped", model: "m", maxSteps: 1 });
  r.line("x".repeat(300));
  r.text("streamed\n");
  r.turnEnd("  [done]");
  const all = writes.join("");
  assert.ok(!all.includes("\u001b"), all.slice(0, 80));
  assert.equal(all, "x".repeat(300) + "\nstreamed\n  [done]\n");
});

test("turnEnd folds the last step, flushes the answer and leaves the summary", () => {
  const f = fakeTty(60);
  const r = mk(f, { statusBar: false });
  r.turnStart({ title: "t", model: "m", maxSteps: 2 });
  r.stepStart(1);
  r.event({ kind: "tool", detail: "run npm test" });
  r.text("the answer, unterminated");
  r.turnEnd("  [1 steps · in 10 · out 2]");
  const lines = f.visible.trimEnd().split("\n");
  assert.match(lines[0], /step 1\s+1 tool \(run\)/);
  assert.equal(lines[1], "the answer, unterminated");
  assert.equal(lines[2], "  [1 steps · in 10 · out 2]");
});

test("ui settings come from the environment, and TERM=dumb turns the decoration off", () => {
  const base = uiSettings({ MPH_HOME: process.env.MPH_HOME } as any);
  assert.equal(base.statusBar, true);
  assert.equal(base.foldTools, true);
  assert.equal(base.glyphs, "ascii");
  assert.equal(uiSettings({ MPH_UI_STATUS_BAR: "off" } as any).statusBar, false);
  assert.equal(uiSettings({ MPH_UI_FOLD_TOOLS: "0" } as any).foldTools, false);
  assert.equal(uiSettings({ MPH_UI_GLYPHS: "unicode" } as any).glyphs, "unicode");
  assert.equal(uiSettings({ MPH_UI_FLUSH_MS: "250" } as any).flushMs, 250);
  assert.equal(uiSettings({ MPH_UI_FLUSH_MS: "99999" } as any).flushMs, 500);
  assert.equal(uiSettings({ NO_COLOR: "1" } as any).color, false);
  const dumb = uiSettings({ TERM: "dumb", MPH_UI_GLYPHS: "unicode" } as any);
  assert.equal(dumb.statusBar, false);
  assert.equal(dumb.glyphs, "ascii");
});
