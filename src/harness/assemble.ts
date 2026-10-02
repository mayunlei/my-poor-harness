/**
 * Request assembly for multi-turn sessions (docs/MEMORY_DESIGN.md §1). Segments, most
 * stable first so the prefix cache survives across turns:
 *
 *   S1 instructions   fixed prompt · skill index · project instructions        (instructions field)
 *   S2 transcript     every past turn: the user's words + the answer / card    (append-only)
 *   S3 carried work   the previous turn's folded working set — only on "continue",
 *                     placed between the last user message and its answer (its real position)
 *   S4 briefing       workspace digest · merged branches · memory L0/L1/L2 · preloaded skills
 *   S5 user message   verbatim
 *   S6 this turn      tool calls and outputs (the loop appends these)
 */
import { countTokens } from "../core/tokens.js";
import { contentText } from "../core/items.js";
import { renderSummary } from "../core/summary.js";
import type { SessionData } from "./session.js";

export const MULTI_TURN_PROMPT = `You are a coding agent in a long-running conversation with a developer, working in their workspace with tools.

Context you are given:
- The conversation so far: every earlier user message verbatim, and earlier answers (older ones condensed to cards; recall(id) shows the full text). Pasted logs/code from older turns may be stubs with recall(id).
- A turn briefing before the new message: workspace state, memories (constraints and preferences in force, possibly relevant entries), and sometimes the previous turn's tool work.
- Earlier tool outputs you no longer see verbatim appear as stubs like [output #id …]; use recall(id, grep=…) when you need the detail.

Rules:
- The user's constraints and preferences (from the conversation and from memory) stay in force until the user explicitly lifts them. If a new request conflicts with one, do not make the conflicting change: point out the conflict and either ask, or do a version that keeps the constraint (for example a new function instead of changing a signature). A request that merely conflicts is not a lift; "ignore the earlier rule" or "yes, change it anyway" is.
- run(cmd) blocks until the command exits. Never poll: for long processes use run(background=true) then wait(job, until=regex|silence).
- Use read/grep/ls for code, edit/multi_edit/write_file for changes. Issue independent tool calls together.
- Do not re-read files you have not changed. Keep tool output small: line ranges, grep limits, test commands that print failures only.
- Memory: memory_search(query) and memory_get(ids) look things up. remember(type, title, body, links, quote) saves what future turns or sessions need and the code does not show: a decision and why, a constraint or preference (quote the user's exact words), an approach that failed and why, a non-obvious code fact (link the file), an open question, a procedure. Do not save trivia.
- Skills: when a listed skill covers the task, load it with skill(name) and follow it.
- Prefer delegate(task, inputs, acceptance) for bounded, self-contained subtasks.
- Do not send commentary-only responses; every response either calls tools or gives the final answer.
- Final answer: lead with the outcome in one or two sentences, then name files changed, what was verified and what was not, and open items.`;

export interface BriefingParts { workspace?: string; merged?: string; memory?: string; skills?: string; gate?: string; userTextWarning?: string }

export function renderBriefing(p: BriefingParts): string {
  const blocks = ["[turn briefing — context for the next user message, not written by the user]"];
  if (p.gate) blocks.push(p.gate);
  if (p.workspace) blocks.push(p.workspace);
  if (p.merged) blocks.push(p.merged);
  if (p.memory) blocks.push(p.memory);
  if (p.skills) blocks.push(p.skills);
  if (p.userTextWarning) blocks.push(p.userTextWarning);
  return blocks.join("\n\n");
}

export function workspaceDigest(session: SessionData): string | undefined {
  if (!session.turns.length && !session.state.filesTouched.length) return undefined;
  return renderSummary(session.state, session.window.filter((x) => x.type === "function_call_output").length).replace("[context digest — earlier tool outputs were folded into stubs; use recall(id) to expand any of them]", "## Workspace state");
}

export function mergedBlocks(session: SessionData): string | undefined {
  if (!session.merged.length) return undefined;
  return session.merged.map((m) => `## Merged from branch "${m.fromTitle}" (${m.at.slice(0, 16)})\n${m.text}`).join("\n\n");
}

/** keep the tail of the carried working set within a token budget, never splitting a call from its output */
export function capCarried(items: any[], budget: number): any[] {
  let used = 0; const out: any[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const t = countTokens(JSON.stringify(items[i]));
    if (used + t > budget) break;
    used += t; out.unshift(items[i]);
  }
  // drop leading outputs whose call was cut, and leading calls whose output was cut cannot happen (tail)
  const calls = new Set(out.filter((x) => x.type === "function_call" || x.type === "custom_tool_call").map((x) => x.call_id));
  return out.filter((x) => !(x.type === "function_call_output" || x.type === "custom_tool_call_output") || calls.has(x.call_id));
}

export interface Assembled { input: any[]; segments: Record<"S2" | "S3" | "S4" | "S5", number> }

export function assembleInput(o: { transcript: any[]; carried: any[]; briefing: string; userText: string }): Assembled {
  const s2 = [...o.transcript];
  if (o.carried.length) {
    // the carried calls belong between the last user message and that turn's answer
    let lastAnswer = -1;
    for (let i = s2.length - 1; i >= 0; i--) if (s2[i]?.role === "assistant") { lastAnswer = i; break; }
    if (lastAnswer >= 0) s2.splice(lastAnswer, 0, ...o.carried); else s2.push(...o.carried);
  }
  const briefing = { type: "message", role: "user", content: [{ type: "input_text", text: o.briefing }] };
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: o.userText }] };
  const tok = (xs: any[]) => xs.reduce((a, x) => a + countTokens(x.type === "message" ? contentText(x.content) : JSON.stringify(x)), 0);
  return { input: [...s2, briefing, user], segments: { S2: tok(o.transcript), S3: tok(o.carried), S4: countTokens(o.briefing), S5: countTokens(o.userText) } };
}
