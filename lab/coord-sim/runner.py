#!/usr/bin/env python3
"""runner.py — one coord-sim scenario run: boot arms → drive the day → grade → ledger.

Usage:
  python3 runner.py --scenario multi-task-day@1 [--arms flat,coord-choose-recall] [--run <id>]
  python3 runner.py --list

Every arm = one scratch root (lab/coord-sim/arms/boot-arm.sh, release binary, real
upstream, ports 4140-4147, never :4096/:4100/:8090). Rows append to ledger/coord-sim.jsonl
+ the bench copy, and the ledger is COMMITTED TO GIT (mission law).

Metrics-first law: each arm row carries the full metric set (see ledger.py).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

LAB = Path(__file__).resolve().parent
sys.path.insert(0, str(LAB / "grader"))
sys.path.insert(0, str(LAB))

# the venv python: hidden-test grading needs pytest (system python3 has none)
HB_PYTHON = os.environ.get("HB_PYTHON", str(Path.home() / "venvs/coordsim/bin/python"))

import metrics  # noqa: E402
import ledger  # noqa: E402
import yaml  # noqa: E402
metrics.HB_PYTHON = HB_PYTHON  # the grader's pytest runs from the venv

PORTS = {"flat": 4140, "coord": 4141, "worker": 4142, "reserve": 4143}
MODEL_IDS = {"smart": "glm-5.3", "fast": "glm-5.3-flash"}
SMART, FAST = "glm-5.3", "glm-5.3-flash"

SCENARIOS = {
    "multi-task-day@1": {
        "tasks": "tasks.yaml",
        # headline thesis row + model row (sync=recall) + sync row (model=choose)
        # + scheduling row (addendum 1: sequential vs parallel vs adaptive)
        "arms": ["flat",
                 "coord-choose-recall",
                 "coord-smart-recall", "coord-fast-recall",
                 "coord-choose-full", "coord-choose-none",
                 "coord-sched-seq", "coord-sched-par", "coord-sched-adapt"],
    },
}


# --------------------------------------------------------------------------- http

def http(method: str, url: str, body: dict | None = None, timeout: int = 600):
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def sse_turn(base: str, sid: str, text: str, log: list) -> tuple[str, int, list]:
    """One user turn: POST the message, consume SSE. Returns (reply, ttfa_ms, tool_calls).

    tool_calls: [{tool, denied, unknown}] — the profile-breach evidence stream.
    Also reads per-step upstream usage from message.updated info when present.
    """
    reply_parts, ttfa, calls, usage = [], -1, [], []
    t0 = time.monotonic()
    req = urllib.request.Request(
        f"{base}/session/{sid}/message", method="POST",
        data=json.dumps({"parts": [{"type": "text", "text": text}]}).encode(),
        headers={"content-type": "application/json", "accept": "text/event-stream"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        event, data_buf = None, []
        for raw in resp:
            line = raw.decode().rstrip("\n")
            if line.startswith("event:"):
                event = line[6:].strip()
                data_buf = []
            elif line.startswith("data:"):
                data_buf.append(line[5:].strip())
                if event and data_buf:
                    try:
                        data = json.loads("\n".join(data_buf))
                    except json.JSONDecodeError:
                        data = None
                    if event == "message.part.delta" and isinstance(data, dict) and data.get("text"):
                        if ttfa < 0:
                            ttfa = int((time.monotonic() - t0) * 1000)
                        reply_parts.append(data["text"])
                    elif event == "message.part.updated" and isinstance(data, dict):
                        p = data.get("part") or {}
                        st = p.get("state") or {}
                        if p.get("type") == "tool" and st.get("status") in ("completed", "error"):
                            calls.append({"tool": p.get("tool"), "status": st.get("status"),
                                          "denied": bool((st.get("metadata") or {}).get("denied")),
                                          "unknown": str(st.get("output", "")).startswith("unknown tool")})
                            log.append({"tool": p.get("tool"), "status": st.get("status")})
                    elif event == "message.updated" and isinstance(data, dict):
                        info = data.get("info") or {}
                        if info.get("role") == "assistant":
                            u = info.get("usage") or info.get("tokens")
                            if u:
                                usage.append(u)
                    event, data_buf = None, []
    return "".join(reply_parts), ttfa, calls


def session_read(base: str, sid: str) -> dict:
    st, body = http("GET", f"{base}/session/{sid}")
    return json.loads(body) if st == 200 else {}


def usage_of(session_json: dict) -> dict:
    """Sum assistant usage recorded in the stored transcript (when the root stores it)."""
    tot_in = tot_out = 0
    for m in session_json.get("messages", []):
        info = m.get("info", m)
        u = info.get("usage") or {}
        tot_in += u.get("input_tokens") or 0
        tot_out += u.get("output_tokens") or 0
    return {"in": tot_in, "out": tot_out}


# --------------------------------------------------------------------------- arms

class Arm:
    def __init__(self, arm_id: str, port: int, ctx_file: str | None, default_model: str):
        self.id = arm_id
        self.port = port
        self.base = f"http://127.0.0.1:{port}"
        self.ctx_file = ctx_file
        self.default_model = default_model
        self.tag = f"coordsim-{arm_id}"
        self.log: list = []
        self.tool_calls: list = []
        self.ttfas: list = []
        self.usage = {"in": 0, "out": 0}
        self.coord_usage = {"in": 0, "out": 0}
        self.findings: list = []

    def boot(self) -> None:
        env = dict(os.environ, YGG_CONTEXT=self.ctx_file) if self.ctx_file else dict(os.environ)
        if self.ctx_file:  # copy the card into the arm's proj dir
            proj = Path(f"/tmp/coordsim/{self.tag}/proj")
            proj.mkdir(parents=True, exist_ok=True)
            (proj / self.ctx_file).write_text(
                (LAB / "arms" / self.ctx_file).read_text().replace("{ROOT}", str(self.port)))
        env["WORLD_BIN"] = os.environ.get("WORLD_BIN",
                                          str(Path.home() / "Work/yggdrasil/target/release/yggdrasil"))
        subprocess.run(["bash", str(LAB / "arms" / "boot-arm.sh"), self.tag, str(self.port),
                        self.default_model], env=env, check=True,
                       stdout=subprocess.DEVNULL)

    def shutdown(self) -> None:
        pidf = Path(f"/tmp/coordsim/{self.tag}.pid")
        if pidf.exists():
            try:
                subprocess.run(["kill", pidf.read_text().strip()], check=False,
                               capture_output=True)
            except Exception:
                pass


def parse_arm(arm_id: str) -> Arm:
    if arm_id == "flat":
        return Arm("flat", PORTS["flat"], None, FAST)
    sm = sched_mode(arm_id)
    if sm:
        return Arm(arm_id, PORTS["coord"], "coordinator.md", FAST)
    m = re.fullmatch(r"coord-(smart|fast|choose)-(full|recall|none)", arm_id)
    if not m:
        raise SystemExit(f"bad arm id {arm_id}")
    model, sync = m.groups()
    card = {"smart": "coordinator-smart.md", "fast": "coordinator-fast.md",
            "choose": "coordinator.md"}[model]
    return Arm(arm_id, PORTS["coord"], card, FAST)


# ------------------------------------------------------------------ coordination

def coord_create_sub(arm: Arm, csid: str, title: str) -> str:
    st, body = http("POST", f"{arm.base}/session",
                    {"title": title, "parentID": csid, "profile": "build"})
    if st != 200:
        arm.findings.append(f"sub-create-failed:{st}:{body[:80]}")
        return ""
    return json.loads(body)["id"]


def coord_switch_model(arm: Arm, sid: str, choice: str) -> bool:
    mid = MODEL_IDS.get(choice)
    if not mid:
        return False
    st, body = http("POST", f"{arm.base}/api/session/{sid}/model",
                    {"model": {"id": mid, "providerID": "yggdrasil"}})
    if st != 204:
        arm.findings.append(f"coord-model-fail:{choice}:{st}")
        return False
    return True


def coord_reply(arm: Arm, csid: str, text: str, forced_model: str | None, sync: str,
                day: list, tasks: list) -> tuple[str, str]:
    """Send one user turn to the coordinator. Returns (reply, model_choice).

    THE PROFILE SEAM (tested literally, mission item 3): the coordinator session runs
    the `coordinator` profile — session-verbs + read only. It has NO bash/write, so it
    cannot itself POST to the root's session API... unless the root's profile gate
    exposes session verbs as tools. What the released root DOES give a coordinator-
    profile session: read/glob/grep/todowrite only — session verbs are NOT tools.
    v1 therefore runs the coordinator's DECISIONS as its reply (the COORD line: model +
    sync + why) and the runner executes the decision mechanically (creates the sub,
    switches its model, sends the task). The CHOICE is the model's; the hands are the
    harness's. The missing session-verb tools = FINDING profile-gap-session-verbs.
    """
    prompt = text
    if sync == "recall" and day:
        prompt += ("\n\nDAY SO FAR (recall summary, <120 words): " + summarize(day))
    elif sync == "full" and day:
        prompt += "\n\nDAY SO FAR (full transcript):\n" + "\n".join(day)
    reply, ttfa, calls = sse_turn(arm.base, csid, prompt, arm.log)
    arm.ttfas.append(ttfa)
    arm.tool_calls.extend(calls)
    u = usage_of(session_read(arm.base, csid))
    arm.coord_usage = {"in": u["in"], "out": u["out"]}
    m = re.search(r"COORD:.*?model=(smart|fast)", reply or "", re.I)
    if m:
        choice = m.group(1).lower()
    elif forced_model:
        choice = forced_model
    else:
        choice = "fast"  # a coordinator that never answered the COORD line defaults fast
        arm.findings.append("coord-no-choice: no COORD line parsed, defaulted fast")
    return reply, choice


def summarize(day: list) -> str:
    """The recall roll-up: ≤120 words, built from the day's known facts (deterministic)."""
    return " ".join(d[:40] for d in day[-2:])[:900]


def grade_contains(reply: str, expected: list) -> bool:
    """Task-level 'done' check: all expected strings present. The scheduler uses this to
    know when a parallel task finished; grade_arm re-grades the full spec later."""
    hay = metrics._norm(reply)
    return all(metrics._norm(e) in hay for e in expected)


# ---------------------------------------------------------------- scheduling (addendum 1)

def sched_mode(arm_id: str) -> str | None:
    """'seq' | 'par' | 'adapt' for coord-sched-* arms, else None."""
    m = re.fullmatch(r"coord-sched-(seq|par|adapt)", arm_id)
    return m.group(1) if m else None


def run_coord_sched(arm: Arm, tasks: list, mode: str) -> dict:
    """The scheduling arms (parallel.md): same coordinator seam, same worker turns,
    only LAUNCH ORDER differs. t5 always waits for its deps (the graph is real)."""
    csid = json.loads(http("POST", f"{arm.base}/session",
                           {"title": "[sim] coordinator day",
                            "profile": "coordinator"})[1])["id"]
    day: list = []
    results: dict = {}
    arrivals: dict = {}
    t0 = time.monotonic()
    coord_ms = 0
    by_id = {t["id"]: t for t in tasks}
    order = [t["id"] for t in tasks]

    def decide(t: dict) -> str:
        """One coordinator turn → the model choice."""
        nonlocal coord_ms
        t1 = time.monotonic()
        ask = ("TASK ARRIVING: " + t["prompt"][:220] +
               "\n\nDecide ONLY — reply with exactly one line:\n"
               f"COORD: task={t['id']} model=<smart|fast> why=<one sentence>")
        reply, choice = coord_reply(arm, csid, ask, None, "none", day, tasks)
        coord_ms += int((time.monotonic() - t1) * 1000)
        return choice

    def execute(t: dict, choice: str) -> dict:
        sub = coord_create_sub(arm, csid, t["id"])
        if sub:
            coord_switch_model(arm, sub, choice)
        wmodel = (MODEL_IDS.get(choice) or arm.default_model) if sub else arm.default_model
        wprompt = t["prompt"]
        if day:
            wprompt += "\n\nDAY SO FAR (recall summary): " + summarize(day)
        wreply, wttfa, wcalls = sse_turn(arm.base, sub, wprompt, arm.log)
        arm.ttfas.append(wttfa)
        arm.tool_calls.extend(wcalls)
        wu = usage_of(session_read(arm.base, sub))
        arm.usage["in"] += wu["in"]; arm.usage["out"] += wu["out"]
        day.append(f"task {t['id']}: worker({wmodel}) replied: {wreply[:300]}")
        return {"id": t["id"], "reply": wreply, "session": sub, "model": wmodel,
                "coord_reply": ""}

    if mode == "seq":
        for t in tasks:
            choice = decide(t)
            arrivals[t["id"]] = time.monotonic()
            results[t["id"]] = execute(t, choice)
    elif mode == "par":
        # all independent tasks at once; t5 (the only dep-carrying task) waits
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            futs = {}
            for t in [x for x in tasks if not (x.get("deps") or [])]:
                choice = decide(t)
                arrivals[t["id"]] = time.monotonic()
                futs[pool.submit(execute, t, choice)] = t["id"]
            for f in list(futs):  # collect as they land
                r = f.result()
                results[r["id"]] = r
            for t in [x for x in tasks if (x.get("deps") or [])]:
                choice = decide(t)
                arrivals[t["id"]] = time.monotonic()
                results[t["id"]] = execute(t, choice)
    else:  # adapt: launch when deps allow, in arrival order, concurrently where legal
        from concurrent.futures import ThreadPoolExecutor
        done: set = set()
        waiting = {t["id"]: set(t.get("deps") or []) for t in tasks}
        with ThreadPoolExecutor(max_workers=4) as pool:
            futs = {}
            while waiting or futs:
                for tid in [tid for tid, deps in waiting.items() if deps <= done]:
                    t = by_id[tid]
                    del waiting[tid]
                    choice = decide(t)
                    arrivals[tid] = time.monotonic()
                    futs[pool.submit(execute, t, choice)] = tid
                if not futs:
                    break
                ready_f = [f for f in futs if f.done()]
                if not ready_f:
                    time.sleep(0.5)
                    continue
                for f in ready_f:
                    r = f.result()
                    results[r["id"]] = r
                    done.add(r["id"])
                    del futs[f]
    wall = int((time.monotonic() - t0) * 1000)
    ordered = [results[tid] for tid in order if tid in results]
    return {"wall_ms": wall, "results": ordered, "coord_ms": coord_ms,
            "arrivals": {k: int(v * 1000) for k, v in arrivals.items()}}



# --------------------------------------------------------------------- the flat arm

def run_flat(arm: Arm, tasks: list, sync: str) -> dict:
    sid = json.loads(http("POST", f"{arm.base}/session", {"title": "[sim] flat day"})[1])["id"]
    day: list = []
    results = []
    t0 = time.monotonic()
    for t in tasks:
        reply, ttfa, calls = sse_turn(arm.base, sid, t["prompt"], arm.log)
        arm.ttfas.append(ttfa)
        arm.tool_calls.extend(calls)
        day.append(f"task {t['id']}: user asked; assistant replied: {reply[:300]}")
        results.append({"id": t["id"], "reply": reply, "session": sid})
    arm.usage = usage_of(session_read(arm.base, sid))
    return {"wall_ms": int((time.monotonic() - t0) * 1000), "results": results,
            "coord_ms": 0}


# ------------------------------------------------------------------- the coord arm

def run_coord(arm: Arm, tasks: list, sync: str, forced_model: str | None) -> dict:
    csid = json.loads(http("POST", f"{arm.base}/session",
                           {"title": "[sim] coordinator day",
                            "profile": "coordinator"})[1])["id"]
    day: list = []
    results = []
    t0 = time.monotonic()
    coord_ms = 0
    for t in tasks:
        t1 = time.monotonic()
        # 1. the coordinator's CHOICE (its own turn, tiny prompt: decide only)
        ask = ("TASK ARRIVING: " + t["prompt"][:220] +
               "\n\nDecide ONLY — reply with exactly one line:\n"
               f"COORD: task={t['id']} model=<smart|fast> sync=<{sync}> why=<one sentence>")
        reply, choice = coord_reply(arm, csid, ask, forced_model, sync, day, tasks)
        coord_ms += int((time.monotonic() - t1) * 1000)
        # 2. the runner executes the choice: fresh sub-session on the chosen model
        sub = coord_create_sub(arm, csid, t["id"])
        if sub:
            coord_switch_model(arm, sub, choice)
        wmodel = (MODEL_IDS.get(choice) or arm.default_model) if sub else arm.default_model
        # 3. the worker's turn (its own root-seam: the sub session on the same root)
        wprompt = t["prompt"]
        if sync == "recall" and day:
            wprompt += "\n\nDAY SO FAR (recall summary): " + summarize(day)
        elif sync == "full" and day:
            wprompt += "\n\nDAY SO FAR (full transcript):\n" + "\n".join(day)
        if sub:
            wreply, wttfa, wcalls = sse_turn(arm.base, sub, wprompt, arm.log)
            arm.ttfas.append(wttfa)
            arm.tool_calls.extend(wcalls)
            wu = usage_of(session_read(arm.base, sub))
            arm.usage["in"] += wu["in"]; arm.usage["out"] += wu["out"]
        else:
            wreply, wttfa, wcalls = "", -1, []
        day.append(f"task {t['id']}: worker({wmodel}) replied: {wreply[:300]}")
        results.append({"id": t["id"], "reply": wreply, "session": sub,
                        "model": wmodel, "coord_reply": reply})
    return {"wall_ms": int((time.monotonic() - t0) * 1000), "results": results,
            "coord_ms": coord_ms}


# ------------------------------------------------------------------------ grading

def grade_arm(arm: Arm, run: dict, tasks: list, arm_id: str) -> dict:
    per_task, success, quality, laz, drf = [], 0, 0.0, 0.0, 0.0
    workdir = Path(f"/tmp/coordsim/{arm.tag}/proj")
    for t, r in zip(tasks, run["results"]):
        score, why = metrics.grade_task(r["reply"], t["grade"], workdir)
        laz_hits = []
        lz, laz_hits = metrics.laziness_score(r["reply"])
        dr, dr_missing = metrics.drift_score(r["reply"], t["grade"].get("expected", [])
                                             if t["grade"]["method"] == "contains" else [])
        per_task.append({"id": t["id"], "score": score, "why": why[:120], "laziness": lz,
                         "laziness_hits": laz_hits, "drift": dr, "drift_missing": dr_missing})
        success += 1 if score >= 1.0 else 0
        quality += score
        laz = max(laz, lz)
        if t["id"] == "t5-spec-drift-check":
            drf = dr
    return {"per_task": per_task, "success_rate": round(success / len(tasks), 3),
            "quality": round(quality / len(tasks), 3), "laziness": laz, "drift": drf}


# ------------------------------------------------------------------------ coherence

def coherence(g: dict, results: list, tasks: list) -> float:
    """coherence-of-merged-results (addendum 1): the t5 fused note judged against the
    arm's OWN earlier answers (internal consistency), not just the gold strings.
    1.0 = all facts + consistent with what the workers actually produced."""
    t5 = next((r for r in results if r["id"] == "t5-spec-drift-check"), None)
    if not t5:
        return 0.0
    note = metrics._norm(t5["reply"])
    checks = 0
    hits = 0
    for e in ["fizz.py", "a-1183", "11,012.50", "16:00"]:  # gold facts (checks 1-4)
        checks += 1
        hits += e in note
    # internal consistency vs the arm's own outputs (checks 5-6)
    t4 = next((r for r in results if r["id"] == "t4-invoice-extract"), None)
    if t4:
        checks += 1
        m = re.search(r"([\d,.]{6,})", t4["reply"] or "")
        hits += bool(m and metrics._norm(m.group(1)) in note)
    t2 = next((r for r in results if r["id"] == "t2-code-fizzbuzz"), None)
    if t2:
        checks += 1
        hits += "fizz" in note and any(w in note for w in ["saved", "wrote", "created", "wrote it", "module"])
    return round(hits / checks, 3) if checks else 0.0


# --------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="multi-task-day@1")
    ap.add_argument("--arms", default=None, help="comma list; default = scenario's arms")
    ap.add_argument("--run", default=time.strftime("%Y%m%d-%H%M"))
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        print("\n".join(SCENARIOS)); return 0
    sc = SCENARIOS[args.scenario]
    tasks = yaml.safe_load((LAB / sc["tasks"]).read_text())["tasks"]
    arm_ids = (args.arms.split(",") if args.arms else sc["arms"])

    print(f"== coord-sim run {args.run}: {len(arm_ids)} arms on scratch roots :414x")
    Path("/tmp/coordsim").mkdir(exist_ok=True)
    rows = []
    for arm_id in arm_ids:
        arm = parse_arm(arm_id)
        forced = {"coord-smart-recall": "smart", "coord-fast-recall": "fast"}.get(arm_id)
        sync = ("recall" if "-recall" in arm_id else
                "full" if "-full" in arm_id else
                "none" if "-none" in arm_id else "recall")
        try:
            arm.boot()
            sm = sched_mode(arm.id)
            if arm.id == "flat":
                run = run_flat(arm, tasks, sync)
            elif sm:
                run = run_coord_sched(arm, tasks, sm)
            else:
                run = run_coord(arm, tasks, sync, forced)
            g = grade_arm(arm, run, tasks, arm_id)
            # coherence-of-merged-results (addendum 1): t5's fused note vs the arm's OWN
            # t1/t2/t4 answers — internal consistency, not just gold facts
            coh = coherence(g, run["results"], tasks)
            breaches = [c for c in arm.tool_calls if c["denied"] or c["unknown"]]
            if breaches:
                arm.findings.append(f"profile-breach:{json.dumps(breaches[:3])}")
            if arm.id.startswith("coord"):
                # the profile-gap findings are structural, filed once per coord arm
                if not any(f.startswith("profile-gap") for f in arm.findings):
                    arm.findings.append(
                        "profile-gap-session-verbs: the coordinator profile exposes "
                        "read/glob/grep/todowrite only — session verbs are NOT tools in the "
                        "released root, so the profile alone cannot delegate; the harness "
                        "executed its COORD decisions (choice is the model's, hands are the "
                        "runner's). Root-contract §5 needs session-verb tools for the "
                        "profile to stand alone.")
                    arm.findings.append(
                        "profile-found: profile:coordinator IS accepted and ENFORCED "
                        "(write/bash/webfetch undeclared+denied) on the fresh binary — "
                        "zero build work in this lab, the gate already exists (lab/yggdrasil "
                        "was stale; the reshaped repo has it)")
            total_tok = arm.usage["in"] + arm.usage["out"] + arm.coord_usage["in"] + arm.coord_usage["out"]
            coord_tok = arm.coord_usage["in"] + arm.coord_usage["out"]
            sm2 = sched_mode(arm.id)
            r = ledger.row(
                run=args.run, scenario=args.scenario, arm=arm.id,
                matrix={"model": "flat" if arm.id == "flat" else (
                            sm2 if sm2 else arm.id.split("-")[1]),
                        "sync": ("session-context" if arm.id == "flat" else
                                 "sched" if sm2 else sync)},
                success_rate=g["success_rate"], quality=g["quality"],
                wall_ms=run["wall_ms"], tokens=total_tok,
                ttfa_ms=round(sum(t for t in arm.ttfas if t >= 0) / max(1, len(arm.ttfas))),
                laziness=g["laziness"], drift=g["drift"],
                coherence=coh,
                coord_overhead=round(coord_tok / total_tok, 3) if total_tok else 0.0,
                coord_ms=run["coord_ms"], findings=arm.findings,
                tasks=g["per_task"])
            rows.append(r)
            print(f"  {arm.id:24s} success={g['success_rate']:.2f} quality={g['quality']:.2f} "
                  f"wall={run['wall_ms']/1000:.0f}s tok={total_tok} ttfa={r['ttfa_ms']}ms "
                  f"coord%={r['coord_overhead']} findings={len(arm.findings)}")
        except Exception as e:  # the world is the first suspect
            ledger.row(run=args.run, scenario=args.scenario, arm=arm_id, verdict="FAIL",
                       findings=[f"arm-crashed:{type(e).__name__}:{str(e)[:160]}"])
            print(f"  {arm_id:24s} FAIL: {e}")
        finally:
            arm.shutdown()

    sha = ledger.commit(f"coord-sim: ledger rows for run {args.run} ({len(rows)} arms) — "
                        f"scenario {args.scenario}, session COORD-SIM")
    print(f"ledger committed: {sha or '(nothing new)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
