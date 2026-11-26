#!/usr/bin/env python3
"""owner-answer-e2e.py — the answer cards in a real browser at phone size, against a scratch stack:
mock upstream + brain (YGG_DEVICES_FILE) + the app built from this worktree in devices mode.

  paired device (cookie)   MAIN shows one card per open question, whole question, Yes · No · Reply;
                           Yes runs the asking session (its next turn carries the brain's block);
                           two open → Yes to all (N), one call per ask with its own id
  the box console          (no credential) the cards say "answer from the paired app": no button; the
                           route answers 403 and nothing reaches the session
  screenshots              $OUT/main-paired.png, main-after-yes.png, main-after-yes-all.png, main-unpaired.png

    owner-answer-e2e.py [--bin PATH] [--port-base N] [--out DIR]     exit 0 = all green
Needs the app built in branch/ (npm run build) and node + playwright-core there.
"""
import argparse, hashlib, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
YGG = os.path.join(ROOT, "root")
FAILS = []
TOKEN = "bfnd-e2e-device-token-0123456789abcdef"


def req(port, method, path, body=None, headers=None, timeout=30, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            b = resp.read()
            return (resp.status, json.loads(b) if b else None) if raw else (json.loads(b) if b else None)
    except urllib.error.HTTPError as e:
        if raw:
            b = e.read()
            return e.code, (json.loads(b) if b else None)
        raise


def check(name, ok, detail=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else ' — ' + str(detail)[:300]}", flush=True)
    if not ok:
        FAILS.append(name)


def wait(pred, timeout=30, step=0.3):
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


def unit(name, cmd, env, cwd=None):
    subprocess.run(["systemctl", "--user", "stop", name], capture_output=True)
    subprocess.run(["systemctl", "--user", "reset-failed", name], capture_output=True)
    args = ["systemd-run", "--user", f"--unit={name}", "--collect", "-q"] + ([f"--working-directory={cwd}"] if cwd else []) + [f"--setenv={k}={v}" for k, v in env.items()] + cmd
    subprocess.run(args, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(YGG, "target", "release", "yggdrasil"))
    ap.add_argument("--port-base", type=int, default=24800)
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "owner-answer-shots"))
    a = ap.parse_args()
    mock, brain, app = a.port_base, a.port_base + 1, a.port_base + 2
    os.makedirs(a.out, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="owner-answer-e2e-")
    pre = f"owner-answer-e2e-{a.port_base}"
    units = [f"{pre}-mock", f"{pre}-brain", f"{pre}-app"]
    reg = os.path.join(tmp, "devices.json")
    json.dump({"version": 2, "killEpoch": 0, "codes": [], "devices": [{
        "id": "dev_e2e", "name": "phone", "created": "2026-11-26T00:00:00Z", "revoked": False, "region": "loopback", "lastRegion": "loopback",
        "regionChanges": 0, "lastSeen": "", "refreshHash": "x", "refreshExp": int(time.time() * 1000) + 10**9, "prevRefresh": [],
        "access": [{"hash": hashlib.sha256(TOKEN.encode()).hexdigest(), "exp": int(time.time() * 1000) + 3_600_000, "region": "loopback"}]}]}, open(reg, "w"))
    try:
        unit(units[0], ["python3", os.path.join(YGG, "mock", "mock_upstream.py"), str(mock)], {})
        d = os.path.join(tmp, "brain")
        os.makedirs(os.path.join(d, "data", "session")); os.makedirs(os.path.join(d, "work"))
        unit(units[1], [a.bin], {"YGG_UPSTREAM_BASE_URL": f"http://127.0.0.1:{mock}", "YGG_UPSTREAM_STYLE": "anthropic", "YGG_UPSTREAM_API_KEY": "mock",
             "YGG_UPSTREAM_MODEL": "mock", "YGG_WAKE_DEBOUNCE_MS": "400", "YGG_LISTEN": f"127.0.0.1:{brain}", "YGG_DATA_DIR": os.path.join(d, "data"),
             "YGG_PROFILES": os.path.join(d, "agents.json"), "YGG_PROJECT_DIR": os.path.join(d, "work"), "YGG_ROOT_NAME": "e2e", "YGG_DEVICES_FILE": reg})
        check("brain up", wait(lambda: req(brain, "GET", "/root"), 15))
        node = subprocess.run(["bash", "-lc", "command -v node"], capture_output=True, text=True).stdout.strip() or "node"
        unit(units[2], [node, "server.mjs"], {"NODE_ENV": "production", "PORT": str(app), "HOST": "127.0.0.1", "BIFROST_AUTH": "devices", "BIFROST_DEVICES_FILE": reg,
             "OPENCODE_URL": f"http://127.0.0.1:{brain}", "ARTIFACTS_DIR": os.path.join(tmp, "art"), "BIFROST_MAIN_TITLE": "[MAIN]", "BIFROST_ADMIN_TOKEN": "admin-e2e-token-0123456789"},
             cwd=os.path.join(ROOT, "branch"))
        check("app up", wait(lambda: urllib.request.urlopen(f"http://127.0.0.1:{app}/pair", timeout=2).status == 200, 40))
        main_id = req(brain, "POST", "/session", {"title": "[MAIN]"})["id"]
        say = lambda text: req(brain, "POST", f"/session/{main_id}/message", {"parts": [{"type": "text", "text": text}]}, timeout=60)
        tool = lambda calls: "tool:" + json.dumps([calls])
        # (the mock upstream replies the one token after "exactly:", so a question here is one hyphenated word)
        qs = ["QUESTION:May-I-deploy-release-7-to-this-computer?-I-need-your-permission.", "QUESTION:May-I-push-the-branch-to-github?-I-need-your-approval."]
        for i, q in enumerate(qs):
            say(tool([["session_start", {"title": f"asker {i}", "agent": "build", "brief": f"Reply with exactly: {q}"}]]))
        asked = wait(lambda: [r for r in req(brain, "GET", "/tree") if r["title"].startswith("asker") and (r.get("card") or {}).get("ask")] if len([r for r in req(brain, "GET", "/tree") if r["title"].startswith("asker") and (r.get("card") or {}).get("ask")]) == 2 else None, 60)
        check("two sessions hold an open question as a card record", asked and len(asked) == 2, [(r["title"], r.get("card")) for r in req(brain, "GET", "/tree")])
        if not asked:
            raise SystemExit(1)
        ids = {r["title"]: r["id"] for r in req(brain, "GET", "/tree") if r["title"].startswith("asker")}
        shots = lambda token, mode: json.loads(subprocess.run(["node", os.path.join(HERE, "owner-answer-shots.mjs"), os.path.join(ROOT, "branch"), f"http://127.0.0.1:{app}", a.out, token, json.dumps({"mode": mode})], capture_output=True, text=True, timeout=180, check=True).stdout.strip().splitlines()[-1])
        # default: typed-once in MAIN's chat — a question nobody bounced earns NO approvals area in MAIN
        r = shots(TOKEN, "none")
        check("MAIN shows no approvals area for questions nobody bounced", r["cards"] == 0, r)
        # a stubborn session: a message from MAIN arrives under the open-question line and it asks the same thing again
        for i, q in enumerate(qs):
            req(brain, "POST", f"/session/{ids[f'asker {i}']}/message?async=1&origin=none", {"parts": [{"type": "text", "text": f"Reply with exactly: {q}"}], "meta": {"from": {"session": main_id, "title": "[MAIN]"}}})
        check("both sessions bounced (the brain marks the ask)", wait(lambda: len([x for x in req(brain, "GET", "/tree") if x["title"].startswith("asker") and ((x.get("card") or {}).get("ask") or {}).get("bounced")]) == 2, 90))
        # the box console (no credential): no button, the route refuses, nothing reaches the session
        r = shots("-", "one")
        check("console: cards show, whole questions, no button, one line", r["cards"] == 2 and r["yes"] == 0 and r["unpaired"] == 2 and r["fits"], r)
        ask0 = req(brain, "GET", f"/tree")
        a0 = next(x for x in ask0 if x["title"] == "asker 0")["card"]["ask"]
        code, _ = req(app, "POST", f"/api/session/{ids['asker 0']}/answer", {"ask": a0["id"], "answer": "yes"}, raw=True)
        check("console: the answer route is 403", code == 403, code)
        check("console: nothing reached the session", not any(m["info"]["role"] == "user" and (m["info"].get("meta") or {}).get("owner_approve") for m in req(brain, "GET", f"/session/{ids['asker 0']}/message")))
        # a paired device: whole question, buttons; Yes
        r = shots(TOKEN, "one")
        check("paired: two cards, both questions whole, Yes/No/Reply, Yes-to-all offered", r["cards"] == 2 and r["yes"] == 2 and r["yesAll"] == 1 and all(q.rstrip("?").startswith("May I") or True for q in r["questions"]) and r["fits"], r)
        check("paired: both questions shown word for word", any("May-I-deploy-release-7-to-this-computer?-I-need-your-permission" in q for q in r["questions"]) and any("May-I-push-the-branch-to-github?" in q for q in r["questions"]), r["questions"])
        check("paired: Yes shows 'answered: yes'", (r.get("done") or "").startswith("answered: yes"), r)
        got = wait(lambda: [m for m in req(brain, "GET", f"/session/{ids['asker 0']}/message") if (m["info"].get("meta") or {}).get("owner_approve")], 15)
        check("paired: the session received the press as a record (device, answer, question)", got and got[0]["info"]["meta"]["owner_approve"]["answer"] == "yes" and got[0]["info"]["meta"]["owner_approve"]["device"] == "dev_e2e", got)
        state = {x["title"]: x for x in req(brain, "GET", "/tree")}
        check("paired: the session ran on it (its card moved on)", wait(lambda: (req(brain, "GET", "/tree") and True) and next(x for x in req(brain, "GET", "/tree") if x["title"] == "asker 0")["card"].get("runs", 0) >= 2, 40), state["asker 0"].get("card"))
        # Yes to all on what is still open (asker 1 only now) — open a second pair to see the two-card path
        say(tool([["session_start", {"title": "asker 2", "agent": "build", "brief": "Reply with exactly: QUESTION:May-I-delete-the-old-data?-I-need-your-permission."}]]))
        say(tool([["session_start", {"title": "asker 3", "agent": "build", "brief": "Reply with exactly: QUESTION:May-I-rotate-the-signing-key?-I-need-your-approval."}]]))
        wait(lambda: len([x for x in req(brain, "GET", "/tree") if (x.get("card") or {}).get("ask") and not x["card"]["ask"].get("answered")]) >= 3, 60)
        for t, q in (("asker 2", "QUESTION:May-I-delete-the-old-data?-I-need-your-permission."), ("asker 3", "QUESTION:May-I-rotate-the-signing-key?-I-need-your-approval.")):
            sid = next(x["id"] for x in req(brain, "GET", "/tree") if x["title"] == t)
            req(brain, "POST", f"/session/{sid}/message?async=1&origin=none", {"parts": [{"type": "text", "text": f"Reply with exactly: {q}"}], "meta": {"from": {"session": main_id, "title": "[MAIN]"}}})
        wait(lambda: len([x for x in req(brain, "GET", "/tree") if ((x.get("card") or {}).get("ask") or {}).get("bounced") and not x["card"]["ask"].get("answered")]) >= 3, 90)
        r = shots(TOKEN, "all")
        check("paired: Yes to all answered every open question", r.get("doneAll", 0) == r["cards"] == 3, r)
        open_left = [x for x in req(brain, "GET", "/tree") if (x.get("card") or {}).get("ask") and not x["card"]["ask"].get("answered")]
        check("paired: none left open; one audit line each", not open_left and sum(1 for _ in open(os.path.join(d, "data", "owner-audit.jsonl"))) >= 4, open_left)
        print(f"screenshots: {a.out}")
    finally:
        for u in units:
            subprocess.run(["systemctl", "--user", "stop", u], capture_output=True)
            subprocess.run(["systemctl", "--user", "reset-failed", u], capture_output=True)
    print(f"\n{'GREEN' if not FAILS else 'RED'}: {len(FAILS)} failure(s) {FAILS if FAILS else ''}")
    sys.exit(1 if FAILS else 0)


main()
