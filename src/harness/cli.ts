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
import { loadConfigFile, saveConfigFile, configPath, resolveUpstream, describeUpstream, type Provider } from "../upstream/index.js";

const args = process.argv.slice(2);
const cmd = args[0] ?? "chat";
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = (n: string) => args.includes(n);

function printEvent(e: { kind: string; detail: string }) {
  const tag = { tool: "⚙", recall: "↩", dedupe: "≡", delegate: "⇢", job: "⏳", commentary: "…", plan: "▣", step: "▸", verify: "✓", argue: "⇄", replan: "↻", compare: "⊞", warn: "!" }[e.kind] ?? "•";
  process.stderr.write(`  ${tag} ${e.detail}\n`);
}

async function chat(session: SessionData) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
  console.log(`session ${session.id} (${session.title}) in ${session.cwd}. /help for commands.`);
  for (;;) {
    const line = (await ask(`\n[${session.title}] you> `)).trim();
    if (!line) continue;
    if (line.startsWith("/")) {
      const [c, ...rest] = line.slice(1).split(/\s+/); const arg = rest.join(" ");
      if (c === "quit" || c === "exit") break;
      if (c === "help") { console.log("/fork <name>  /merge <branch>  /discard  /switch <id|name>  /sessions  /knobs [k=v ...]  /profile <name>  /strategy [name]  /compact  /stats  /quit"); continue; }
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
    const strat = strategyFor(knobs.strategy);
    const r = strat.name === "react"
      ? await runTurn({ session, userText: line, knobs, store, ledger, router, onText: (t) => process.stdout.write(t), onEvent: printEvent })
      : await strat.run({ session, userText: line, knobs, store, ledger, router, onEvent: printEvent });
    if (strat.name !== "react") process.stdout.write(r.text + "\n");
    else if (!r.text.includes("[model error]")) process.stdout.write("\n");
    else console.log(r.text);
    console.log(`\n  [${r.steps} steps · in ${r.usage.input} (cached ${r.usage.cached}) · out ${r.usage.output} · cost≈${Math.round(r.costEquiv)}]`);
  }
  rl.close();
}

async function main() {
  await initTokenizer();
  const cwd = resolve(opt("--cwd", process.cwd())!);
  if (cmd === "help" || flag("--help")) {
    console.log(`th chat [--session id] [--cwd dir] [--title t] [--model m] [--profile p]   interactive session with fork/merge
th run "task" [--session id] [--cwd dir] [--prompt-file f] [--max-steps n]   one-shot turn
th map --task "..." (--items a,b,c | --items-file f) [--parallel 3]   map-reduce: fresh context per item
th compare --tasks f.json[l] [--strategies react,plan_verify] [--copy] [--json out]   same tasks, every strategy, scored by the task's own acceptance command
th strategies                                         list execution strategies
th sessions | th fork <id> <name> | th merge <branch> <main> | th discard <id>
th knobs [--project p] [k=v ...]
th login | th logout | th whoami                      ChatGPT (Codex OAuth) login for the built-in upstream
th config [provider=codex|openai_compatible] [base_url=...] [api_key=...] [wire_api=responses|chat] [codex_models=a,b]   show / set ~/.token_harness/config.json`); return;
  }
  if (cmd === "login") { await runLogin(); return; }
  if (cmd === "logout") { runLogout(); return; }
  if (cmd === "whoami") { printWhoami(); return; }
  if (cmd === "config") {
    const kv = args.slice(1).filter((a) => a.includes("="));
    if (kv.length) {
      const cfg = loadConfigFile();
      for (const x of kv) {
        const [k, ...rest] = x.split("="); const v = rest.join("=");
        if (k === "provider") { if (v !== "codex" && v !== "openai_compatible") throw new Error("provider must be codex or openai_compatible"); cfg.provider = v as Provider; }
        else if (k === "base_url") cfg.base_url = v || undefined;
        else if (k === "api_key") cfg.api_key = v || undefined;
        else if (k === "wire_api") { if (v && v !== "responses" && v !== "chat") throw new Error("wire_api must be responses or chat"); cfg.wire_api = (v || undefined) as any; }
        else if (k === "codex_base_url") cfg.codex = { ...(cfg.codex ?? {}), base_url: v || undefined };
        else if (k === "codex_models") cfg.codex = { ...(cfg.codex ?? {}), models: v.split(",").map((m) => m.trim()).filter(Boolean) };
        else throw new Error(`unknown config key ${k} (provider, base_url, api_key, wire_api, codex_base_url, codex_models)`);
      }
      saveConfigFile(cfg); console.log(`saved ${configPath()}`);
    }
    const cfg = loadConfigFile();
    console.log(JSON.stringify({ ...cfg, api_key: cfg.api_key ? "***" : undefined }, null, 2));
    console.log(`effective upstream: ${describeUpstream(resolveUpstream())}`);
    return;
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

  let session: SessionData | undefined = opt("--session") ? findSession(opt("--session")!) : undefined;
  if (!session) { session = newSession(cwd, opt("--title")); saveSession(session); }
  if (opt("--model")) { session.knobs = { ...(session.knobs ?? {}), main_model: opt("--model") }; saveSession(session); }
  if (opt("--profile")) { session.knobs = { ...(session.knobs ?? {}), ...PROFILES[opt("--profile")!] }; saveSession(session); }
  if (cmd === "run") {
    const flags = ["--session", "--cwd", "--title", "--model", "--profile", "--max-steps", "--prompt-file"];
    const skipIdx = new Set<number>(); flags.forEach((f) => { const i = args.indexOf(f); if (i >= 0) { skipIdx.add(i); skipIdx.add(i + 1); } });
    const text = opt("--prompt-file") ? readFileSync(opt("--prompt-file")!, "utf8") : args.slice(1).filter((a, i) => !skipIdx.has(i + 1) && !a.startsWith("--")).join(" ");
    const maxSteps = opt("--max-steps") ? Number(opt("--max-steps")) : undefined;
    const sname = opt("--strategy") ?? resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), session.knobs as any).strategy;
    const strat = strategyFor(sname);
    let r;
    if (strat.name === "react") {
      r = await runTurn({ session, userText: text, maxSteps, onText: (t) => process.stdout.write(t), onEvent: printEvent });
    } else {
      const knobs = resolveKnobs(knobsFor({ project: session.cwd, session: session.id }), { ...(session.knobs as any), strategy: sname });
      const ledger = new Ledger(); const store = new ArtifactStore();
      r = await strat.run({ session, userText: text, knobs, store, ledger, router: new Router(knobs, ledger), maxSteps, onEvent: printEvent });
      console.log(r.text);
    }
    if (r.text.startsWith("[model error]") || r.text.startsWith("[stopped")) console.log(r.text);
    console.log(`\n[${session.id} · ${strat.name} · ${r.steps} model calls · in ${r.usage.input} cached ${r.usage.cached} · out ${r.usage.output}]`); return; }
  await chat(session);
}
main().catch((e) => { console.error(e); process.exit(1); });
