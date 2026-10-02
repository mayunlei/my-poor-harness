/**
 * Launcher for `mph`.
 *
 * A release tarball ships the compiled dist/ and runs on plain node with no dev
 * dependencies; a source checkout has no dist/ and is run through tsx.
 *
 * A checkout that has both is the awkward case: a dist/ left over from `npm run
 * build` or `npm run package` would silently shadow every later edit to src/, so
 * when src/ is newer we run the source and say so. MPH_FROM_SOURCE=1 forces it.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

/** newest mtime under src/, or 0 when there is no source tree (a release tarball) */
function newestSource(dir) {
  let newest = 0;
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) { const m = statSync(p).mtimeMs; if (m > newest) newest = m; }
    }
  };
  walk(dir);
  return newest;
}

export function launch(entry) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const compiled = join(root, "dist", entry.replace(/^src\//, "").replace(/\.ts$/, ".js"));
  const args = process.argv.slice(2);
  const opts = { stdio: "inherit", cwd: process.cwd(), env: { ...process.env, NODE_PATH: join(root, "node_modules") } };

  let useCompiled = existsSync(compiled) && process.env.MPH_FROM_SOURCE !== "1";
  if (useCompiled) {
    const src = newestSource(join(root, "src"));
    if (src > statSync(compiled).mtimeMs) {
      console.error("[mph] dist/ is older than src/ — running from source. `npm run build` to refresh it.");
      useCompiled = false;
    }
  }

  const child = useCompiled
    ? spawn(process.execPath, [compiled, ...args], opts)
    : spawn(process.execPath, ["--import", pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href, join(root, entry), ...args], opts);
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}
