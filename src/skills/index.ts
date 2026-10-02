/**
 * Skills (docs/MEMORY_DESIGN.md §5.1): folders with a SKILL.md whose frontmatter has
 * `name` and `description` (the Agent Skills convention; existing ~/.codex/skills and
 * ~/.claude/skills work unchanged). Progressive disclosure:
 *   index  one line per skill in the static prefix (cache-stable)
 *   body   SKILL.md, loaded by skill(name) or preloaded when the gate picks it
 *   files  read / run by the model as the body instructs
 * Optional frontmatter `requires: [gh, jq]` hides nothing but marks the skill unavailable
 * when a CLI is missing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { harnessHome } from "../core/knobs.js";
import { countTokens } from "../core/tokens.js";
import { mphEnv } from "../core/env.js";

export interface Skill { name: string; description: string; dir: string; file: string; requires: string[]; missing: string[]; origin: "project" | "user" }

export function skillRoots(cwd: string, project?: string, env: NodeJS.ProcessEnv = process.env): { dir: string; origin: "project" | "user" }[] {
  const roots: { dir: string; origin: "project" | "user" }[] = [];
  const projDirs = [...new Set([resolve(cwd), project ? resolve(project) : undefined].filter(Boolean) as string[])];
  for (const p of projDirs) for (const sub of [".agents/skills", ".claude/skills", ".codex/skills", ".mph/skills"]) roots.push({ dir: join(p, sub), origin: "project" });
  const extra = mphEnv("SKILLS_PATH", env);
  if (extra) for (const d of extra.split(delimiter).filter(Boolean)) roots.push({ dir: resolve(d), origin: "user" });
  const home = env.HOME ?? homedir();
  for (const d of [join(harnessHome(), "skills"), join(home, ".agents", "skills"), join(home, ".claude", "skills"), join(home, ".codex", "skills")]) roots.push({ dir: d, origin: "user" });
  return roots;
}

/** minimal YAML frontmatter: scalar keys, quoted strings, folded `>`/`|` blocks, and [a, b] / "- a" lists */
export function parseFrontmatter(text: string): { meta: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, any> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1]; let val: any = kv[2].trim();
    if (val === ">" || val === "|" || val === ">-" || val === "|-") {
      const block: string[] = []; while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      val = block.join(val.startsWith(">") ? " " : "\n");
    } else if (val === "") {
      const items: string[] = []; while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
      val = items.length ? items : "";
    } else if (/^\[.*\]$/.test(val)) val = val.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    else val = val.replace(/^["']|["']$/g, "");
    meta[key] = val;
  }
  return { meta, body: text.slice(m[0].length) };
}

const whichCache = new Map<string, boolean>();
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (whichCache.has(cmd)) return whichCache.get(cmd)!;
  const ok = (env.PATH ?? "").split(delimiter).some((d) => { try { return d && existsSync(join(d, cmd)); } catch { return false; } });
  whichCache.set(cmd, ok); return ok;
}

export function discoverSkills(cwd: string, project?: string, env: NodeJS.ProcessEnv = process.env): Skill[] {
  const byName = new Map<string, Skill>();
  for (const root of skillRoots(cwd, project, env)) {
    if (!existsSync(root.dir)) continue;
    let entries: string[] = []; try { entries = readdirSync(root.dir); } catch { continue; }
    for (const name of entries.sort()) {
      const dir = join(root.dir, name);
      let file = join(dir, "SKILL.md");
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      if (!existsSync(file)) {
        // one level of grouping (e.g. ~/.claude/skills/synced/<skill>/SKILL.md)
        for (const sub of (() => { try { return readdirSync(dir); } catch { return []; } })()) {
          const f = join(dir, sub, "SKILL.md");
          if (existsSync(f)) addSkill(byName, f, join(dir, sub), root.origin, env);
        }
        continue;
      }
      addSkill(byName, file, dir, root.origin, env);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function addSkill(byName: Map<string, Skill>, file: string, dir: string, origin: "project" | "user", env: NodeJS.ProcessEnv): void {
  let text = ""; try { text = readFileSync(file, "utf8"); } catch { return; }
  const { meta } = parseFrontmatter(text);
  const name = String(meta.name || dir.split("/").pop() || "").trim();
  if (!name || byName.has(name)) return;   // earlier roots win (project before user)
  const requires = Array.isArray(meta.requires) ? meta.requires.map(String) : typeof meta.requires === "string" && meta.requires ? meta.requires.split(/[,\s]+/).filter(Boolean) : [];
  byName.set(name, { name, description: String(meta.description ?? "").replace(/\s+/g, " ").trim(), dir, file, requires, missing: requires.filter((c: string) => !onPath(c, env)), origin });
}

export function skillLine(s: Skill, maxDesc = 200): string {
  const d = s.description.length > maxDesc ? s.description.slice(0, maxDesc - 1) + "…" : s.description;
  return `- ${s.name}: ${d}${s.missing.length ? ` (unavailable: missing ${s.missing.join(", ")})` : ""}`;
}

/** index for the static prefix, within a token budget; overflow is listed by name only */
export function renderSkillIndex(skills: Skill[], budget: number): string {
  if (!skills.length) return "";
  const head = "## Skills\nLoad a skill with skill(name) before doing a task it covers; follow its instructions, read its files with read() and run its scripts with run().";
  const lines: string[] = []; let used = countTokens(head);
  const rest: string[] = [];
  for (const s of skills) { const l = skillLine(s); const t = countTokens(l); if (used + t <= budget) { lines.push(l); used += t; } else rest.push(s.name); }
  if (rest.length) lines.push(`- also available (no description shown): ${rest.join(", ")}`);
  return [head, ...lines].join("\n");
}

export function loadSkillBody(s: Skill): string {
  const text = readFileSync(s.file, "utf8");
  const { body } = parseFrontmatter(text);
  let files: string[] = [];
  try { files = readdirSync(s.dir).filter((f) => f !== "SKILL.md").slice(0, 30); } catch { /* ignore */ }
  return `[skill ${s.name} · ${s.dir}]\n${body.trim()}${files.length ? `\n\n[files in ${s.dir}: ${files.join(", ")}]` : ""}${s.missing.length ? `\n[warning: missing CLIs ${s.missing.join(", ")}]` : ""}`;
}

/** AGENTS.md / CLAUDE.md from the project root and cwd, capped */
export function projectInstructions(cwd: string, project: string | undefined, budget: number): string {
  if (budget <= 0) return "";
  const seen = new Set<string>(); const parts: string[] = [];
  for (const d of [project, cwd].filter(Boolean) as string[]) for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    const p = join(resolve(d), f); if (seen.has(p) || !existsSync(p)) continue; seen.add(p);
    try { parts.push(`### ${p}\n${readFileSync(p, "utf8").trim()}`); } catch { /* ignore */ }
  }
  if (!parts.length) return "";
  let text = "## Project instructions\n" + parts.join("\n\n");
  if (countTokens(text) > budget) text = text.slice(0, budget * 3) + "\n[project instructions truncated]";
  return text;
}
