import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { saveToDataset, listDatasets, readIndex, readCase, datasetsDir } from "./dataset.js";
import { runTurn } from "./loop.js";
import { strategyFor, STRATEGIES } from "./strategies/index.js";
import { compareStrategies, formatCompare, saveCompare, loadTasks } from "./compare.js";
import { newSession, saveSession, loadSession, listSessions, findSession, forkSession, mergeSession, discardSession, pruneEmptySessions, type SessionData } from "./session.js";
import { knobsFor, applyKnobChange, resolveKnobs, KNOB_SPECS, PROFILES } from "../core/knobs.js";
import { ArtifactStore } from "../core/artifacts.js";
import { Ledger } from "../core/ledger.js";
import { Router } from "./router.js";
import { initTokenizer } from "../core/tokens.js";
import { runLogin, printWhoami, runLogout } from "../upstream/login_cli.js";
import { loadConfigFile, configPath, resolveUpstream, describeUpstream } from "../upstream/index.js";
import { resolveModels, memorySettings, setConfigValues, maskConfig } from "../upstream/config.js";
import { MemoryStore, MEMORY_TYPES, type MemoryType } from "../memory/store.js";
import { detailBlock, l1Line } from "../memory/recall.js";
import { discoverSkills, loadSkillBody, skillLine } from "../skills/index.js";
import { projectOf } from "../memory/store.js";
import type { GateAction } from "./gate.js";
import { VIBE_PROMPT, VIBE_TOOL_NAMES } from "./vibe.js";
import { loadCredentials } from "../upstream/codex_auth.js";
import { LEDGER_COMMANDS } from "../sidecar/commands.js";
import { Renderer } from "./render.js";
import { uiSettings } from "../upstream/config.js";

const HELP = `mph — one command for the whole harness. State lives in ~/.mph (override with MPH_HOME).
\`mph <command> --help\` has the flags for the bigger ones.

conversation
  chat [--session id] [--cwd dir] [--title t] [--model m] [--profile p]    interactive session with fork/merge
  run "task" | run - | run --prompt-file f     one turn; [--session id | --resume-last] [--cwd dir] [--max-steps n]
                                               [--continue|--new] [--strategy s] [--json]
                                               exit 0 done · 2 step limit · 3 model error · 4 user words lost
  vibe ["what you want"]                       configure the harness by talking to it; /vibe inside chat
  map --task "..." (--items a,b,c | --items-file f) [--parallel 3]         map-reduce, fresh context per item
  compare --tasks f.json[l] [--strategies react,plan_verify] [--copy] [--json out]
  strategies | sessions [--prune] | fork <id> <name> | merge <branch> <main> | discard <id>

datasets (real sessions kept for backtesting a later harness)
  save [<session> | --last] --note "一句话：这个会话用来解决什么问题" [--dataset name] [--id name]
                                               the session with its full per-turn context; /save <note> inside chat
  dataset [list] | dataset <name> | dataset show <name>/<id>

serving
  proxy [--port 8791] [--provider ...] [--verbose]      transparent /v1/responses proxy: keep your current client
  dash [--open] [--once] [--port 8792]                  live dashboard over the ledger (read-only)

the ledger
  report [--since ISO] [--json]                cost, credits, cache, compaction net effect, pass rates
  tune [--scope ...] [--dry-run] | watch [--every 900] | history
  price [--json] | price-probe [--models a,b] [--go]    what a model really costs

settings
  knobs [--project p] [k=v ...]                every threshold, and its history in \`mph history\`
  memory list|search|get|pin|unpin|forget|export|import|gc
  skill list | show <name>
  login | logout | whoami                      ChatGPT (Codex OAuth) login for the built-in upstream
  config [k=v ...]                             provider, base_url, api_key, wire_api, *_model, memory_*
                                               ui_status_bar, ui_fold_tools, ui_glyphs, ui_wrap, ui_flush_ms, ui_color

terminal (any command)
  --verbose                                    one line per tool call instead of one line per step
  --plain                                      no status bar, no colour: for a dumb terminal or a pipe`;

const MODEL_TIERS = ["main", "mid", "small"] as const;
type ModelTier = typeof MODEL_TIERS[number];

const COMMAND_HELP: Record<string, string> = {
  chat: `mph chat — interactive coding session

Usage:
  mph chat [--session ID] [--resume-last] [--cwd DIR] [--title TITLE]
           [--model MODEL] [--profile NAME]

Inside chat, type /help for commands. Useful commands include /model, /vibe,
/fork, /switch, /memory, /compact, /stats, and /quit. With no command, ` +
    `\`mph\` starts chat in the current directory.`,
  run: `mph run — send one prompt and exit

Usage:
  mph run "TASK"
  mph run - < prompt.txt
  mph run --prompt-file FILE

Options:
  --session ID | --resume-last   continue an existing session
  --cwd DIR                     run in another directory
  --model MODEL                 choose the main model for this session
  --profile NAME                use a built-in tuning profile
  --strategy NAME               react or another listed strategy
  --max-steps N                 stop after N model calls
  --continue | --new            choose how the next turn starts
  --json                        emit newline-delimited JSON events and result

Exit codes: 0 done · 2 step limit · 3 model error · 4 user words lost`,
  vibe: `mph vibe — configure mph by talking to it

Usage:
  mph vibe
  mph vibe "turn memory off"

The interactive form accepts natural-language configuration requests. It does
not edit project files or run commands. Use /vibe off inside chat to leave it.`,
  config: `mph config — inspect or change the upstream model settings

Usage:
  mph config
  mph config provider=openai_compatible base_url=https://... api_key=...
  mph config main_model=MODEL mid_model=MODEL small_model=MODEL

Keys: provider, base_url, api_key, wire_api, codex_base_url, codex_models,
main_model, mid_model, small_model, memory_recall, memory_write.
Secrets are masked when displayed. Session-only model changes use /model in chat
or --model with mph run/chat.`,
  model: `Model selection has two scopes:
  mph config main_model=MODEL       save a global default
  mph chat --model MODEL             save it for this session
  /model MODEL                       change it during an interactive session
  /model list                        show main/mid/small and their sources
  /model auto                        return a tier to the provider default`,
  memory: `mph memory — manage long-term memory

Usage:
  mph memory list [--all] [--type TYPE]
  mph memory search QUERY
  mph memory get ID | pin ID | unpin ID | forget ID
  mph memory export [FILE] | import FILE | gc`,
  knobs: `mph knobs — inspect or change token-saving thresholds

Usage:
  mph knobs
  mph knobs key=value ...
  mph knobs --project DIR key=value ...
  mph history                  show knob change history`,
  save: `mph save — preserve a real session for later backtesting

Usage:
  mph save --last --note "what this session solved"
  mph save SESSION_ID --note "what this session solved" [--dataset NAME] [--id ID]

The note is required in practice because it explains why the case was saved.`,
  dataset: `mph dataset — list or inspect saved backtesting cases

Usage:
  mph dataset list
  mph dataset NAME
  mph dataset show NAME/ID`,
  sessions: `mph sessions — list saved sessions

Usage:
  mph sessions
  mph sessions --prune`,
  map: `mph map — run the same task against independent items

Usage:
  mph map --task "summarize {item}" --items a,b,c [--parallel N]
  mph map --task "..." --items-file FILE [--parallel N]`,
  compare: `mph compare — compare strategies on the same task set

Usage:
  mph compare --tasks FILE.jsonl [--strategies react,plan_verify]
              [--max-steps N] [--copy] [--json OUT]`,
};

function helpFor(topic?: string): string {
  if (!topic) return HELP;
  return COMMAND_HELP[topic] ?? `No detailed help for \`${topic}\`. Try \`mph help\` to see all commands.`;
}

const VIBE_BANNER = `vibe on: tell me what you want the harness to do and I will read and change its own settings.
  e.g. "把记忆关掉" · "这个项目上下文给小一点" · "换成我自己的 qwen 端点" · "现在是什么配置"
  I can read the workspace and the settings; I cannot edit your files or run commands here. /vibe off to leave.`;

/** one definition of what vibe mode is: its prompt, its tools, and no memory writes */
const VIBE_TURN = { instructions: VIBE_PROMPT, toolNames: VIBE_TOOL_NAMES, multiTurn: false as const };

function showModels(session: SessionData): void {
  const u = resolveUpstream();
  const m = resolveModels(resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), session.knobs as any), process.env, u);
  console.log(`models (session ${session.id}):`);
  for (const tier of MODEL_TIERS) console.log(`  ${tier.padEnd(5)} ${m[tier]} (${m.source[tier]})`);
  if (u.provider === "codex") console.log(`available: ${u.codexModels.join(", ")}`);
  else console.log("available: endpoint does not advertise a model list; any model id is accepted");
  console.log("usage: /model <model> | /model <main|mid|small> <model> | /model auto");
}

function setSessionModel(session: SessionData, tier: ModelTier, value: string): void {
  const model = value === "auto" ? "" : value;
  session.knobs = { ...(session.knobs ?? {}), [`${tier}_model`]: model };
  saveSession(session);
  const m = resolveModels(resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), session.knobs as any), process.env, resolveUpstream());
  console.log(`${tier} model ${model || "auto"} → ${m[tier]}`);
}

const args = process.argv.slice(2);
const cmd = args[0] ?? "chat";
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = (n: string) => args.includes(n);

/** the words of a command, with flag values (`--cwd X`) left out; `run` and `vibe` both need this */
function positionalAfter(flags: string[]): string[] {
  const skip = new Set<number>();
  for (const f of flags) { const i = args.indexOf(f); if (i >= 0) { skip.add(i); skip.add(i + 1); } }
  return args.slice(1).filter((a, i) => !skip.has(i + 1) && !a.startsWith("--"));
}

/**
 * One renderer per process, and every line of human-facing output goes through it.
 * That is the point: events used to go to stderr while the answer went to stdout,
 * and two fds interleaving on one pty is one of the things that kills Apple
 * Terminal mid-turn (see src/harness/render.ts).
 */
let renderShared: Renderer | undefined;
function renderer(): Renderer {
  if (!renderShared) {
    const plain = flag("--plain") || !!process.env.MPH_PLAIN;
    renderShared = new Renderer({
      ui: plain ? { ...uiSettings(), statusBar: false, color: false, glyphs: "ascii" } : uiSettings(),
      verbose: flag("--verbose"),
    });
  }
  return renderShared;
}

function printEvent(e: { kind: string; detail: string }) { renderer().event(e); }

async function chat(session: SessionData, startInVibe = false) {
  const render = renderer();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  /**
   * ^C used to close the readline interface -- with no SIGINT listener that is what
   * node does -- and the chat then had no prompt and no way back. Now the first ^C
   * clears the line and says so, and a second one within two seconds quits.
   */
  let lastSigint = 0;
  rl.on("SIGINT", () => {
    const now = Date.now();
    if (now - lastSigint < 2000) { render.close(); rl.close(); process.exit(130); }
    lastSigint = now;
    render.suspend();
    process.stdout.write("\n  (^C again to quit, or /quit)\n");
    rl.prompt(true);
  });
  let inputClosed = false;
  rl.once("close", () => { inputClosed = true; });
  const ask = (q: string) => new Promise<string>((resolveAnswer) => {
    let settled = false;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      rl.off("close", onClose);
      resolveAnswer(answer);
    };
    const onClose = () => finish("");
    rl.once("close", onClose);
    rl.question(q, finish);
  });
  console.log(`session ${session.id} (${session.title}) in ${session.cwd}. /help for commands.`);
  let pendingGate: GateAction | undefined;
  let vibe = startInVibe;
  if (vibe) console.log(VIBE_BANNER);
  for (;;) {
    render.suspend();
    const line = (await ask(`\n[${titleOf(session)}${vibe ? " · vibe" : ""}] you> `)).trim();
    if (inputClosed) break;
    if (!line) continue;
    let text = line;
    if (line === "/vibe" || line.startsWith("/vibe ")) {
      const arg = line.slice(5).trim();
      if (arg === "off") { vibe = false; console.log("vibe off: back to coding."); continue; }
      const was = vibe; vibe = true;
      if (!arg) { console.log(was ? "already in vibe mode (/vibe off to leave)" : VIBE_BANNER); continue; }
      text = arg;                                  // `/vibe 帮我配置` is a message, not just a mode switch
    } else if (line.startsWith("/")) {
      const [c, ...rest] = line.slice(1).split(/\s+/); const arg = rest.join(" ");
      if (c === "quit" || c === "exit") break;
      if (c === "help") { console.log("/vibe [what you want]  /vibe off  (configure the harness by talking to it)\n/continue  /new  (force how the next turn starts)\n/verbose [on|off]  /status [on|off]  (expand tool calls · bottom status bar)\n/memory [list|search <q>|get <id>|pin <id>|unpin <id>|forget <id>]  /skills\n/save <一句话注释：这个会话用来解决什么问题>  (keep this session in the dataset for backtesting)\n/model [list|auto|<model>|<main|mid|small> <model>]  choose the session model (like Claude Code/Codex)\n/fork <name>  /merge <branch>  /discard  /switch <id|name>  /sessions  /knobs [k=v ...]  /profile <name>  /strategy [name]  /compact  /stats  /quit"); continue; }
      if (c === "model") {
         if (!rest.length || rest[0] === "list") { showModels(session); continue; }
         const tier = MODEL_TIERS.includes(rest[0] as ModelTier) ? rest[0] as ModelTier : "main";
         const value = tier === "main" && rest[0] !== "main" && rest.length === 1 ? rest[0] : rest[1];
         if (!value) { console.log("usage: /model <model> | /model <main|mid|small> <model> | /model auto"); continue; }
         setSessionModel(session, tier, value); continue;
       }
       if (c === "save") {
        try { const r = saveToDataset(session, { note: arg, dataset: "default" }); console.log(`saved ${r.turns} turns (${r.contextFiles} with full context) → ${r.dir}`); }
        catch (e: any) { console.log(e?.message ?? e); }
        continue;
      }
      if (c === "continue" || c === "new") { pendingGate = c === "continue" ? "continue" : "rebuild"; console.log(`next turn will ${c === "continue" ? "carry the previous turn's work" : "start from the briefing only"}`); continue; }
      if (c === "memory") { memoryCommand(rest, true); continue; }
      if (c === "skills") { for (const sk of discoverSkills(session.cwd, projectOf(session.cwd))) console.log(skillLine(sk, 120)); continue; }
      if (c === "fork") { const child = forkSession(session, arg || `fork-${session.turns.length}`); console.log(`forked → ${child.id} (${child.title}); now on branch`); session = child; continue; }
      if (c === "merge") { const b = findSession(arg); if (!b) { console.log("no such branch"); continue; } const blk = mergeSession(b, session); console.log(`merged "${b.title}" into ${session.title}:\n${blk.text}`); continue; }
      if (c === "discard") { if (!session.parent) { console.log("not a branch"); continue; } discardSession(session); const p = loadSession(session.parent)!; console.log(`discarded; back on ${p.title}`); session = p; continue; }
      if (c === "switch") { const s = findSession(arg); if (s) { session = s; console.log(`now on ${s.id} (${s.title})`); } else console.log("no such session"); continue; }
      if (c === "sessions") { for (const s of listSessions().slice(0, 20)) console.log(`${s.id}  ${s.status.padEnd(9)} turns=${String(s.turns.length).padStart(3)}  ${s.title}${s.parent ? `  (branch of ${s.parent})` : ""}`); continue; }
      if (c === "knobs") {
        if (!arg) { const k = knobsFor({ project: session.cwd, session: session.id }); for (const [n, v] of Object.entries(k)) console.log(`${n} = ${v}`); continue; }
        const changes: any = {}; for (const kv of rest) { const [k, v] = kv.split("="); if (k in KNOB_SPECS) changes[k] = v; }
        applyKnobChange(`session:${session.id}`, changes, "user", "cli"); console.log("ok", changes); continue;
      }
      if (c === "profile") { if (!(arg in PROFILES)) { console.log("profiles: " + Object.keys(PROFILES).join(", ")); continue; } session.knobs = { ...PROFILES[arg] }; saveSession(session); console.log(`profile ${arg} applied to session`); continue; }
      if (c === "strategy") {
        if (!arg) { const cur = knobsFor({ project: session.cwd, session: session.id }).strategy; console.log(`strategy = ${cur}`); for (const [n, st] of Object.entries(STRATEGIES)) console.log(`  ${n.padEnd(12)} ${st.description}`); continue; }
        if (!(arg in STRATEGIES)) { console.log("strategies: " + Object.keys(STRATEGIES).join(", ")); continue; }
        session.knobs = { ...(session.knobs ?? {}), strategy: arg }; saveSession(session); console.log(`strategy ${arg} applied to this session`); continue;
      }
      if (c === "verbose") {
        const on = arg === "" ? !render.isVerbose() : !["off", "false", "0", "no"].includes(arg);
        render.setVerbose(on); console.log(`tool calls: ${on ? "one line each (verbose)" : "folded into one line per step"}`); continue;
      }
      if (c === "status") {
        const on = arg === "" ? !render.ui.statusBar : !["off", "false", "0", "no"].includes(arg);
        render.setStatusBar(on); console.log(`status bar ${on ? "on" : "off"} (persist it with \`mph config ui_status_bar=${on ? "on" : "off"}\`)`); continue;
      }
      if (c === "compact") { session.window = session.window.slice(-2); saveSession(session); console.log("window trimmed; next turn starts from digest"); continue; }
      if (c === "stats") { const t = session.turns; const u = t.reduce((a, x) => ({ input: a.input + x.usage.input, cached: a.cached + x.usage.cached, output: a.output + x.usage.output }), { input: 0, cached: 0, output: 0 }); console.log(`turns=${t.length} steps=${t.reduce((a, x) => a + x.steps, 0)} input=${u.input} cached=${u.cached} (${(100 * u.cached / Math.max(1, u.input)).toFixed(0)}%) output=${u.output} window=${session.window.length} files=${session.state.filesTouched.length}`); continue; }
      console.log(`unknown command /${c}; type /help to see available commands`); continue;
    }
    const knobs = resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), session.knobs as any);
    const ledger = new Ledger(); const store = new ArtifactStore(); const router = new Router(knobs, ledger);
    const strat = vibe ? strategyFor("react") : strategyFor(knobs.strategy);
    const onText = (t: string) => render.text(t);
    let r;
    try {
      r = vibe
        ? await runTurn({ session, userText: text, knobs, store, ledger, router, ...VIBE_TURN, onText, onEvent: printEvent, ui: render })
        : strat.name === "react"
        ? await runTurn({ session, userText: text, knobs, store, ledger, router, gateAction: pendingGate, onText, onEvent: printEvent, ui: render })
        // a strategy runs many nested turns; it reports through events and its own
        // final text rather than fighting over one status bar
        : await strat.run({ session, userText: text, knobs, store, ledger, router, onEvent: printEvent });
    } finally { render.endText(); }
    if (!vibe && strat.name !== "react") render.line(r.text);
    pendingGate = undefined;
    render.turnEnd(turnSummary(r));
  }
  render.close();
  rl.close();
}

/** the status bar and the prompt want the task, not the session's own id */
function titleOf(session: SessionData): string {
  if (session.title && session.title !== session.id) return session.title;
  const last = session.turns[session.turns.length - 1];
  return last ? last.user.split("\n")[0].trim().slice(0, 40) : session.id;
}

/** the one line that stays in the scrollback after a turn */
function turnSummary(r: { steps: number; usage: { input: number; cached: number; output: number }; costEquiv: number; memory?: unknown }): string {
  const u = r.usage;
  const mem = (r as any).memory ? ` · memory ${(r as any).memory.recalled.length} shown ${(r as any).memory.written.length} written` : "";
  return `  [${r.steps} steps · in ${u.input} (cached ${u.cached}, ${Math.round((100 * u.cached) / Math.max(1, u.input))}%) · out ${u.output} · cost≈${Math.round(r.costEquiv)}${mem}]`;
}

const KNOWN_COMMANDS = new Set([
  "chat", "run", "vibe", "map", "compare", "strategies", "sessions", "fork", "merge", "discard",
  "save", "dataset", "datasets", "proxy", "dash", "dashboard", "report", "tune", "watch", "history",
  "price", "price-probe", "knobs", "memory", "skill", "skills", "login", "logout", "whoami", "config",
]);

async function main() {
  const cwd = resolve(opt("--cwd", process.cwd())!);
  if (cmd === "help") { console.log(helpFor(args[1])); return; }
  if (cmd === "--help" || cmd === "-h") { console.log(HELP); return; }

  // A typo must not silently start a model-backed chat (and potentially spend tokens).
  if (!KNOWN_COMMANDS.has(cmd)) {
    console.error(`Unknown command: ${cmd}`);
    console.error("Run `mph help` to see available commands, or just `mph` to start chat.");
    process.exitCode = 2;
    return;
  }

  // The proxy, the dashboard and the ledger commands used to be their own binaries.
  // They are imported on demand so `mph chat` does not pay for a dashboard it is not
  // starting, and so that nothing runs just by being imported.
  if (cmd === "proxy") { (await import("../proxy/cli.js")).proxyMain(args.slice(1)); return; }
  if (cmd === "dash" || cmd === "dashboard") { await (await import("../dashboard/cli.js")).dashMain(args.slice(1)); return; }
  if ((LEDGER_COMMANDS as readonly string[]).includes(cmd)) { await (await import("../sidecar/cli.js")).ledgerMain(cmd as any, args.slice(1)); return; }

  // The commands above answer their own --help; the remaining commands have local
  // usage text instead of dumping the entire command catalog.
  if (flag("--help") || flag("-h")) { console.log(helpFor(cmd)); return; }

  await initTokenizer();
  if (cmd === "login") { await runLogin(); return; }
  if (cmd === "logout") { runLogout(); return; }
  if (cmd === "whoami") { printWhoami(); return; }
  if (cmd === "config") {
    const kv = args.slice(1).filter((a) => a.includes("="));
    if (kv.length) {
      const { changed } = setConfigValues(kv.map((x) => { const [k, ...rest] = x.split("="); return [k, rest.join("=")] as [string, string]; }));
      console.log(`saved ${configPath()}: ${Object.entries(changed).map(([k, v]) => `${k} = ${v}`).join(", ")}`);
    }
    const cfg = loadConfigFile();
    console.log(JSON.stringify(maskConfig(cfg), null, 2));
    console.log(`effective upstream: ${describeUpstream(resolveUpstream())}`);
    const m = resolveModels(knobsFor({ project: cwd }));
    console.log(`models: main ${m.main} (${m.source.main}) · mid ${m.mid} (${m.source.mid}) · small ${m.small} (${m.source.small})`);
    const ms = memorySettings();
    console.log(`memory (global): recall ${ms.recall ? "on" : "off"} · write ${ms.write ? "on" : "off"}`);
    return;
  }
  if (cmd === "memory") { memoryCommand(args.slice(1), false); return; }
  if (cmd === "skill" || cmd === "skills") {
    const sub = args[1] ?? "list"; const skills = discoverSkills(cwd, projectOf(cwd));
    if (sub === "list") { if (!skills.length) console.log("no skills found"); for (const sk of skills) console.log(`${skillLine(sk, 140)}\n    ${sk.file}`); return; }
    if (sub === "show") { const sk = skills.find((x) => x.name === args[2]); if (!sk) throw new Error(`no skill ${args[2]}`); console.log(loadSkillBody(sk)); return; }
    throw new Error("usage: mph skill list | show <name>");
  }
  if (cmd === "save") {
    const ref = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    const s = flag("--last") || !ref ? listSessions().find((x) => x.status === "active" && !x.id.includes(":") && (flag("--last") || x.cwd === cwd)) : findSession(ref);
    if (!s) throw new Error(ref ? `no session ${ref}` : "no session to save (pass a session id, or --last)");
    const r = saveToDataset(s, { note: opt("--note") ?? "", dataset: opt("--dataset"), id: opt("--id") });
    console.log(`saved ${s.id} (${s.title}) as ${r.dataset}/${r.id}: ${r.turns} turns, ${r.contextFiles} with full context, ${r.ledgerRows} ledger rows, ${r.memories} memories\n${r.dir}`);
    return;
  }
  if (cmd === "dataset" || cmd === "datasets") {
    const sub = args[1] ?? "list";
    if (sub === "list") { const ds = listDatasets(); if (!ds.length) console.log(`no datasets yet (${datasetsDir()}); save one with mph save --note "..."`); for (const d of ds) console.log(`${d.name.padEnd(20)} ${d.cases} case(s)`); return; }
    if (sub === "show") {
      const [ds, id] = String(args[2] ?? "").split("/"); if (!ds || !id) throw new Error("usage: mph dataset show <dataset>/<id>");
      const k = readCase(ds, id);
      console.log(`${ds}/${id}\nnote: ${k.note}\nsession: ${k.session.id} (${k.session.title}) in ${k.session.cwd}\nsaved: ${k.saved_at} · harness ${k.harness_version ?? "?"} · models ${k.models.main} / ${k.models.small}${k.git_at_save ? ` · git ${k.git_at_save.head?.slice(0, 10)}${k.git_at_save.dirty ? " (dirty)" : ""}` : ""}`);
      for (const t of k.turns) console.log(`\n[turn ${t.idx}] ${t.gate ? `(${t.gate.action}) ` : ""}${t.steps} steps · in ${t.usage.input} · ${t.files_changed.length ? "files: " + t.files_changed.join(", ") : "no files"}\n  user: ${t.user.replace(/\s+/g, " ").slice(0, 200)}\n  answer: ${String(t.answer_card || t.answer).replace(/\s+/g, " ").slice(0, 200)}`);
      return;
    }
    const rows = readIndex(sub);
    if (!rows.length) { console.log(`dataset ${sub} is empty or missing`); return; }
    for (const r of rows) console.log(`${r.id.padEnd(34)} ${String(r.turns).padStart(3)} turns  ${r.note}`);
    return;
  }
  if (cmd === "sessions") {
    if (flag("--prune")) { const { removed, kept } = pruneEmptySessions(); console.log(`removed ${removed.length} session(s) that never ran a turn, kept ${kept}`); return; }
    for (const s of listSessions()) console.log(`${s.id}  ${s.status.padEnd(9)} turns=${String(s.turns.length).padStart(3)}  ${s.cwd}  ${s.title}`);
    return;
  }
  if (cmd === "fork") { const p = findSession(args[1]); if (!p) throw new Error("no such session"); const c = forkSession(p, args[2] ?? "fork"); console.log(c.id); return; }
  if (cmd === "merge") { const b = findSession(args[1]), m = findSession(args[2]); if (!b || !m) throw new Error("session not found"); console.log(mergeSession(b, m).text); return; }
  if (cmd === "discard") { const s = findSession(args[1]); if (!s) throw new Error("no such session"); discardSession(s); return; }
  if (cmd === "knobs") { const kv = args.slice(1).filter((a) => a.includes("=")); if (kv.length) { const ch: any = {}; for (const x of kv) { const [k, v] = x.split("="); ch[k] = v; } applyKnobChange(opt("--project") ? `project:${opt("--project")}` : "global", ch, "user", "cli"); } for (const [n, v] of Object.entries(knobsFor({ project: opt("--project") }))) console.log(`${n} = ${v}`); return; }
  if (cmd === "map") {
    const task = opt("--task"); if (!task) throw new Error("--task required");
    const items = opt("--items-file") ? readFileSync(opt("--items-file")!, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : (opt("--items") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const par = Number(opt("--parallel", "3"));
    const store = new ArtifactStore(); const ledger = new Ledger(); const knobs = knobsFor({ project: cwd });
    const router = new Router({ ...knobs, ...PROFILES.batch } as any, ledger);
    const results: string[] = []; let i = 0;
    const worker = async () => { for (;;) { const idx = i++; if (idx >= items.length) return; const it = items[idx]; const s = newSession(cwd, `map:${it}`); s.knobs = PROFILES.batch; const r = await runTurn({ session: s, userText: task.replace(/\{item\}/g, it) + (task.includes("{item}") ? "" : `\n\nItem: ${it}`), knobs: { ...knobs, ...PROFILES.batch } as any, store, ledger, router, tier: "T3", onEvent: printEvent, quiet: true }); results[idx] = `## ${it}\n${r.text}\n[${r.steps} steps, in ${r.usage.input}, out ${r.usage.output}]`; } };
    await Promise.all(Array.from({ length: Math.min(par, items.length) }, worker));
    console.log(results.join("\n\n")); return;
  }
  if (cmd === "strategies") { for (const [n, st] of Object.entries(STRATEGIES)) console.log(`${n.padEnd(14)} ${st.description}`); return; }
  if (cmd === "compare") {
    const tf = opt("--tasks"); if (!tf) throw new Error("--tasks file.json|file.jsonl required");
    const tasks = loadTasks(tf);
    const strategies = (opt("--strategies") ?? "react,plan_verify").split(",").map((s2) => s2.trim()).filter(Boolean);
    for (const s2 of strategies) strategyFor(s2);          // fail fast on a typo
    const rep = await compareStrategies({ tasks, strategies, cwd, copy: flag("--copy"), maxSteps: opt("--max-steps") ? Number(opt("--max-steps")) : undefined, onEvent: printEvent });
    console.log("\n" + formatCompare(rep));
    const saved = opt("--json"); if (saved) { writeFileSync(saved, JSON.stringify(rep, null, 2)); console.log(`\nwrote ${saved}`); } else console.log(`\nwrote ${saveCompare(rep)}`);
    return;
  }

  if (cmd === "vibe") {
    const text = positionalAfter(["--cwd", "--session", "--title"]).join(" ").trim();
    const up = resolveUpstream();
    if (up.provider === "codex" && !loadCredentials()) {
      console.error("vibe needs a model to talk to, and there are no ChatGPT credentials yet.\nRun `mph login` first, or point mph at your own endpoint:\n  mph config provider=openai_compatible base_url=https://... api_key=...");
      process.exitCode = 1; return;
    }
    let s2 = opt("--session") ? findSession(opt("--session")!) : undefined;
    if (!s2) { s2 = newSession(cwd, "vibe"); if (!text) saveSession(s2); }   // only the interactive form needs the file up front
    if (!text) { await chat(s2, true); return; }
    const render = renderer();
    const r = await runTurn({ session: s2, userText: text, ...VIBE_TURN, onText: (t) => render.text(t), onEvent: printEvent, ui: render });
    render.turnEnd(`  [${r.steps} steps · in ${r.usage.input} (cached ${r.usage.cached}) · out ${r.usage.output}]`);
    render.close();
    return;
  }

  let session: SessionData | undefined = opt("--session") ? findSession(opt("--session")!) : undefined;
  if (!session && flag("--resume-last")) session = listSessions().find((x) => x.status === "active" && x.cwd === cwd && !x.id.includes(":"));
  if (!session) {
    session = newSession(cwd, opt("--title"));
    // A one-shot `run` that never reaches a turn should leave nothing behind; runTurn
    // persists the session at turn end. Interactive chat is the one path that needs the
    // file up front, because /fork, /switch and /sessions expect it to exist.
    if (cmd === "chat") saveSession(session);
  }
  if (opt("--model")) { session.knobs = { ...(session.knobs ?? {}), main_model: opt("--model") }; saveSession(session); }
  if (opt("--profile")) { session.knobs = { ...(session.knobs ?? {}), ...PROFILES[opt("--profile")!] }; saveSession(session); }
  if (cmd === "run") {
    const positional = positionalAfter(["--session", "--cwd", "--title", "--model", "--profile", "--max-steps", "--prompt-file", "--strategy"]);
    const text = opt("--prompt-file") ? readFileSync(opt("--prompt-file")!, "utf8") : positional.length === 1 && positional[0] === "-" ? readFileSync(0, "utf8") : positional.join(" ");
    if (!text.trim()) throw new Error("empty prompt");
    const json = flag("--json");
    const out = (o: any) => process.stdout.write(JSON.stringify(o) + "\n");
    // --json is a wire format: it writes its own lines and never touches the renderer
    const render = json ? undefined : renderer();
    const onEvent = json ? (e: { kind: string; detail: string }) => out({ type: "event", ...e }) : printEvent;
    const onText = json ? (t: string) => out({ type: "text", delta: t }) : (t: string) => render!.text(t);
    const gateAction: GateAction | undefined = flag("--continue") ? "continue" : flag("--new") ? "rebuild" : undefined;
    const maxSteps = opt("--max-steps") ? Number(opt("--max-steps")) : undefined;
    const sname = opt("--strategy") ?? resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), session.knobs as any).strategy;
    const strat = strategyFor(sname);
    let r;
    if (strat.name === "react") {
      r = await runTurn({ session, userText: text, maxSteps, gateAction, onText, onEvent, ui: render });
    } else {
      const knobs = resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), { ...(session.knobs as any), strategy: sname });
      const ledger = new Ledger(); const store = new ArtifactStore();
      r = await strat.run({ session, userText: text, knobs, store, ledger, router: new Router(knobs, ledger), maxSteps, onEvent });
      if (!json) render!.line(r.text);
    }
    const rr: any = r;
    const exit = rr.fidelity === false ? 4 : r.text.startsWith("[model error]") ? 3 : r.text.startsWith("[stopped") ? 2 : 0;
    if (json) out({ type: "result", session: session.id, strategy: strat.name, text: r.text, steps: r.steps, usage: r.usage, cost_equiv: Math.round(r.costEquiv), gate: rr.gate ? { action: rr.gate.action, by: rr.gate.by, why: rr.gate.why } : undefined, fidelity: rr.fidelity, memory: rr.memory, exit });
    else {
      if (r.text.startsWith("[model error]") || r.text.startsWith("[stopped")) render!.line(r.text);
      render!.turnEnd(`\n[${session.id} · ${strat.name} · ${r.steps} model calls · in ${r.usage.input} cached ${r.usage.cached} · out ${r.usage.output}${rr.gate ? ` · ${rr.gate.action}` : ""}]`);
      render!.close();
    }
    process.exitCode = exit; return; }
  await chat(session);
}
function memoryCommand(argv: string[], inChat: boolean): void {
  const sub = argv[0] ?? "list";
  const ms = memorySettings();
  let store: MemoryStore;
  try { store = new MemoryStore(); } catch (e: any) { console.log(`memory store unavailable: ${e?.message ?? e}`); return; }
  try {
    if (sub === "list") {
      const type = argv.includes("--type") ? argv[argv.indexOf("--type") + 1] as MemoryType : undefined;
      const rows = store.list({ status: argv.includes("--all") ? "all" : "active", type, limit: 200 });
      console.log(`memory: ${store.count()} active (recall ${ms.recall ? "on" : "off"}, write ${ms.write ? "on" : "off"})`);
      for (const e of rows) console.log(`${e.pinned ? "*" : " "} ${l1Line(e)}${e.status !== "active" ? `  [${e.status}]` : ""}`);
      return;
    }
    if (sub === "search") { const q = argv.slice(1).join(" "); for (const h of store.search(q, { limit: 30, includeInactive: argv.includes("--all") })) console.log(`${h.score.toFixed(2)} ${l1Line(h.entry)}`); return; }
    if (sub === "get") { for (const id of argv.slice(1)) { const e = store.get(id); console.log(e ? detailBlock(e) + `\n  source: ${e.source.by} · ${e.source.session} turn ${e.source.turn} · used ${e.useCount}x` : `${id}: not found`); } return; }
    if (sub === "pin" || sub === "unpin") { for (const id of argv.slice(1)) store.setPinned(id, sub === "pin"); console.log("ok"); return; }
    if (sub === "forget") { for (const id of argv.slice(1)) store.setStatus(id, "superseded"); console.log("ok (kept in the store as superseded; `memory list --all` shows it)"); return; }
    if (sub === "export") { const t = store.exportJsonl(); if (argv[1]) { writeFileSync(argv[1], t); console.log(`wrote ${argv[1]}`); } else process.stdout.write(t); return; }
    if (sub === "import") { if (!argv[1]) throw new Error("memory import <file.jsonl>"); console.log(`imported ${store.importJsonl(readFileSync(argv[1], "utf8"))}`); return; }
    if (sub === "gc") { const cutoff = Date.now() - 60 * 86400_000; const old = store.list({ limit: 5000 }).filter((e) => !e.pinned && Date.parse(e.lastUsed ?? e.updated) < cutoff); console.log(old.length ? `not used for 60 days (forget them with \`memory forget <id>\`):\n` + old.map(l1Line).join("\n") : "nothing stale"); return; }
    console.log(`unknown memory command ${sub}${inChat ? "" : "; see mph help"}`);
  } finally { store.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
