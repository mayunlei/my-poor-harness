#!/usr/bin/env node
import { spawn } from "node:child_process"; import { fileURLToPath } from "node:url"; import { dirname, join } from "node:path"; import { pathToFileURL } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
spawn(process.execPath, ["--import", pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href, join(root, "src/sidecar/cli.ts"), ...process.argv.slice(2)], { stdio: "inherit", cwd: process.cwd(), env: { ...process.env, NODE_PATH: join(root, "node_modules") } }).on("exit", (c) => process.exit(c ?? 0));
