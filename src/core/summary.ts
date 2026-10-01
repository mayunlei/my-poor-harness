/**
 * State summary S: deterministic digest of the folded region. Model-written
 * notes (state_update) can be merged in by the harness; the proxy uses only
 * the deterministic part plus an optional T2 small-model summary.
 */
import type { Item, OutputItem, CallItem } from "./items.js";
import { commandKind } from "./items.js";

export interface StateSummary {
  filesTouched: string[];
  commandsByKind: Record<string, number>;
  errorsSeen: string[];
  lastTestStatus?: string;
  turns: number;
  notes?: string;          // model-written state_update, if any
  modelSummary?: string;   // T2 summary, if any
}

const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const TEST_SUMMARY_RE = /^(=+ .*(?:passed|failed|error).* =+|Ran \d+ tests?.*|FAILED \(.*\)|OK(?: \(.*\))?|Tests:\s+.*|\d+ passing.*|\d+ failing.*)$/m;

export function buildSummary(items: Item[], prior?: StateSummary): StateSummary {
  const files = new Set<string>(prior?.filesTouched ?? []);
  const cmds: Record<string, number> = { ...(prior?.commandsByKind ?? {}) };
  const errors: string[] = [...(prior?.errorsSeen ?? [])];
  let lastTest = prior?.lastTestStatus;
  let turns = prior?.turns ?? 0;
  for (const it of items) {
    if (it.kind === "user") turns = Math.max(turns, it.turn + 1);
    if (it.kind === "call") {
      const c = it as CallItem;
      if (c.tool === "apply_patch") { for (const m of c.args.matchAll(PATCH_FILE_RE)) files.add(m[1].trim()); }
      if (c.tool === "write_file" || c.tool === "edit" || c.tool === "replace_in_file") { const p = c.argsObj?.path ?? c.argsObj?.file; if (p) files.add(String(p)); }
      const k = commandKind(c.command);
      cmds[k] = (cmds[k] ?? 0) + 1;
    }
    if (it.kind === "output") {
      const o = it as OutputItem;
      if (o.tags.has("error")) {
        const line = o.text.split("\n").find((l) => /Error|Exception|FAILED|fatal/.test(l));
        if (line) { const s = line.trim().slice(0, 160); if (!errors.includes(s)) errors.push(s); }
      }
      if (o.tags.has("test")) { const m = TEST_SUMMARY_RE.exec(o.text); if (m) lastTest = m[1].trim().slice(0, 160); }
    }
  }
  return { filesTouched: [...files].slice(-40), commandsByKind: cmds, errorsSeen: errors.slice(-10), lastTestStatus: lastTest, turns, notes: prior?.notes, modelSummary: prior?.modelSummary };
}

export function renderSummary(s: StateSummary, stubsCount: number): string {
  const lines: string[] = ["[context digest — earlier tool outputs were folded into stubs; use recall(id) to expand any of them]"];
  lines.push(`turns so far: ${s.turns}; folded outputs: ${stubsCount}`);
  if (s.filesTouched.length) lines.push(`files edited: ${s.filesTouched.join(", ")}`);
  const cmd = Object.entries(s.commandsByKind).map(([k, v]) => `${k}=${v}`).join(" ");
  if (cmd) lines.push(`commands run: ${cmd}`);
  if (s.lastTestStatus) lines.push(`last test status: ${s.lastTestStatus}`);
  if (s.errorsSeen.length) lines.push(`errors seen: ${s.errorsSeen.map((e) => `"${e}"`).join("; ")}`);
  if (s.modelSummary) lines.push(`summary: ${s.modelSummary}`);
  if (s.notes) lines.push(`state notes: ${s.notes}`);
  return lines.join("\n");
}
