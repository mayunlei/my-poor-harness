/**
 * ArtifactStore: content-addressed storage for raw tool outputs and transcripts.
 * Everything that leaves the model's context is written here first, so a stub
 * can always be expanded again via recall(id).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sha1 } from "./items.js";

export interface ArtifactMeta {
  id: string;
  bytes: number;
  lines: number;
  createdAt: string;
  kind: string;
  label?: string;
}

export class ArtifactStore {
  readonly root: string;
  constructor(root?: string) {
    this.root = root ?? join(process.env.TOKEN_HARNESS_HOME ?? join(homedir(), ".token_harness"), "artifacts");
    mkdirSync(this.root, { recursive: true });
  }

  private pathFor(id: string): string { return join(this.root, id.slice(0, 2), id); }

  put(text: string, kind = "output", label?: string): ArtifactMeta {
    const id = sha1(text).slice(0, 12);
    const p = this.pathFor(id);
    const metaObj: ArtifactMeta = { id, bytes: Buffer.byteLength(text), lines: text.split("\n").length, createdAt: new Date().toISOString(), kind, label };
    if (!existsSync(p) || !existsSync(p + ".meta.json")) {
      mkdirSync(join(this.root, id.slice(0, 2)), { recursive: true });
      // atomic writes: concurrent processes (e.g. two replays) may store the same artifact
      const tmp = p + "." + process.pid + ".tmp";
      writeFileSync(tmp, text); renameSync(tmp, p);
      writeFileSync(tmp, JSON.stringify(metaObj)); renameSync(tmp, p + ".meta.json");
      return metaObj;
    }
    try { return JSON.parse(readFileSync(p + ".meta.json", "utf8")) as ArtifactMeta; } catch { return metaObj; }
  }

  has(id: string): boolean { return existsSync(this.pathFor(id)); }

  get(id: string): string | undefined {
    const p = this.pathFor(id);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }

  meta(id: string): ArtifactMeta | undefined {
    const p = this.pathFor(id) + ".meta.json";
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
  }

  /** recall(id, {grep, range, head, tail}) returns a bounded slice of the artifact */
  recall(id: string, opts: { grep?: string; range?: [number, number]; head?: number; tail?: number; maxChars?: number } = {}): string {
    const text = this.get(id);
    if (text === undefined) return `[artifact ${id} not found]`;
    const maxChars = opts.maxChars ?? 12000;
    const lines = text.split("\n");
    let out: string[];
    if (opts.grep) {
      let re: RegExp;
      try { re = new RegExp(opts.grep, "i"); } catch { re = new RegExp(opts.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      out = [];
      lines.forEach((l, i) => { if (re.test(l)) out.push(`${i + 1}: ${l}`); });
      if (out.length === 0) out = [`[no lines match /${opts.grep}/ in ${lines.length} lines]`];
      if (out.length > 200) out = out.slice(0, 200).concat([`[... ${out.length - 200} more matches]`]);
    } else if (opts.range) {
      const [a, b] = opts.range;
      out = lines.slice(Math.max(0, a - 1), b).map((l, i) => `${a + i}: ${l}`);
    } else if (opts.tail) {
      out = lines.slice(-opts.tail);
    } else {
      out = lines.slice(0, opts.head ?? 200);
      if (lines.length > out.length) out.push(`[... ${lines.length - out.length} more lines; use range/grep/tail]`);
    }
    let s = out.join("\n");
    if (s.length > maxChars) s = s.slice(0, maxChars) + `\n[... truncated to ${maxChars} chars]`;
    return s;
  }

  size(): number {
    try { return statSync(this.root).size; } catch { return 0; }
  }
}
