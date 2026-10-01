#!/usr/bin/env python3
"""
R6 quality regression for token_harness on SWE-bench Lite dev (23 cases).

Two arms, same model, same prompt, same step budget; only the context policy differs:
  off : compression disabled (no stubs, no poll collapse, no read dedupe, max output cap,
        max turn budget, no reasoning drop)  -> the baseline
  on  : default knobs (shaping, folding with hysteresis, dedupe, recall)

Solver   : `th run` (token_harness harness loop) in a fresh copy of the repo workspace.
Judge    : ~/Program/agentic_agent/scripts/evaluate_codex_subagent_case.py
           (hidden test patch, FAIL_TO_PASS + PASS_TO_PASS, normalized env mode).
Model    : any OpenAI-compatible endpoint given via env:
           TH_OPENAI_BASE_URL / TH_OPENAI_API_KEY / TH_OPENAI_WIRE_API, model via --model.

Usage (python >= 3.10 with pandas + pyarrow):
  python bench/swe_regress.py --out ~/.token_harness/regress/<stamp> --model qwen3.7-plus \
      [--arms off,on] [--cases id1,id2] [--parallel 4] [--max-steps 40]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

TH_ROOT = Path(__file__).resolve().parents[1]
AGENTIC = Path(os.environ.get("AGENTIC_AGENT_ROOT", Path.home() / "Program" / "agentic_agent"))
sys.path.insert(0, str(AGENTIC / "src"))
sys.path.insert(0, str(AGENTIC))

from agentic_agent.benchmark import SWEBenchBenchmarkRunner, _case_prompt  # noqa: E402
from agentic_agent.config import load_config, merge_env_with_dotenv  # noqa: E402
from react_ablation_harness.repo_env import NORMALIZED_MODE, prepare_repo_env, build_shell_env  # noqa: E402

DATASET = AGENTIC / "benchmarks" / "swe_bench_lite" / "dev-00000-of-00001.parquet"

ARM_KNOBS = {
    "off": {
        "stub_old_outputs": "false", "collapse_poll_chains": "false", "dedupe_reads": "false",
        "per_output_cap": "8000", "turn_budget": "200000", "compact_on_turn_start": "never",
        "drop_reasoning_outside_window": "false", "idempotent_cmd_cache": "false",
        "rg_max_hits": "200", "log_tail_lines": "200", "traceback_tail_lines": "60",
    },
    "on": {},
    # forces folding on the short contexts of a single SWE task, so recall / stubs are exercised
    "tight": {"turn_budget": "20000", "window": "6", "per_output_cap": "1500"},
}

PROMPT_SUFFIX = (
    "\n\nPractical notes:\n"
    "- The workspace is a real local checkout with git available; your current directory is the repository root.\n"
    "- `python` / `pytest` on PATH come from a virtualenv with the repository's dependencies; PYTHONPATH points at this checkout.\n"
    "- Prefer repository-relative paths.\n"
    "- After making a change, run targeted validation and inspect git diff before you finish.\n"
    "- Finish with a short report of the root cause and the change.\n"
)


def log(*a):
    print(f"[{datetime.now().strftime('%H:%M:%S')}]", *a, flush=True)


def parse_list(v) -> list[str]:
    if isinstance(v, list):
        return [str(x) for x in v]
    t = str(v or "").strip()
    if not t:
        return []
    try:
        d = json.loads(t)
    except json.JSONDecodeError:
        return [t]
    return [str(x) for x in d] if isinstance(d, list) else [str(d)]


def th(args: list[str], env: dict, timeout: float | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess:
    # resolve tsx from token_harness, not from cwd (the solver runs inside the task workspace)
    loader = (TH_ROOT / "node_modules" / "tsx" / "dist" / "loader.mjs").as_uri()
    return subprocess.run([shutil.which("node") or "node", "--import", loader, str(TH_ROOT / "src" / "harness" / "cli.ts"), *args],
                          cwd=str(cwd or TH_ROOT), env={**env, "NODE_PATH": str(TH_ROOT / "node_modules")}, capture_output=True, text=True, timeout=timeout)


def shallow_checkout(repo: str, commit: str, ws: Path) -> None:
    """Fetch only the one commit (snapshot, no history); no timeout, retried."""
    last = ""
    for attempt in range(4):
        if ws.exists():
            shutil.rmtree(ws)
        ws.mkdir(parents=True)
        ok = True
        for cmd in (["git", "init", "-q"], ["git", "remote", "add", "origin", f"https://github.com/{repo}.git"],
                    ["git", "fetch", "-q", "--depth", "1", "origin", commit], ["git", "checkout", "-q", "FETCH_HEAD"]):
            r = subprocess.run(cmd, cwd=str(ws), capture_output=True, text=True)
            if r.returncode != 0:
                last = f"{' '.join(cmd[:3])}: {r.stderr[-300:]}"; ok = False; break
        if ok:
            return
        log(f"shallow fetch {repo}@{commit[:8]} attempt {attempt + 1} failed: {last.strip()[:200]}")
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(last)


def materialize(materializer: SWEBenchBenchmarkRunner, case, ws: Path, repo_cache: Path):
    mirror = repo_cache / (case.repo.replace("/", "__") + ".git")
    if (mirror / "HEAD").exists():
        if ws.exists():
            shutil.rmtree(ws)
        for cmd in (["git", "clone", "--quiet", "--no-checkout", str(mirror), str(ws)], ["git", "-C", str(ws), "checkout", "--quiet", case.base_commit]):
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(f"{' '.join(cmd[:3])} failed: {r.stderr[-400:]}")
        mode = "local_clone"
    else:
        shallow_checkout(case.repo, case.base_commit, ws)
        mode = "shallow_fetch"
    subprocess.run(["git", "-C", str(ws), "remote", "remove", "origin"], capture_output=True)
    subprocess.run(["git", "-C", str(ws), "config", "user.email", "bench@token-harness.local"], capture_output=True)
    subprocess.run(["git", "-C", str(ws), "config", "user.name", "bench"], capture_output=True)
    head = subprocess.run(["git", "-C", str(ws), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    return SimpleNamespace(mode=mode, workspace_root=str(ws), actual_head=head, synthetic_git_baseline=False,
                           workspace_head_matches_requested=head == case.base_commit, fallback_reason=None, requested_base_commit=case.base_commit)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--arms", default="off,on")
    ap.add_argument("--cases", default="")
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--max-steps", type=int, default=40)
    ap.add_argument("--agent-timeout", type=float, default=45 * 60)
    ap.add_argument("--eval-timeout", type=float, default=30 * 60)
    args = ap.parse_args()

    import pandas as pd

    out = Path(args.out).expanduser().resolve(); out.mkdir(parents=True, exist_ok=True)
    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    for a in arms:
        if a not in ARM_KNOBS:
            raise SystemExit(f"unknown arm {a}")
    for k in ("TH_OPENAI_BASE_URL", "TH_OPENAI_API_KEY"):
        if not os.environ.get(k):
            raise SystemExit(f"{k} must be set (OpenAI-compatible endpoint for the solver)")

    frame = pd.read_parquet(DATASET)
    rows = {r["instance_id"]: r for r in frame.to_dict("records")}
    ids = [c.strip() for c in args.cases.split(",") if c.strip()] or list(rows)

    repo_cache = out / "repo_cache"; repo_cache.mkdir(exist_ok=True)
    eval_env_root = out / "eval_envs"; agent_env_root = out / "agent_envs"
    config = load_config(merge_env_with_dotenv(workspace_root=AGENTIC))
    materializer = SWEBenchBenchmarkRunner(config, output_dir=out / "materialize", repo_cache_dir=repo_cache)
    cases = {c.instance_id: c for c in materializer.load_cases(DATASET)}

    base_env = {k: v for k, v in os.environ.items()}
    # --- per-arm harness homes with knobs ------------------------------------------
    for arm in arms:
        home = out / "homes" / arm; home.mkdir(parents=True, exist_ok=True)
        env = {**base_env, "TOKEN_HARNESS_HOME": str(home)}
        kv = {"main_model": args.model, "mid_model": args.model, "small_model": args.model, "use_model_summary": "false", **ARM_KNOBS[arm]}
        r = th(["knobs", *[f"{k}={v}" for k, v in kv.items()]], env)
        if r.returncode != 0:
            raise SystemExit(f"knob setup failed for {arm}: {r.stderr}")
        (home / "knobs.effective.txt").write_text(r.stdout)

    # --- prepare pristine workspaces + agent envs (serial, cached) -----------------------
    prepared: dict[str, dict] = {}
    agent_envs: dict[str, dict] = {}
    for iid in ids:
        case = cases[iid]; row = rows[iid]
        cdir = out / "cases" / iid; pristine = cdir / "pristine"
        meta_path = cdir / "prep.json"
        if meta_path.exists() and pristine.exists():
            prepared[iid] = json.loads(meta_path.read_text())
        else:
            cdir.mkdir(parents=True, exist_ok=True)
            if pristine.exists():
                shutil.rmtree(pristine)
            t0 = time.time()
            try:
                mat = materialize(materializer, case, pristine, repo_cache)
            except Exception as exc:
                log(f"PREP FAILED {iid}: {str(exc)[-300:]}")
                (cdir / "prep_error.txt").write_text(str(exc))
                continue
            prompt = _case_prompt(case, materialization=mat) + PROMPT_SUFFIX
            meta = {
                "instance_id": iid, "repo": case.repo, "base_commit": case.base_commit,
                "problem_statement": case.problem_statement, "hints_text": case.hints_text,
                "fail_to_pass": parse_list(row.get("FAIL_TO_PASS")), "pass_to_pass": parse_list(row.get("PASS_TO_PASS")),
                "test_patch": str(row.get("test_patch", "") or ""), "gold_patch": str(row.get("patch", "") or ""),
            }
            (cdir / "case_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
            (cdir / "prompt.txt").write_text(prompt)
            prepared[iid] = {"materialization": getattr(mat, "mode", "?"), "seconds": round(time.time() - t0, 1)}
            meta_path.write_text(json.dumps(prepared[iid]))
            log(f"prepared {iid} ({prepared[iid]['materialization']}, {prepared[iid]['seconds']}s)")
        repo_key = case.repo.replace("/", "__")
        if repo_key not in agent_envs:
            src = agent_env_root / "_src" / repo_key
            if not src.exists():
                src.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(pristine, src, symlinks=True)
            t0 = time.time()
            try:
                pe = prepare_repo_env(repo_key=repo_key, eval_root=src, env_root=agent_env_root, mode=NORMALIZED_MODE)
                agent_envs[repo_key] = {"venv": str(pe.venv_dir), "notes": pe.notes}
                log(f"agent env {repo_key}: {pe.venv_dir} ({round(time.time() - t0)}s)")
            except Exception as exc:
                agent_envs[repo_key] = {"venv": None, "error": str(exc)[-2000:]}
                log(f"agent env {repo_key} FAILED: {str(exc)[-300:]}")
    (out / "agent_envs.json").write_text(json.dumps(agent_envs, indent=2))

    # --- run arms ---------------------------------------------------------------------------
    repo_locks: dict[str, threading.Lock] = {}
    lock_guard = threading.Lock()
    results_path = out / "results.jsonl"
    done = set()
    if results_path.exists():
        for line in results_path.read_text().splitlines():
            try:
                d = json.loads(line); done.add((d["arm"], d["instance_id"]))
            except Exception:
                pass
    write_lock = threading.Lock()

    def job(arm: str, iid: str) -> dict:
        case = cases[iid]
        repo_key = case.repo.replace("/", "__")
        cdir = out / "cases" / iid
        adir = out / "runs" / arm / iid
        if adir.exists():
            shutil.rmtree(adir)
        adir.mkdir(parents=True)
        ws = adir / "workspace"
        shutil.copytree(cdir / "pristine", ws, symlinks=True)
        # the prompt names the materialized path; point it at this arm's own copy
        prompt_file = adir / "prompt.txt"
        prompt_file.write_text((cdir / "prompt.txt").read_text().replace(str(cdir / "pristine"), str(ws)))
        shutil.copy2(cdir / "case_meta.json", adir / "case_meta.json")
        home = out / "homes" / arm
        venv = agent_envs.get(repo_key, {}).get("venv")
        env = build_shell_env(venv_dir=Path(venv)) if venv else dict(base_env)
        env["PYTHONPATH"] = str(ws / "src") if (ws / "src").is_dir() and any((ws / "src").glob("*/__init__.py")) else str(ws)
        env["TOKEN_HARNESS_HOME"] = str(home)
        t0 = time.time()
        status = "ok"
        try:
            r = th(["run", "--cwd", str(ws), "--max-steps", str(args.max_steps), "--title", f"{arm}:{iid}", "--prompt-file", str(prompt_file)], env, timeout=args.agent_timeout, cwd=ws)
            stdout, stderr = r.stdout, r.stderr
        except subprocess.TimeoutExpired as e:
            status = "agent_timeout"
            stdout = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
            stderr = (e.stderr or b"").decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
        agent_s = time.time() - t0
        # guard: the solver must not touch the shared pristine checkout
        dirty = subprocess.run(["git", "status", "--porcelain"], cwd=str(cdir / "pristine"), capture_output=True, text=True).stdout.strip()
        if dirty:
            subprocess.run(["git", "checkout", "--", "."], cwd=str(cdir / "pristine"), capture_output=True)
            subprocess.run(["git", "clean", "-fdq"], cwd=str(cdir / "pristine"), capture_output=True)
            status = "touched_pristine"
        (adir / "agent.stdout.txt").write_text(stdout); (adir / "agent.stderr.txt").write_text(stderr)
        m = re.search(r"\[(s_[0-9a-f]+) · (\d+) steps · in (\d+) cached (\d+) · out (\d+)\]", stdout)
        sid = m.group(1) if m else None
        if status == "ok" and not sid:
            status = "agent_crash"
        elif "[model error]" in stdout:
            status = "model_error"
        elif "[stopped after" in stdout:
            status = "step_limit"
        # token accounting from the arm ledger (thread-safe enough: we only read rows of our session)
        tok = {"steps": 0, "input": 0, "cached": 0, "output": 0, "reasoning": 0, "ctx_before": 0, "ctx_after": 0, "compactions": 0, "recalls": 0, "folded": 0}
        if sid:
            for line in (home / "ledger.jsonl").read_text().splitlines():
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("session") != sid or d.get("source") != "harness" or d.get("event") not in ("response", "compact"):
                    continue
                tok["steps"] += 1
                for k in ("input", "cached", "output", "reasoning", "ctx_before", "ctx_after"):
                    tok[k] += int(d.get(k) or 0)
                tok["compactions"] += d.get("event") == "compact"
                tok["recalls"] += d.get("tool_kind") == "recall"
                tok["folded"] = max(tok["folded"], int((d.get("extra") or {}).get("folded") or 0))
        # judge (serialized per repo: the eval env is shared and gets an editable install)
        with lock_guard:
            lk = repo_locks.setdefault(repo_key, threading.Lock())
        t1 = time.time()
        with lk:
            try:
                ev = subprocess.run([sys.executable, str(AGENTIC / "scripts" / "evaluate_codex_subagent_case.py"), "--case-root", str(adir), "--env-root", str(eval_env_root)],
                                    cwd=str(AGENTIC), capture_output=True, text=True, timeout=args.eval_timeout)
                (adir / "eval.stdout.txt").write_text(ev.stdout + "\n" + ev.stderr)
            except subprocess.TimeoutExpired:
                (adir / "eval.stdout.txt").write_text("eval timeout")
        er_path = adir / "eval_result.json"
        er = json.loads(er_path.read_text()) if er_path.exists() else {"accepted": False, "failure_category": "eval_missing"}
        diff = subprocess.run(["git", "diff", "--stat"], cwd=str(ws), capture_output=True, text=True).stdout.strip().splitlines()
        res = {
            "arm": arm, "instance_id": iid, "repo": case.repo, "status": status, "session": sid,
            "accepted": bool(er.get("accepted")), "failure_category": er.get("failure_category"),
            "fail_to_pass_ok": er.get("fail_to_pass_ok"), "pass_to_pass_ok": er.get("pass_to_pass_ok"),
            "changed_files": er.get("candidate_changed_files"), "diffstat": diff[-1] if diff else "",
            "agent_s": round(agent_s), "eval_s": round(time.time() - t1), **tok,
        }
        # the workspace copies are large; keep the patch, drop the tree
        try:
            (adir / "final.diff").write_text(subprocess.run(["git", "diff"], cwd=str(ws), capture_output=True, text=True).stdout)
            shutil.rmtree(ws, ignore_errors=True); shutil.rmtree(adir / "eval_candidate", ignore_errors=True)
        except Exception:
            pass
        with write_lock:
            with results_path.open("a") as f:
                f.write(json.dumps(res) + "\n")
        log(f"{arm:3} {iid:38} accepted={res['accepted']!s:5} {res['failure_category'] or '':22} steps={tok['steps']:3} in={tok['input']:>8} out={tok['output']:>6} ctx {tok['ctx_before']}→{tok['ctx_after']} status={status} ({res['agent_s']}s+{res['eval_s']}s)")
        return res

    skipped = [iid for iid in ids if iid not in prepared]
    if skipped:
        log(f"skipping {len(skipped)} cases that could not be prepared: {', '.join(skipped)}")
    jobs = [(arm, iid) for iid in ids if iid in prepared for arm in arms if (arm, iid) not in done]
    log(f"{len(jobs)} jobs ({len(done)} already done), parallel={args.parallel}")
    with ThreadPoolExecutor(max_workers=max(1, args.parallel)) as pool:
        futs = {pool.submit(job, a, i): (a, i) for a, i in jobs}
        for f in as_completed(futs):
            try:
                f.result()
            except Exception as exc:
                a, i = futs[f]
                log(f"JOB FAILED {a} {i}: {exc}")
                with write_lock:
                    with results_path.open("a") as fh:
                        fh.write(json.dumps({"arm": a, "instance_id": i, "accepted": False, "status": "harness_error", "failure_category": "harness_error", "error": str(exc)[-1000:]}) + "\n")
    summarize(out, arms)
    return 0


def summarize(out: Path, arms: list[str]) -> None:
    rows = [json.loads(l) for l in (out / "results.jsonl").read_text().splitlines() if l.strip()]
    last = {}
    for r in rows:
        last[(r["arm"], r["instance_id"])] = r
    ids = sorted({i for _, i in last})
    lines = ["# token_harness R6 regression (SWE-bench Lite dev)", "", f"output: {out}", ""]
    lines.append("| arm | cases | accepted | input tok | cached | output tok | steps | input / accepted |")
    lines.append("|---|---|---|---|---|---|---|---|")
    agg = {}
    for arm in arms:
        rs = [last[(arm, i)] for i in ids if (arm, i) in last]
        acc = sum(r.get("accepted", False) for r in rs)
        s = {k: sum(int(r.get(k) or 0) for r in rs) for k in ("input", "cached", "output", "steps", "ctx_before", "ctx_after")}
        agg[arm] = {"n": len(rs), "acc": acc, **s}
        lines.append(f"| {arm} | {len(rs)} | {acc} | {s['input']:,} | {s['cached']:,} | {s['output']:,} | {s['steps']} | {s['input'] // max(1, acc):,} |")
    lines += ["", "| case | " + " | ".join(arms) + " |", "|---|" + "---|" * len(arms)]
    for i in ids:
        cells = []
        for arm in arms:
            r = last.get((arm, i))
            cells.append("-" if not r else f"{'PASS' if r.get('accepted') else (r.get('failure_category') or r.get('status'))} · {r.get('steps', 0)} st · {int(r.get('input') or 0) // 1000}K")
        lines.append(f"| {i} | " + " | ".join(cells) + " |")
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    (out / "summary.json").write_text(json.dumps(agg, indent=2))
    print("\n".join(lines))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--summarize":
        summarize(Path(sys.argv[2]), sys.argv[3].split(",") if len(sys.argv) > 3 else ["off", "on"])
    else:
        raise SystemExit(main())
