import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { runTurn } from "./loop.js";
import { strategyFor, STRATEGIES } from "./strategies/index.js";
import { compareStrategies, formatCompare, saveCompare, loadTasks } from "./compare.js";
import { newSession, saveSession, loadSession, listSessions, findSession, forkSession, mergeSession, discardSession, type SessionData } from "./session.js";
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
  strategies | sessions | fork <id> <name> | merge <branch> <main> | discard <id>

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
  config [k=v ...]                             provider, base_url, api_key, wire_api, *_model, memory_*`;

const VIBE_BANNER = `vibe on: tell me what you want the harness to do and I will read and change its own settings.
  e.g. "把记忆关掉" · "这个项目上下文给小一点" · "换成我自己的 qwen 端点" · "现在是什么配置"
  I can read the workspace and the settings; I cannot edit your files or run commands here. /vibe off to leave.`;

/** one definition of what vibe mode is: its prompt, its tools, and no memory writes */
const VIBE_TURN = { instructions: VIBE_PROMPT, toolNames: VIBE_TOOL_NAMES, multiTurn: false as const };

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

function printEvent(e: { kind: string; detail: string }) {
  const tag = { tool: "⚙", recall: "↩", dedupe: "≡", delegate: "⇢", job: "⏳", commentary: "…", plan: "▣", step: "▸", verify: "✓", argue: "⇄", replan: "↻", compare: "⊞", warn: "!", gate: "◇", skill: "✦", memory_miss: "?", batch: "⇉", settings: "◆" }[e.kind] ?? "•";
  process.stderr.write(`  ${tag} ${e.detail}\n`);
}

async function chat(session: SessionData, startInVibe = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
  console.log(`session ${session.id} (${session.title}) in ${session.cwd}. /help for commands.`);
  let pendingGate: GateAction | undefined;
  let vibe = startInVibe;
  if (vibe) console.log(VIBE_BANNER);
  for (;;) {
    const line = (await ask(`\n[${session.title}${vibe ? " · vibe" : ""}] you> `)).trim();
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
      if (c === "help") { console.log("/vibe [what you want]  /vibe off  (configure the harness by talking to it)\n/continue  /new  (force how the next turn starts)\n/memory [list|search <q>|get <id>|pin <id>|unpin <id>|forget <id>]  /skills\n/fork <name>  /merge <branch>  /discard  /switch <id|name>  /sessions  /knobs [k=v ...]  /profile <name>  /strategy [name]  /compact  /stats  /quit"); continue; }
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
      if (c === "compact") { session.window = session.window.slice(-2); saveSession(session); console.log("window trimmed; next turn starts from digest"); continue; }
      if (c === "stats") { const t = session.turns; const u = t.reduce((a, x) => ({ input: a.input + x.usage.input, cached: a.cached + x.usage.cached, output: a.output + x.usage.output }), { input: 0, cached: 0, output: 0 }); console.log(`turns=${t.length} steps=${t.reduce((a, x) => a + x.steps, 0)} input=${u.input} cached=${u.cached} (${(100 * u.cached / Math.max(1, u.input)).toFixed(0)}%) output=${u.output} window=${session.window.length} files=${session.state.filesTouched.length}`); continue; }
      console.log("unknown command"); continue;
    }
    const knobs = resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), session.knobs as any);
    const ledger = new Ledger(); const store = new ArtifactStore(); const router = new Router(knobs, ledger);
    const strat = vibe ? strategyFor("react") : strategyFor(knobs.strategy);
    const r = vibe
      ? await runTurn({ session, userText: text, knobs, store, ledger, router, ...VIBE_TURN, onText: (t) => process.stdout.write(t), onEvent: printEvent })
      : strat.name === "react"
      ? await runTurn({ session, userText: text, knobs, store, ledger, router, gateAction: pendingGate, onText: (t) => process.stdout.write(t), onEvent: printEvent })
      : await strat.run({ session, userText: text, knobs, store, ledger, router, onEvent: printEvent });
    if (!vibe && strat.name !== "react") process.stdout.write(r.text + "\n");
    else if (!r.text.includes("[model error]")) process.stdout.write("\n");
    else console.log(r.text);
    pendingGate = undefined;
    const mem = (r as any).memory ? ` · memory shown ${(r as any).memory.recalled.length} written ${(r as any).memory.written.length}` : "";
    console.log(`\n  [${r.steps} steps · in ${r.usage.input} (cached ${r.usage.cached}) · out ${r.usage.output} · cost≈${Math.round(r.costEquiv)}${mem}]`);
  }
  rl.close();
}

async function main() {
  const cwd = resolve(opt("--cwd", process.cwd())!);
  if (cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(HELP); return; }

  // The proxy, the dashboard and the ledger commands used to be their own binaries.
  // They are imported on demand so `mph chat` does not pay for a dashboard it is not
  // starting, and so that nothing runs just by being imported.
  if (cmd === "proxy") { (await import("../proxy/cli.js")).proxyMain(args.slice(1)); return; }
  if (cmd === "dash" || cmd === "dashboard") { await (await import("../dashboard/cli.js")).dashMain(args.slice(1)); return; }
  if ((LEDGER_COMMANDS as readonly string[]).includes(cmd)) { await (await import("../sidecar/cli.js")).ledgerMain(cmd as any, args.slice(1)); return; }

  // the commands above answer their own --help; for the rest there is one help
  if (flag("--help") || flag("-h")) { console.log(HELP); return; }

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
  if (cmd === "sessions") { for (const s of listSessions()) console.log(`${s.id}  ${s.status.padEnd(9)} turns=${String(s.turns.length).padStart(3)}  ${s.cwd}  ${s.title}`); return; }
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
    if (!s2) { s2 = newSession(cwd, "vibe"); saveSession(s2); }
    if (!text) { await chat(s2, true); return; }
    const r = await runTurn({ session: s2, userText: text, ...VIBE_TURN, onText: (t) => process.stdout.write(t), onEvent: printEvent });
    process.stdout.write("\n");
    console.log(`\n  [${r.steps} steps · in ${r.usage.input} (cached ${r.usage.cached}) · out ${r.usage.output}]`);
    return;
  }

  let session: SessionData | undefined = opt("--session") ? findSession(opt("--session")!) : undefined;
  if (!session && flag("--resume-last")) session = listSessions().find((x) => x.status === "active" && x.cwd === cwd && !x.id.includes(":"));
  if (!session) { session = newSession(cwd, opt("--title")); saveSession(session); }
  if (opt("--model")) { session.knobs = { ...(session.knobs ?? {}), main_model: opt("--model") }; saveSession(session); }
  if (opt("--profile")) { session.knobs = { ...(session.knobs ?? {}), ...PROFILES[opt("--profile")!] }; saveSession(session); }
  if (cmd === "run") {
    const positional = positionalAfter(["--session", "--cwd", "--title", "--model", "--profile", "--max-steps", "--prompt-file", "--strategy"]);
    const text = opt("--prompt-file") ? readFileSync(opt("--prompt-file")!, "utf8") : positional.length === 1 && positional[0] === "-" ? readFileSync(0, "utf8") : positional.join(" ");
    if (!text.trim()) throw new Error("empty prompt");
    const json = flag("--json");
    const out = (o: any) => process.stdout.write(JSON.stringify(o) + "\n");
    const onEvent = json ? (e: { kind: string; detail: string }) => out({ type: "event", ...e }) : printEvent;
    const onText = json ? (t: string) => out({ type: "text", delta: t }) : (t: string) => process.stdout.write(t);
    const gateAction: GateAction | undefined = flag("--continue") ? "continue" : flag("--new") ? "rebuild" : undefined;
    const maxSteps = opt("--max-steps") ? Number(opt("--max-steps")) : undefined;
    const sname = opt("--strategy") ?? resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), session.knobs as any).strategy;
    const strat = strategyFor(sname);
    let r;
    if (strat.name === "react") {
      r = await runTurn({ session, userText: text, maxSteps, gateAction, onText, onEvent });
    } else {
      const knobs = resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), { ...(session.knobs as any), strategy: sname });
      const ledger = new Ledger(); const store = new ArtifactStore();
      r = await strat.run({ session, userText: text, knobs, store, ledger, router: new Router(knobs, ledger), maxSteps, onEvent });
      if (!json) console.log(r.text);
    }
    const rr: any = r;
    const exit = rr.fidelity === false ? 4 : r.text.startsWith("[model error]") ? 3 : r.text.startsWith("[stopped") ? 2 : 0;
    if (json) out({ type: "result", session: session.id, strategy: strat.name, text: r.text, steps: r.steps, usage: r.usage, cost_equiv: Math.round(r.costEquiv), gate: rr.gate ? { action: rr.gate.action, by: rr.gate.by, why: rr.gate.why } : undefined, fidelity: rr.fidelity, memory: rr.memory, exit });
    else {
      if (r.text.startsWith("[model error]") || r.text.startsWith("[stopped")) console.log(r.text);
      console.log(`\n[${session.id} · ${strat.name} · ${r.steps} model calls · in ${r.usage.input} cached ${r.usage.cached} · out ${r.usage.output}${rr.gate ? ` · ${rr.gate.action}` : ""}]`);
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
