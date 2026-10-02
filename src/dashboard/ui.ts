/**
 * The dashboard page. Kept as a string so `tsc` output needs no asset copying
 * and the compiled dist runs with plain node and zero dependencies.
 */
export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>token-harness live</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --panel2: #1b222c; --line: #2a323d;
    --fg: #e6edf3; --dim: #8b949e; --accent: #4ea1ff; --good: #3fb950; --warn: #d29922; --bad: #f85149;
    --before: #f85149; --after: #3fb950;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f8fa; --panel:#fff; --panel2:#f0f3f6; --line:#d8dee4; --fg:#1f2328; --dim:#636c76; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  header { padding: 18px 16px 10px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 17px; letter-spacing: .2px; }
  h1 b { color: var(--accent); }
  .status { font-family: var(--mono); font-size: 12px; color: var(--dim); display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); }
  .dot.live { background: var(--good); box-shadow: 0 0 0 0 rgba(63,185,80,.7); animation: pulse 2s infinite; }
  .dot.down { background: var(--bad); }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(63,185,80,.6)} 70%{box-shadow:0 0 0 7px rgba(63,185,80,0)} 100%{box-shadow:0 0 0 0 rgba(63,185,80,0)} }
  main { padding: 0 16px 40px; max-width: 1400px; margin: 0 auto; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin: 8px 0 14px; }
  .kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .kpi .label { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: var(--dim); }
  .kpi .value { font-family: var(--mono); font-size: 25px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .kpi .sub { font-size: 11.5px; color: var(--dim); font-family: var(--mono); }
  .kpi.hero { background: linear-gradient(140deg, rgba(78,161,255,.16), transparent 70%), var(--panel); border-color: var(--accent); }
  .kpi.hero .value { color: var(--accent); font-size: 31px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 14px; }
  .panel > h2 { margin: 0; padding: 10px 14px; font-size: 12px; text-transform: uppercase; letter-spacing: .7px; color: var(--dim); border-bottom: 1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .panel > h2 .hint { text-transform: none; letter-spacing: 0; font-family: var(--mono); font-size: 11px; }
  .body { padding: 12px 14px; }
  .cols { display: grid; grid-template-columns: 1.55fr 1fr; gap: 14px; align-items: start; }
  @media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }
  table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; }
  th { text-align: right; font-weight: 500; color: var(--dim); padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; font-size: 11px; }
  th:first-child, td:first-child { text-align: left; }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--panel2); }
  tbody tr.sel { background: var(--panel2); box-shadow: inset 3px 0 0 var(--accent); }
  .sid { max-width: 190px; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: bottom; }
  .live-badge { color: var(--good); }
  .idle-badge { color: var(--dim); }
  .gain { color: var(--good); }
  .feed { list-style: none; margin: 0; padding: 0; font-family: var(--mono); font-size: 12px; max-height: 420px; overflow-y: auto; }
  .feed li { padding: 6px 14px; border-bottom: 1px solid var(--line); display: flex; gap: 8px; align-items: baseline; }
  .feed .t { color: var(--dim); }
  .ev { padding: 0 6px; border-radius: 4px; background: var(--panel2); border: 1px solid var(--line); font-size: 11px; }
  .ev.compact { color: var(--accent); border-color: var(--accent); }
  .ev.dedupe, .ev.poll_collapse, .ev.shape { color: var(--good); }
  .ev.recall { color: var(--warn); }
  .ev.plan, .ev.replan { color: var(--accent); }
  .ev.verify { color: var(--good); }
  .ev.argue { color: var(--warn); }
  .ev.strategy { color: var(--fg); border-color: var(--accent); }
  .legend { display: flex; gap: 14px; font-size: 11.5px; color: var(--dim); font-family: var(--mono); }
  .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
  .bar { height: 8px; border-radius: 4px; background: var(--panel2); overflow: hidden; border: 1px solid var(--line); }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  .empty { color: var(--dim); padding: 20px 14px; font-family: var(--mono); font-size: 12px; }
  svg { display: block; width: 100%; height: auto; }
  code { font-family: var(--mono); color: var(--dim); font-size: 11.5px; }
</style>
</head>
<body>
<header>
  <h1>token-<b>harness</b> live</h1>
  <div class="status"><span id="dot" class="dot"></span><span id="conn">connecting…</span></div>
  <div class="status" id="meta"></div>
</header>
<main>
  <div class="kpis" id="kpis"></div>
  <div class="panel" id="budgetPanel" hidden>
    <h2>Weekly budget <span class="hint" id="budgetHint"></span></h2>
    <div class="body"><div class="bar"><i id="budgetBar" style="width:0%"></i></div></div>
  </div>
  <div class="cols">
    <div>
      <div class="panel">
        <h2><span>Context per step <span class="hint" id="chartFor"></span></span>
            <span class="legend"><span><i class="sw" style="background:var(--before)"></i>client would send</span><span><i class="sw" style="background:var(--after)"></i>actually sent</span></span></h2>
        <div class="body" id="chart"></div>
      </div>
      <div class="panel">
        <h2><span>Sessions</span><span class="hint">click a row to chart it</span></h2>
        <div id="sessions"></div>
      </div>
      <div class="panel" id="stratPanel" hidden>
        <h2><span>By strategy</span><span class="hint">cost of every agent it ran · pass rate from each run's own oracle</span></h2>
        <div id="strategies"></div>
      </div>
    </div>
    <div>
      <div class="panel">
        <h2><span>Savings feed</span><span class="hint">newest first</span></h2>
        <ul class="feed" id="feed"></ul>
      </div>
      <div class="panel">
        <h2>Where the savings came from</h2>
        <div id="events"></div>
      </div>
    </div>
  </div>
  <p><code id="ledger"></code></p>
  <p><code>credits come from the upstream's own meter, which is eventually consistent and shared across your devices: totals are sound, a single row is not.</code></p>
</main>
<script>
const fmt = (n) => { n = n || 0; const a = Math.abs(n);
  if (a >= 1e9) return (n/1e9).toFixed(2)+"B"; if (a >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (a >= 1e3) return (n/1e3).toFixed(1)+"K"; return String(Math.round(n)); };
const pct = (x) => (100*(x||0)).toFixed(0)+"%";
const esc = (s) => String(s==null?"":s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const shortSid = (s) => s.length > 26 ? s.slice(0,10)+"…"+s.slice(-12) : s;
const ago = (s) => { if (s < 60) return Math.round(s)+"s"; if (s < 3600) return Math.round(s/60)+"m"; if (s < 86400) return (s/3600).toFixed(1)+"h"; return (s/86400).toFixed(1)+"d"; };

let selected = null, latest = null;

function kpis(t, snap) {
  const active = snap.sessions.filter(s => s.active).length;
  const cards = [];
  // when the upstream meters credits, real money leads
  if (t.creditsSpent > 0) cards.push({
    label: "credits spent",
    value: t.creditsSpent < 100 ? t.creditsSpent.toFixed(3) : fmt(t.creditsSpent),
    sub: (t.creditsBalance != null ? fmt(t.creditsBalance) + " left" : "balance unknown") +
         (t.creditsPerMillionIn ? " \u00b7 " + t.creditsPerMillionIn.toFixed(1) + " per 1M in" : ""),
  });
  cards.push(
    { cls: "hero", label: "quota stretch", value: "\u00d7" + (t.multiplier||1).toFixed(2),
      sub: "same work, " + (t.multiplier>1 ? (100 - 100/t.multiplier).toFixed(0)+"% less paid for" : "no data yet") },
    { label: "tokens not sent", value: fmt(t.savedTokens), sub: fmt(t.ctxBefore) + " wanted \u2192 " + fmt(t.ctxAfter) + " sent" },
    { label: "cost-equivalent saved", value: fmt(t.savedCost), sub: "paid " + fmt(t.cost) + " of " + fmt(t.baseline) },
    { label: "cache hit", value: pct(t.cacheHitRate), sub: fmt(t.cached) + " cached / " + fmt(t.input) + " in" },
    { label: "output tokens", value: fmt(t.output), sub: t.responses + " responses, " + t.turns + " turns" },
    { label: "sessions", value: String(t.sessions), sub: active + " active now" },
  );
  document.getElementById("kpis").innerHTML = cards.map(c =>
    '<div class="kpi ' + (c.cls||"") + '"><div class="label">' + c.label + '</div><div class="value">' + c.value + '</div><div class="sub">' + esc(c.sub) + '</div></div>').join("");
}

function budget(b) {
  const p = document.getElementById("budgetPanel");
  if (!b) { p.hidden = true; return; }
  p.hidden = false;
  const used = Math.min(100, 100 * b.used / b.weekly);
  document.getElementById("budgetBar").style.width = used.toFixed(1) + "%";
  document.getElementById("budgetBar").style.background = used > 85 ? "var(--bad)" : used > 60 ? "var(--warn)" : "var(--accent)";
  document.getElementById("budgetHint").textContent =
    fmt(b.used) + " / " + fmt(b.weekly) + " used (" + used.toFixed(1) + "%) · unmodified client would be at " + fmt(b.wouldHaveUsed) +
    (b.remainingSteps != null ? " · ~" + fmt(b.remainingSteps) + " steps left" : "");
}

function chart(s) {
  const el = document.getElementById("chart");
  document.getElementById("chartFor").textContent = s ? shortSid(s.session) : "";
  if (!s || s.series.length === 0) { el.innerHTML = '<div class="empty">no steps recorded yet — run the proxy or the harness and this fills in live</div>'; return; }
  const pts = s.series, W = 860, H = 230, PL = 52, PR = 8, PT = 10, PB = 22;
  const maxY = Math.max(1, ...pts.map(p => Math.max(p.before, p.after)));
  const x = (i) => PL + (pts.length === 1 ? 0 : i * (W - PL - PR) / (pts.length - 1));
  const y = (v) => PT + (H - PT - PB) * (1 - v / maxY);
  const line = (key) => pts.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p[key]).toFixed(1)).join(" ");
  const area = (key) => line(key) + " L " + x(pts.length - 1).toFixed(1) + " " + y(0) + " L " + x(0).toFixed(1) + " " + y(0) + " Z";
  const ticks = [0, .5, 1].map(f => { const v = maxY * f; return '<g><line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)"/>' +
      '<text x="' + (PL - 6) + '" y="' + (y(v) + 4) + '" fill="var(--dim)" font-size="10" text-anchor="end" font-family="monospace">' + fmt(v) + '</text></g>'; }).join("");
  el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">' + ticks +
    '<path d="' + area("before") + '" fill="var(--before)" opacity=".13"/>' +
    '<path d="' + area("after") + '" fill="var(--after)" opacity=".18"/>' +
    '<path d="' + line("before") + '" fill="none" stroke="var(--before)" stroke-width="1.6"/>' +
    '<path d="' + line("after") + '" fill="none" stroke="var(--after)" stroke-width="1.8"/>' +
    '<text x="' + PL + '" y="' + (H - 6) + '" fill="var(--dim)" font-size="10" font-family="monospace">step ' + pts[0].step + '</text>' +
    '<text x="' + (W - PR) + '" y="' + (H - 6) + '" fill="var(--dim)" font-size="10" font-family="monospace" text-anchor="end">step ' + pts[pts.length-1].step + '</text>' +
    '</svg>';
}

function sessions(list) {
  const el = document.getElementById("sessions");
  if (!list.length) { el.innerHTML = '<div class="empty">no sessions in the ledger yet</div>'; return; }
  el.innerHTML = '<table><thead><tr><th>session</th><th>model</th><th>steps</th><th>would send</th><th>sent</th><th>×</th><th>cached</th><th>folds</th><th>recalls</th><th>credits</th><th>last</th></tr></thead><tbody>' +
    list.map(s => { const mult = s.ctxAfter ? s.ctxBefore / s.ctxAfter : 1;
      const folds = (s.events.compact||0) + (s.events.shape||0) + (s.events.dedupe||0) + (s.events.poll_collapse||0);
      return '<tr data-sid="' + esc(s.session) + '" class="' + (s.session === selected ? "sel" : "") + '">' +
        '<td><span class="sid" title="' + esc(s.session) + '">' + (s.active ? '<span class="live-badge">●</span> ' : '') + esc(shortSid(s.session)) + '</span></td>' +
        '<td>' + esc(s.model || "-") + '</td><td>' + s.responses + '</td><td>' + fmt(s.ctxBefore) + '</td><td>' + fmt(s.ctxAfter) + '</td>' +
        '<td class="' + (mult > 1.05 ? "gain" : "") + '">' + mult.toFixed(2) + '</td><td>' + pct(s.input ? s.cached/s.input : 0) + '</td>' +
        '<td>' + folds + '</td><td>' + s.recalls + '</td>' +
        '<td>' + (s.creditsSpent ? (s.creditsSpent < 100 ? s.creditsSpent.toFixed(2) : fmt(s.creditsSpent)) : "-") + '</td>' +
        '<td class="' + (s.active ? "live-badge" : "idle-badge") + '">' + ago(s.idleS) + '</td></tr>'; }).join("") + '</tbody></table>';
  el.querySelectorAll("tr[data-sid]").forEach(tr => tr.onclick = () => { selected = tr.dataset.sid; render(latest); });
}

function strategies(list) {
  const p = document.getElementById("stratPanel");
  if (!list || !list.length) { p.hidden = true; return; }
  p.hidden = false;
  document.getElementById("strategies").innerHTML =
    '<table><thead><tr><th>strategy</th><th>runs</th><th>pass</th><th>calls</th><th>cost-equiv</th><th>per pass</th><th>credits</th><th>cr/pass</th><th>phases</th></tr></thead><tbody>' +
    list.map(s => {
      const ph = Object.entries(s.phases || {}).sort((a,b) => b[1]-a[1]).map(([k,v]) => k + " " + v).join(", ");
      return '<tr><td>' + esc(s.strategy) + '</td><td>' + (s.runs || 0) + '</td>' +
        '<td class="' + (s.runs && s.passed === s.runs ? "gain" : s.runs ? "" : "idle-badge") + '">' + (s.runs ? s.passed + "/" + s.runs : "-") + '</td>' +
        '<td>' + s.responses + '</td><td>' + fmt(s.cost) + '</td>' +
        '<td>' + (s.costPerPass ? fmt(s.costPerPass) : "-") + '</td>' +
        '<td>' + (s.creditsSpent ? s.creditsSpent.toFixed(2) : "-") + '</td>' +
        '<td>' + (s.creditsPerPass ? s.creditsPerPass.toFixed(2) : "-") + '</td>' +
        '<td style="text-align:left;color:var(--dim)">' + esc(ph) + '</td></tr>';
    }).join("") + '</tbody></table>';
}

function feed(rows) {
  const el = document.getElementById("feed");
  if (!rows.length) { el.innerHTML = '<li class="empty">nothing folded yet</li>'; return; }
  el.innerHTML = rows.map(r => '<li><span class="t">' + r.ts.slice(11, 19) + '</span><span class="ev ' + esc(r.event) + '">' + esc(r.event) + '</span>' +
    '<span title="' + esc(r.session) + '">t' + r.turn + '·s' + r.step + '</span>' +
    (r.saved ? '<span class="gain">−' + fmt(r.saved) + ' tok</span>' : '') +
    (r.note ? '<span class="t">' + esc(r.note).slice(0, 48) + '</span>' : '') + '</li>').join("");
}

function events(byEvent) {
  const el = document.getElementById("events");
  const rows = Object.entries(byEvent).sort((a, b) => b[1] - a[1]);
  if (!rows.length) { el.innerHTML = '<div class="empty">no events yet</div>'; return; }
  const max = rows[0][1];
  el.innerHTML = '<table><tbody>' + rows.map(([k, v]) =>
    '<tr><td>' + esc(k) + '</td><td style="width:60%"><div class="bar"><i style="width:' + (100*v/max).toFixed(1) + '%"></i></div></td><td>' + v + '</td></tr>').join("") + '</tbody></table>';
}

function render(snap) {
  if (!snap) return;
  latest = snap;
  kpis(snap.totals, snap);
  budget(snap.budget);
  if (!selected || !snap.sessions.some(s => s.session === selected)) selected = snap.sessions[0] ? snap.sessions[0].session : null;
  chart(snap.sessions.find(s => s.session === selected));
  sessions(snap.sessions);
  strategies(snap.byStrategy);
  feed(snap.feed);
  events(snap.byEvent);
  document.getElementById("meta").textContent = snap.rows + " ledger rows · " + (snap.window.from ? snap.window.from.slice(0,16).replace("T"," ") + " → " + snap.window.to.slice(11,19) : "empty");
  document.getElementById("ledger").textContent = "ledger: " + snap.ledger;
}

function conn(state, text) {
  document.getElementById("dot").className = "dot " + state;
  document.getElementById("conn").textContent = text;
}

let es;
function connect() {
  es = new EventSource("/api/stream");
  es.onopen = () => conn("live", "live");
  es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch {} };
  es.onerror = () => { conn("down", "reconnecting…"); es.close(); setTimeout(connect, 2000); };
}
fetch("/api/snapshot").then(r => r.json()).then(render).catch(() => {});
connect();
</script>
</body>
</html>`;
