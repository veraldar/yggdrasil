#!/usr/bin/env python3
"""rig.py — what sits behind the rehearsal's :443 (sni-443 v2) in G4.4: a loopback stand-in for the VPS.

    rig.py CERT KEY STATUS_FILE AP_PORT TRUNK_PORT OWNER_PORT SITE_PORT ICE_PORT ICE1_PORT

  AP_PORT     the v0.9 access point (TLS, a PROXY v1 line first, as trunk-ap behind sni-443): GET /ap/_link with
              X-Proto 1 holds a hub link (a byte a second); GET / → 200 while a hub link is up, else 503 (trunk-ap
              without its hub); a v1 bridge's GET /t/root → 426 (spec §11: no mixed mode)
  TRUNK_PORT  the v1 trunk (TLS): GET /t/state → 200 {"claimed":true}; GET / → 302 /login; GET /t/root with
              X-Proto 2 holds a root link; a v0.9 bridge's GET /ap/_link → 426
  OWNER_PORT  GET /t/ice/owner → 404 (no ufrag registered) · SITE_PORT the website · ICE ports: echo
STATUS_FILE gets {"v0_links", "v1_links", "v1_ever"} twice a second (the rehearsal reads link continuity from it).
"""
import json
import os
import socket
import ssl
import sys
import threading
import time

cert, key, status = sys.argv[1:4]
AP, TRUNK, OWNER, SITE, ICE, ICE1 = (int(x) for x in sys.argv[4:10])
lock = threading.Lock()
links = {"v0": set(), "v1": set()}
ever = [0]


def head_of(c):
    h = b""
    while b"\r\n\r\n" not in h:
        d = c.recv(4096)
        if not d:
            return None
        h += d
    lines = h.split(b"\r\n\r\n", 1)[0].decode(errors="replace").split("\r\n")
    meth, path = (lines[0].split(" ") + ["", ""])[:2]
    hdr = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:])}
    return meth, path, hdr


def reply(c, code, body=b"", extra=""):
    c.sendall(f"HTTP/1.1 {code}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n{extra}\r\n".encode() + body)


def hold(c, kind):
    c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n")
    me = object()
    with lock:
        links[kind].add(me)
        if kind == "v1":
            ever[0] += 1
    try:
        while True:
            c.sendall(b".")
            time.sleep(1)
    except OSError:
        pass
    finally:
        with lock:
            links[kind].discard(me)


def tls_server(port, handle, proxy):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", port))
    s.listen(64)

    def one(c):
        try:
            c.settimeout(10)
            if proxy:  # the PROXY v1 line sni-443 sends on a `proxy` route
                line = b""
                while not line.endswith(b"\r\n") and len(line) < 108:
                    d = c.recv(1)
                    if not d:
                        return
                    line += d
                if not line.startswith(b"PROXY "):
                    return
            t = ctx.wrap_socket(c, server_side=True)
            t.settimeout(None)
            h = head_of(t)
            if h:
                handle(t, *h)
        except (OSError, ssl.SSLError):
            pass
        finally:
            try:
                c.close()
            except OSError:
                pass
    while True:
        c, _ = s.accept()
        threading.Thread(target=one, args=(c,), daemon=True).start()


def ap(c, meth, path, hdr):
    if path == "/ap/_link":
        return hold(c, "v0") if hdr.get("x-proto") == "1" else reply(c, "426 Upgrade Required", b"proto mismatch\n")
    if path == "/t/root":
        return reply(c, "426 Upgrade Required", b"this is a v0.9 trunk\n")
    with lock:
        up = bool(links["v0"])
    reply(c, "200 OK", b"v0.9 app through the hub's bridge\n") if up else reply(c, "503 Service Unavailable", b"no hub link\n")


def trunk(c, meth, path, hdr):
    if path == "/t/root":
        return hold(c, "v1") if hdr.get("x-proto") == "2" else reply(c, "426 Upgrade Required", b"update this computer\n")
    if path == "/ap/_link":
        return reply(c, "426 Upgrade Required", b"update this computer\n")
    if path == "/t/state":
        return reply(c, "200 OK", b'{"claimed":true,"has_roots":true,"lockdown":false,"providers":[]}', "Content-Type: application/json\r\n")
    if path == "/" or not path.startswith("/t/"):
        return reply(c, "302 Found", b"", "Location: /login\r\n")
    reply(c, "404 Not Found")


def plain(port, fn):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", port))
    s.listen(64)
    while True:
        c, _ = s.accept()
        threading.Thread(target=fn, args=(c,), daemon=True).start()


def owner(c):
    try:
        if head_of(c):
            reply(c, "404 Not Found", b"no root registered that ufrag\n")
    finally:
        c.close()


def site(c):
    try:
        c.recv(4096)
        c.sendall(b"website")
    except OSError:
        pass
    c.close()


def echo(c):
    try:
        while True:
            d = c.recv(65536)
            if not d:
                break
            c.sendall(d)
    except OSError:
        pass
    c.close()


for args in ((tls_server, AP, ap, True), (tls_server, TRUNK, trunk, False)):
    threading.Thread(target=args[0], args=args[1:], daemon=True).start()
for port, fn in ((OWNER, owner), (SITE, site), (ICE, echo), (ICE1, echo)):
    threading.Thread(target=plain, args=(port, fn), daemon=True).start()
print("rig: up", flush=True)
while True:
    with lock:
        doc = {"v0_links": len(links["v0"]), "v1_links": len(links["v1"]), "v1_ever": ever[0], "ts": time.time()}
    with open(status + ".tmp", "w") as f:
        json.dump(doc, f)
    os.replace(status + ".tmp", status)
    time.sleep(0.5)
