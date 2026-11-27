# regressions from the independent review of package 2 (run each: python3 test_<x>.py [poll]; YGG_BIN=<brain>)
"""Review rig: home 4280, lab 4281, mock 4282, delaying proxy 4283 (home -> lab). Kills only its own PIDs."""
import json, os, re, shutil, subprocess, sys, threading, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import os as _os
BIN = _os.environ.get("YGG_BIN") or _os.path.expanduser("~/.cache/p2-reach/target/release/yggdrasil")
MOCK = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "../../../root/mock/mock_upstream.py")
BASE = _os.path.expanduser("~/.cache/p2-reach/regress-run")
HOME, LAB, MOCKP, PROXY = 4280, 4281, 4282, 4283
DELAY = {"async_post": 0.0}
PROCS = []
ENVS = {}
LABP = [None]

def restart_lab():
    LABP[0].terminate(); LABP[0].wait(10)
    env, d = ENVS['lab']
    LABP[0] = subprocess.Popen([BIN], env=env, stdout=open(f"{d}/brain2.log", "w"), stderr=subprocess.STDOUT, cwd=f"{d}/work")
    PROCS.append(LABP[0])
    for _ in range(100):
        try:
            req(LAB, 'GET', '/root'); return
        except Exception:
            time.sleep(0.2)


def req(port, method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        t = resp.read().decode()
        return json.loads(t) if t else None

class Delay(BaseHTTPRequestHandler):
    def handle(self):
        try: super().handle()
        except (BrokenPipeError, ConnectionResetError): pass
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def handle_one(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else None
        hdrs = {k: v for k, v in self.headers.items() if k.lower() in ("content-type", "x-ygg-peer", "accept")}
        r = urllib.request.Request(f"http://127.0.0.1:{LAB}{self.path}", data=body, method=self.command, headers=hdrs)
        try:
            resp = urllib.request.urlopen(r, timeout=120); code = resp.status; out = resp.read(); ct = resp.headers.get("content-type", "application/json")
        except urllib.error.HTTPError as e:
            code, out, ct = e.code, e.read(), "application/json"
        if self.command == "POST" and "/message" in self.path and "async=1" in self.path and DELAY["async_post"]:
            print(f"[proxy] holding the async POST answer {DELAY['async_post']}s: {out[:120]!r}", flush=True)
            time.sleep(DELAY["async_post"])
        self.send_response(code); self.send_header("content-type", ct); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)
    do_GET = do_POST = do_PUT = do_PATCH = handle_one

def start():
    shutil.rmtree(BASE, ignore_errors=True)
    os.makedirs(BASE)
    PROCS.append(subprocess.Popen(["python3", MOCK, str(MOCKP)], stdout=open(f"{BASE}/mock.log", "w"), stderr=subprocess.STDOUT))
    srv = ThreadingHTTPServer(("127.0.0.1", PROXY), Delay); threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = {"YGG_UPSTREAM_BASE_URL": f"http://127.0.0.1:{MOCKP}", "YGG_UPSTREAM_STYLE": "anthropic", "YGG_UPSTREAM_API_KEY": "mock",
            "YGG_UPSTREAM_MODEL": "mock", "YGG_PEER_TOKEN": "rv-token", "PATH": os.environ["PATH"], "HOME": os.environ["HOME"],
            "TMPDIR": _os.path.expanduser("~/.cache/p2-reach/tmp")}
    for name, port, peers, extra in (("home", HOME, f"lab=http://127.0.0.1:{PROXY}", {"YGG_RELAY_LOST_S": os.environ.get("LOST_S", "25")}),
                                     ("lab", LAB, f"home=http://127.0.0.1:{HOME}", {})):
        d = f"{BASE}/{name}"; os.makedirs(f"{d}/work"); os.makedirs(f"{d}/data")
        env = dict(base, YGG_LISTEN=f"127.0.0.1:{port}", YGG_DATA_DIR=f"{d}/data", YGG_PROFILES=f"{d}/agents.json",
                   YGG_PROJECT_DIR=f"{d}/work", YGG_ROOT_NAME=name, YGG_PEERS=peers, **extra)
        ENVS[name] = (env, d)
        PROCS.append(subprocess.Popen([BIN], env=env, stdout=open(f"{d}/brain.log", "w"), stderr=subprocess.STDOUT, cwd=f"{d}/work"))
        if name == "lab": LABP[0] = PROCS[-1]
    for _ in range(100):
        try:
            req(HOME, "GET", "/root"); req(LAB, "GET", "/root"); break
        except Exception:
            time.sleep(0.2)

def stop():
    for p in PROCS:
        try: p.terminate(); p.wait(5)
        except Exception:
            try: p.kill()
            except Exception: pass

def make_proxy(title="reach"):
    main = req(HOME, "POST", "/session", {"title": "[MAIN]"})["id"]
    script = "tool:" + json.dumps([[["session_start", {"title": title, "agent": "build", "root": "lab", "brief": "Reply with exactly: READY"}]]])
    req(HOME, "POST", f"/session/{main}/message", {"parts": [{"type": "text", "text": script}]}, 60)
    for _ in range(100):
        t = {r["title"]: r for r in req(HOME, "GET", "/tree")}
        if title in t and not t[title]["busy"]:
            return t[title]["id"]
        time.sleep(0.2)
    raise SystemExit("no proxy")

def sse(port, path, body, out, key, timeout=90):
    """Collects (event, data) pairs of one SSE POST into out[key]; out[key+'_end'] = how it ended."""
    out[key] = []
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST",
                               headers={"content-type": "application/json", "accept": "text/event-stream"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            out[key + "_headers_at"] = round(time.time() - t0, 1)
            ev = None
            for raw in resp:
                line = raw.decode().rstrip("\n")
                if line.startswith("event:"): ev = line[6:].strip()
                elif line.startswith("data:"):
                    out[key].append((ev, line[5:].strip(), round(time.time() - t0, 1)))
        out[key + "_end"] = f"stream closed after {round(time.time()-t0,1)}s"
    except Exception as e:
        out[key + "_end"] = f"{type(e).__name__}: {e} after {round(time.time()-t0,1)}s"
