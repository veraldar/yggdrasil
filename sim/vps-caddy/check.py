#!/usr/bin/env python3
"""check.py — the client side of sim/vps-caddy-rehearsal.sh (G4.5). Talks to the rig's Caddy by its container
address, with the real names in SNI and Host (never DNS), through the rig's :443 router as phones do.

    check.py sites COPY                      the sites, upstream ports and roots a Caddyfile copy declares (JSON)
    check.py corpus COPY IP CAFILE OUT       every existing site asked the same requests → OUT (JSON)
    check.py compare A B                     exit 0 when both corpora answered byte for byte alike (Date aside)
    check.py req URL IP CAFILE [-H K:V]… [-X M] [--port N]   one request → JSON (status, headers, body)
    check.py tls-ok NAME IP CAFILE [PORT]    exit 0 when NAME's certificate verifies against CAFILE
    check.py reload IP CAFILE SITE STREAM_URL WS_URL… -- CMD…   CMD (a caddy reload) under load → JSON
"""
import base64
import hashlib
import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

HOST_TOKEN = "HostTokenOnDiskAAAAAAAAAAAAAAAAAAAAAAAAAAA"  # a file in the host's /var/www/acme (trunk-ap's renewals)


def sites(copy):
    """Top-level site blocks of a Caddyfile: [{scheme, host, port, handles[], proxies[], roots[]}]."""
    out, depth, cur = [], 0, []
    for raw in open(copy):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if depth == 0 and line.endswith("{"):
            cur = []
            for a in line[:-1].split(","):
                a = a.strip()
                if not a:
                    continue
                scheme = "http" if a.startswith("http://") else "https"
                a = a.split("://", 1)[-1]
                host, _, port = a.partition(":")
                cur.append({"scheme": scheme, "host": host, "port": int(port or (80 if scheme == "http" else 443)),
                            "handles": [], "proxies": [], "roots": []})
            out += cur
        elif depth >= 1:
            m = re.match(r"handle\s+(/\S*)\s*\{", line)
            if m:
                for s in cur:
                    s["handles"].append(m.group(1))
            m = re.match(r"reverse_proxy\s+(?:\S+\s+)?127\.0\.0\.1:(\d+)", line)
            if m:
                for s in cur:
                    s["proxies"].append(int(m.group(1)))
            m = re.match(r"root\s+\*\s+(\S+)", line)
            if m:
                for s in cur:
                    s["roots"].append(m.group(1))
        depth += line.count("{") - line.count("}")
    return out


class Conn(http.client.HTTPSConnection):
    def __init__(self, ip, port, sni, ctx):
        super().__init__(ip, port, context=ctx, timeout=15)
        self.sni = sni

    def connect(self):
        sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.sni)


def ctx_of(cafile):
    c = ssl.create_default_context(cafile=cafile)
    return c


def fetch(scheme, host, port, ip, cafile, method="GET", path="/", headers=None, body=None):
    """One request → {status, headers (Date dropped), body (latin-1, ≤4 KB), body_sha, len} or {error}."""
    h = {"Host": host if port in (80, 443) else f"{host}:{port}", **(headers or {})}
    try:
        c = Conn(ip, port, host, ctx_of(cafile)) if scheme == "https" else http.client.HTTPConnection(ip, port, timeout=15)
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
    except (OSError, http.client.HTTPException, ssl.SSLError) as e:
        return {"error": type(e).__name__ + (": " + str(getattr(e, "reason", "")) if getattr(e, "reason", "") else "")}
    hs = [(k, v) for k, v in r.getheaders() if k.lower() != "date"]
    return {"status": r.status, "headers": hs, "body": data[:4096].decode("latin-1"),
            "body_sha": hashlib.sha256(data).hexdigest(), "len": len(data)}


def corpus(copy, ip, cafile):
    res = {}
    for s in sites(copy):
        sc, host, port = s["scheme"], s["host"], s["port"]
        via = 443 if (sc == "https" and port == 8443) else port  # https as phones reach it: :443 → the router → :8443
        k = f"{sc}://{host}:{port}"

        def ask(name, **kw):
            res[f"{k} {name}"] = fetch(sc, host, via, ip, cafile, **kw)
        ask("GET /")
        ask("HEAD /", method="HEAD")
        ask("GET / gzip", headers={"Accept-Encoding": "gzip"})
        ask("GET /nope", path="/nope")
        ask("GET /x?y=1 spoofed XFF", path="/x?y=1", headers={"X-Forwarded-For": "6.6.6.6"})
        for r in s["roots"]:
            ask("GET /index.html", path="/index.html")
            ask("GET /app.js gzip", path="/app.js", headers={"Accept-Encoding": "gzip"})
            if r.endswith("/acme"):
                ask("GET host token", path=f"/.well-known/acme-challenge/{HOST_TOKEN}")
                ask("GET short token", path="/.well-known/acme-challenge/abc")
                ask("GET traversal", path="/.well-known/acme-challenge/..%2f..%2fetc%2fpasswd")
        for hp in s["handles"]:
            p = hp.rstrip("*")
            ask(f"GET {p}x?y=1", path=p + "x?y=1", headers={"X-Forwarded-For": "6.6.6.6"})
            ask(f"POST {p}post", method="POST", path=p + "post", body=b"hello", headers={"Content-Type": "text/plain"})
        if sc == "https" and port == 8443:
            res[f"{k} GET / direct to :8443"] = fetch(sc, host, 8443, ip, cafile)
    res["http://unknown.example GET /"] = fetch("http", "unknown.example", 80, ip, cafile)
    res["https://unknown.example via 443"] = fetch("https", "unknown.example", 443, ip, cafile)
    return res


def ws_open(url, ip, cafile):
    u = urlsplit(url)
    port = u.port or (443 if u.scheme == "wss" else 80)
    s = socket.create_connection((ip, port), 10)
    if u.scheme == "wss":
        s = ctx_of(cafile).wrap_socket(s, server_hostname=u.hostname)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET {u.path or '/'} HTTP/1.1\r\nHost: {u.hostname}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        d = s.recv(4096)
        if not d:
            raise OSError("closed during the upgrade")
        head += d
    if not head.startswith(b"HTTP/1.1 101"):
        raise OSError(head.split(b"\r\n", 1)[0].decode())
    return s


def ws_ping(s, n):
    """one masked text frame out, its echo back → True"""
    try:
        data = f"ping-{n}".encode()
        mask = os.urandom(4)
        s.sendall(bytes([0x81, 0x80 | len(data)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        s.settimeout(5)
        h = s.recv(2)
        if len(h) < 2:
            return False
        got = b""
        while len(got) < (h[1] & 0x7F):
            d = s.recv((h[1] & 0x7F) - len(got))
            if not d:
                return False
            got += d
        return got.endswith(data)
    except OSError:
        return False


def curl_h2(site, ip, cafile):
    """one request as a browser makes it (HTTP/2 over TLS, through :443) → the status, or an error"""
    r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--http2", "-m", "10", "--cacert", cafile,
                        "--resolve", f"{site}:443:{ip}", f"https://{site}/"], capture_output=True, text=True)
    return 200 if r.stdout == "200" else f"curl {r.returncode} {r.stdout}"


def reload_under_load(ip, cafile, site, stream_url, ws_urls, cmd):
    """CMD while 4 browser-like clients (HTTP/2, a new connection each time) and 2 HTTP/1.1 clients hammer SITE, a 5 s
    response is in flight and websockets are open → what each saw"""
    stop = threading.Event()
    seen = {"h2": [0, []], "h1": [0, []]}

    def hammer(kind):
        while not stop.is_set():
            r = curl_h2(site, ip, cafile) if kind == "h2" else fetch("https", site, 443, ip, cafile).get("status") or "x"
            if r == 200:
                seen[kind][0] += 1
            else:
                seen[kind][1].append(r if kind == "h2" else "RemoteDisconnected/empty reply")
    hs = [threading.Thread(target=hammer, args=(k,), daemon=True) for k in ("h2",) * 4 + ("h1",) * 2]
    for h in hs:
        h.start()
    st = {}

    def stream():
        u = urlsplit(stream_url)
        st["r"] = fetch("https", u.hostname, 443, ip, cafile, path=u.path)
    t_stream = threading.Thread(target=stream)
    t_stream.start()
    wss = {}
    for w in ws_urls:
        try:
            s = ws_open(w, ip, cafile)
            wss[w] = [s, ws_ping(s, 1)]
        except OSError as e:
            wss[w] = [None, f"open: {e}"]
    time.sleep(1)
    t0 = time.monotonic()
    rc = subprocess.run(cmd, capture_output=True, text=True)
    took = time.monotonic() - t0
    time.sleep(1.5)
    stop.set()
    for h in hs:
        h.join(20)
    t_stream.join(30)
    out = {"reload_rc": rc.returncode, "reload_err": rc.stderr.strip()[-300:] if rc.returncode else "", "reload_s": round(took, 2),
           "h2_ok": seen["h2"][0], "h2_bad_n": len(seen["h2"][1]), "h2_bad": seen["h2"][1][:5],
           "h1_ok": seen["h1"][0], "h1_bad_n": len(seen["h1"][1]),
           "stream": {k: st.get("r", {}).get(k) for k in ("status", "len", "error")}}
    for w, (s, first) in wss.items():
        out[f"ws {w}"] = {"before": first, "after": bool(s) and ws_ping(s, 2)}
        if s:
            s.close()
    return out


def main(argv):
    if argv[:1] == ["sites"]:
        print(json.dumps(sites(argv[1])))
    elif argv[:1] == ["corpus"]:
        with open(argv[4], "w") as f:
            json.dump(corpus(argv[1], argv[2], argv[3]), f, indent=1, sort_keys=True)
    elif argv[:1] == ["compare"]:
        a, b = json.load(open(argv[1])), json.load(open(argv[2]))
        diff = [k for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]
        for k in diff:
            print(f"  differs: {k}\n    {json.dumps(a.get(k))[:300]}\n    {json.dumps(b.get(k))[:300]}")
        print(f"{len(a)} requests, {len(diff)} differ")
        return 1 if diff or not a else 0
    elif argv[:1] == ["req"]:
        url, ip, cafile, rest = argv[1], argv[2], argv[3], argv[4:]
        hdr, meth, port = {}, "GET", None
        while rest:
            if rest[0] == "-H":
                k, _, v = rest[1].partition(":")
                hdr[k.strip()] = v.strip()
            elif rest[0] == "-X":
                meth = rest[1]
            elif rest[0] == "--port":
                port = int(rest[1])
            rest = rest[2:]
        u = urlsplit(url)
        p = port or u.port or (443 if u.scheme == "https" else 80)
        print(json.dumps(fetch(u.scheme, u.hostname, p, ip, cafile, method=meth, path=(u.path or "/") + (f"?{u.query}" if u.query else ""),
                               headers=hdr)))
    elif argv[:1] == ["tls-ok"]:
        port = int(argv[4]) if len(argv) > 4 else 443
        try:
            s = ctx_of(argv[3]).wrap_socket(socket.create_connection((argv[2], port), 5), server_hostname=argv[1])
            s.close()
            return 0
        except (OSError, ssl.SSLError) as e:
            print(f"tls-ok {argv[1]}: {e}", file=sys.stderr)
            return 1
    elif argv[:1] == ["reload"]:
        i = argv.index("--")
        ip, cafile, site, stream_url, *ws = argv[1:i]
        print(json.dumps(reload_under_load(ip, cafile, site, stream_url, ws, argv[i + 1:])))
    else:
        print(__doc__, file=sys.stderr)
        return 64
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
