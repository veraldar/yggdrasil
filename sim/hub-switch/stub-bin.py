#!/usr/bin/env python3
"""stub-bin.py — every binary of a hub release, as stand-ins that speak the health endpoints (G4.4, until the
WIRE / IDP streams' real v1 binaries exist). sim/hub-switch-rehearsal.sh copies it into each fake release as:

  bin/yggdrasil            the brain: GET /root {"name"}, /session [MAIN], /extensions (librarian up?), POST /admin/drain
  bin/bifrost-net          bridge -c TOML: [ap] → a v0.9 link (GET /ap/_link, X-Proto 1) through the public door;
                           [trunk] → a v1 link (GET /t/root, X-Proto 2) to [trunk] url, and trunk-state.json (C5)
                           written every 2 s (link up / down); a release with bin/never-link never links
                           wg -c TOML: /_wg and /_wg/_roots on [wg] http · root-key FILE: FILE (0600) + FILE.pub
  librarian/librarian.py   --port N · cc-live/cc_live.py --port N (/sessions) · voice/agent.py ($AGENT_HTTP_PORT)
Ports come from the hub's own env files and TOML, as the real ones do. The bridge trusts CONF/rig-ca.pem (beside its
TOML) and reaches every name on 127.0.0.1 (the rig's public door); no real name is resolved.
"""
import base64
import http.server
import json
import os
import socket
import ssl
import sys
import threading
import time
import tomllib
from urllib.parse import urlsplit

NAME = os.path.basename(sys.argv[0])


def serve(port, routes, host="127.0.0.1"):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def answer(self):
            r = routes.get((self.command, self.path.split("?")[0]))
            if r is None:
                r = (404, {"error": "no route"})
            code, body = r() if callable(r) else r
            data = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        do_GET = do_POST = answer
    s = http.server.ThreadingHTTPServer((host, port), H)
    s.daemon_threads = True
    print(f"{NAME}: up on {host}:{port}", flush=True)
    s.serve_forever()


def port_open(p):
    try:
        socket.create_connection(("127.0.0.1", p), 1).close()
        return True
    except OSError:
        return False


def arg(flag):
    return sys.argv[sys.argv.index(flag) + 1]


def brain():
    lib = int(os.environ.get("STUB_LIBRARIAN", "0"))
    serve(int(os.environ["STUB_PORT"]), {
        ("GET", "/root"): (200, {"name": os.environ.get("YGG_ROOT_NAME", "?"), "stub": True}),
        ("GET", "/session"): (200, [{"id": "ses_main", "title": "[MAIN]"}]),
        ("GET", "/extensions"): lambda: (200, [{"name": "librarian", "up": port_open(lib)}]),
        ("POST", "/admin/drain"): (200, {"drained": True}),
    })


def link(url, path, proto, ca, on_up, on_down):
    """hold one link through the public door; call on_up/on_down; redial each second"""
    u = urlsplit(url)
    ctx = ssl.create_default_context(cafile=ca)
    while True:
        try:
            s = ctx.wrap_socket(socket.create_connection(("127.0.0.1", u.port or 443), 5), server_hostname=u.hostname)
            s.sendall(f"GET {path} HTTP/1.1\r\nHost: {u.hostname}\r\nX-Proto: {proto}\r\n\r\n".encode())
            s.settimeout(5)
            head = b""
            while b"\r\n\r\n" not in head:
                d = s.recv(4096)
                if not d:
                    raise OSError("closed")
                head += d
            if not head.startswith(b"HTTP/1.1 200"):
                raise OSError(head.split(b"\r\n", 1)[0].decode())
            on_up()
            while s.recv(64):  # the far end sends a byte a second while the link holds
                pass
        except OSError as e:
            print(f"{NAME}: link {url}{path}: {e}", flush=True)
        on_down()
        time.sleep(1)


def bridge():
    path = arg("-c")
    cfg = tomllib.load(open(path, "rb"))
    ca = os.path.join(os.path.dirname(path), "rig-ca.pem")
    if "trunk" in cfg:
        t = cfg["trunk"]
        st, state = t["state_file"], {"up": False, "since": int(time.time() * 1000)}

        def write():
            now = int(time.time() * 1000)
            doc = {"version": 1, "trunk": {"url": t["url"], "trunk_id": "trk_stub", "trunk_key": t["trunk_key"]},
                   "root": {"id": t["root_id"], "name": "omarchy"},
                   "link": {"state": "up" if state["up"] else "down", "since": state["since"], "written": now},
                   "keys": [], "kill_epoch": 0, "lockdown": False, "deny": [],
                   "directory": {"seq": 1, "issued_at": now, "sig": "stub", "roots": []}, "vapid_public": None}
            tmp = st + ".tmp"
            with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
                json.dump(doc, f)
            os.replace(tmp, st)

        def flip(up):
            if state["up"] != up:
                state["up"], state["since"] = up, int(time.time() * 1000)
            write()

        def every():
            while True:
                write()
                time.sleep(2)
        threading.Thread(target=every, daemon=True).start()
        if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "never-link")):
            print(f"{NAME}: this release's bridge never links (rehearsal: a v1 release that fails its health)", flush=True)
            while True:
                time.sleep(60)
        link(t["url"], "/t/root", 2, ca, lambda: flip(True), lambda: flip(False))
    elif "ap" in cfg:
        link(cfg["ap"]["url"], "/ap/_link", 1, ca, lambda: None, lambda: None)
    else:
        sys.exit(f"{NAME}: bridge: no [ap] and no [trunk] in {path}")


def wg():
    cfg = tomllib.load(open(arg("-c"), "rb"))
    host, _, port = cfg["wg"]["http"].rpartition(":")
    serve(int(port), {("GET", "/_wg"): (200, {"node": "stub"}), ("GET", "/_wg/_roots"): (200, [])}, host)


def root_key():
    f = sys.argv[2]
    with open(os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
        fh.write(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=") + "\n")
    with open(f + ".pub", "w") as fh:
        fh.write(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=") + "\n")


def main():
    if NAME == "yggdrasil":
        brain()
    elif NAME == "bifrost-net":
        {"bridge": bridge, "wg": wg, "root-key": root_key}[sys.argv[1]]()
    elif NAME == "librarian.py":
        serve(int(arg("--port")), {("GET", "/"): (200, {"librarian": "stub"})})
    elif NAME == "cc_live.py":
        serve(int(arg("--port")), {("GET", "/sessions"): (200, [])})
    elif NAME == "agent.py":
        serve(int(os.environ["AGENT_HTTP_PORT"]), {("GET", "/"): (200, {"worker": "stub"})})
    else:
        sys.exit(f"stub-bin: unknown name {NAME}")


if __name__ == "__main__":
    main()
