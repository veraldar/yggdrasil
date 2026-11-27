#!/usr/bin/env python3
"""harness-fallback-e2e.py — deterministic end-to-end proof of harness chains (v10, the owner's
"the latest fallback harness proposition is good").

Boots a scratch yggdrasil brain binary + mock_upstream.py + fake `claude` and `agy` binaries on
PATH + a fake usage endpoint (Claude's /api/oauth/usage and z.ai's quota/limit), and checks:
  S1. THE OWNER'S SCENARIO: a `fix` session (Claude Code · opus) hits the 5-hour limit MID-WORK,
      after 2 tool calls -> the next entry of fix's chain (Antigravity) takes the turn at once
      with a done-state brief (steps done, files touched, one line per step), the 2 steps stay on
      the reply, nothing is redone, the card says only who served, MAIN gets the report.
  S2. 0 tools + quota on a role with no chain of its own -> the automatic fallback (root, full
      glm-5.3), briefed with the one-line takeover note.
  S3. A built-in role whose chain was cleared (`fallback: []`) on a Claude override -> automatic:
      the role's own engine (Antigravity).
  S4. Pinned role -> never falls back.
  S5. P1 (the trunk integrator, a `lead`) falls back now — only the coordinator never does.
  S6. `fallback: "none"` -> never; an explicit one-entry chain that is out too -> tried once only.
  S7. Non-quota error with 0 tools -> never falls back.
  S8. Proactive: the usage endpoint says Claude is at 95% -> the turn starts on the next entry,
      Claude never runs; GET /usage shows both plans (z.ai's key goes without "Bearer").
  S9. Everything out (Claude 100%, agy's error seen, root at 97%) -> one line, nothing runs.
  S11. Any provider: a root model on a provider (`rig-out/mock`) whose plan is out degrades to the
      providers file's fallback (`rig-ok`) in the same call and cools until its reset; GET /provider
      shows type, health, reachability, discovery and locality, never a key; PUT/DELETE /provider.
  S12. The role editor's API: GET /agent/:name {fallback, fallback_effective, fallback_cap}; PUT
      the array (cap 3, the coordinator refused); GET /agent lists every chain.
  S10. A brain whose root upstream is out (z.ai 1310): a `research` session (root, chain ① agy)
      moves at once (no 76 s of rate-limit backoff); MAIN (the coordinator) does NOT; the next
      research turn starts on agy without asking z.ai (the 1310 is kept until z.ai's own reset).

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
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
YGG = os.path.join(HERE, "..", "root")
FAILS = []

# the fake usage endpoints: what they answer, and who asked with which credentials
USAGE = {"claude_pct": 20, "zai_pct": 3, "seen": []}


class UsageMock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        auth = self.headers.get("authorization", "")
        if self.path.startswith("/api/oauth/usage"):
            USAGE["seen"].append(("claude", auth, self.headers.get("anthropic-beta", "")))
            reset = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + 3 * 3600))
            return self._json(200, {"limits": [
                {"kind": "session", "percent": USAGE["claude_pct"], "resets_at": reset},
                {"kind": "weekly_all", "percent": 30, "resets_at": reset},
            ]})
        if self.path.startswith("/api/monitor/usage/quota/limit"):
            USAGE["seen"].append(("zai", auth, ""))
            return self._json(200, {"code": 200, "data": {"level": "pro", "limits": [
                {"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": USAGE["zai_pct"],
                 "nextResetTime": int((time.time() + 7200) * 1000)},
                {"type": "TIME_LIMIT", "unit": 5, "number": 1, "percentage": 100,
                 "nextResetTime": int((time.time() + 86400) * 1000)},
            ]}})
        return self._json(404, {"error": "no"})


def req(port, method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method, headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def req_status(port, method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method, headers={"content-type": "application/json"}
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
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else ' — ' + str(detail)[:600]}", flush=True)
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
        if isinstance(p, dict) and p.get("type") == "text" and not p.get("notice")  # the brain's own "↪ moved" line
    )


def tools_of(msg):
    return [p.get("tool") for p in (msg or {}).get("parts") or [] if isinstance(p, dict) and p.get("type") == "tool"]


def meta_of(msg):
    return ((msg or {}).get("info") or {}).get("meta") or {}


def tree_by_title(port):
    return {r["title"]: r for r in req(port, "GET", "/tree")}


def write_exec(path, body):
    with open(path, "w") as f:
        f.write(body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def lines_of(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def agy_text(entry):
    """agy reads one JSON user line: the text it was given."""
    raw = (entry or {}).get("stdin", "")
    try:
        return json.loads(raw.strip().splitlines()[-1])["message"]["content"]
    except Exception:  # noqa: BLE001
        return raw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(YGG, "target", "release", "yggdrasil"))
    ap.add_argument("--port-base", type=int, default=18470)
    a = ap.parse_args()

    brain_port, mock_port, usage_port, brain2_port = a.port_base, a.port_base + 1, a.port_base + 2, a.port_base + 3
    tmp = tempfile.mkdtemp(prefix="ygg-fb-e2e-")
    procs = []
    usage_srv = ThreadingHTTPServer(("127.0.0.1", usage_port), UsageMock)
    threading.Thread(target=usage_srv.serve_forever, daemon=True).start()

    try:
        bin_dir, data_dir, data2_dir, work_dir, claude_cfg = (os.path.join(tmp, d) for d in ("bin", "data", "data2", "work", "claude-cfg"))
        for d in (bin_dir, data_dir, data2_dir, work_dir, claude_cfg):
            os.makedirs(d)
        with open(os.path.join(claude_cfg, ".credentials.json"), "w") as f:
            json.dump({"claudeAiOauth": {"accessToken": "tok-sim", "expiresAt": int((time.time() + 86400) * 1000)}}, f)

        claude_log = os.path.join(tmp, "claude.log")
        agy_log = os.path.join(tmp, "agy.log")

        # Fake `claude` CLI: the prompt on stdin scripts it (quota mid-work / 0 tools / crash / ok).
        write_exec(
            os.path.join(bin_dir, "claude"),
            f"""#!/usr/bin/env python3
import json, sys
prompt = sys.stdin.read()
with open({claude_log!r}, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "prompt": prompt[:400]}}) + "\\n")
def out(v):
    print(json.dumps(v), flush=True)
LIMIT = "You've hit your 5-hour limit · resets 11:30pm (Europe/Paris)"
if "MIDWORK_QUOTA" in prompt:
    out({{"type": "system", "subtype": "init", "session_id": "cc-midwork-1"}})
    out({{"type": "assistant", "session_id": "cc-midwork-1", "message": {{"content": [{{"type": "tool_use", "name": "Bash", "input": {{"command": "pytest -q tests/test_login.py"}}}}]}}}})
    out({{"type": "assistant", "session_id": "cc-midwork-1", "message": {{"content": [{{"type": "tool_use", "name": "Edit", "input": {{"file_path": "src/app.py", "old_string": "a", "new_string": "b"}}}}]}}}})
    out({{"type": "result", "subtype": "error", "is_error": True, "result": LIMIT, "session_id": "cc-midwork-1"}})
    sys.exit(1)
if "NON_QUOTA_ERR" in prompt:
    out({{"type": "result", "subtype": "error", "is_error": True, "result": "invalid flag --bogus"}})
    sys.exit(1)
if "QUOTA_BOUNCE" in prompt or "DOUBLE_QUOTA" in prompt:
    out({{"type": "system", "subtype": "init", "session_id": "cc-bounce-1"}})
    out({{"type": "assistant", "session_id": "cc-bounce-1", "message": {{"content": [{{"type": "text", "text": LIMIT}}]}}}})
    out({{"type": "result", "subtype": "error", "is_error": True, "result": LIMIT, "session_id": "cc-bounce-1"}})
    sys.exit(1)
out({{"type": "system", "subtype": "init", "session_id": "cc-ok-1"}})
out({{"type": "result", "subtype": "success", "is_error": False, "result": "CLAUDE-OK", "session_id": "cc-ok-1"}})
""",
        )

        # Fake `agy` CLI: `agy models`; quota for DOUBLE_QUOTA / AGY_QUOTA; else it answers.
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
if "DOUBLE_QUOTA" in line or "AGY_QUOTA" in line:
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
                        # the live omarchy shape: roles with an engine, the built-in chains
                        "fix": {"harness": "claude", "model": "opus"},
                        "lead": {"harness": "claude", "model": "opus"},
                        "build": {"harness": "antigravity", "model": "gemini-4-neon-high", "fallback": []},
                        "fixer": {"harness": "claude", "model": "opus"},
                        "deploy_pinned": {"harness": "claude", "model": "opus", "pinned": True},
                        "no_fb": {"harness": "claude", "model": "opus", "fallback": "none"},
                        "double_q": {"harness": "claude", "model": "opus", "fallback": ["agy/gemini-4-neon-high"]},
                    },
                    "engines": {"claude": {"model": "opus"}, "antigravity": {"model": "gemini-4-neon-high"}},
                },
                f,
            )

        # A3: two providers on the same mock: one out of quota (its key = z.ai's 1310), one fine
        with open(os.path.join(tmp, "providers.json"), "w") as f:
            json.dump({"provider": {
                "rig-out": {"type": "openai-compatible", "options": {"baseURL": f"http://127.0.0.1:{mock_port}/v1",
                            "apiKey": "mock-1310", "resetTimezone": "+08:00"}, "models": ["mock"]},
                "rig-ok": {"type": "vllm", "options": {"baseURL": f"http://127.0.0.1:{mock_port}", "apiKey": "mock"}, "models": "auto"},
            }, "fallback": ["rig-ok/mock-b"]}, f)

        mock_log = open(os.path.join(tmp, "mock.log"), "w")
        brain_log = open(os.path.join(tmp, "brain.log"), "w")
        procs.append(
            subprocess.Popen(["python3", os.path.join(YGG, "mock", "mock_upstream.py"), str(mock_port)], stdout=mock_log, stderr=mock_log)
        )
        check("mock upstream up", wait(lambda: req(mock_port, "GET", "/calls") is not None, 10))

        base_env = os.environ.copy()
        base_env.update(
            {
                "PATH": f"{bin_dir}:{base_env.get('PATH', '')}",
                "YGG_UPSTREAM_BASE_URL": f"http://127.0.0.1:{mock_port}",
                "YGG_UPSTREAM_STYLE": "anthropic",
                "YGG_UPSTREAM_MODEL": "glm-5.3-flash",
                "YGG_MODELS": "glm-5.3-flash,glm-5.3,glm-5.2",
                "YGG_PROJECT_DIR": work_dir,
                "YGG_PROFILES": agents_path,
                "YGG_PROVIDERS": os.path.join(tmp, "providers.json"),
                "YGG_WAKE_DEBOUNCE_MS": "300",
                # the usage reads go to the fake endpoints, read again every 0.3 s
                "CLAUDE_CONFIG_DIR": claude_cfg,
                "YGG_USAGE_CLAUDE_URL": f"http://127.0.0.1:{usage_port}/api/oauth/usage",
                "YGG_USAGE_ZAI_URL": f"http://127.0.0.1:{usage_port}/api/monitor/usage/quota/limit",
                "YGG_USAGE_TTL_MS": "300",
                # this sim checks the fail-fast shape (an owner's turn with every engine out says
                # when, one line); the wait for the reset is sim/engine-fallback-smart-e2e.py's
                "YGG_FALLBACK_WAIT_MAX_MIN": "0",
            }
        )
        env = dict(base_env, YGG_UPSTREAM_API_KEY="mock", YGG_LISTEN=f"127.0.0.1:{brain_port}", YGG_DATA_DIR=data_dir, YGG_ROOT_NAME="fb-sim")
        procs.append(subprocess.Popen([a.bin], env=env, stdout=brain_log, stderr=brain_log))
        check("brain up", wait(lambda: req(brain_port, "GET", "/root") is not None, 10))

        main_id = req(brain_port, "POST", "/session", {"title": "[MAIN]"})["id"]
        say = lambda text: req(brain_port, "POST", f"/session/{main_id}/message", {"parts": [{"type": "text", "text": text}]}, 90)
        a_chat = lambda: req(mock_port, "GET", "/calls")["a_chat"]

        def turn(title, agent, text, engine=None, pinned=False):
            body = {"title": title, "agent": agent}
            if engine:
                body["engine"] = engine
            if pinned:
                body["pinned"] = True
            sid = req(brain_port, "POST", "/session", body)["id"]
            code, out = req_status(brain_port, "POST", f"/session/{sid}/message", {"parts": [{"type": "text", "text": text}]})
            return sid, code, out, req(brain_port, "GET", f"/session/{sid}")

        def reset_marks():
            """A quota error a turn hit keeps that engine skipped until its reset (15 min here): a
            pinned session's good turn on it clears it for the next scenario."""
            turn("clear claude", "fixer", "hello", engine="claude", pinned=True)
            turn("clear agy", "fixer", "hello", engine="antigravity", pinned=True)

        tiny_brief = (
            "Previous harness claude hit a hard quota before doing any work; "
            "you are taking over this session and its full context — continue the last request."
        )
        # the walk reads Claude's numbers in the background; let the first read land
        wait(lambda: (req(brain_port, "GET", "/usage").get("claude") or {}).get("pct") == 20, 10)

        # ── S1. THE SCENARIO: fix on Claude, 2 tool calls, 5-hour limit -> agy (fix's entry 1)
        c0, a0, calls0 = len(lines_of(claude_log)), len(lines_of(agy_log)), a_chat()
        say(tool([["session_start", {"title": "fix login", "agent": "fix", "brief": "MIDWORK_QUOTA The login page 500s — fix it."}]]))
        done = wait(lambda: (tree_by_title(brain_port).get("fix login", {}).get("card") or {}).get("status") == "done", 30)
        row = tree_by_title(brain_port).get("fix login", {})
        info = req(brain_port, "GET", f"/session/{row['id']}") if row else {}
        msgs = req(brain_port, "GET", f"/session/{row['id']}/message") if row else []
        reply = next((m for m in reversed(msgs) if m["info"]["role"] == "assistant"), {})
        agy_in = agy_text((lines_of(agy_log) or [None])[-1])
        fb = meta_of(reply).get("fallback") or {}
        check(
            "S1: Claude hits the 5-hour limit after 2 tool calls -> agy (fix's chain entry 1) finishes the turn at once",
            bool(done) and "AGY-FALLBACK-OK" in text_of(reply)
            and len(lines_of(claude_log)) == c0 + 1 and len(lines_of(agy_log)) == a0 + 1
            and not [m for m in msgs if meta_of(m).get("engine") == "root"],
            {"done": done, "reply": text_of(reply), "claude": len(lines_of(claude_log)) - c0, "agy": len(lines_of(agy_log)) - a0},
        )
        check(
            "S1: the brief carries the done-state (steps, files, one line per step) — continue, do not redo",
            "Previous harness claude hit a hard quota mid-work (steps done: 2 tool calls, files touched: 1 (src/app.py)); "
            "you are taking over this session and its full context — continue the last request, do not redo finished steps." in agy_in
            and "- Bash: pytest -q tests/test_login.py\n- Edit: src/app.py" in agy_in,
            agy_in[-700:],
        )
        check(
            "S1: the 2 steps Claude did stay on the reply (nothing redone, nothing lost)",
            tools_of(reply) == ["Bash", "Edit"],
            tools_of(reply),
        )
        check(
            "S1: the card says only who served (antigravity · gemini-4-neon-high); the chain stays in meta",
            row.get("engine") == "claude"  # the session keeps its HOME engine
            and (info.get("model") or {}).get("id") == "opus"
            and (row.get("card") or {}).get("engine") == "antigravity"
            and (row.get("card") or {}).get("model") == "gemini-4-neon-high"
            and not any(k.startswith("fallback") for k in (row.get("card") or {}))
            and fb.get("from") == "claude" and fb.get("to") == "antigravity"
            and (fb.get("chain") or [{}])[0].get("tools_done") == 2
            and (fb.get("chain") or [{}])[0].get("from") == "claude/opus",
            {"engine": row.get("engine"), "card": row.get("card"), "fallback": fb},
        )
        u = req(brain_port, "GET", "/usage")
        check(
            "S1: GET /usage keeps Claude's quota error until its reset (the walk skips it)",
            (u.get("claude") or {}).get("out", {}).get("why", "").find("5-hour limit") >= 0
            and (u.get("claude") or {}).get("source") == "claude-oauth",
            u.get("claude"),
        )
        reset_marks()

        # ── S2. 0 tools + quota on a role without a chain -> automatic: root glm-5.3
        c0 = len(lines_of(claude_log))
        sid, code, out, s2 = turn("quota start", "fixer", "QUOTA_BOUNCE Reply with exactly: SERVED-BY-ROOT-GLM")
        raw_ctx = req(brain_port, "GET", f"/session/{sid}/context?part=raw")
        check(
            "S2: 0 tools + quota, no chain of its own -> root glm-5.3 with the one-line brief",
            code == 200 and "SERVED-BY-ROOT-GLM" in text_of(out) and len(lines_of(claude_log)) == c0 + 1
            and s2.get("engine") == "claude" and ((s2.get("card") or {}).get("engine"), (s2.get("card") or {}).get("model")) == ("root", "glm-5.3")
            and meta_of(out).get("model") == "glm-5.3" and meta_of(out).get("engine") == "root"
            and tiny_brief in json.dumps(raw_ctx, ensure_ascii=False),
            {"code": code, "reply": text_of(out), "engine": s2.get("engine"), "meta": meta_of(out)},
        )
        reset_marks()

        # ── S3. build (chain cleared) on a Claude override -> automatic: build's own engine (agy)
        a0 = len(lines_of(agy_log))
        sid, code, out, s3 = turn("override bounce", "build", "QUOTA_BOUNCE turn", engine="claude")
        check(
            "S3: a cleared chain is automatic: Claude override -> the role's own engine (antigravity), briefed",
            code == 200 and "AGY-FALLBACK-OK" in text_of(out) and len(lines_of(agy_log)) == a0 + 1
            and s3.get("engine") == "claude" and (s3.get("card") or {}).get("engine") == "antigravity" and tiny_brief in agy_text(lines_of(agy_log)[-1]),
            {"code": code, "reply": text_of(out), "engine": s3.get("engine")},
        )
        reset_marks()

        # ── S4. pinned role -> never
        calls0, a0 = a_chat(), len(lines_of(agy_log))
        sid, code, out, s4 = turn("deploy release", "deploy_pinned", "QUOTA_BOUNCE deploy")
        check(
            "S4: a pinned role does NOT fall back",
            code == 500 and "5-hour limit" in json.dumps(out) and s4.get("engine") == "claude"
            and a_chat() == calls0 and len(lines_of(agy_log)) == a0,
            {"code": code, "engine": s4.get("engine")},
        )
        reset_marks()

        # ── S5. P1 (the integrator, a lead) falls back now: only the coordinator never does
        a0 = len(lines_of(agy_log))
        sid, code, out, s5 = turn("P1 · home root on the trunk (integrator)", "lead", "QUOTA_BOUNCE merge tree-next")
        check(
            "S5: P1 integrator (lead) falls back on its chain (agy) — owner v10: only the coordinator is pinned",
            code == 200 and "AGY-FALLBACK-OK" in text_of(out) and s5.get("engine") == "claude" and len(lines_of(agy_log)) == a0 + 1,
            {"code": code, "reply": text_of(out), "engine": s5.get("engine")},
        )
        reset_marks()

        # ── S6. "none" -> never; an explicit chain [agy] that is out too -> tried once, no third
        calls0, a0 = a_chat(), len(lines_of(agy_log))
        sid, code, out, s6 = turn("optout", "no_fb", "QUOTA_BOUNCE")
        check(
            "S6a: fallback \"none\" does NOT fall back",
            code == 500 and s6.get("engine") == "claude" and a_chat() == calls0 and len(lines_of(agy_log)) == a0,
            code,
        )
        reset_marks()
        c0, a0, calls0 = len(lines_of(claude_log)), len(lines_of(agy_log)), a_chat()
        sid, code, out, _ = turn("double quota", "double_q", "DOUBLE_QUOTA")
        check(
            "S6b: chain [agy] out too -> claude once, agy once, never root",
            code == 500 and len(lines_of(claude_log)) == c0 + 1 and len(lines_of(agy_log)) == a0 + 1
            and a_chat() == calls0 and "(fallback antigravity/gemini-4-neon-high after claude quota)" in json.dumps(out, ensure_ascii=False),
            {"code": code, "body": out},
        )
        reset_marks()

        # ── S7. non-quota error -> never
        calls0, a0 = a_chat(), len(lines_of(agy_log))
        sid, code, out, s7 = turn("non quota", "fix", "NON_QUOTA_ERR")
        check(
            "S7: a non-quota error with 0 tools does NOT fall back",
            code == 500 and "invalid flag" in json.dumps(out) and s7.get("engine") == "claude"
            and a_chat() == calls0 and len(lines_of(agy_log)) == a0,
            {"code": code, "body": out},
        )

        # ── S8. proactive: Claude's numbers say 95% before the turn -> agy starts it
        USAGE["claude_pct"] = 95
        USAGE["seen"].clear()
        time.sleep(0.4)
        u = req(brain_port, "GET", "/usage")
        seen = list(USAGE["seen"])
        check(
            "S8: GET /usage reads both plans: Claude with its sign-in token, z.ai with its key (no Bearer)",
            (u.get("claude") or {}).get("pct") == 95 and (u.get("root") or {}).get("pct") == 3
            and (u.get("root") or {}).get("source") == "z.ai" and (u.get("antigravity") or {}).get("source") == "none"
            and ("claude", "Bearer tok-sim", "oauth-2025-04-20") in seen and ("zai", "mock", "") in seen,
            {"usage": u, "seen": seen},
        )
        c0, a0 = len(lines_of(claude_log)), len(lines_of(agy_log))
        sid, code, out, s8 = turn("fix early", "fix", "please look at the login")
        agy_in = agy_text((lines_of(agy_log) or [None])[-1])
        check(
            "S8: Claude at 95% -> the turn starts on agy (fix's entry 1); Claude is never started",
            code == 200 and "AGY-FALLBACK-OK" in text_of(out) and len(lines_of(claude_log)) == c0
            and len(lines_of(agy_log)) == a0 + 1 and s8.get("engine") == "claude"
            and "Previous harness claude is at its usage limit (95% of its 5-hour window used" in agy_in
            and (meta_of(out).get("fallback") or {}).get("reason", "").startswith("usage: 95%"),
            {"code": code, "reply": text_of(out), "claude": len(lines_of(claude_log)) - c0, "brief": agy_in[-300:], "meta": meta_of(out)},
        )

        # ── S9. everything out: one line, nothing runs; the next turn reads the numbers again
        USAGE["claude_pct"], USAGE["zai_pct"] = 100, 97
        turn("agy out", "fixer", "AGY_QUOTA", engine="antigravity", pinned=True)  # agy's error, seen
        time.sleep(0.4)
        req(brain_port, "GET", "/usage")
        c0, a0, calls0 = len(lines_of(claude_log)), len(lines_of(agy_log)), a_chat()
        sid, code, out, s9 = turn("fix late", "fix", "please fix it")
        err = json.dumps(out, ensure_ascii=False)
        check(
            "S9: Claude used up, agy's error seen, root at 97% -> one line, nothing runs, the session stays",
            code == 500 and "no fallback clears" in err and "root/glm-5.3 (97% of its 5-hour window used" in err
            and "the next turn checks again" in err
            and (len(lines_of(claude_log)), len(lines_of(agy_log)), a_chat()) == (c0, a0, calls0) and s9.get("engine") == "claude",
            {"code": code, "body": out},
        )
        USAGE["claude_pct"], USAGE["zai_pct"] = 20, 3

        # ── S10. the root's own upstream out (z.ai 1310): the coordinator stays, research moves
        brain2_log = open(os.path.join(tmp, "brain2.log"), "w")
        env2 = dict(base_env, YGG_UPSTREAM_API_KEY="mock-1310", YGG_LISTEN=f"127.0.0.1:{brain2_port}", YGG_DATA_DIR=data2_dir,
                    YGG_ROOT_NAME="fb-sim-2", YGG_UPSTREAM_RESET_TZ="+08:00", YGG_USAGE_ZAI_URL="off")
        procs.append(subprocess.Popen([a.bin], env=env2, stdout=brain2_log, stderr=brain2_log))
        check("brain 2 (z.ai out) up", wait(lambda: req(brain2_port, "GET", "/root") is not None, 10))
        main2 = req(brain2_port, "POST", "/session", {"title": "[MAIN]"})["id"]
        key_calls = lambda: (req(mock_port, "GET", "/keys") or {}).get("mock-1310", 0)
        # reactive first: research's turn on the root hits z.ai's 1310
        a0, k0 = len(lines_of(agy_log)), key_calls()
        r10 = req(brain2_port, "POST", "/session", {"title": "research quota", "agent": "research"})["id"]
        t0 = time.time()
        code, out = req_status(brain2_port, "POST", f"/session/{r10}/message", {"parts": [{"type": "text", "text": "compare the two options"}]})
        r10i = req(brain2_port, "GET", f"/session/{r10}")
        agy_in = agy_text((lines_of(agy_log) or [None])[-1])
        check(
            "S10a: research on the root, root used up (1310) -> agy (research's chain ①) at once, briefed",
            code == 200 and "AGY-FALLBACK-OK" in text_of(out) and r10i.get("engine") == "root" and (r10i.get("card") or {}).get("engine") == "antigravity"
            and key_calls() == k0 + 1 and len(lines_of(agy_log)) == a0 + 1
            and "Previous harness root hit a hard quota before doing any work" in agy_in and time.time() - t0 < 15,
            {"code": code, "reply": text_of(out), "engine": r10i.get("engine"), "secs": round(time.time() - t0, 1), "brief": agy_in[-300:]},
        )
        # the coordinator never moves, whatever the marks say
        a0 = len(lines_of(agy_log))
        t0 = time.time()
        code, out = req_status(brain2_port, "POST", f"/session/{main2}/message", {"parts": [{"type": "text", "text": "hello"}]})
        check(
            "S10b: MAIN (the coordinator) on a used-up root does NOT fall back — and fails at once (no rate-limit backoff)",
            code == 500 and "1310" in json.dumps(out) and len(lines_of(agy_log)) == a0 and time.time() - t0 < 15,
            {"code": code, "body": str(out)[:300], "secs": round(time.time() - t0, 1)},
        )
        # proactive now: the 1310 is known, the next research turn does not even ask z.ai
        a0, k0 = len(lines_of(agy_log)), key_calls()
        r11 = req(brain2_port, "POST", "/session", {"title": "research again", "agent": "research"})["id"]
        code, out = req_status(brain2_port, "POST", f"/session/{r11}/message", {"parts": [{"type": "text", "text": "and the third option"}]})
        agy_in = agy_text((lines_of(agy_log) or [None])[-1])
        check(
            "S10d: with the root's limit known, the next research turn starts on agy — z.ai is not asked again",
            code == 200 and "AGY-FALLBACK-OK" in text_of(out) and key_calls() == k0 and len(lines_of(agy_log)) == a0 + 1
            and "Previous harness root is out of its usage limit (resets " in agy_in,
            {"code": code, "reply": text_of(out), "z.ai calls": key_calls() - k0, "brief": agy_in[-300:]},
        )
        u2 = req(brain2_port, "GET", "/usage")
        check(
            "S10c: the root's 1310 is kept with z.ai's own reset time (printed in Beijing time)",
            ((u2.get("root") or {}).get("out") or {}).get("until", 0) > (time.time() + 1800) * 1000,
            u2.get("root"),
        )

        # ── S11. any provider (A3/A4): a root model on a provider, routed through provider.rs
        pv = req(brain_port, "GET", "/provider")
        rows = {r["id"]: r for r in pv.get("providers", [])}
        raw = json.dumps(pv)
        check(
            "S11a: GET /provider lists the providers with type, health, reachability, discovery — keys by source only",
            set(rows) >= {"yggdrasil", "rig-out", "rig-ok"}
            and rows["rig-ok"].get("models") == ["mock", "mock-b"] and rows["rig-ok"].get("auto") is True
            and rows["rig-ok"].get("reachable", {}).get("ok") is True and rows["rig-ok"].get("locality") == "local"
            and rows["rig-ok"].get("metered") is False and rows["rig-out"].get("key") == {"source": "inline", "resolved": True}
            and rows["yggdrasil"].get("env") is True and "mock-1310" not in raw and pv.get("types", [None])[0] == "zai",
            {"rows": {k: {x: v.get(x) for x in ("type", "models", "reachable", "locality", "key")} for k, v in rows.items()}},
        )
        agent = req(brain_port, "GET", "/agent/research")
        check(
            "S11b: the root's model pickers offer provider models as provider/model",
            "rig-ok/mock-b" in (agent.get("models_by_harness") or {}).get("root", []) and "rig-out/mock" in agent.get("models", []),
            agent.get("models"),
        )
        k0 = (req(mock_port, "GET", "/keys") or {}).get("mock-1310", 0)
        sid = req(brain_port, "POST", "/session", {"title": "on a provider", "agent": "research", "engine": "root", "model": "rig-out/mock"})["id"]
        code, out = req_status(brain_port, "POST", f"/session/{sid}/message", {"parts": [{"type": "text", "text": "Reply with exactly: ROUTED-OK"}]})
        info11 = req(brain_port, "GET", f"/session/{sid}")
        pv = req(brain_port, "GET", "/provider")
        rows = {r["id"]: r for r in pv.get("providers", [])}
        check(
            "S11c: rig-out answers 1310 -> rig-ok (the file's fallback) answers in the same call; the reply names who served",
            code == 200 and "ROUTED-OK" in text_of(out) and (req(mock_port, "GET", "/keys") or {}).get("mock-1310", 0) == k0 + 1
            and meta_of(out).get("model") == "rig-ok/mock-b" and (info11.get("model") or {}).get("id") == "rig-out/mock"
            and (rows["rig-out"].get("health") or {}).get("status") == "exhausted",
            {"code": code, "reply": text_of(out), "meta": meta_of(out), "health": rows["rig-out"].get("health")},
        )
        code, out = req_status(brain_port, "POST", f"/session/{sid}/message", {"parts": [{"type": "text", "text": "Reply with exactly: ROUTED-AGAIN"}]})
        check(
            "S11d: rig-out cools until its reset: the next turn does not ask it",
            code == 200 and "ROUTED-AGAIN" in text_of(out) and (req(mock_port, "GET", "/keys") or {}).get("mock-1310", 0) == k0 + 1,
            {"code": code, "reply": text_of(out)},
        )
        # a LAN Ollama nobody answers on (debian-box's view of the Mac): added, listed, unreachable
        code, pv = req_status(brain_port, "PUT", "/provider", {"name": "mac-studio", "type": "Ollama", "baseURL": "http://10.255.255.1:11434", "apiKey": "sk-lan-secret"})
        rows = {r["id"]: r for r in (pv or {}).get("providers", [])}
        mac = rows.get("mac-studio") or {}
        code_bad, bad = req_status(brain_port, "PUT", "/provider", {"name": "x", "type": "emacs", "baseURL": "http://x"})
        code_del, _ = req_status(brain_port, "DELETE", "/provider/mac-studio")
        check(
            "S11e: PUT /provider adds a LAN Ollama (listed, unreachable, LAN, no quota, key never answered); a bad one is refused; DELETE drops it",
            code == 200 and mac.get("type") == "ollama" and mac.get("reachable", {}).get("ok") is False and mac.get("locality") == "lan"
            and mac.get("metered") is False and "sk-lan-secret" not in json.dumps(pv)
            and code_bad == 400 and "unknown type" in json.dumps(bad) and code_del == 200,
            {"code": code, "mac": mac, "bad": (code_bad, bad), "del": code_del},
        )

        # ── S12. the role editor's API (the app builds on it)
        d = req(brain_port, "GET", "/agent/review")
        code, put = req_status(brain_port, "PUT", "/agent/review", {"fallback": ["agy/gemini-4-neon-high", "root/rig-ok/mock-b", "claude/sonnet"]})
        code4, too_many = req_status(brain_port, "PUT", "/agent/review", {"fallback": ["agy", "root", "claude", "codex"]})
        codec, _ = req_status(brain_port, "PUT", "/agent/coordinator", {"fallback": ["agy"]})
        listed = {a["name"]: a for a in req(brain_port, "GET", "/agent")}
        check(
            "S12: GET /agent/:name has the chain (+ resolved, cap); PUT takes the array (any provider's root model), refuses a 4th and the coordinator",
            d.get("fallback") == ["root/glm-5.3", "claude/sonnet"] and d.get("fallback_cap") == 3
            and code == 200 and put.get("fallback") == ["antigravity/gemini-4-neon-high", "root/rig-ok/mock-b", "claude/sonnet"]
            and put.get("fallback_effective") == ["antigravity/gemini-4-neon-high", "root/rig-ok/mock-b", "claude/sonnet"]
            and code4 == 400 and "at most 3" in json.dumps(too_many) and codec == 400
            and listed["review"].get("fallback") == put.get("fallback") and listed["coordinator"].get("fallback") == [],
            {"get": d.get("fallback"), "put": (code, put.get("fallback"), put.get("fallback_effective")), "4": (code4, too_many), "coord": codec},
        )

    finally:
        usage_srv.shutdown()
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

    print(f"\n{'GREEN' if not FAILS else 'RED'}: {len(FAILS)} failure(s) {FAILS if FAILS else ''}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
