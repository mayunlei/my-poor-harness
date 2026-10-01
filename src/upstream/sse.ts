/**
 * Responses SSE helpers. The Codex backend (store:false) sends `response.completed`
 * with an empty `output`; the items only appear as `response.output_item.done`
 * events. The collector rebuilds the final response object from both.
 */
export function parseSseBlocks(text: string): any[] {
  const events: any[] = [];
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try { events.push(JSON.parse(payload)); } catch { /* ignore */ }
  }
  return events;
}

export class ResponseCollector {
  items: any[] = [];
  final: any = null;
  error: any = null;
  feed(ev: any): void {
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "response.output_item.done" && ev.item) { const i = typeof ev.output_index === "number" ? ev.output_index : this.items.length; this.items[i] = ev.item; }
    else if (ev.type === "response.completed" || ev.type === "response.incomplete") this.final = ev.response;
    else if (ev.type === "response.failed") { this.final = ev.response; this.error = ev.response?.error ?? { message: "response.failed" }; }
    else if (ev.type === "error") this.error = ev.error ?? ev;
  }
  /** final response with `output` filled from output_item.done when the completed event omitted it */
  response(): any {
    if (!this.final) return null;
    const items = this.items.filter(Boolean);
    const out = Array.isArray(this.final.output) && this.final.output.length ? this.final.output : items;
    return { ...this.final, output: out };
  }
}

/** incremental "data:" block splitter for streamed bodies */
export class SseLineBuffer {
  private buf = "";
  push(chunk: string): any[] {
    this.buf += chunk;
    const out: any[] = [];
    let idx;
    while ((idx = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + 2);
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try { out.push(JSON.parse(payload)); } catch { /* ignore */ }
    }
    return out;
  }
}
