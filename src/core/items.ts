/**
 * Item model: a normalized view of a Responses API `input` array.
 * The rewrite pass works on Items and converts back to Responses items.
 * Conversion must be lossless for items we do not touch.
 */
import { createHash } from "node:crypto";

export type Tag = "error" | "traceback" | "test" | "poll-empty" | "poll" | "read" | "dup" | "search" | "git" | "run" | "noise";

export interface BaseItem {
  /** index in the original input array */
  idx: number;
  /** original Responses item (passed through untouched when not rewritten) */
  raw: any;
  /** turn number (0-based, increments on each user message) */
  turn: number;
}

export interface SystemItem extends BaseItem { kind: "system"; text: string; role: "system" | "developer"; }
export interface UserItem extends BaseItem { kind: "user"; text: string; }
export interface AssistantItem extends BaseItem { kind: "assistant"; text: string; }
export interface ReasoningItem extends BaseItem { kind: "reasoning"; id?: string; }
export interface CallItem extends BaseItem { kind: "call"; callId: string; tool: string; args: string; argsObj: any; command?: string; }
export interface OutputItem extends BaseItem {
  kind: "output";
  callId: string;
  text: string;
  tool?: string;
  command?: string;
  tags: Set<Tag>;
  /** canonical read target when tool call was a file read */
  readKey?: string;
  exitCode?: number | null;
}
export interface StubItem extends BaseItem { kind: "stub"; callId: string; summary: string; artifactId: string; }
export interface OtherItem extends BaseItem { kind: "other"; }

export type Item = SystemItem | UserItem | AssistantItem | ReasoningItem | CallItem | OutputItem | StubItem | OtherItem;

export function contentText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? c?.input_text ?? "")).join("");
}

export function outputText(output: any): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("");
  if (output && typeof output === "object" && typeof output.text === "string") return output.text;
  return output == null ? "" : JSON.stringify(output);
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

const FIRST_TOKEN = /^\s*(?:cd\s+\S+\s*&&\s*)?(?:[A-Z_]+=\S+\s+)*([A-Za-z0-9_./-]+)/;

export function commandOf(tool: string, argsObj: any): string | undefined {
  if (!argsObj || typeof argsObj !== "object") return undefined;
  if (tool === "exec_command" || tool === "shell" || tool === "exec" || tool === "shell_command" || tool === "bash" || tool === "run") {
    const cmd = argsObj.cmd ?? argsObj.command ?? argsObj.input;
    if (Array.isArray(cmd)) return cmd.join(" ");
    if (typeof cmd === "string") return cmd;
  }
  if (tool === "write_stdin") return `write_stdin ${argsObj.session_id ?? ""} ${JSON.stringify(argsObj.chars ?? "")}`;
  return undefined;
}

export function commandKind(command: string | undefined): string {
  if (!command) return "other";
  const m = FIRST_TOKEN.exec(command);
  const k = m ? m[1].split("/").pop()! : "?";
  if (["sed", "cat", "head", "tail", "nl"].includes(k)) return "read";
  if (["rg", "grep", "find", "ls", "fd", "wc", "tree"].includes(k)) return "search";
  if (["python", "python3", "pytest", "node", "npm", "pnpm", "conda", "bash", "sh", "cargo", "go", "make", "npx", "tsx", "uv"].includes(k)) return "run";
  if (["sleep", "ps", "pgrep", "lsof", "screen", "tmux"].includes(k)) return "poll";
  if (k === "git") return "git";
  if (k === "write_stdin") return "stdin";
  return "other";
}

const READ_RE = /(?:sed\s+-n\s+'?(\d+),(\d+)p'?\s+|(?:cat|nl(?:\s+-ba)?|head(?:\s+-n\s*\d+)?|tail(?:\s+-n\s*\d+)?)\s+)(\S+)/;

/** canonical key for a file read command, e.g. "/path/file.py:1-220" */
export function readKeyOf(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const m = READ_RE.exec(command);
  if (!m) return undefined;
  const file = m[3];
  if (!/\.[A-Za-z0-9]+$/.test(file) && !file.includes("/")) return undefined;
  return m[1] ? `${file}:${m[1]}-${m[2]}` : file;
}

const EXIT_RE = /Process exited with code (\d+)/;

export function parseInput(input: any[]): Item[] {
  const items: Item[] = [];
  let turn = -1;
  const callTool = new Map<string, { tool: string; command?: string }>();
  input.forEach((raw, idx) => {
    const type = raw?.type ?? (raw?.role ? "message" : undefined);
    if (type === "message" || (raw?.role && raw?.content !== undefined)) {
      const role = raw.role;
      const text = contentText(raw.content);
      if (role === "user") {
        // Codex injects AGENTS.md / environment blocks as user messages; keep turn counting on real messages only
        const injected = text.startsWith("<") || text.startsWith("# AGENTS.md");
        if (!injected) turn++;
        items.push({ kind: "user", idx, raw, turn: Math.max(turn, 0), text });
      } else if (role === "assistant") {
        items.push({ kind: "assistant", idx, raw, turn: Math.max(turn, 0), text });
      } else {
        items.push({ kind: "system", idx, raw, turn: Math.max(turn, 0), text, role: role === "system" ? "system" : "developer" });
      }
      return;
    }
    const t = Math.max(turn, 0);
    if (type === "reasoning") { items.push({ kind: "reasoning", idx, raw, turn: t, id: raw.id }); return; }
    if (type === "function_call" || type === "custom_tool_call") {
      const args = type === "function_call" ? (raw.arguments ?? "") : (raw.input ?? "");
      let argsObj: any = undefined;
      try { argsObj = typeof args === "string" ? JSON.parse(args) : args; } catch { argsObj = undefined; }
      const tool = raw.name ?? "";
      let command = commandOf(tool, argsObj);
      if (command === undefined && type === "custom_tool_call" && typeof args === "string" && ["exec", "shell", "bash", "exec_command"].includes(tool)) {
        const m = /exec_command\(\{\s*cmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(args);
        if (m) { try { command = m[1].startsWith("`") ? m[1].slice(1, -1) : JSON.parse(m[1].startsWith("'") ? '"' + m[1].slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"' : m[1]); } catch { command = m[1].slice(1, -1); } }
        else command = args;
      }
      callTool.set(raw.call_id, { tool, command });
      items.push({ kind: "call", idx, raw, turn: t, callId: raw.call_id, tool, args: typeof args === "string" ? args : JSON.stringify(args), argsObj, command });
      return;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const text = outputText(raw.output);
      const meta = callTool.get(raw.call_id);
      const m = EXIT_RE.exec(text.slice(0, 300));
      items.push({
        kind: "output", idx, raw, turn: t, callId: raw.call_id, text, tool: meta?.tool, command: meta?.command,
        tags: new Set<Tag>(), readKey: readKeyOf(meta?.command), exitCode: m ? Number(m[1]) : null,
      });
      return;
    }
    items.push({ kind: "other", idx, raw, turn: t });
  });
  return items;
}

/** Build a Responses API item from an Item (after rewrite). */
export function toResponsesItem(it: Item): any {
  switch (it.kind) {
    case "stub":
      return { type: "function_call_output", call_id: it.callId, output: it.summary };
    case "output": {
      // if text was changed by shaping, emit the shaped text
      const original = outputText(it.raw.output);
      if (original === it.text) return it.raw;
      return { ...it.raw, output: it.text };
    }
    default:
      return it.raw;
  }
}

export function toResponsesInput(items: Item[]): any[] {
  return items.map(toResponsesItem);
}
