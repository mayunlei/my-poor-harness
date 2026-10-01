/**
 * Shared launcher for the th* commands.
 *
 * A release tarball ships the compiled dist/ and runs on plain node with no
 * dev dependencies; a source checkout has no dist/ and is run through tsx.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export function launch(entry) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const compiled = join(root, "dist", entry.replace(/^src\//, "").replace(/\.ts$/, ".js"));
  const args = process.argv.slice(2);
  const opts = { stdio: "inherit", cwd: process.cwd(), env: { ...process.env, NODE_PATH: join(root, "node_modules") } };
  const child = existsSync(compiled)
    ? spawn(process.execPath, [compiled, ...args], opts)
    : spawn(process.execPath, ["--import", pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href, join(root, entry), ...args], opts);
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}
