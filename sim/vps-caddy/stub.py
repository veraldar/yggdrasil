#!/usr/bin/env python3
"""stub.py — the backends behind the VPS's Caddy in sim/vps-caddy-rehearsal.sh (G4.5).

    stub.py upstream PORT…          the VPS's own upstreams (127.0.0.1:<port> in Caddy's network namespace)
    stub.py trunk PORT WEBROOT      the v1 trunk's container: /t/state, its ACME webroot, everything else echoed
    stub.py router CONF SRC         a copy of sni-443.py (SRC) on CONF, in the same namespace (the VPS's :443)

Every answer is deterministic (no Date, a fixed Server), so two runs of one request compare byte for byte:
  GET /…/stream     200, 25 pieces 0.2 s apart (a request still running while Caddy reloads)
  Upgrade: websocket on …/ws   101, then every frame echoed (a link held open across a reload)
  anything else     200 JSON: who answered, method, path, Host and the X-Forwarded-* / Via it was given
trunk only: GET /t/state → {"claimed":false,…}; GET /.well-known/acme-challenge/<token> → the file WEBROOT/.well-known/
acme-challenge/<token> (certbot --webroot writes it) or 404.
"""
import base64
import hashlib
import http.server
import json
import os
import struct
import subprocess
import sys
import threading
import time

WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC11B85"


def handler(who, webroot=None):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version, sys_version = "stub", ""

        def date_time_string(self, timestamp=None):  # noqa: ARG002 — deterministic answers
            return "Thu, 01 Jan 2026 00:00:00 GMT"

        def log_message(self, *a):
            pass

        def send(self, code, body, ctype="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n) if n else b""

        def ws(self):
            key = self.headers.get("Sec-WebSocket-Key", "").encode()
            acc = base64.b64encode(hashlib.sha1(key + WS_GUID).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", acc)
            self.end_headers()
            self.wfile.flush()
            r = self.rfile
            try:
                while True:
                    h = r.read(2)
                    if len(h) < 2:
                        return
                    op, n = h[0] & 0x0F, h[1] & 0x7F
                    if n == 126:
                        n = struct.unpack(">H", r.read(2))[0]
                    elif n == 127:
                        n = struct.unpack(">Q", r.read(8))[0]
                    mask = r.read(4) if h[1] & 0x80 else b"\0\0\0\0"
                    data = bytes(b ^ mask[i % 4] for i, b in enumerate(r.read(n)))
                    if op == 8:
                        self.wfile.write(b"\x88\x00")
                        return
                    out = (who + ":").encode() + data
                    self.wfile.write(bytes([0x80 | op, len(out)]) + out if len(out) < 126 else
                                     bytes([0x80 | op, 126]) + struct.pack(">H", len(out)) + out)
                    self.wfile.flush()
            except OSError:
                return

        def any(self):
            path = self.path
            if self.headers.get("Upgrade", "").lower() == "websocket" and path.split("?")[0].endswith("/ws"):
                return self.ws()
            data = self.body()
            if path.split("?")[0].endswith("/stream"):
                piece = b"x" * 1000
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(25 * len(piece)))
                self.end_headers()
                for _ in range(25):
                    self.wfile.write(piece)
                    self.wfile.flush()
                    time.sleep(0.2)
                return
            if webroot is not None:
                if path == "/t/state":
                    return self.send(200, b'{"claimed":false,"has_roots":false,"lockdown":false,"providers":[]}')
                pre = "/.well-known/acme-challenge/"
                if path.startswith(pre):
                    f = os.path.join(webroot, ".well-known", "acme-challenge", os.path.basename(path[len(pre):]))
                    if os.path.isfile(f):
                        with open(f, "rb") as fh:
                            return self.send(200, fh.read(), "text/plain")
                    return self.send(404, b"no such token\n", "text/plain")
            h = self.headers
            out = {"who": who, "method": self.command, "path": path, "host": h.get("Host"),
                   "xff": h.get("X-Forwarded-For"), "xfp": h.get("X-Forwarded-Proto"), "xfh": h.get("X-Forwarded-Host"),
                   "via": h.get("Via"), "ae": h.get("Accept-Encoding"), "body_sha": hashlib.sha256(data).hexdigest()[:16]}
            self.send(200, json.dumps(out, sort_keys=True).encode())

        do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = any
    return H


def serve(host, port, h):
    s = http.server.ThreadingHTTPServer((host, port), h)
    s.daemon_threads = True
    threading.Thread(target=s.serve_forever, daemon=True).start()


def main(argv):
    if argv[:1] == ["upstream"]:
        for p in argv[1:]:
            serve("127.0.0.1", int(p), handler(f"upstream:{p}"))
    elif argv[:1] == ["trunk"] and len(argv) == 3:
        serve("0.0.0.0", int(argv[1]), handler("trunk", argv[2]))
    elif argv[:1] == ["router"] and len(argv) == 3:
        return subprocess.call([sys.executable, argv[2], "-c", argv[1]], env=dict(os.environ, SNI443_STATS="off"))
    else:
        print(__doc__, file=sys.stderr)
        return 64
    print("stub: up", flush=True)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
