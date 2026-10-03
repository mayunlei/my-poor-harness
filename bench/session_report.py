#!/usr/bin/env python3
"""
Fork-aware token statistics over local Codex sessions.

A forked session starts by copying its parent's whole history into its own rollout file
within a few milliseconds, token_count events included. Counting those again inflates every
total (on one machine 78K of 94K token events in forks were copies). This report skips the
copied block: in a session whose meta has `forked_from_id`, every line before the first gap of
more than one second is the parent's history.

Usage:
  python3 bench/session_report.py [--json out.json]      # CODEX_HOME overrides ~/.codex
"""
import datetime as dt
import glob
import json
import os
import statistics
import sys

home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
files = sorted(glob.glob(os.path.join(home, "sessions", "*", "*", "*", "*.jsonl")) + glob.glob(os.path.join(home, "archived_sessions", "*.jsonl")))


def ts(s):
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def injected(text):
    t = text.lstrip()
    return t.startswith("<") or t.startswith("# AGENTS.md")


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(c.get("text", "") if isinstance(c, dict) else str(c) for c in content)
    return ""


seen_ids = set()
tot = dict(files=len(files), sessions=0, forks=0, subagents=0, copied_lines=0, copied_token_events=0, requests=0,
           input=0, cached=0, output=0, reasoning=0)
first_requests = []
turns = []          # (steps, c0, growth_per_step or None, input_sum)
first_ts = last_ts = None

for f in files:
    try:
        with open(f, encoding="utf-8") as fh:
            lines = fh.readlines()
    except Exception:
        continue
    if not lines:
        continue
    try:
        meta = json.loads(lines[0])
    except Exception:
        continue
    p = meta.get("payload", {}) if meta.get("type") == "session_meta" else {}
    sid = p.get("id") or f
    if sid in seen_ids:          # the same session archived and live
        continue
    seen_ids.add(sid)
    is_fork = bool(p.get("forked_from_id"))
    is_sub = bool(p.get("parent_thread_id")) or str(p.get("source", "")).lower().startswith("subagent")
    tot["sessions"] += 1
    tot["forks"] += is_fork
    tot["subagents"] += is_sub and not is_fork

    rows = []
    for l in lines:
        try:
            rows.append(json.loads(l))
        except Exception:
            pass
    start = 0
    if is_fork:
        prev = None
        for i, r in enumerate(rows):
            t = ts(r.get("timestamp", "") or "")
            if prev and t and (t - prev).total_seconds() > 1:
                start = i
                break
            prev = t or prev
        else:
            start = len(rows)      # nothing happened after the copy
        tot["copied_lines"] += start
        tot["copied_token_events"] += sum(1 for r in rows[:start] if r.get("type") == "event_msg" and r.get("payload", {}).get("type") == "token_count")

    prev_in = None
    turn = None
    first_done = False
    for r in rows[start:]:
        t = ts(r.get("timestamp", "") or "")
        if t:
            first_ts = t if first_ts is None or t < first_ts else first_ts
            last_ts = t if last_ts is None or t > last_ts else last_ts
        typ = r.get("type"); pl = r.get("payload", {}) or {}
        if typ == "response_item" and pl.get("type") == "message" and pl.get("role") == "user" and not injected(text_of(pl.get("content"))):
            if turn and turn["inputs"]:
                turns.append(turn)
            turn = {"inputs": []}
            continue
        if typ == "event_msg" and pl.get("type") == "token_count":
            lu = (pl.get("info") or {}).get("last_token_usage") or {}
            inp = lu.get("input_tokens") or 0
            if not inp or inp == prev_in:   # empty or the duplicate event Codex writes
                continue
            prev_in = inp
            tot["requests"] += 1
            tot["input"] += inp
            tot["cached"] += lu.get("cached_input_tokens") or 0
            tot["output"] += lu.get("output_tokens") or 0
            tot["reasoning"] += lu.get("reasoning_output_tokens") or 0
            if not first_done and not is_fork and not is_sub:
                first_requests.append(inp)
            first_done = True
            if turn is None:
                turn = {"inputs": []}
            turn["inputs"].append(inp)
    if turn and turn["inputs"]:
        turns.append(turn)

steps = [len(t["inputs"]) for t in turns]
c0 = [t["inputs"][0] for t in turns]
growth = [(t["inputs"][-1] - t["inputs"][0]) / (len(t["inputs"]) - 1) for t in turns if len(t["inputs"]) > 1]
per_turn = [sum(t["inputs"]) for t in turns]
long_share = sum(s for s, n in zip(per_turn, steps) if n >= 50) / max(1, sum(per_turn))


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else 0


report = {
    "codex_home": home,
    "range": [first_ts.date().isoformat() if first_ts else None, last_ts.date().isoformat() if last_ts else None],
    **tot,
    "cache_hit": tot["cached"] / max(1, tot["input"]),
    "input_output_ratio": tot["input"] / max(1, tot["output"]),
    "first_request_median": statistics.median(first_requests) if first_requests else 0,
    "turns": len(turns),
    "steps_mean": statistics.mean(steps) if steps else 0, "steps_p50": pct(steps, 0.5), "steps_p90": pct(steps, 0.9),
    "c0_mean": statistics.mean(c0) if c0 else 0,
    "growth_per_step_mean": statistics.mean(growth) if growth else 0,
    "input_per_turn_mean": statistics.mean(per_turn) if per_turn else 0,
    "input_per_turn_p99": pct(per_turn, 0.99), "input_per_turn_max": max(per_turn) if per_turn else 0,
    "long_turn_input_share": long_share,
}

if "--json" in sys.argv:
    with open(sys.argv[sys.argv.index("--json") + 1], "w") as fh:
        json.dump(report, fh, indent=2)

B = 1e9; M = 1e6; K = 1e3
print(f"Codex sessions in {home}, {report['range'][0]} to {report['range'][1]} (fork-aware)")
print(f"| sessions | {tot['sessions']:,} ({tot['forks']} forks, {tot['subagents']} sub-agents; {tot['copied_token_events']:,} copied token events skipped) |")
print(f"| requests | {tot['requests']:,} |")
print(f"| input tokens | {tot['input']/B:.1f}B (cache hit {report['cache_hit']*100:.1f}%) |")
print(f"| output tokens | {tot['output']/M:.0f}M, of which reasoning {tot['reasoning']/M:.0f}M |")
print(f"| input : output | {report['input_output_ratio']:.0f} : 1 |")
print(f"| first request of a fresh session (median) | {report['first_request_median']/K:.0f}K |")
print(f"| steps per turn | mean {report['steps_mean']:.0f} / p50 {report['steps_p50']} / p90 {report['steps_p90']} |")
print(f"| context when a turn starts (mean) | {report['c0_mean']/K:.0f}K |")
print(f"| growth per step (mean) | {report['growth_per_step_mean']/K:.1f}K |")
print(f"| input per turn | mean {report['input_per_turn_mean']/M:.1f}M / p99 {report['input_per_turn_p99']/M:.0f}M / max {report['input_per_turn_max']/M:.0f}M |")
print(f"| share of input in turns of >= 50 steps | {report['long_turn_input_share']*100:.0f}% |")
