#!/usr/bin/env python3
"""S17 with the REAL model (package 2): two scratch brains on loopback, home (scripted mock upstream,
it only places the session) and lab (a real Claude Code session, haiku, the owner's login).
A 6 MB PDF uploaded to home in pieces goes to the Claude Code session on lab as a reference; lab
pulls it; Claude Code opens it and names the marker word. Then it writes artifacts/marker.html and
links it; home opens that file through POST /file/artifact {root: lab} + GET /file/<hash>.
run: python3 sim/reach/s17_real.py <bin>   (ports 4276 home, 4277 lab, 4278 mock; state ~/.cache/root-sim/p2-s17-*)"""
import hashlib, json, os, random, string, subprocess, sys, time, urllib.request

HOME, LAB, MOCK = 4276, 4277, 4278
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(os.path.dirname(HERE))
BIN = sys.argv[1]
TOK = "s17-" + "".join(random.choice(string.ascii_lowercase) for _ in range(12))
F = []

def check(n, ok, d=""):
    print(("ok   " if ok else "FAIL ") + n + ("" if ok else f" — {str(d)[:500]}"), flush=True)
    if not ok: F.append(n)

def req(port, m, p, b=None, t=60, raw=None, ct="application/json"):
    d = raw if raw is not None else (json.dumps(b).encode() if b is not None else None)
    r = urllib.request.Request(f"http://127.0.0.1:{port}{p}", data=d, method=m, headers={"content-type": ct})
    with urllib.request.urlopen(r, timeout=t) as x:
        s = x.read()
        return s if raw is not None and m == "GET" else (json.loads(s) if s else None)

def get_raw(port, p):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{p}", timeout=120) as x:
        return x.status, x.headers.get("content-type", ""), x.read()

def text(m): return "".join(p.get("text", "") for p in (m or {}).get("parts", []) if p.get("type") == "text")

def sse(port, path, body, timeout=600):
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST",
                               headers={"content-type": "application/json", "accept": "text/event-stream"})
    out, name = [], "message"
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        for raw in resp:
            line = raw.decode(errors="replace").rstrip("\r\n")
            if line.startswith("event:"): name = line[6:].strip()
            elif line.startswith("data:"):
                try: d = json.loads(line[5:].strip())
                except ValueError: d = {}
                out.append((name, d))
                if name in ("message.completed", "message.aborted", "error"): break
                name = "message"
    return out

def wait(pred, t=300, step=2):
    end = time.time() + t
    while time.time() < end:
        v = pred()
        if v: return v
        time.sleep(step)
    return None

def up():
    subprocess.run(["systemctl", "--user", "stop", "p2-s17-mock"], capture_output=True)
    subprocess.run(["systemd-run", "--user", "--unit=p2-s17-mock", "--collect", "-q", "python3", os.path.join(REPO, "root/mock/mock_upstream.py"), str(MOCK)], check=True)
    env = dict(os.environ, YGG_PEER_TOKEN=TOK)
    subprocess.run(["bash", os.path.join(REPO, "sim/brain-up.sh"), "p2-s17-home", str(HOME), BIN], check=True,
                   env=dict(env, YGG_ROOT_NAME="home", YGG_PEERS=f"lab=http://127.0.0.1:{LAB}", SIM_UPSTREAM_BASE_URL=f"http://127.0.0.1:{MOCK}"))
    subprocess.run(["bash", os.path.join(REPO, "sim/brain-up.sh"), "p2-s17-lab", str(LAB), BIN], check=True,
                   env=dict(env, YGG_ROOT_NAME="lab", YGG_PEERS=f"home=http://127.0.0.1:{HOME}", SIM_HARNESS="1"))
    wait(lambda: all(req(p, "GET", "/root") for p in (HOME, LAB)), 30, 1)

def down():
    for n in ("p2-s17-home", "p2-s17-lab"):
        subprocess.run(["bash", os.path.join(REPO, "sim/brain-up.sh"), n, "down"], capture_output=True)
    subprocess.run(["systemctl", "--user", "stop", "p2-s17-mock"], capture_output=True)

def main():
    up()
    try:
        marker = "S17-" + "".join(random.choice(string.ascii_uppercase) for _ in range(6))
        pdf = os.path.expanduser("~/.cache/p2-reach/s17/report.pdf")
        subprocess.run(["python3", os.path.join(HERE, "make_pdf.py"), pdf, "--mb", "6", "--marker", marker], check=True, capture_output=True)
        data = open(pdf, "rb").read()
        print(f"pdf: {len(data)} bytes, marker {marker}")
        main_id = req(HOME, "POST", "/session", {"title": "[MAIN]"})["id"]
        brief = {"title": "pdf reader", "agent": "claude", "root": "lab", "model": "haiku", "brief": "Reply with exactly: READY"}
        req(HOME, "POST", f"/session/{main_id}/message", {"parts": [{"type": "text", "text": "tool:" + json.dumps([[["session_start", brief]]])}]}, 120)
        row = wait(lambda: next((r for r in req(HOME, "GET", "/tree") if r["title"] == "pdf reader" and (r.get("card") or {}).get("status") == "done"), None), 300)
        check("MAIN placed a Claude Code session on lab; its first turn ran there", bool(row), req(HOME, "GET", "/tree"))
        if not row: return
        proxy = row["id"]; lab_id = req(HOME, "GET", f"/session/{proxy}")["remote"]["id"]
        # the phone's upload, in pieces
        u = req(HOME, "POST", "/file/upload", {"name": "report.pdf", "mime": "application/pdf", "size": len(data)})
        off, last, puts = 0, None, 0
        while off < len(data):
            chunk = data[off:off + u["piece"]]
            last = req(HOME, "PUT", f"/file/upload/{u['upload']}?offset={off}", raw=chunk, ct="application/octet-stream"); puts += 1
            off += len(chunk)
        ref = last["file"]
        check(f"the 6 MB PDF went home in {puts} pieces of ≤ 1 MiB; REF = its sha256", puts >= 6 and ref["hash"] == hashlib.sha256(data).hexdigest(), ref)
        part = {"type": "file", "mime": "application/pdf", "filename": "report.pdf", "url": f"/file/{ref['hash']}", "hash": ref["hash"], "size": ref["size"], "root": ref["root"]}
        t0 = time.time()
        evs = sse(HOME, f"/session/{proxy}/message", {"parts": [{"type": "text", "text": "what is the marker word in this pdf? it starts with S17-. answer with the word only"}, part]})
        names = [n for n, _ in evs]
        reply = text(evs[-1][1]) if names and names[-1] == "message.completed" else ""
        print(f"  {round(time.time() - t0)} s, events: {len([n for n in names if n == 'message.part.delta'])} deltas, last {names[-1:]}; reply: {reply[:200]!r}")
        check("the reply streamed through home (SSE) and ended with message.completed", names[-1:] == ["message.completed"], names[-5:])
        check("Claude Code on lab opened the PDF: its reply names the marker", marker in reply, reply[:300])
        lb = os.path.expanduser(f"~/.cache/root-sim/p2-s17-lab/data/files/blobs/{ref['hash']}")
        check("lab pulled the file: its blob is byte-identical", os.path.exists(lb) and open(lb, "rb").read() == data)
        ms = req(LAB, "GET", f"/session/{lab_id}/message")
        um = [m for m in ms if m["info"]["role"] == "user" and "marker word" in text(m)]
        fp = [p for m in um for p in m["parts"] if p.get("type") == "file"]
        check("lab stored the message once, with a reference (no bytes) and a path", len(um) == 1 and len(fp) == 1 and fp[0].get("path", "").endswith("report.pdf") and not str(fp[0].get("url", "")).startswith("data:"), fp)
        # the other way: a file the session makes, opened through home
        r = req(HOME, "POST", f"/session/{proxy}/message", {"parts": [{"type": "text", "text": f"write a small html page to artifacts/marker.html (in your working folder) with the marker word {marker} in an h1. then reply with exactly this link and nothing else: /api/artifact/marker.html"}]}, 600)
        seen = json.dumps(req(HOME, "GET", f"/session/{proxy}/message"))
        check("the reply's link, read through home, says where the file is (?root=lab)", f"/api/artifact/marker.html?root=lab&session={lab_id}" in seen, text(r)[:200])
        ref2 = req(HOME, "POST", "/file/artifact", {"name": "marker.html", "root": "lab", "session": lab_id}, 120)
        st, ct, body = get_raw(HOME, f"/file/{ref2['hash']}?mime={ref2['mime']}&name=marker.html")
        check("home opens the file lab's session made (200, text/html, holds the marker)", st == 200 and ct.startswith("text/html") and marker.encode() in body, (st, ct, body[:200]))
    finally:
        down()
        os.system("rm -rf ~/.claude/projects/-home-dweeb-xyz--cache-root-sim-p2-s17-lab-work")
    print("GREEN" if not F else f"RED {F}"); sys.exit(1 if F else 0)

main()
