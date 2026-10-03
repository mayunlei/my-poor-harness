/**
 * Terminal output for the interactive CLI.
 *
 * Every rule in here is a mitigation first and a UI choice second. Apple Terminal
 * 2.14 (macOS 14.7.1) crashes while mph streams: its timer-driven link detector
 * walks the scrollback as an NSAttributedString
 * (__NSFireTimer -> -[NSAttributedString URLAtIndex:effectiveRange:] ->
 * CFStringFindCharacterFromSet -> _platform_memmove, SIGSEGV at 0) and the window
 * dies a few seconds into a turn, taking mph with it mid-turn. We cannot fix
 * Terminal, so we stop handing it the input it chokes on:
 *
 *   one writer      events used to go to stderr while the answer went to stdout;
 *                   two fds on one pty interleave inside a half-written line.
 *   whole lines     streamed model text is buffered and emitted a line at a time,
 *                   so the last line stops being rewritten token by token.
 *   bounded lines   every line is hard-wrapped at the window width, so no logical
 *                   line is long enough for Terminal to reflow.
 *   one write()     writes are coalesced into at most one syscall per flush_ms, so
 *                   the text storage mutates ~20x a second instead of ~2000x.
 *   no escapes in   ESC and the other C0 controls are stripped from everything the
 *                   model or a tool produced; only our own status line emits SGR.
 *   less output     folded tool calls cut what has to be scanned at all.
 *
 * The status bar is deliberately drawn without DECSTBM: a scroll region left behind
 * by a terminal that died would wreck the surviving shell. It is just the last line,
 * erased before anything prints above it, so the worst a crash can leave is one
 * stale line of text.
 */

export interface UiSettings {
  /** bottom status line (title, model, tokens, latency); TTY only */
  statusBar: boolean;
  /** collapse a step's tool calls into one line instead of one line per call */
  foldTools: boolean;
  /** hard-wrap output at the window width */
  wrap: boolean;
  /** coalesce writes into one syscall per this many ms (0 = write immediately) */
  flushMs: number;
  /** unicode = the ⚙ ↩ ≡ tags; ascii = plain words (ambiguous-width glyphs are one
   *  of the things Terminal's detector mishandles, so ascii is the default) */
  glyphs: "ascii" | "unicode";
  /** reverse video on the status line */
  color: boolean;
}

export const UI_DEFAULTS: UiSettings = { statusBar: true, foldTools: true, wrap: true, flushMs: 40, glyphs: "ascii", color: true };

export interface TurnStatus {
  title: string;
  model: string;
  step: number;
  maxSteps: number;
  input: number; cached: number; output: number; reasoning: number;
  /** what the turn is doing right now */
  phase: "" | "gate" | "thinking" | "tools" | "answering" | "wrap-up";
  /** wall time of the last completed model call */
  lastLatencyMs: number;
}

const EMPTY: TurnStatus = { title: "", model: "", step: 0, maxSteps: 0, input: 0, cached: 0, output: 0, reasoning: 0, phase: "", lastLatencyMs: 0 };

/** events that are their own line even in folded mode, with the tag they get */
const LOUD: Record<string, string> = { warn: "!", gate: "?", skill: "+", delegate: ">>", plan: "[]", verify: "ok", replan: "@", compare: "%", settings: "$", argue: "<>", step: "*" };
const UNICODE_TAG: Record<string, string> = { tool: "⚙", recall: "↩", dedupe: "≡", delegate: "⇢", job: "⏳", commentary: "…", plan: "▣", step: "▸", verify: "✓", argue: "⇄", replan: "↻", compare: "⊞", warn: "!", gate: "◇", skill: "✦", memory_miss: "?", batch: "⇉", settings: "◆" };

// ---------------------------------------------------------------------------------
// width
// ---------------------------------------------------------------------------------

/** columns a string occupies: CJK and the emoji planes are double-width, marks are zero */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x200b || (c >= 0x0300 && c <= 0x036f) || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    w += isWide(c) ? 2 : 1;
  }
  return w;
}

function isWide(c: number): boolean {
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x303e) || (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xa960 && c <= 0xa97f) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe10 && c <= 0xfe19) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1f9ff) || (c >= 0x20000 && c <= 0x3fffd);
}

/** cut to at most `cols` columns, never through a surrogate pair */
export function cutToWidth(s: string, cols: number): string {
  if (cols <= 0) return "";
  let w = 0, out = "";
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > cols) return out;
    out += ch; w += cw;
  }
  return out;
}

/** cut to `cols` columns with a trailing marker when something was dropped */
export function ellipsize(s: string, cols: number): string {
  if (displayWidth(s) <= cols) return s;
  return cutToWidth(s, Math.max(1, cols - 1)) + "…";
}

/**
 * Break into chunks of at most `cols` columns, preferring the last space. Terminal
 * reflows long logical lines on resize, which is one of the ways its detector walks
 * off the end; wrapping here means there is nothing left to reflow.
 */
export function wrapToWidth(s: string, cols: number): string[] {
  if (cols <= 2 || displayWidth(s) <= cols) return [s];
  const out: string[] = [];
  let rest = s;
  while (displayWidth(rest) > cols) {
    const head = cutToWidth(rest, cols);
    const sp = head.lastIndexOf(" ");
    const cut = sp > cols * 0.5 ? sp + 1 : head.length;
    out.push(rest.slice(0, cut).replace(/\s+$/, ""));
    // a cut that landed on a word boundary would otherwise indent the continuation
    rest = rest.slice(cut).replace(/^ +/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Strip what must never reach the terminal verbatim: ESC sequences and the other C0
 * controls (a model writing terminal code, a tool echoing a progress bar), and lone
 * surrogates, which `.slice()` on a JSON blob produces all by itself.
 */
export function sanitize(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")        // OSC (window title, hyperlinks)
    .replace(/\u001b[@-Z\\-_]|\u001b\[[0-?]*[ -/]*[@-~]/g, "")          // CSI and the rest of ESC
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g, "")           // C0/C1, keeping \t and \n
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, "�")
    .replace(/(^|[^\ud800-\udbff])([\udc00-\udfff])/g, "$1�");
}

// ---------------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------------

export interface RendererOptions {
  out?: { write(s: string): unknown; isTTY?: boolean; columns?: number; on?: (ev: string, fn: () => void) => unknown };
  ui?: Partial<UiSettings>;
  /** force/forbid TTY behaviour (status bar, wrapping); default: out.isTTY */
  tty?: boolean;
  width?: number;
  verbose?: boolean;
}

export class Renderer {
  private out: NonNullable<RendererOptions["out"]>;
  private tty: boolean;
  private widthOverride?: number;
  readonly ui: UiSettings;
  private verbose: boolean;

  private pending = "";             // complete lines waiting for the next flush
  private partial = "";             // streamed text with no newline yet
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private statusShown = false;
  private statusDirty = false;
  private suspended = true;         // no status bar until a turn starts

  private st: TurnStatus = { ...EMPTY };
  private turnStartedAt = 0;
  private stepStartedAt = 0;
  private stepTools: string[] = [];
  private stepQuiet = new Map<string, number>();   // folded chatty events of this step
  private closed = false;

  constructor(o: RendererOptions = {}) {
    this.out = o.out ?? process.stdout;
    this.tty = o.tty ?? !!this.out.isTTY;
    this.widthOverride = o.width;
    this.ui = { ...UI_DEFAULTS, ...o.ui };
    this.verbose = o.verbose ?? false;
    if (this.tty) {
      this.out.on?.("resize", () => { this.statusDirty = true; this.schedule(); });
      installExitGuard(this);
    }
  }

  get width(): number { return this.widthOverride ?? (this.tty ? this.out.columns ?? 80 : 80); }
  setVerbose(v: boolean): void { this.verbose = v; }
  isVerbose(): boolean { return this.verbose; }
  setStatusBar(on: boolean): void { this.ui.statusBar = on; if (!on) this.hideStatus(); else { this.statusDirty = true; this.schedule(); } }

  // --- output ---------------------------------------------------------------------

  /** one or more complete lines of our own text (never model output) */
  line(text = ""): void {
    for (const raw of sanitize(text).split("\n")) {
      const cols = this.width - 1;                    // never touch the last column: a
      if (this.ui.wrap && this.tty) {                 // line that exactly fills it wraps
        for (const part of wrapToWidth(raw, cols)) this.pending += part + "\n";
      } else this.pending += raw + "\n";
    }
    this.schedule();
  }

  /** streamed model text: buffered, emitted a whole line at a time */
  text(delta: string): void {
    this.partial += delta;
    const cols = this.width - 1;
    for (;;) {
      const nl = this.partial.indexOf("\n");
      if (nl >= 0) { this.emitPartial(this.partial.slice(0, nl)); this.partial = this.partial.slice(nl + 1); continue; }
      // no newline in sight: flush a line's worth so a long paragraph still appears
      if (this.ui.wrap && this.tty && displayWidth(this.partial) > cols) {
        const head = wrapToWidth(this.partial, cols);
        if (head.length < 2) break;
        this.emitPartial(head[0]);
        this.partial = this.partial.slice(head[0].length).replace(/^\s/, "");
        continue;
      }
      break;
    }
    this.schedule();
  }

  private emitPartial(s: string): void {
    const clean = sanitize(s);
    if (this.ui.wrap && this.tty) for (const part of wrapToWidth(clean, this.width - 1)) this.pending += part + "\n";
    else this.pending += clean + "\n";
  }

  /** end of a streamed answer: push out whatever has no newline yet */
  endText(): void {
    if (this.partial) { this.emitPartial(this.partial); this.partial = ""; }
    this.flushNow();
  }

  // --- events ---------------------------------------------------------------------

  /**
   * Tool calls and loop events. Folded (the default) means a step's tool calls are
   * counted and summarised in one line when the step ends -- which is what makes the
   * trace readable -- while the live detail goes to the status bar instead of the
   * scrollback. Verbose means one line per call, as it used to be.
   */
  event(e: { kind: string; detail: string }): void {
    const detail = sanitize(e.detail).replace(/\s+/g, " ").trim();
    if (e.kind === "tool") {
      const name = detail.split(" ")[0] || "tool";
      this.stepTools.push(name);
      this.st.phase = "tools";
      this.statusDirty = true;
      if (this.verbose || !this.ui.foldTools) this.line("  " + this.tag("tool") + " " + detail);
      else this.schedule();
      return;
    }
    // the batch line says "4 tool calls in one response"; the fold line already does
    if (!this.verbose && this.ui.foldTools && e.kind === "batch") return;
    if (!this.verbose && this.ui.foldTools && (e.kind === "dedupe" || e.kind === "recall" || e.kind === "job" || e.kind === "memory_miss")) {
      this.stepQuiet.set(e.kind, (this.stepQuiet.get(e.kind) ?? 0) + 1);
      this.statusDirty = true; this.schedule();
      return;
    }
    if (e.kind === "commentary") {
      if (this.verbose) this.line("  " + this.tag("commentary") + " " + detail);
      return;
    }
    this.line("  " + this.tag(e.kind) + " " + detail);
  }

  private tag(kind: string): string {
    if (this.ui.glyphs === "unicode") return UNICODE_TAG[kind] ?? "•";
    return LOUD[kind] ?? { tool: ">", recall: "<", dedupe: "=", job: "~", commentary: "#", memory_miss: "?", batch: ">>" }[kind] ?? "-";
  }

  // --- turn / step lifecycle ------------------------------------------------------

  turnStart(s: Partial<TurnStatus>): void {
    this.st = { ...EMPTY, ...s };
    this.turnStartedAt = Date.now();
    this.stepStartedAt = 0;
    this.stepTools = []; this.stepQuiet.clear();
    this.suspended = false;
    this.statusDirty = true;
    if (this.tty && this.ui.statusBar && !this.ticker) {
      this.ticker = setInterval(() => { if (!this.suspended) { this.statusDirty = true; this.flushNow(); } }, 1000);
      (this.ticker as any).unref?.();
    }
    this.schedule();
  }

  /** a model call is starting; closes the previous step's fold line */
  stepStart(step: number): void {
    this.closeStep();
    this.st.step = step;
    this.st.phase = "thinking";
    this.stepStartedAt = Date.now();
    this.stepTools = []; this.stepQuiet.clear();
    this.statusDirty = true; this.schedule();
  }

  status(s: Partial<TurnStatus>): void {
    Object.assign(this.st, s);
    this.statusDirty = true;
    this.schedule();
  }

  /** emit the folded one-liner for the step that just finished */
  private closeStep(): void {
    if (!this.stepStartedAt || this.verbose || !this.ui.foldTools) { this.stepStartedAt = 0; return; }
    const parts: string[] = [];
    if (this.stepTools.length) parts.push(`${this.stepTools.length} tool${this.stepTools.length > 1 ? "s" : ""} (${countsOf(this.stepTools)})`);
    for (const [k, n] of this.stepQuiet) parts.push(`${n} ${k}`);
    if (parts.length) {
      parts.push(secs(Date.now() - this.stepStartedAt));
      this.line(`  ${this.tag("step")} step ${this.st.step}  ${parts.join("  ")}`);
    }
    this.stepStartedAt = 0;
    this.stepTools = []; this.stepQuiet.clear();
  }

  /** end of turn: fold the last step, drop the status bar, leave a permanent summary */
  turnEnd(summary?: string): void {
    this.closeStep();
    this.endText();
    this.suspended = true;
    this.hideStatus();
    if (summary) this.line(summary);
    this.flushNow();
    if (this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
  }

  /** hide the bar before readline draws its prompt, or before a nested console.log */
  suspend(): void { this.suspended = true; this.endText(); this.hideStatus(); this.flushNow(); }
  resume(): void { if (this.tty) { this.suspended = false; this.statusDirty = true; this.schedule(); } }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.endText(); this.hideStatus(); this.flushNow();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
  }

  // --- the status line ------------------------------------------------------------

  /**
   * Segments in priority order: when the window is too narrow the lowest-priority
   * ones go first, so a 60-column window still shows the task and the tokens.
   */
  statusText(): string {
    const st = this.st;
    // each segment may offer shorter forms; a narrow window shortens before it drops,
    // and the task and the token spend are the last two things standing
    const segs: { forms: string[]; p: number }[] = [];
    segs.push({ p: 9, forms: [
      `in ${k(st.input)}${st.input ? ` (${Math.round((100 * st.cached) / Math.max(1, st.input))}% cached)` : ""} out ${k(st.output)}`,
      `in ${k(st.input)} out ${k(st.output)}`,
      `${k(st.input)}/${k(st.output)}`,
    ] });
    if (this.turnStartedAt) segs.push({ p: 8, forms: [secs(Date.now() - this.turnStartedAt)] });
    if (st.lastLatencyMs) segs.push({ p: 7, forms: [`last ${secs(st.lastLatencyMs)}`] });
    if (st.phase) segs.push({ p: 6, forms: [this.stepTools.length && st.phase === "tools" ? `${st.phase}: ${countsOf(this.stepTools)}` : st.phase, st.phase] });
    if (st.step) segs.push({ p: 5, forms: [`step ${st.step}${st.maxSteps ? "/" + st.maxSteps : ""}`, `s${st.step}`] });
    if (st.model) segs.push({ p: 4, forms: [st.model] });

    const max = this.width - 1;
    const minTitle = Math.min(12, displayWidth(st.title || "mph"));
    const at = new Map<typeof segs[number], number>(segs.map((x) => [x, 0]));
    for (;;) {
      const tail = segs.map((x) => x.forms[at.get(x)!]).join(" · ");
      const room = max - 1 - displayWidth(tail) - (tail ? 3 : 0);   // 1 for the leading space
      const last = segs.length <= 1 && (!segs.length || at.get(segs[0])! === segs[0].forms.length - 1);
      if (room >= minTitle || last) {
        const title = room > 0 ? ellipsize(st.title || "mph", room) : "";
        const text = cutToWidth(" " + [title, tail].filter(Boolean).join(" · "), max);
        const pad = text + " ".repeat(Math.max(0, max - displayWidth(text)));
        return this.ui.color ? `\u001b[7m${pad}\u001b[0m` : pad;
      }
      // drop the least important segment; only the last one standing is shortened,
      // so a 120-column window never shows "12.3k/1.2k" next to the model name
      if (segs.length > 1) {
        let worst = 0;
        for (let i = 1; i < segs.length; i++) if (segs[i].p < segs[worst].p) worst = i;
        segs.splice(worst, 1);
      } else at.set(segs[0], at.get(segs[0])! + 1);
    }
  }

  private wantStatus(): boolean { return this.tty && this.ui.statusBar && !this.suspended && !this.closed; }

  private hideStatus(): void {
    if (!this.statusShown) return;
    this.out.write("\r\u001b[2K");
    this.statusShown = false;
  }

  // --- the single write path -------------------------------------------------------

  private schedule(): void {
    if (this.ui.flushMs <= 0 || !this.tty) { this.flushNow(); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flushNow(); }, this.ui.flushMs);
    (this.timer as any).unref?.();
  }

  /** one write() per flush: the terminal sees one coherent chunk, not 2000 fragments */
  flushNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const body = this.pending; this.pending = "";
    const redraw = this.wantStatus() && (this.statusDirty || !!body || !this.statusShown);
    if (!body && !redraw && !(this.statusShown && !this.wantStatus())) return;
    let s = "";
    if (this.statusShown && (body || redraw || !this.wantStatus())) { s += "\r\u001b[2K"; this.statusShown = false; }
    s += body;
    if (this.wantStatus()) { s += this.statusText(); this.statusShown = true; this.statusDirty = false; }
    if (s) this.out.write(s);
  }
}

function countsOf(names: string[]): string {
  const c = new Map<string, number>();
  for (const n of names) c.set(n, (c.get(n) ?? 0) + 1);
  return [...c].map(([n, k2]) => (k2 > 1 ? `${n} x${k2}` : n)).join(", ");
}

/** 1.2k / 12.3k / 123k / 1.2M -- the status line has no room for 1234567 */
function k(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 100_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

function secs(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + "s";
  if (s < 60) return Math.round(s) + "s";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s - m * 60)).padStart(2, "0")}`;
}

/**
 * The bar is one line of ordinary text, so an abrupt death leaves it on screen and
 * nothing else. Still: erase it on the way out, including on a signal, so the shell
 * prompt does not land on top of it.
 */
const guarded = new Set<Renderer>();
let guardInstalled = false;
function installExitGuard(r: Renderer): void {
  guarded.add(r);
  if (guardInstalled) return;
  guardInstalled = true;
  const off = () => { for (const x of guarded) x.close(); };
  process.on("exit", off);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { off(); process.exit(sig === "SIGINT" ? 130 : 143); });
  }
}
