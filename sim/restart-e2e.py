#!/usr/bin/env python3
"""restart-e2e.py — C5 on a real brain process: a deploy cuts turns in flight; the next process
hands each cut turn back ONCE, in its own conversation, and rebuilds a cut wake from the inbox.

Deterministic: the mock upstream ("sleep N" holds a turn N s, "reply with exactly: X"). One scratch
brain on :4189 (its own data dir, its own units), restarted the way preview-up.sh does it: drain,
stop, start on the same data.

  MAIN  an owner turn running (sleep) · two wakes waiting behind it: one carries a report from K
        (closed before the restart), one an automation report
  C     a brief from MAIN running (sleep)
  L     a lead: its own turn running (sleep) · a wake waiting behind it with its kid LK's report

  H     (HARNESS=1) a Claude Code session on haiku, cut while its Bash tool runs: the resend goes
        on in THE SAME Claude Code conversation (its id unchanged, both prompts in its file)

    restart-e2e.py [--bin PATH]     exit 0 = all green   (HARNESS=1: the Claude Code leg too)
"""
import argparse, json, os, subprocess, sys, tempfile, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
YGG = os.path.join(HERE, "..", "root")
MOCK, PORT = 18198, 4189
fails = []


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f" — {str(detail)[:300]}"), flush=True)
    if not ok:
        fails.append(name)


def req(method, path, body=None, timeout=30):
    r = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        t = resp.read()
        return json.loads(t) if t else None


def wait(fn, secs):
    end = time.time() + secs
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(0.3)
    return None


def unit(name, cmd, env):
    subprocess.run(["systemctl", "--user", "stop", name], capture_output=True)
    subprocess.run(["systemctl", "--user", "reset-failed", name], capture_output=True)
    subprocess.run(["systemd-run", "--user", f"--unit={name}", "--collect", "-q"] + [f"--setenv={k}={v}" for k, v in env.items()] + cmd, check=True)


def msgs(sid):
    return req("GET", f"/session/{sid}/message?internal=1")


def text(m):
    return " ".join(p.get("text", "") for p in m["parts"] if p.get("type") == "text")


def users(sid):
    return [m for m in msgs(sid) if m["info"]["role"] == "user"]


def post(sid, t, meta=None):
    body = {"parts": [{"type": "text", "text": t}]}
    if meta:
        body["meta"] = meta
    return req("POST", f"/session/{sid}/message?async=1&origin=none", body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(YGG, "target", "release", "yggdrasil"))
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="restart-e2e-")
    os.makedirs(os.path.join(tmp, "work"))
    units = ["restart-e2e-mock", "restart-e2e-brain"]
    env = {"YGG_UPSTREAM_BASE_URL": f"http://127.0.0.1:{MOCK}", "YGG_UPSTREAM_STYLE": "anthropic", "YGG_UPSTREAM_API_KEY": "mock",
           "YGG_UPSTREAM_MODEL": "mock", "YGG_WAKE_DEBOUNCE_MS": "400", "YGG_LISTEN": f"127.0.0.1:{PORT}",
           "YGG_DATA_DIR": os.path.join(tmp, "data"), "YGG_PROJECT_DIR": os.path.join(tmp, "work"),
           "YGG_PROFILES": os.path.join(tmp, "agents.json"), "YGG_ROOT_NAME": "restart"}
    harness = os.environ.get("HARNESS") == "1"
    if harness:
        cc = os.path.expanduser("~/.local/share/mise/installs/claude/latest")
        env.update({"HOME": os.path.expanduser("~"), "PATH": f"{cc}:/usr/local/bin:/usr/bin:/bin"})
    hid, h = "", ""
    try:
        unit(units[0], ["python3", os.path.join(YGG, "mock", "mock_upstream.py"), str(MOCK)], {})
        unit(units[1], [a.bin], env)
        check("brain up", wait(lambda: req("GET", "/root"), 10))
        main_id = req("POST", "/session", {"title": "[MAIN]"})["id"]
        new = lambda title, parent, agent: req("POST", "/session", {"title": title, "parentID": parent, "agent": agent})["id"]
        k, c, lead = new("K", main_id, "build"), new("C", main_id, "build"), new("L", main_id, "lead")
        lk = new("LK", lead, "build")
        sender = {"from": {"session": main_id, "title": "[MAIN]"}}
        if harness:
            h = req("POST", "/session", {"title": "H", "agent": "claude", "model": "haiku"})["id"]
            req("POST", f"/session/{h}/message", {"parts": [{"type": "text", "text": "Reply with exactly: H-ONE"}]}, 180)
            hid = (req("GET", f"/session/{h}").get("harness") or {}).get("id", "")
            check("H: a Claude Code conversation exists", bool(hid), req("GET", f"/session/{h}").get("harness"))
            post(h, "Use your Bash tool to run the command `sleep 45`, then reply with exactly: H-TWO")

        # turns in flight at the deploy
        post(main_id, "sleep 60 then Reply with exactly: MAIN-BUSY")
        post(c, "sleep 60 then Reply with exactly: C-DONE", sender)
        post(lead, "sleep 60 then Reply with exactly: L-BUSY", sender)
        # reports that queue wakes behind them
        post(k, "Reply with exactly: K-DONE")
        post(lk, "Reply with exactly: LK-DONE")
        req("POST", f"/session/{main_id}/message", {"parts": [{"type": "text", "text": "nightly backup finished"}], "meta": {"auto": True}})
        waiting = lambda sid: [m for m in users(sid) if (m["info"].get("meta") or {}).get("auto") and (m["info"].get("meta") or {}).get("events") is not None]
        both = lambda: " ".join(text(m) for m in waiting(main_id))
        check("before: wakes with K's and the automation's reports wait behind MAIN's running turn", wait(lambda: '"K"' in both() and "nightly backup" in both(), 20), both()[:200])
        check("before: a wake waits behind L's running turn", wait(lambda: len(waiting(lead)) >= 1, 20))
        old_wake_ids = {m["info"]["id"] for m in waiting(main_id) + waiting(lead)}
        k_ev = [e for e in req("GET", f"/session/{main_id}/inbox") if e["from"] == k]
        check("before: K's report is in MAIN's inbox", bool(k_ev))
        req("POST", f"/session/{k}/close", {"reason": "done with it"})
        if harness:
            tool_on = lambda: any(p.get("type") == "tool" for m in msgs(h) if m["info"]["role"] == "assistant" for p in m["parts"])
            check("H: its Bash tool is running at the deploy", wait(tool_on, 40))

        # the deploy: drain (turns still running), stop, start the next process on the same data
        d = req("POST", "/admin/drain", {"max_s": 2}, 10)
        check("drain: three turns still running", set(d["still_running"]) >= {main_id, c, lead}, d)
        subprocess.run(["systemctl", "--user", "stop", units[1]], check=True)
        unit(units[1], [a.bin], env)
        check("brain back", wait(lambda: req("GET", "/root"), 10))
        time.sleep(3)

        # each cut real turn: once, in its own conversation, from its sender
        for sid, name, want in ((main_id, "MAIN's owner turn", "MAIN-BUSY"), (c, "C's brief", "C-DONE"), (lead, "L's brief", "L-BUSY")):
            copies = [m for m in users(sid) if (m["info"].get("meta") or {}).get("resent_of")]
            check(f"{name}: sent again once, in its own session", len(copies) == 1 and text(copies[0]).startswith("[sent again after a brain restart] ") and want in text(copies[0]), [text(m)[:80] for m in copies])
            if sid != main_id and copies:
                check(f"{name}: …from MAIN, not as the owner's words", (copies[0]["info"].get("meta") or {}).get("from", {}).get("session") == main_id, copies[0]["info"].get("meta"))
            if sid == main_id and copies:
                check(f"{name}: …the owner's words stay the owner's", "from" not in (copies[0]["info"].get("meta") or {}), copies[0]["info"].get("meta"))
        # cut wakes: never sent again as text, retired
        allu = [m for s in (main_id, lead) for m in users(s)]
        check("no wake is sent again as its old text", not any((m["info"].get("meta") or {}).get("resent_of") in old_wake_ids for m in allu))
        check("the cut wakes are out of the model's view", all((m["info"].get("meta") or {}).get("retired") for m in allu if m["info"]["id"] in old_wake_ids), [(m["info"]["id"][-6:], (m["info"].get("meta") or {}).get("retired")) for m in allu if m["info"]["id"] in old_wake_ids])
        # MAIN: the closed session's report stays out; the automation report comes once, fresh
        main_copy = [m for m in users(main_id) if (m["info"].get("meta") or {}).get("resent_of")]
        lines = (main_copy[0]["info"].get("meta") or {}).get("inbox_lines", []) if main_copy else []
        later = [m for m in users(main_id) if m["info"]["id"] not in old_wake_ids and (m["info"].get("meta") or {}).get("auto") and (m["info"].get("meta") or {}).get("events") is not None]
        fresh_texts = " ".join(lines) + " " + " ".join(text(m) for m in later)
        entries = [l for l in lines if "nightly backup" in l] + [l for m in later for l in text(m).splitlines() if l.startswith('- "nightly backup')]
        check("MAIN: the closed session K's report does not come back", "K-DONE" not in fresh_texts and '"K"' not in fresh_texts, fresh_texts[:300])
        check("MAIN: the automation report comes back once, fresh", len(entries) == 1, entries)
        # L: the kid's report rebuilt into a fresh wake, after the resent brief
        fresh_l = wait(lambda: [m for m in users(lead) if m["info"]["id"] not in old_wake_ids and (m["info"].get("meta") or {}).get("events")], 60)
        check("L: a fresh wake rebuilt from the inbox (LK's report)", fresh_l and "LK-DONE" in text(fresh_l[0]), [text(m)[:120] for m in (fresh_l or [])])
        # every resent turn answered
        for sid, want in ((main_id, "MAIN-BUSY"), (c, "C-DONE"), (lead, "L-BUSY")):
            got = wait(lambda: any(m["info"]["role"] == "assistant" and want in text(m) for m in msgs(sid)), 90)
            check(f"answered after the restart: {want}", bool(got))
        check("no session got a duplicate turn", all(len([m for m in users(s) if (m["info"].get("meta") or {}).get("resent_of")]) <= 1 for s in (main_id, c, lead)))
        check("the brain marked this process for the next restart", os.path.exists(os.path.join(tmp, "data", ".booted")))
        if harness:
            copies = [m for m in users(h) if (m["info"].get("meta") or {}).get("resent_of")]
            check("H: sent again once", len(copies) == 1, [text(m)[:80] for m in copies])
            got = wait(lambda: any(m["info"]["role"] == "assistant" and "H-TWO" in text(m) for m in msgs(h)), 150)
            check("H: answered after the restart (H-TWO)", bool(got))
            after = (req("GET", f"/session/{h}").get("harness") or {}).get("id", "")
            check("H: the same Claude Code conversation (id unchanged)", after == hid, (hid, after))
            import glob
            files = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{hid}.jsonl"))
            body = open(files[0]).read() if files else ""
            check("H: its conversation holds the first turn, the cut one and the resent one",
                  "H-ONE" in body and body.count("sleep 45") >= 2 and "[sent again after a brain restart]" in body, files)
    finally:
        for u in units:
            subprocess.run(["systemctl", "--user", "stop", u], capture_output=True)
        if hid:  # the twin's Claude Code conversation: its own project folder, removed by id
            import glob, shutil
            for f in glob.glob(os.path.expanduser(f"~/.claude/projects/*/{hid}.jsonl")):
                d = os.path.dirname(f)
                if "restart-e2e-" in d:
                    shutil.rmtree(d, ignore_errors=True)
        print(f"data kept in {tmp}" if fails else "", end="")
    print(f"\nRESTART-E2E: {'GREEN' if not fails else 'RED: ' + ', '.join(fails)}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
