#!/usr/bin/env python3
"""harness-fallback-e2e.py — deterministic end-to-end proof of automatic harness+model fallback.

Boots a scratch yggdrasil brain binary + mock_upstream.py + fake `claude` and `agy` binaries on PATH
and verifies every contract rule:
  1. Session start (via MAIN) bounces on Claude 5-hour quota with 0 tools -> retries once on root
     GLM glm-5.3, briefs the taking-over model with a one-line system note, succeeds, card records
     engine=root and model=glm-5.3 (no user-facing fallback annotations), internal meta records
     fallback, MAIN woken.
  2. Follow-up turn bounces on Claude 5-hour quota with 0 tools on an override engine -> retries once
     on the role's other default engine (antigravity / gemini-4-neon-high), briefs agy with the
     one-line takeover note, card records serving engine without user-facing fallback annotations.
  3. Mid-work quota hit (1+ tools already ran) -> NEVER falls back, keeps claude + conversation id.
  4. Pinned role (`pinned: true`) with 0 tools + quota -> NEVER falls back.
  5. Trunk integrator session (`P1 · home root on the trunk (integrator)`) with 0 tools + quota ->
     NEVER falls back (while a non-P1 lead session DOES fall back).
  6. Explicit opt-out (`fallback: "none"`) -> NEVER falls back; double quota (`claude` -> `agy`
     both hitting quota) -> retries ONCE only, never chains to a third engine.
  7. Non-quota error with 0 tools -> NEVER falls back.

Usage:
    sim/harness-fallback-e2e.py [--bin PATH] [--port-base N]    exit 0 = all green
"""
import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
YGG = os.path.join(HERE, "..", "root")
FAILS = []


def req(port, method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        method=method,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def req_status(port, method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        method=method,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            body_out = json.loads(raw) if raw else {}
        except ValueError:
            body_out = {"raw": raw.decode(errors="replace")}
        return e.code, body_out


def check(name, ok, detail=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else ' — ' + str(detail)[:300]}", flush=True)
    if not ok:
        FAILS.append(name)


def wait(pred, timeout=30, step=0.25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = pred()
            if v:
                return v
        except Exception:  # noqa: BLE001
            pass
        time.sleep(step)
    return None


def tool(calls):
    return "tool:" + json.dumps([calls])


def text_of(msg):
    return "".join(
        p.get("text") or ""
        for p in (msg or {}).get("parts") or []
        if isinstance(p, dict) and p.get("type") == "text"
    )


def tree_by_title(port):
    return {r["title"]: r for r in req(port, "GET", "/tree")}


def write_exec(path, body):
    with open(path, "w") as f:
        f.write(body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def hit_count(path):
    if not os.path.exists(path):
        return 0
    with open(path) as f:
        return len([l for l in f if l.strip()])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(YGG, "target", "release", "yggdrasil"))
    ap.add_argument("--port-base", type=int, default=18470)
    a = ap.parse_args()

    brain_port = a.port_base
    mock_port = a.port_base + 1
    tmp = tempfile.mkdtemp(prefix="ygg-fb-e2e-")
    procs = []

    try:
        bin_dir = os.path.join(tmp, "bin")
        data_dir = os.path.join(tmp, "data")
        work_dir = os.path.join(tmp, "work")
        os.makedirs(bin_dir)
        os.makedirs(data_dir)
        os.makedirs(work_dir)

        claude_log = os.path.join(tmp, "claude.log")
        agy_log = os.path.join(tmp, "agy.log")

        # Fake `claude` CLI: inspects stdin prompt to trigger quota/midwork/crash/ok deterministically.
        write_exec(
            os.path.join(bin_dir, "claude"),
            f"""#!/usr/bin/env python3
import json, sys
prompt = sys.stdin.read()
with open({claude_log!r}, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "prompt": prompt[:120]}}) + "\\n")

if "MIDWORK_QUOTA" in prompt:
    print(json.dumps({{"type": "system", "subtype": "init", "session_id": "cc-midwork-1"}}), flush=True)
    print(json.dumps({{"type": "assistant", "session_id": "cc-midwork-1", "message": {{"content": [{{"type": "tool_use", "name": "Bash", "input": {{"command": "ls"}}}}]}}}}), flush=True)
    print(json.dumps({{"type": "result", "subtype": "error", "is_error": True, "result": "You've hit your 5-hour limit · resets 11:30pm (Europe/Paris)", "session_id": "cc-midwork-1"}}), flush=True)
    sys.exit(1)
if "NON_QUOTA_ERR" in prompt:
    print(json.dumps({{"type": "result", "subtype": "error", "is_error": True, "result": "invalid flag --bogus"}}), flush=True)
    sys.exit(1)
if "QUOTA_BOUNCE" in prompt or "DOUBLE_QUOTA" in prompt:
    print(json.dumps({{"type": "system", "subtype": "init", "session_id": "cc-bounce-1"}}), flush=True)
    print(json.dumps({{"type": "assistant", "session_id": "cc-bounce-1", "message": {{"content": [{{"type": "text", "text": "You've hit your 5-hour limit · resets 11:30pm (Europe/Paris)"}}]}}}}), flush=True)
    print(json.dumps({{"type": "result", "subtype": "error", "is_error": True, "result": "You've hit your 5-hour limit · resets 11:30pm (Europe/Paris)", "session_id": "cc-bounce-1"}}), flush=True)
    sys.exit(1)
print(json.dumps({{"type": "system", "subtype": "init", "session_id": "cc-ok-1"}}), flush=True)
print(json.dumps({{"type": "result", "subtype": "success", "is_error": False, "result": "CLAUDE-OK", "session_id": "cc-ok-1"}}), flush=True)
""",
        )

        # Fake `agy` CLI: handles `agy models`, quota errors for DOUBLE_QUOTA, and normal fallback replies.
        write_exec(
            os.path.join(bin_dir, "agy"),
            f"""#!/usr/bin/env python3
import json, sys
if len(sys.argv) > 1 and sys.argv[1] == "models":
    print("gemini-4-neon-high\\tGemini 4 Neon (High)")
    sys.exit(0)
line = sys.stdin.read()
with open({agy_log!r}, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "stdin": line}}) + "\\n")
if "DOUBLE_QUOTA" in line:
    print(json.dumps({{"event": "result", "result": {{"conversation_id": "", "status": "ERROR", "error": "RESOURCE_EXHAUSTED: You have exhausted your capacity on this model."}}}}), flush=True)
    sys.exit(1)
print(json.dumps({{"event": "init", "conversation_id": "agy-conv-1"}}), flush=True)
print(json.dumps({{"event": "step_update", "step_update": {{"step_type": "agent_response", "text_delta": "AGY-FALLBACK-OK"}}}}), flush=True)
print(json.dumps({{"event": "result", "result": {{"conversation_id": "agy-conv-1", "status": "SUCCESS", "response": "AGY-FALLBACK-OK"}}}}), flush=True)
""",
        )

        agents_path = os.path.join(tmp, "agents.json")
        with open(agents_path, "w") as f:
            json.dump(
                {
                    "default_agent": "build",
                    "agent": {
                        "fix": {"harness": "claude", "model": "opus"},
                        "lead": {"harness": "claude", "model": "opus"},
                        "build": {"harness": "antigravity", "model": "gemini-4-neon-high"},
                        "deploy_pinned": {"harness": "claude", "model": "opus", "pinned": True},
                        "no_fb": {"harness": "claude", "model": "opus", "fallback": "none"},
                        "double_q": {
                            "harness": "claude",
                            "model": "opus",
                            "fallback": {"engine": "antigravity", "model": "gemini-4-neon-high"},
                        },
                    },
                    "engines": {
                        "claude": {"model": "opus"},
                        "antigravity": {"model": "gemini-4-neon-high"},
                    },
                },
                f,
            )

        mock_log = open(os.path.join(tmp, "mock.log"), "w")
        brain_log = open(os.path.join(tmp, "brain.log"), "w")
        procs.append(
            subprocess.Popen(
                ["python3", os.path.join(YGG, "mock", "mock_upstream.py"), str(mock_port)],
                stdout=mock_log,
                stderr=mock_log,
            )
        )
        check("mock upstream up", wait(lambda: req(mock_port, "GET", "/calls") is not None, 10))

        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{bin_dir}:{env.get('PATH', '')}",
                "YGG_UPSTREAM_BASE_URL": f"http://127.0.0.1:{mock_port}",
                "YGG_UPSTREAM_STYLE": "anthropic",
                "YGG_UPSTREAM_API_KEY": "mock",
                "YGG_UPSTREAM_MODEL": "glm-5.3-flash",
                "YGG_MODELS": "glm-5.3-flash,glm-5.3,glm-5.2",
                "YGG_LISTEN": f"127.0.0.1:{brain_port}",
                "YGG_DATA_DIR": data_dir,
                "YGG_PROJECT_DIR": work_dir,
                "YGG_PROFILES": agents_path,
                "YGG_ROOT_NAME": "fb-sim",
                "YGG_WAKE_DEBOUNCE_MS": "300",
            }
        )
        procs.append(subprocess.Popen([a.bin], env=env, stdout=brain_log, stderr=brain_log))
        check("brain up", wait(lambda: req(brain_port, "GET", "/root") is not None, 10))

        main_id = req(brain_port, "POST", "/session", {"title": "[MAIN]"})["id"]
        say = lambda text: req(
            brain_port, "POST", f"/session/{main_id}/message", {"parts": [{"type": "text", "text": text}]}, 60
        )

        want_brief = (
            "Previous harness claude hit a hard quota before doing any work; "
            "you are taking over this session and its full context — continue the last request."
        )

        # ── Scenario 1: Session fails to start on Claude 5h quota (0 tools) -> root glm-5.3
        c0 = hit_count(claude_log)
        say(
            tool(
                [
                    [
                        "session_start",
                        {
                            "title": "quota start fix",
                            "agent": "fix",
                            "brief": "QUOTA_BOUNCE Reply with exactly: SERVED-BY-ROOT-GLM",
                        },
                    ]
                ]
            )
        )
        done = wait(
            lambda: (tree_by_title(brain_port).get("quota start fix", {}).get("card") or {}).get("status") == "done",
            25,
        )
        row = tree_by_title(brain_port).get("quota start fix", {})
        info = req(brain_port, "GET", f"/session/{row['id']}") if row else {}
        msgs = req(brain_port, "GET", f"/session/{row['id']}/message") if row else []
        last_reply = next((m for m in reversed(msgs) if m["info"]["role"] == "assistant"), {})
        raw_ctx = req(brain_port, "GET", f"/session/{row['id']}/context?part=raw") if row else {}
        check(
            "S1: session start bounces on Claude 5h quota (0 tools) -> falls back once to root glm-5.3 and completes",
            bool(done)
            and "SERVED-BY-ROOT-GLM" in text_of(last_reply)
            and hit_count(claude_log) == c0 + 1,
            {"done": done, "reply": text_of(last_reply), "claude_hits": hit_count(claude_log) - c0},
        )
        check(
            "S1: card records serving engine/model with NO user-facing fallback fields; internal meta.fallback kept",
            row.get("engine") == "root"
            and info.get("engine") == "root"
            and (info.get("model") or {}).get("id") == "glm-5.3"
            and (row.get("card") or {}).get("engine") == "root"
            and (row.get("card") or {}).get("model") == "glm-5.3"
            and "fallback_from" not in (row.get("card") or {})
            and "fallback_reason" not in (row.get("card") or {})
            and ((last_reply.get("info") or {}).get("meta") or {}).get("fallback", {}).get("from") == "claude",
            {"row_engine": row.get("engine"), "model": info.get("model"), "card": row.get("card")},
        )
        check(
            "S1: taking-over root model received the one-line takeover system brief",
            want_brief in json.dumps(raw_ctx, ensure_ascii=False),
            json.dumps(raw_ctx, ensure_ascii=False)[-400:],
        )
        # Digest uses default model (glm-5.3-flash), so check transcript meta + session model for glm-5.3
        check(
            "S1: reply metadata stamps serving engine=root and model=glm-5.3",
            ((last_reply.get("info") or {}).get("meta") or {}).get("model") == "glm-5.3"
            and ((last_reply.get("info") or {}).get("meta") or {}).get("engine") == "root",
            (last_reply.get("info") or {}).get("meta"),
        )
        read_r = say(tool([["session_read", {"id": "quota start fix"}]]))
        read_out = [p for p in read_r["parts"] if p["type"] == "tool"][0]["state"]["output"]
        check(
            "S1: session_read reports serving engine without user-facing fallback annotation",
            "engine=root " in read_out and "fallback from" not in read_out,
            read_out[:240],
        )

        # ── Scenario 2: Follow-up turn bounces on quota (0 tools) -> role's other default engine (agy)
        s2 = req(brain_port, "POST", "/session", {"title": "override bounce", "agent": "build", "engine": "claude"})
        t1_code, t1 = req_status(
            brain_port, "POST", f"/session/{s2['id']}/message", {"parts": [{"type": "text", "text": "hello turn 1"}]}
        )
        check("S2: turn 1 succeeds on claude", t1_code == 200 and "CLAUDE-OK" in text_of(t1), (t1_code, text_of(t1)))
        a0 = hit_count(agy_log)
        t2_code, t2 = req_status(
            brain_port,
            "POST",
            f"/session/{s2['id']}/message",
            {"parts": [{"type": "text", "text": "QUOTA_BOUNCE turn 2"}]},
        )
        s2_info = req(brain_port, "GET", f"/session/{s2['id']}")
        agy_entries = [json.loads(l) for l in open(agy_log)] if os.path.exists(agy_log) else []
        check(
            "S2: turn 2 bounces on claude quota (0 tools) -> falls back to build's default engine (antigravity), briefed, no card fallback fields",
            t2_code == 200
            and "AGY-FALLBACK-OK" in text_of(t2)
            and hit_count(agy_log) == a0 + 1
            and s2_info.get("engine") == "antigravity"
            and (s2_info.get("model") or {}).get("id") == "gemini-4-neon-high"
            and (s2_info.get("card") or {}).get("engine") == "antigravity"
            and "fallback_from" not in (s2_info.get("card") or {})
            and "fallback_reason" not in (s2_info.get("card") or {})
            and ((t2.get("info") or {}).get("meta") or {}).get("fallback", {}).get("from") == "claude"
            and bool(agy_entries)
            and want_brief in agy_entries[-1].get("stdin", ""),
            {"code": t2_code, "reply": text_of(t2), "engine": s2_info.get("engine"), "card": s2_info.get("card")},
        )

        # ── Scenario 3: Mid-work quota hit (tools already ran) -> NEVER falls back
        calls_before = req(mock_port, "GET", "/calls")["a_chat"]
        s3 = req(brain_port, "POST", "/session", {"title": "midwork fix", "agent": "fix"})
        c3, b3 = req_status(
            brain_port,
            "POST",
            f"/session/{s3['id']}/message",
            {"parts": [{"type": "text", "text": "MIDWORK_QUOTA edit file"}]},
        )
        s3_info = req(brain_port, "GET", f"/session/{s3['id']}")
        calls_after = req(mock_port, "GET", "/calls")["a_chat"]
        check(
            "S3: mid-work quota (1 tool ran) does NOT fall back — fails with quota error, keeps claude + conv id",
            c3 == 500
            and "5-hour limit" in json.dumps(b3)
            and s3_info.get("engine") == "claude"
            and (s3_info.get("harness") or {}).get("id") == "cc-midwork-1"
            and "fallback_from" not in (s3_info.get("card") or {})
            and calls_after == calls_before,
            {"code": c3, "body": b3, "engine": s3_info.get("engine"), "harness": s3_info.get("harness"), "calls": (calls_before, calls_after)},
        )

        # ── Scenario 4: Pinned role (`pinned: true`) with 0 tools + quota -> NEVER falls back
        calls_before = req(mock_port, "GET", "/calls")["a_chat"]
        s4 = req(brain_port, "POST", "/session", {"title": "deploy release", "agent": "deploy_pinned"})
        c4, b4 = req_status(
            brain_port,
            "POST",
            f"/session/{s4['id']}/message",
            {"parts": [{"type": "text", "text": "QUOTA_BOUNCE deploy"}]},
        )
        s4_info = req(brain_port, "GET", f"/session/{s4['id']}")
        calls_after = req(mock_port, "GET", "/calls")["a_chat"]
        check(
            "S4: pinned role does NOT fall back on quota (0 tools)",
            c4 == 500
            and "5-hour limit" in json.dumps(b4)
            and s4_info.get("engine") == "claude"
            and "fallback_from" not in (s4_info.get("card") or {})
            and calls_after == calls_before,
            {"code": c4, "body": b4, "engine": s4_info.get("engine"), "calls": (calls_before, calls_after)},
        )

        # ── Scenario 5: P1 trunk integrator session on role `lead` -> NEVER falls back; normal lead DOES
        calls_before = req(mock_port, "GET", "/calls")["a_chat"]
        p1 = req(
            brain_port,
            "POST",
            "/session",
            {"title": "P1 · home root on the trunk (integrator)", "agent": "lead"},
        )
        c5, b5 = req_status(
            brain_port,
            "POST",
            f"/session/{p1['id']}/message",
            {"parts": [{"type": "text", "text": "QUOTA_BOUNCE merge tree-next"}]},
        )
        p1_info = req(brain_port, "GET", f"/session/{p1['id']}")
        calls_after = req(mock_port, "GET", "/calls")["a_chat"]
        check(
            "S5a: P1 trunk integrator session does NOT fall back on quota (0 tools)",
            c5 == 500
            and "5-hour limit" in json.dumps(b5)
            and p1_info.get("engine") == "claude"
            and "fallback_from" not in (p1_info.get("card") or {})
            and calls_after == calls_before,
            {"code": c5, "body": b5, "engine": p1_info.get("engine"), "calls": (calls_before, calls_after)},
        )
        p2 = req(brain_port, "POST", "/session", {"title": "P2 · other lead", "agent": "lead"})
        c5b, b5b = req_status(
            brain_port,
            "POST",
            f"/session/{p2['id']}/message",
            {"parts": [{"type": "text", "text": "QUOTA_BOUNCE Reply with exactly: P2-ROOT-OK"}]},
        )
        p2_info = req(brain_port, "GET", f"/session/{p2['id']}")
        check(
            "S5b: non-P1 lead session DOES fall back on quota (0 tools)",
            c5b == 200
            and "P2-ROOT-OK" in text_of(b5b)
            and p2_info.get("engine") == "root"
            and "fallback_from" not in (p2_info.get("card") or {})
            and ((b5b.get("info") or {}).get("meta") or {}).get("fallback", {}).get("from") == "claude",
            {"code": c5b, "reply": text_of(b5b), "engine": p2_info.get("engine"), "card": p2_info.get("card")},
        )

        # ── Scenario 6: Explicit opt-out (`fallback: "none"`) & retry-once double quota
        calls_before = req(mock_port, "GET", "/calls")["a_chat"]
        s6a = req(brain_port, "POST", "/session", {"title": "optout", "agent": "no_fb"})
        c6a, _ = req_status(
            brain_port, "POST", f"/session/{s6a['id']}/message", {"parts": [{"type": "text", "text": "QUOTA_BOUNCE"}]}
        )
        check(
            "S6a: role with fallback=\"none\" does NOT fall back",
            c6a == 500
            and req(brain_port, "GET", f"/session/{s6a['id']}").get("engine") == "claude"
            and req(mock_port, "GET", "/calls")["a_chat"] == calls_before,
            c6a,
        )

        c0, a0 = hit_count(claude_log), hit_count(agy_log)
        calls_before = req(mock_port, "GET", "/calls")["a_chat"]
        s6b = req(brain_port, "POST", "/session", {"title": "double quota", "agent": "double_q"})
        c6b, b6b = req_status(
            brain_port, "POST", f"/session/{s6b['id']}/message", {"parts": [{"type": "text", "text": "DOUBLE_QUOTA"}]}
        )
        check(
            "S6b: double quota (claude -> agy) retries ONCE only, never chains to root",
            c6b == 500
            and hit_count(claude_log) == c0 + 1
            and hit_count(agy_log) == a0 + 1
            and req(mock_port, "GET", "/calls")["a_chat"] == calls_before
            and "after claude quota" in json.dumps(b6b),
            {"code": c6b, "body": b6b, "claude": hit_count(claude_log) - c0, "agy": hit_count(agy_log) - a0},
        )

        # ── Scenario 7: Non-quota error with 0 tools -> NEVER falls back
        calls_before = req(mock_port, "GET", "/calls")["a_chat"]
        s7 = req(brain_port, "POST", "/session", {"title": "non quota", "agent": "fix"})
        c7, b7 = req_status(
            brain_port,
            "POST",
            f"/session/{s7['id']}/message",
            {"parts": [{"type": "text", "text": "NON_QUOTA_ERR"}]},
        )
        check(
            "S7: non-quota error with 0 tools does NOT fall back",
            c7 == 500
            and "invalid flag" in json.dumps(b7)
            and req(brain_port, "GET", f"/session/{s7['id']}").get("engine") == "claude"
            and req(mock_port, "GET", "/calls")["a_chat"] == calls_before,
            {"code": c7, "body": b7},
        )

    finally:
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{'GREEN' if not FAILS else 'RED'}: {len(FAILS)} failure(s) {FAILS if FAILS else ''}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
