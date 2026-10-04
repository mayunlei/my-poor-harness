/**
 * Vibe mode: configuring the harness by talking to it.
 *
 *   mph vibe "把记忆关掉，上下文给小一点"
 *   /vibe            inside a chat session, then plain sentences
 *
 * The same agent loop as a coding turn, with a different prompt and a different tool
 * set: it may read the workspace and read and write the harness's own settings, and
 * it may not edit files or run commands. Every write goes through the same validators
 * the CLI uses, and lands in the knob history with a reason, so `mph history` shows
 * what the conversation changed and `mph knobs k=v` undoes it.
 */
import { readFileSync } from "node:fs";
import { KNOB_SPECS, applyKnobChange, harnessHome, knobFilePath, knobsFor, loadKnobFile, type KnobName, type KnobSpec } from "../core/knobs.js";
import { Ledger } from "../core/ledger.js";
import { buildReport, formatReport } from "../sidecar/metrics.js";
import { CONFIG_KEYS, configPath, describeUpstream, loadConfigFile, maskConfig, memorySettings, resolveModels, resolveUpstream, setConfigValues } from "../upstream/config.js";
import { loadCredentials, planFromToken } from "../upstream/codex_auth.js";
import { MemoryStore, projectOf } from "../memory/store.js";
import { discoverSkills, skillLine } from "../skills/index.js";
import type { ToolDef } from "./providers.js";
import type { RegisteredTool } from "./tools_extra.js";

export const VIBE_PROMPT = `You configure my-poor-harness (the "mph" CLI) for the developer you are talking to. You are not writing code in this mode: you read the harness's own settings, explain them in plain words, and change them when asked.

What you can touch
- settings_read gives you the effective configuration: upstream, models, memory switches, every knob with its default and range, the skills on disk, and recent usage from the ledger.
- settings_write changes knobs (scope global, project or session) and config.json. It validates everything and refuses the whole call if any value is wrong, so a rejection means nothing was written.
- upstream_probe tells you which credentials and endpoint would actually be used, without spending anything.
- read, ls and grep let you look at the workspace when the right setting depends on the project.

How to work
- Read before you write. Never set a knob whose current value and range you have not just read.
- Make the smallest change that gets what was asked, and say what each one does in one line. Group one coherent change into a single settings_write call, and put the user's own reason in "why" -- it goes into the knob history.
- Ask, do not guess, when the request is ambiguous or when the choice has a cost: a bigger model, a probe that spends quota, turning memory writes off (entries already stored are kept, but nothing new is recorded).
- Say when a knob is cache-breaking: it takes effect at the next turn boundary and the prefix cache is rebuilt once.
- Never print an API key, and never ask the user to paste one into this conversation. Tell them to run \`mph config api_key=...\` in their shell instead.
- Default to the user's own scope: a request about "this project" is scope project, a request about "from now on" is global, "just for now" is session.
- If what they want is not a setting (a code change, a bug, a question about their repo), say so in one line and tell them to leave vibe mode with /vibe off.

Finish with: what changed (key = old -> new), what it will do, and how to undo it (\`mph history\` lists every change; \`mph knobs <name>=<old>\` puts one back). If nothing needed changing, say that instead of writing something to look busy.`;

/** the tools vibe mode gets: read-only on the workspace, read/write on the harness */
export const VIBE_TOOL_NAMES = ["read", "recall", "ls", "grep", "settings_read", "settings_write", "upstream_probe"];

type KnobScope = "global" | "project" | "session";

function knobRange(spec: KnobSpec): string {
  if (spec.choices) return spec.choices.join(" | ");
  if (typeof spec.default === "boolean") return "true | false";
  if (spec.min !== undefined || spec.max !== undefined) return `${spec.min ?? "-inf"}..${spec.max ?? "inf"}${spec.step ? ` step ${spec.step}` : ""}`;
  return typeof spec.default;
}

/** where a knob's current value comes from, so the agent changes the layer that is actually in force */
function setIn(name: string, project: string, session: string): string {
  const f = loadKnobFile();
  const where: string[] = [];
  if (f.sessions?.[session] && name in f.sessions[session]) where.push("session");
  if (f.projects?.[project] && name in f.projects[project]) where.push(`project ${project}`);
  if (f.global && name in f.global) where.push("global");
  return where.length ? where.join(", ") : "default";
}

export function knobTable(project: string, session: string, filter?: string): string {
  const eff = knobsFor({ project, session });
  const pat = filter ? new RegExp(String(filter), "i") : undefined;
  const rows: string[] = [];
  for (const [name, specRaw] of Object.entries(KNOB_SPECS)) {
    const spec = specRaw as KnobSpec;
    if (pat && !pat.test(name) && !pat.test(spec.description)) continue;
    const cur = (eff as any)[name];
    const src = setIn(name, project, session);
    rows.push(`${name} = ${JSON.stringify(cur)}${src === "default" ? "" : `  [set in ${src}]`}\n    default ${JSON.stringify(spec.default)} · ${knobRange(spec)}${spec.cacheBreaking ? " · cache-breaking" : ""} · ${spec.description}`);
  }
  if (!rows.length) return `no knob matches /${filter}/`;
  return rows.join("\n");
}

/**
 * Strict knob validation. The CLI's clampKnob silently falls back to the default on a
 * bad value, which is the wrong answer for an agent: it would report success and leave
 * the knob untouched. Here every rejection comes back as a sentence it can act on.
 */
export function validateKnobs(input: Record<string, unknown>): { values: Record<string, any>; errors: string[] } {
  const values: Record<string, any> = {}; const errors: string[] = [];
  const names = Object.keys(KNOB_SPECS);
  for (const [k, raw] of Object.entries(input ?? {})) {
    const spec = (KNOB_SPECS as any)[k] as KnobSpec | undefined;
    if (!spec) {
      const near = names.filter((n) => n.includes(k.slice(0, 5)) || k.includes(n.slice(0, 5))).slice(0, 5);
      errors.push(`unknown knob "${k}"${near.length ? `; did you mean ${near.join(", ")}?` : ""}`);
      continue;
    }
    if (typeof spec.default === "number") {
      const v = Number(raw);
      if (!Number.isFinite(v)) { errors.push(`${k} must be a number, got ${JSON.stringify(raw)}`); continue; }
      if (spec.min !== undefined && v < spec.min) { errors.push(`${k} must be >= ${spec.min}, got ${v}`); continue; }
      if (spec.max !== undefined && v > spec.max) { errors.push(`${k} must be <= ${spec.max}, got ${v}`); continue; }
      values[k] = v;
    } else if (typeof spec.default === "boolean") {
      const s = String(raw).toLowerCase();
      if (raw === true || ["true", "on", "1", "yes"].includes(s)) values[k] = true;
      else if (raw === false || ["false", "off", "0", "no"].includes(s)) values[k] = false;
      else errors.push(`${k} must be true or false, got ${JSON.stringify(raw)}`);
    } else if (spec.choices) {
      if (!spec.choices.includes(String(raw))) errors.push(`${k} must be one of ${spec.choices.join(", ")}, got ${JSON.stringify(raw)}`);
      else values[k] = String(raw);
    } else values[k] = String(raw);
  }
  return { values, errors };
}

function overview(cwd: string, session: string): string {
  const project = projectOf(cwd);
  const up = resolveUpstream();
  const m = resolveModels(knobsFor({ project, session }), process.env, up);
  const ms = memorySettings();
  const skills = discoverSkills(cwd, project);
  let memCount = "unavailable";
  try { const s = new MemoryStore(); memCount = `${s.count()} active`; s.close(); } catch (e: any) { memCount = `unavailable (${e?.message ?? e})`; }
  const led = new Ledger();
  let rows = 0;
  try { rows = led.readAll().length; } catch { /* no ledger yet */ }
  return [
    `home: ${harnessHome()}   (config ${configPath()}, knobs ${knobFilePath()})`,
    `project: ${project}    session: ${session}`,
    `upstream: ${describeUpstream(up)}`,
    `models: main ${m.main} (${m.source.main}) · mid ${m.mid} (${m.source.mid}) · small ${m.source.small === "default" && m.small === m.main ? `${m.small} (same as main)` : `${m.small} (${m.source.small})`}`,
    `memory: recall ${ms.recall ? "on" : "off"} · write ${ms.write ? "on" : "off"} · codex ${ms.codex ? "on" : "off"} · ${memCount}`,
    `skills: ${skills.length ? skills.map((s) => s.name).join(", ") : "none found"}`,
    `ledger: ${rows} rows`,
    ``,
    `config.json:`,
    JSON.stringify(maskConfig(loadConfigFile()), null, 2),
    ``,
    `knobs that are not at their default:`,
    knobTable(project, session).split("\n\n").filter((b) => b.includes("[set in ")).join("\n") || "  (none: everything is at its default)",
    ``,
    `sections for settings_read: overview (this), knobs (all ${Object.keys(KNOB_SPECS).length}, with filter), config (keys you may write), skills, usage`,
  ].join("\n");
}

function configSection(): string {
  return [
    `config.json (${configPath()}):`,
    JSON.stringify(maskConfig(loadConfigFile()), null, 2),
    ``,
    `keys settings_write accepts under "config":`,
    ...Object.entries(CONFIG_KEYS).map(([k, v]) => `  ${k.padEnd(16)} ${v}`),
  ].join("\n");
}

function usageSection(since?: string): string {
  try { return formatReport(buildReport(new Ledger(), { since })); } catch (e: any) { return `no usable ledger yet (${e?.message ?? e})`; }
}

function skillsSection(cwd: string): string {
  const skills = discoverSkills(cwd, projectOf(cwd));
  if (!skills.length) return "no skills found. Put a folder with a SKILL.md under ./.mph/skills, ~/.mph/skills, ~/.codex/skills or ~/.claude/skills.";
  return skills.map((s) => `${skillLine(s, 140)}\n    ${s.file}${s.missing.length ? `\n    unavailable: needs ${s.missing.join(", ")} on PATH` : ""}`).join("\n");
}

export const VIBE_TOOLS: RegisteredTool[] = [
  {
    vibeOnly: true,
    def: {
      name: "settings_read",
      description: "Read the harness's own configuration. Sections: overview (upstream, models, memory, non-default knobs), knobs (every knob with default, range and where it is set; use filter), config (config.json and the keys you may write), skills, usage (the ledger report).",
      parameters: { type: "object", properties: { section: { type: "string", enum: ["overview", "knobs", "config", "skills", "usage"] }, filter: { type: "string", description: "knobs only: a regex over names and descriptions" }, since: { type: "string", description: "usage only: ISO timestamp" } } },
    },
    handler: (ctx, args) => {
      const section = String(args.section ?? "overview");
      if (section === "knobs") return knobTable(projectOf(ctx.cwd), ctx.sessionId, args.filter ? String(args.filter) : undefined);
      if (section === "config") return configSection();
      if (section === "skills") return skillsSection(ctx.cwd);
      if (section === "usage") return usageSection(args.since ? String(args.since) : undefined);
      return overview(ctx.cwd, ctx.sessionId);
    },
  },
  {
    vibeOnly: true,
    def: {
      name: "settings_write",
      description: "Change knobs and/or config.json. All or nothing: if any value is invalid nothing is written and you get the reasons. `why` is recorded in the knob history. Scope: global (default), project (this workspace) or session (this conversation only).",
      parameters: {
        type: "object",
        properties: {
          why: { type: "string", description: "one line, in the user's own words; stored as provenance" },
          scope: { type: "string", enum: ["global", "project", "session"] },
          knobs: { type: "object", description: "knob name -> value" },
          config: { type: "object", description: "config.json key -> value (see settings_read section=config)" },
        },
        required: ["why"],
      },
    },
    handler: (ctx, args) => {
      const why = String(args.why ?? "").trim();
      if (!why) return "[settings_write] why is required: one line saying what the user asked for";
      const scope = (String(args.scope ?? "global") as KnobScope);
      if (!["global", "project", "session"].includes(scope)) return `[settings_write] scope must be global, project or session`;
      const knobsIn = (args.knobs ?? {}) as Record<string, unknown>;
      const configIn = (args.config ?? {}) as Record<string, unknown>;
      if (!Object.keys(knobsIn).length && !Object.keys(configIn).length) return "[settings_write] nothing to change: pass knobs and/or config";

      const { values, errors } = validateKnobs(knobsIn);
      if (errors.length) return `[settings_write] nothing written. ${errors.length} problem(s):\n- ${errors.join("\n- ")}`;

      const project = projectOf(ctx.cwd);
      const before = knobsFor({ project, session: ctx.sessionId });
      const out: string[] = [];

      if (Object.keys(configIn).length) {
        try {
          const { changed } = setConfigValues(Object.entries(configIn).map(([k, v]) => [k, String(v ?? "")]));
          for (const [k, v] of Object.entries(changed)) out.push(`config.${k} = ${v}`);
        } catch (e: any) { return `[settings_write] nothing written to config.json: ${e?.message ?? e}${Object.keys(values).length ? " (the knobs were not written either)" : ""}`; }
      }

      if (Object.keys(values).length) {
        const target = scope === "global" ? "global" : scope === "project" ? `project:${project}` : `session:${ctx.sessionId}`;
        applyKnobChange(target, values as any, "vibe", why);
        const after = knobsFor({ project, session: ctx.sessionId });
        for (const k of Object.keys(values)) out.push(`${k}: ${JSON.stringify((before as any)[k])} -> ${JSON.stringify((after as any)[k])} (${scope})${(KNOB_SPECS as any)[k]?.cacheBreaking ? " · cache-breaking, applies at the next turn" : ""}`);
      }

      ctx.onEvent?.({ kind: "settings", detail: out.join("; ").slice(0, 120) });
      return `[settings_write ok · why: ${why}]\n${out.join("\n")}\nundo: \`mph history\` shows this change; \`mph knobs <name>=<old value>\` puts one back.`;
    },
  },
  {
    vibeOnly: true,
    def: {
      name: "upstream_probe",
      description: "Which credentials and endpoint a request would actually use, and whether they look usable. Spends nothing. With check_endpoint=true it also does one free GET (the model list) against an OpenAI-compatible base URL.",
      parameters: { type: "object", properties: { check_endpoint: { type: "boolean" } } },
    },
    handler: async (_ctx, args) => {
      const up = resolveUpstream();
      const lines = [describeUpstream(up)];
      if (up.provider === "codex") {
        const c = loadCredentials();
        if (!c) lines.push("credentials: none. The user has to run `mph login` (or log in with the Codex CLI) themselves -- it opens a browser, so you cannot do it for them.");
        else {
          const left = c.expiresAt ? Math.round((c.expiresAt - Date.now()) / 60000) : undefined;
          lines.push(`credentials: account ${c.accountId}${planFromToken(c.accessToken) ? ` (${planFromToken(c.accessToken)})` : ""} · source ${c.source} · access token ${left === undefined ? "expiry unknown" : left > 0 ? `valid ${left} min` : `expired ${-left} min ago`}${c.refreshToken ? " · refresh token present" : " · no refresh token, so an expiry means a new login"}`);
        }
        lines.push(`models the backend accepts: ${up.codexModels?.join(", ") ?? "(default list)"}`);
      } else {
        lines.push(`api key: ${up.apiKey ? "set" : "NOT set — requests will fail unless the endpoint is open"}`);
        if (args.check_endpoint) {
          const url = `${up.baseUrl.replace(/\/$/, "")}/models`;
          try {
            const r = await fetch(url, { headers: up.apiKey ? { authorization: `Bearer ${up.apiKey}` } : {}, signal: AbortSignal.timeout(10_000) });
            const body = await r.text();
            lines.push(`GET ${url} -> ${r.status} ${r.statusText}`);
            if (r.ok) { try { const ids = (JSON.parse(body).data ?? []).map((m: any) => m.id).slice(0, 40); lines.push(`models: ${ids.join(", ") || "(none listed)"}`); } catch { lines.push(`body: ${body.slice(0, 300)}`); } }
            else lines.push(`body: ${body.slice(0, 300)}`);
          } catch (e: any) { lines.push(`GET ${url} failed: ${e?.message ?? e}`); }
        }
      }
      const home = harnessHome();
      lines.push(`home: ${home}`);
      return lines.join("\n");
    },
  },
];

/** AGENTS.md / CLAUDE.md, so the first vibe turn can say something about this project */
export function projectHint(cwd: string): string {
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    try { return readFileSync(`${cwd}/${f}`, "utf8").slice(0, 600); } catch { /* next */ }
  }
  return "";
}

export const VIBE_TOOL_DEFS: ToolDef[] = VIBE_TOOLS.map((t) => t.def);
