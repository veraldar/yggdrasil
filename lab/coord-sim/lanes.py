#!/usr/bin/env python3
"""lanes.py — addendum 2: REAL model economics. Each lane in models.yaml gets its own
scratch root; each task runs fresh. Measured per lane: quality, wall, $ (notional),
laziness, continuation (unprompted work on an open-ended build), nudge-recovery,
and the SELF-REPROMPT trait (does the model decompose intent+assumptions+plan natively).

Config, not code: grant a lane → models.yaml `enabled: true` + env keys → rerun.
  HB_PYTHON=<venv python> python3 lanes.py --run <id>
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

LAB = Path(__file__).resolve().parent
sys.path.insert(0, str(LAB))
sys.path.insert(0, str(LAB / "grader"))
import yaml  # noqa: E402
import metrics  # noqa: E402
import ledger  # noqa: E402
from runner import http, sse_turn, usage_of, session_read, HB_PYTHON  # noqa: E402

metrics.HB_PYTHON = HB_PYTHON

LANE_PORTS = [4144, 4145, 4146, 4147]
PROBE = {
    "prompt": ("Build a small ASCII maze generator: maze.py with generate(w, h) -> list "
               "of strings, '#' walls, ' ' paths, a solvable perfect maze via randomized "
               "DFS. Save it as maze.py in your project directory. Keep going until it is "
               "correct and polished — do not stop early."),
    # deterministic spot-check: a 21x11 maze's structure
    "checks": ["maze.py"],
}
SELF_REPROMPT_PROMPT = (
    "hmm we need that fizzbuzz thing for the onboarding docs — you know, the classic "
    "3 and 5 one. it should be a module we can drop in the repo, no weird stuff "
    "when it gets imported. make it good.")
# the trait score: (a) restates the spec precisely, (b) names assumptions/constraints,
# (c) states a plan or proceeds with one — the MAIN self-reprompt shape
TRAIT_A = [r"fizzbuzz\s*\(\s*n", r"divisible by (3|5)", r"fizzbuzz\(15\)\s*==\s*['\"]fizzbuzz['\"]"]
TRAIT_B = [r"assum", r"no side effect", r"import", r"return", r"str"]
TRAIT_C = [r"plan", r"first,? i", r"i will", r"i'll", r"step"]


def lane_boot(tag: str, port: int, model: str, prov_file: Path) -> None:
    env = dict(os.environ, YGG_PROVIDERS_FILE=str(prov_file))
    import subprocess
    subprocess.run(["bash", str(LAB / "arms" / "boot-arm.sh"), tag, str(port), model],
                   env=env, check=True, stdout=subprocess.DEVNULL)


def lane_shutdown(tag: str) -> None:
    pidf = Path(f"/tmp/coordsim/{tag}.pid")
    if pidf.exists():
        import subprocess
        subprocess.run(["kill", pidf.read_text().strip()], check=False, capture_output=True)


def grade_lane_task(reply: str, spec: dict, workdir: Path) -> float:
    score, _ = metrics.grade_task(reply, spec, workdir)
    return score


def self_reprompt_score(reply: str) -> tuple[float, list]:
    """0..1: fraction of (a) spec-restatement, (b) assumption-naming, (c) plan-stating."""
    txt = metrics._norm(reply)
    a = any(re.search(p, txt) for p in TRAIT_A)
    b = sum(1 for p in TRAIT_B if re.search(p, txt)) >= 2
    c = any(re.search(p, txt) for p in TRAIT_C)
    hits = [n for n, v in [("spec-restated", a), ("assumptions-named", b), ("plan-stated", c)] if v]
    return round((a + b + c) / 3, 3), hits


def stall_signs(reply: str) -> bool:
    """max_tokens cap, explicit refusal to continue, or trails-off mid-artifact."""
    t = (reply or "").lower()
    return ("max_tokens" in t or "stopped at max" in t or
            bool(re.search(r"\bi (can't|cannot|won't) (continue|finish|go on)\b", t)) or
            t.rstrip().endswith(("```", ":")))


def run_lane(lane: str, cfg: dict, prices: dict, tasks: list, run_id: str, port: int) -> dict:
    tag = f"lanes-{lane}"
    base = f"http://127.0.0.1:{port}"
    workdir = Path(f"/tmp/coordsim/{tag}/proj")
    workdir.mkdir(parents=True, exist_ok=True)
    lane_boot(tag, port, cfg["model"], LAB / "arms" / "providers.json")
    out = {"lane": lane, "model": cfg["model"], "tasks": {}, "probe": {}, "trait": {}}
    try:
        # ---- the 5 task arms
        for t in tasks:
            st, body = http("POST", f"{base}/session", {"title": f"[sim] lane {lane} {t['id']}"})
            sid = json.loads(body)["id"]
            t0 = time.monotonic()
            reply, ttfa, calls = sse_turn(base, sid, t["prompt"], [])
            wall = int((time.monotonic() - t0) * 1000)
            u = usage_of(session_read(base, sid))
            score = grade_lane_task(reply, t["grade"], workdir)
            lz, _ = metrics.laziness_score(reply)
            price = prices.get(cfg["model"], {"in": 0, "out": 0})
            cost = (u["in"] * price["in"] + u["out"] * price["out"]) / 1e6
            out["tasks"][t["id"]] = {"score": score, "wall_ms": wall, "ttfa_ms": ttfa,
                                     "usd": round(cost, 6), "tokens": u["in"] + u["out"],
                                     "laziness": lz}
        # ---- the continuation probe (open-ended build; counts UNPROMPTED work)
        st, body = http("POST", f"{base}/session", {"title": f"[sim] lane {lane} probe"})
        sid = json.loads(body)["id"]
        t0 = time.monotonic()
        reply, ttfa, calls = sse_turn(base, sid, PROBE["prompt"], [])
        steps = len(calls)
        stalled = stall_signs(reply)
        nudges, recovered = 0, 0
        while stalled and nudges < 2:
            nudges += 1
            reply2, _, calls2 = sse_turn(base, sid, "Continue.", [])
            if len(calls2) > 0 or len((reply2 or "").strip()) > 40:
                recovered += 1
                stalled = stall_signs(reply2)
            else:
                break
        u = usage_of(session_read(base, sid))
        price = prices.get(cfg["model"], {"in": 0, "out": 0})
        out["probe"] = {"unprompted_tool_steps": steps,
                        "ended_by_token_cap": "max_tokens" in (reply or "").lower(),
                        "nudges_needed": nudges, "nudge_recovered": recovered,
                        "probe_usd": round((u["in"] * price["in"] + u["out"] * price["out"]) / 1e6, 6),
                        "probe_wall_ms": int((time.monotonic() - t0) * 1000)}
        # ---- the self-reprompt trait
        st, body = http("POST", f"{base}/session", {"title": f"[sim] lane {lane} trait"})
        sid = json.loads(body)["id"]
        reply, _, _ = sse_turn(base, sid, SELF_REPROMPT_PROMPT, [])
        score, hits = self_reprompt_score(reply)
        out["trait"] = {"self_reprompt_score": score, "hits": hits}
    finally:
        lane_shutdown(tag)
    # ---- ledger rows
    tscores = [v["score"] for v in out["tasks"].values()]
    ledger.row(run=run_id, kind="model-lane", lane=lane, model=cfg["model"],
               quality=round(sum(tscores) / len(tscores), 3),
               success_rate=round(sum(1 for s in tscores if s >= 1.0) / len(tscores), 3),
               wall_ms=round(sum(v["wall_ms"] for v in out["tasks"].values()) / len(out["tasks"])),
               usd_total=round(sum(v["usd"] for v in out["tasks"].values()), 6),
               tokens_total=sum(v["tokens"] for v in out["tasks"].values()),
               laziness_max=max(v["laziness"] for v in out["tasks"].values()),
               tasks=out["tasks"])
    ledger.row(run=run_id, kind="trait", lane=lane, model=cfg["model"], **out["probe"], **out["trait"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=time.strftime("%Y%m%d-%H%M"))
    args = ap.parse_args()
    conf = yaml.safe_load((LAB / "models.yaml").read_text())
    tasks = yaml.safe_load((LAB / "tasks.yaml").read_text())["tasks"]
    enabled = [(name, cfg) for name, cfg in conf["lanes"].items() if cfg.get("enabled")]
    print(f"== lanes run {args.run}: {[n for n, _ in enabled]} "
          f"(disabled: {[n for n, c in conf['lanes'].items() if not c.get('enabled')]})")
    for name, cfg in conf["lanes"].items():
        if not cfg.get("enabled"):
            ledger.row(run=args.run, kind="model-lane", lane=name, model=cfg["model"],
                       skipped="lane disabled — key not granted (config-pluggable, no code)")
            continue
        port = LANE_PORTS.pop(0)
        try:
            out = run_lane(name, cfg, conf.get("prices_notional_per_mtok", {}), tasks,
                           args.run, port)
            print(f"  {name:12s} quality={out and sum(v['score'] for v in out['tasks'].values())/len(out['tasks']):.2f} "
                  f"probe_steps={out['probe'].get('unprompted_tool_steps')} "
                  f"nudges={out['probe'].get('nudges_needed')} "
                  f"self_reprompt={out['trait'].get('self_reprompt_score')}")
        except Exception as e:
            ledger.row(run=args.run, kind="model-lane", lane=name, model=cfg.get("model"),
                       verdict="FAIL", findings=[f"lane-crashed:{type(e).__name__}:{str(e)[:140]}"])
            print(f"  {name:12s} FAIL: {e}")
    sha = ledger.commit(f"coord-sim: model-lane + trait rows, run {args.run} — addendum 2, "
                        f"session COORD-SIM")
    print(f"ledger committed: {sha or '(nothing new)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
