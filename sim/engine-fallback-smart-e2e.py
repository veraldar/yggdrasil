#!/usr/bin/env python3
"""engine-fallback-smart-e2e.py — the "Smarter engine fallback" proposal (11-26), end to end.

Boots a scratch brain + mock upstream + FAKE `claude`, `agy` and `opencode` binaries whose quota is
a switch (ctl.json: engine -> epoch it is out until; while out they answer the quota error with
the reset they print: "Resets in Ns"). Four engines in one role's list, in priority order:
    1 claude (home)   2 agy   3 opencode   4 root (glm-5.3)

  S1  nothing out -> the home engine (1) serves.
  S2  1 out -> 2 serves, the session keeps engine 1; the reply carries one "↪" line; a second turn
      while 1 is out does not even start 1 (the reset it printed is known).
  S3  1 and 2 out -> 3 serves, again the session stays on 1; the next turn goes straight to 3.
  S4  1 resets -> the next turn is back on 1 ("a session never stays lower once a higher one is back").
  S5  every engine of a 3-engine role out -> an owner's turn WAITS for the earliest reset (busy,
      alive), then the walk starts again from the top: 1 serves; it says so on the reply.
  S6  the same with nobody watching (a heartbeat-shaped auto turn): no wait, no engine started,
      the session is paused until the reset; the turn ends at once saying so.
  S7  wait cap 0 (the old behaviour): the turn fails at once with the reset time.

Usage: sim/engine-fallback-smart-e2e.py [--bin PATH] [--port-base N]     exit 0 = all green
"""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("hf", os.path.join(HERE, "harness-fallback-e2e.py"))
hf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hf)  # its main() is guarded: only the helpers load
req, req_status, check, wait, write_exec, lines_of, meta_of, FAILS = hf.req, hf.req_status, hf.check, hf.wait, hf.write_exec, hf.lines_of, hf.meta_of, hf.FAILS


def notices(msg):
    return [p.get("text") or "" for p in (msg or {}).get("parts") or [] if isinstance(p, dict) and p.get("notice")]


def text_of(msg):
    return "".join(p.get("text") or "" for p in (msg or {}).get("parts") or [] if isinstance(p, dict) and p.get("type") == "text" and not p.get("notice"))


FAKE_PY = """#!/usr/bin/env python3
import json, os, sys, time
ENGINE = {engine!r}
ctl = json.load(open({ctl!r}))
until = ctl.get(ENGINE, 0)
body = sys.stdin.read() if ENGINE != "opencode" else (sys.argv[-1] if len(sys.argv) > 1 else "")
if len(sys.argv) > 1 and sys.argv[1] == "models":
    print("gemini-4-neon-high\\tGemini 4 Neon (High)")
    sys.exit(0)
with open({log!r}, "a") as f:
    f.write(json.dumps({{"t": time.time(), "argv": sys.argv[1:]}}) + "\\n")
left = int(until - time.time()) + 1
out = time.time() < until
def emit(v):
    print(json.dumps(v), flush=True)
if ENGINE == "claude":
    if out:
        emit({{"type": "system", "subtype": "init", "session_id": "cc-1"}})
        emit({{"type": "result", "subtype": "error", "is_error": True, "result": "You've hit your 5-hour limit · resets in %ds" % left, "session_id": "cc-1"}})
        sys.exit(1)
    emit({{"type": "system", "subtype": "init", "session_id": "cc-1"}})
    emit({{"type": "result", "subtype": "success", "is_error": False, "result": "CLAUDE-OK", "session_id": "cc-1"}})
elif ENGINE == "agy":
    if out:
        emit({{"event": "result", "result": {{"conversation_id": "", "status": "ERROR", "error": "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in %ds." % left}}}})
        sys.exit(1)
    emit({{"event": "init", "conversation_id": "agy-1"}})
    emit({{"event": "result", "result": {{"conversation_id": "agy-1", "status": "SUCCESS", "response": "AGY-OK"}}}})
else:
    if out:
        sys.stderr.write("quota exceeded: usage limit reached. Resets in %ds.\\n" % left)
        sys.exit(1)
    emit({{"type": "text", "sessionID": "ses_oc1", "part": {{"type": "text", "text": "OC-OK"}}}})
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(HERE, "..", "root", "target", "release", "yggdrasil"))
    ap.add_argument("--port-base", type=int, default=18520)
    a = ap.parse_args()
    brain_port, mock_port, brain2_port = a.port_base, a.port_base + 1, a.port_base + 2
    tmp = tempfile.mkdtemp(prefix="ygg-efs-e2e-")
    procs = []
    try:
        bin_dir, work_dir, claude_cfg = (os.path.join(tmp, d) for d in ("bin", "work", "claude-cfg"))
        for d in (bin_dir, work_dir, claude_cfg):
            os.makedirs(d)
        ctl = os.path.join(tmp, "ctl.json")
        logs = {e: os.path.join(tmp, f"{e}.log") for e in ("claude", "agy", "opencode")}

        def out_for(**secs):
            """engine -> seconds it stays out (0 = up)."""
            now = time.time()
            with open(ctl, "w") as f:
                json.dump({e: now + s for e, s in secs.items() if s}, f)

        out_for()
        for e in ("claude", "agy", "opencode"):
            write_exec(os.path.join(bin_dir, e), FAKE_PY.format(engine=e, ctl=ctl, log=logs[e]))
        calls = lambda e: len(lines_of(logs[e]))

        agents = os.path.join(tmp, "agents.json")
        with open(agents, "w") as f:
            json.dump({
                "default_agent": "four",
                "agent": {
                    "four": {"harness": "claude", "model": "opus", "fallback": ["agy/gemini-4-neon-high", "opencode", "root/glm-5.3"]},
                    "three": {"harness": "claude", "model": "opus", "fallback": ["agy/gemini-4-neon-high", "opencode"]},
                },
                "engines": {"claude": {"model": "opus"}, "antigravity": {"model": "gemini-4-neon-high"}},
            }, f)
        mock_log = open(os.path.join(tmp, "mock.log"), "w")
        brain_log = open(os.path.join(tmp, "brain.log"), "w")
        procs.append(subprocess.Popen(["python3", os.path.join(HERE, "..", "root", "mock", "mock_upstream.py"), str(mock_port)], stdout=mock_log, stderr=mock_log))
        check("mock upstream up", wait(lambda: req(mock_port, "GET", "/calls") is not None, 10))
        env = os.environ.copy()
        env.update({
            "PATH": f"{bin_dir}:{env.get('PATH', '')}",
            "YGG_UPSTREAM_BASE_URL": f"http://127.0.0.1:{mock_port}", "YGG_UPSTREAM_STYLE": "anthropic", "YGG_UPSTREAM_MODEL": "glm-5.3-flash",
            "YGG_UPSTREAM_API_KEY": "mock", "YGG_MODELS": "glm-5.3-flash,glm-5.3", "YGG_PROJECT_DIR": work_dir, "YGG_PROFILES": agents,
            "YGG_WAKE_DEBOUNCE_MS": "300", "CLAUDE_CONFIG_DIR": claude_cfg, "YGG_USAGE_CLAUDE_URL": "off", "YGG_USAGE_TTL_MS": "300",
            "YGG_LISTEN": f"127.0.0.1:{brain_port}", "YGG_DATA_DIR": os.path.join(tmp, "data"), "YGG_ROOT_NAME": "efs-sim",
        })
        os.makedirs(env["YGG_DATA_DIR"])
        procs.append(subprocess.Popen([a.bin], env=env, stdout=brain_log, stderr=brain_log))
        check("brain up", wait(lambda: req(brain_port, "GET", "/root") is not None, 10))

        sid4 = req(brain_port, "POST", "/session", {"title": "four engines", "agent": "four"})["id"]
        sid3 = req(brain_port, "POST", "/session", {"title": "three engines", "agent": "three"})["id"]

        def turn(sid, text="work", auto=False, timeout=90):
            body = {"parts": [{"type": "text", "text": text}]}
            if auto:
                body["meta"] = {"auto": True}
            t0 = time.time()
            code, out = req_status(brain_port, "POST", f"/session/{sid}/message", body, timeout)
            return code, out, req(brain_port, "GET", f"/session/{sid}"), time.time() - t0

        served = lambda out: meta_of(out).get("engine")
        home = lambda info: info.get("engine")

        # S1
        code, out, info, _ = turn(sid4)
        check("S1: nothing out -> the home engine (claude) serves", code == 200 and served(out) == "claude" and home(info) == "claude" and "CLAUDE-OK" in text_of(out), (code, served(out), text_of(out)))

        # S2 — 1 out for 6 s
        out_for(claude=6)
        c0, a0 = calls("claude"), calls("agy")
        code, out, info, _ = turn(sid4)
        n = notices(out)
        check("S2: claude out -> agy serves, the session keeps engine claude, one ↪ line on the reply",
              code == 200 and served(out) == "antigravity" and "AGY-OK" in text_of(out) and home(info) == "claude" and (info.get("model") or {}).get("id") == "opus"
              and len(n) == 1 and n[0].startswith("↪ claude/opus is out") and "antigravity/gemini-4-neon-high" in n[0] and "home" not in info,
              (code, served(out), home(info), n, info.get("model")))
        check("S2: the reply's ↪ line is no part of what the session said (text, cards)", "↪" not in text_of(out) and "↪" not in json.dumps((info.get("card") or {}).get("summary")), text_of(out))
        code, out2, info2, _ = turn(sid4)
        check("S2: the next turn, claude still out: claude is not started again (its printed reset is known); agy serves",
              code == 200 and served(out2) == "antigravity" and calls("claude") == c0 + 1 and calls("agy") == a0 + 2 and home(info2) == "claude",
              (served(out2), calls("claude"), c0, calls("agy"), a0))

        # S3 — 1 and 2 out
        time.sleep(7)  # claude is back; a marks expired
        out_for(claude=8, agy=8)
        c0, a0, o0 = calls("claude"), calls("agy"), calls("opencode")
        code, out, info, _ = turn(sid4)
        check("S3: claude and agy out -> opencode serves (claude asked once, agy once), session stays on claude",
              code == 200 and served(out) == "opencode" and "OC-OK" in text_of(out) and home(info) == "claude"
              and (calls("claude"), calls("agy"), calls("opencode")) == (c0 + 1, a0 + 1, o0 + 1)
              and len(notices(out)) == 2,
              (code, served(out), notices(out), (calls("claude") - c0, calls("agy") - a0, calls("opencode") - o0)))
        code, out2, _, _ = turn(sid4)
        check("S3: the next turn goes straight to opencode (neither dead engine is asked)",
              served(out2) == "opencode" and (calls("claude"), calls("agy")) == (c0 + 1, a0 + 1), (served(out2), calls("claude") - c0, calls("agy") - a0))

        # S4 — everything back
        time.sleep(9)
        code, out, info, _ = turn(sid4)
        check("S4: claude is back -> the session is on engine 1 again, never stuck lower",
              code == 200 and served(out) == "claude" and home(info) == "claude" and (info.get("card") or {}).get("engine") == "claude" and not notices(out),
              (served(out), home(info), notices(out)))

        # S5 — every engine of the 3-engine role out: the owner's turn waits for the earliest reset
        out_for(claude=7, agy=10, opencode=12)
        code, out, info, secs = turn(sid3)
        n = notices(out)
        check("S5: all out -> the turn waits for the earliest reset (~7 s), then starts from the top: claude serves",
              code == 200 and served(out) == "claude" and 5 <= secs <= 25 and home(info) == "claude" and any("waiting until" in x for x in n),
              (code, served(out), round(secs, 1), n))

        # S6 — all out, nobody watching
        time.sleep(1)
        out_for(claude=9, agy=9, opencode=9)
        # the engines' marks come from errors: let the brain learn them with one owner turn that fails fast
        code, out, info, secs = turn(sid3, auto=True, timeout=30)
        paused = (info.get("paused") or {}).get("until")
        check("S6: an auto turn (heartbeat), every engine out: no wait — it ends at once, saying 'paused until', the session is marked paused",
              code != 200 and secs < 10 and "paused until" in json.dumps(out) and paused and paused > time.time() * 1000, (code, out, round(secs, 1), paused))
        c0 = (calls("claude"), calls("agy"), calls("opencode"))
        code, out, info, secs = turn(sid3, auto=True, timeout=30)
        check("S6: the next heartbeat while paused starts no engine at all",
              code != 200 and secs < 5 and "paused until" in json.dumps(out) and (calls("claude"), calls("agy"), calls("opencode")) == c0, (code, out, c0))
        time.sleep(10)
        out_for()

        # S7 — wait cap 0 (a second brain): fail at once, say when
        env2 = dict(env, YGG_LISTEN=f"127.0.0.1:{brain2_port}", YGG_DATA_DIR=os.path.join(tmp, "data2"), YGG_FALLBACK_WAIT_MAX_MIN="0")
        os.makedirs(env2["YGG_DATA_DIR"])
        procs.append(subprocess.Popen([a.bin], env=env2, stdout=open(os.path.join(tmp, "brain2.log"), "w"), stderr=subprocess.STDOUT))
        check("brain 2 (wait cap 0) up", wait(lambda: req(brain2_port, "GET", "/root") is not None, 10))
        sidb = req(brain2_port, "POST", "/session", {"title": "cap zero", "agent": "three"})["id"]
        out_for(claude=30, agy=30, opencode=30)
        t0 = time.time()
        code, out = req_status(brain2_port, "POST", f"/session/{sidb}/message", {"parts": [{"type": "text", "text": "work"}]}, 40)
        check("S7: wait cap 0 -> an all-out turn fails at once and says when the earliest engine is back",
              code != 200 and time.time() - t0 < 15 and "comes back at" in json.dumps(out), (code, out, round(time.time() - t0, 1)))
    finally:
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:  # noqa: BLE001
                try:
                    p.kill()
                except Exception:  # noqa: BLE001
                    pass
        if FAILS:
            print(f"(logs kept in {tmp})")
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    print(f"{'RED' if FAILS else 'GREEN'}: {len(FAILS)} failure(s)", FAILS if FAILS else "")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
