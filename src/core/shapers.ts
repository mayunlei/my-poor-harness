/**
 * Shapers: bound tool output before it enters the context while preserving the
 * fields that decide a correct patch (failed command, exception type, assertion
 * diff, traceback tail). Lesson from the April 2026 ablations: naive head/tail
 * truncation (F4) lost exactly those lines and dropped accuracy.
 */
import type { Tag } from "./items.js";
import { countTokens } from "./tokens.js";

export interface ShapeResult {
  text: string;
  tokensBefore: number;
  tokensAfter: number;
  tags: Set<Tag>;
  shaper: string;
  artifactNeeded: boolean;
}

export interface ShaperKnobs {
  perOutputCap: number;        // tokens
  headShare: number;           // 0..1
  rgMaxHits: number;
  logTailLines: number;
  tracebackTailLines: number;
  stripExecHeader: boolean;
}

export const EXEC_HEADER_RE = /^(?:Script completed\n|Script failed[^\n]*\n)?(?:Chunk ID: \S+\n)?(?:Wall time:? [^\n]*\n)?(?:Process exited with code (\d+)\n|Process running[^\n]*\n)?(?:Original token count: \d+\n)?(?:Output:\n)?/;

const ERROR_LINE = /\b(Traceback \(most recent call last\)|Error:|Exception|FAILED|FAIL:|AssertionError|assert |panic:|error\[E\d+\]|TypeError|ReferenceError|SyntaxError|ModuleNotFoundError|ImportError|KeyError|ValueError|npm ERR!|fatal:|segfault)/;
const TEST_SUMMARY = /^(=+ .*(passed|failed|error|skipped).* =+|Ran \d+ tests?|OK\b|FAILED \(|Tests:\s+\d+|Test Suites:|\d+ passing|\d+ failing)/m;
const PYTEST_FAIL_HEADER = /^(_{3,} .+ _{3,}|FAILED .+::.+)/;

export function tagOutput(text: string, command?: string): Set<Tag> {
  const tags = new Set<Tag>();
  const head = text.slice(0, 4000);
  if (ERROR_LINE.test(head) || /Process exited with code [1-9]/.test(head)) tags.add("error");
  if (/Traceback \(most recent call last\)/.test(text)) tags.add("traceback");
  if (TEST_SUMMARY.test(text) || /\b(pytest|npm test|vitest|jest|cargo test|go test)\b/.test(command ?? "")) tags.add("test");
  return tags;
}

function stripHeader(text: string): { body: string; exitCode: number | null; header: string } {
  const m = EXEC_HEADER_RE.exec(text);
  if (!m || m[0].length === 0) return { body: text, exitCode: null, header: "" };
  return { body: text.slice(m[0].length), exitCode: m[1] !== undefined ? Number(m[1]) : null, header: m[0] };
}

function headTail(lines: string[], capTokens: number, headShare: number, keepIdx: Set<number>): string[] {
  // keep failure-critical lines (keepIdx) unconditionally, then fill with head/tail
  const total = lines.length;
  const budgetChars = capTokens * 3.5;
  const kept = new Set<number>(keepIdx);
  let used = 0;
  for (const i of kept) used += lines[i].length + 1;
  const headBudget = Math.max(0, (budgetChars - used) * headShare);
  const tailBudget = Math.max(0, (budgetChars - used) * (1 - headShare));
  let acc = 0;
  for (let i = 0; i < total && acc < headBudget; i++) { if (!kept.has(i)) { kept.add(i); acc += lines[i].length + 1; } }
  acc = 0;
  for (let i = total - 1; i >= 0 && acc < tailBudget; i--) { if (!kept.has(i)) { kept.add(i); acc += lines[i].length + 1; } }
  const out: string[] = [];
  let gap = 0;
  for (let i = 0; i < total; i++) {
    if (kept.has(i)) {
      if (gap > 0) { out.push(`[... ${gap} lines omitted ...]`); gap = 0; }
      out.push(lines[i]);
    } else gap++;
  }
  if (gap > 0) out.push(`[... ${gap} lines omitted ...]`);
  return out;
}

function shapePytest(lines: string[], k: ShaperKnobs): string[] {
  const keep = new Set<number>();
  // summary lines + FAILED lines + traceback tail blocks
  lines.forEach((l, i) => {
    if (TEST_SUMMARY.test(l) || PYTEST_FAIL_HEADER.test(l) || /^E\s{2,}/.test(l) || /^(FAILED|ERROR) /.test(l)) keep.add(i);
  });
  // traceback tails: for each "Traceback" start, keep the last N lines of that block
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/Traceback \(most recent call last\)/.test(lines[i])) start = i;
    const blockEnd = start >= 0 && (i === lines.length - 1 || /^\S.*(Error|Exception)\b/.test(lines[i]));
    if (blockEnd) { for (let j = Math.max(start, i - k.tracebackTailLines); j <= i; j++) keep.add(j); start = -1; }
  }
  return headTail(lines, k.perOutputCap, 0.3, keep);
}

function shapeRg(lines: string[], k: ShaperKnobs): string[] {
  if (lines.length <= k.rgMaxHits) return lines;
  const byFile = new Map<string, number>();
  for (const l of lines) { const f = l.split(":")[0]; byFile.set(f, (byFile.get(f) ?? 0) + 1); }
  const out = lines.slice(0, k.rgMaxHits);
  out.push(`[... ${lines.length - k.rgMaxHits} more hits across ${byFile.size} files; top files: ${[...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f}(${n})`).join(", ")}]`);
  return out;
}

function shapeLog(lines: string[], k: ShaperKnobs): string[] {
  const keep = new Set<number>();
  lines.forEach((l, i) => { if (ERROR_LINE.test(l)) keep.add(i); });
  const tailStart = Math.max(0, lines.length - k.logTailLines);
  for (let i = tailStart; i < lines.length; i++) keep.add(i);
  return headTail(lines, k.perOutputCap, 0.1, keep);
}

export function pickShaper(command: string | undefined, text: string): "pytest" | "rg" | "log" | "git" | "generic" {
  const c = command ?? "";
  if (/\b(pytest|python -m pytest|npm test|vitest|jest|cargo test|go test)\b/.test(c) || /^=+ .*test session starts/m.test(text)) return "pytest";
  if (/\b(rg|grep)\b/.test(c) && !/\|\s*(head|tail|wc)/.test(c)) return "rg";
  if (/\btail\b.*\.(log|out|err|jsonl)\b/.test(c) || /\.log\b/.test(c)) return "log";
  if (/^\s*git\s+(diff|log|show)/.test(c)) return "git";
  return "generic";
}

export function shapeOutput(text: string, command: string | undefined, k: ShaperKnobs): ShapeResult {
  const tokensBefore = countTokens(text);
  const { body, exitCode, header } = k.stripExecHeader ? stripHeader(text) : { body: text, exitCode: null, header: "" };
  const tags = tagOutput(text, command);
  let result = body;
  const prefix = exitCode !== null && exitCode !== 0 ? `[exit ${exitCode}] ` : "";
  const shaper = pickShaper(command, body);
  if (countTokens(body) > k.perOutputCap) {
    const lines = body.split("\n");
    let shaped: string[];
    if (shaper === "pytest") shaped = shapePytest(lines, k);
    else if (shaper === "rg") shaped = shapeRg(lines, k);
    else if (shaper === "log") shaped = shapeLog(lines, k);
    else {
      const keep = new Set<number>();
      lines.forEach((l, i) => { if (ERROR_LINE.test(l)) keep.add(i); });
      shaped = headTail(lines, k.perOutputCap, k.headShare, keep);
    }
    result = shaped.join("\n");
    // hard cap as a last resort
    if (countTokens(result) > k.perOutputCap * 1.5) {
      const chars = Math.floor(k.perOutputCap * 1.5 * 3.5);
      result = result.slice(0, Math.floor(chars * 0.6)) + `\n[... middle truncated ...]\n` + result.slice(-Math.floor(chars * 0.4));
    }
  }
  const out = prefix + result;
  const tokensAfter = countTokens(out);
  return { text: out, tokensBefore, tokensAfter, tags, shaper: tokensAfter < tokensBefore ? shaper : "none", artifactNeeded: tokensAfter < tokensBefore || header.length > 0 };
}

export function isEmptyPoll(text: string): boolean {
  const { body } = stripHeader(text);
  return body.trim().length < 5;
}
