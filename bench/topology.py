#!/usr/bin/env python3
"""Where does plan -> worker -> verify beat ReAct? (zero model cost, pure arithmetic)

Same cost model as README.md, applied per agent context:

    T_in(context) = n*C0 + n(n-1)/2 * (o+a)

ReAct runs the whole task in ONE context, so it pays the quadratic term once, in
full. plan_verify splits the same n steps over k independently verified steps, so
each worker's context carries only n/k steps:

    sum over k of (n/k)*C0_w + (n/k)^2/2*(o+a)  =  n*C0_w + n^2/(2k) * (o+a)

That is the whole structural argument: per-turn rebuild fixes C0, and once C0 is
small the n^2 term is what is left to attack -- splitting into k verified steps
divides it by k. The price is a planner context, a verifier per step, and the
argue rounds, which is a fixed overhead that does not shrink with n. So there is
a crossover, and below it ReAct is simply the right answer.

These are estimates from this machine's measured averages, not measurements of
the strategies themselves. `mph compare --tasks tasks.jsonl` measures the real
thing, including the part this model cannot capture: whether the cheap worker
actually succeeds.

    python3 bench/topology.py [--oa 1400] [--c0-react 5000] [--c0-worker 3000]
"""
import argparse

def ctx(n, c0, oa):
    """input tokens a single agent context burns over n steps"""
    return n * c0 + (n * (n - 1) / 2) * oa if n > 0 else 0

def react(n, a):
    return ctx(n, a.c0_react, a.oa)

def plan_verify(n, k, a):
    per = max(1, round(n / k))
    workers = sum(ctx(per, a.c0_worker, a.oa) for _ in range(k))
    verifiers = k * ctx(a.verifier_steps, a.c0_worker, a.oa)
    planner = ctx(a.planner_steps, a.c0_plan, a.oa)
    return (workers + verifiers) * a.argue_overhead + planner

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--oa", type=int, default=1400, help="tokens one step adds to its context (tool output + model output)")
    p.add_argument("--c0-react", type=int, default=5000, help="ReAct context at turn start after per-turn rebuild")
    p.add_argument("--c0-worker", type=int, default=3000, help="a worker's context: fixed prompt + step contract")
    p.add_argument("--c0-plan", type=int, default=10000, help="the planner's context (it reads the repo first)")
    p.add_argument("--planner-steps", type=int, default=6)
    p.add_argument("--verifier-steps", type=int, default=4)
    p.add_argument("--argue-overhead", type=float, default=1.3, help="multiplier for retries after an objection")
    p.add_argument("--raw-c0", type=int, default=94000, help="context an unmodified client starts a turn with")
    a = p.parse_args()

    print(f"{'steps n':>8} {'k':>3} {'ReAct':>13} {'plan_verify':>13} {'ratio':>7}  cheaper")
    for n in (4, 6, 10, 15, 20, 29, 40, 60, 100, 200):
        k = max(2, min(8, round(n / 5)))
        r, pv = react(n, a), plan_verify(n, k, a)
        print(f"{n:8d} {k:3d} {r:13,.0f} {pv:13,.0f} {pv/r:7.2f}  {'plan_verify' if pv < r else 'ReAct'}")

    n, k = 29, 6
    print(f"\nfor the average turn on this machine (n={n}):")
    for label, v in ((f"unmodified client, C0={a.raw_c0:,}", n*a.raw_c0 + (n*(n-1)/2)*a.oa),
                     ("ReAct + per-turn rebuild", react(n, a)),
                     (f"plan_verify, {k} verified steps", plan_verify(n, k, a))):
        print(f"  {label:36s} {v:13,.0f}")
    print(f"\nwhere plan_verify's tokens go at n={n}, k={k}:")
    print(f"  planner    {ctx(a.planner_steps,a.c0_plan,a.oa):11,.0f}   (paid once, does not shrink with n)")
    print(f"  workers    {sum(ctx(max(1,round(n/k)),a.c0_worker,a.oa) for _ in range(k)):11,.0f}")
    print(f"  verifiers  {k*ctx(a.verifier_steps,a.c0_worker,a.oa):11,.0f}   (the price of not trusting the worker)")

if __name__ == "__main__":
    main()
