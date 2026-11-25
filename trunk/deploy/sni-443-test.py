#!/usr/bin/env python3
"""sni-443-test.py — sni-443.py against real TLS clients, on loopback, no root, ~10 s.

Fake backends: a 'website' and a 'coturn' that record the first bytes and answer their name, and a real TLS
'access point' that requires the PROXY v1 line first (like `bifrost-net ap` with proxy_protocol = true).
Checks every route, byte-exact passthrough, case and trailing-dot names, a wildcard route, STUN, garbage,
an idle connection that outlives the 5 s connect timeout, IPv6 (when this machine has it), ICE over TCP (RFC 4571-framed
STUN → the `ice` backend, then framed DTLS byte-exact both ways) and config errors.
v2 (G3.9): the ICE ufrag ask (200 / 404 / slow / hung / 500 / junk / down → the default), SIGHUP reload of a real
process under 20 live connections + a storm of 20 reloads (zero dropped), refused reloads (bad config, changed listen
lines), the stricter parser, and a replay of today's config — the VPS copy at SNI443_VPS_CONF (default
~/.cache/trunk-v1/vps-ro/sni-443.conf, kept outside the repo) and the kit's render — through the old copies from git,
first-bytes case by case. ~40 s.
    python3 trunk/deploy/sni-443-test.py        exit 0 = GREEN
"""
import importlib.util
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sni", os.path.join(HERE, "sni-443.py"))
sni = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sni)
TMP = tempfile.mkdtemp(prefix="sni-443-test.")
CRT, KEY = os.path.join(TMP, "t.crt"), os.path.join(TMP, "t.key")
subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                "-keyout", KEY, "-out", CRT, "-days", "1", "-subj", "/CN=trunk.example.org",
                "-addext", "subjectAltName=DNS:trunk.example.org,DNS:x.apps.example.org,DNS:www.example.org"],
               check=True, capture_output=True)
got = {}


def listener(host="127.0.0.1"):
    s = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, 0))
    s.listen(16)
    return s


def fake(name, s):
    """records the first bytes, answers its own name"""
    while True:
        c, _ = s.accept()
        c.settimeout(3)
        try:
            got.setdefault(name, []).append(c.recv(65536))
        except OSError:
            pass
        try:
            c.sendall(name.encode())
        except OSError:
            pass
        c.close()


def tls_backend(name, s, want_proxy):
    """a real TLS server; with want_proxy it requires the PROXY v1 line first. Echoes NAME:<data>, twice."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CRT, KEY)
    while True:
        c, _ = s.accept()

        def one(c=c):
            c.settimeout(20)
            if want_proxy:
                line = b""
                while not line.endswith(b"\r\n") and len(line) < 108:
                    line += c.recv(1)
                got.setdefault(name + "-proxy", []).append(line.decode(errors="replace"))
            try:
                t = ctx.wrap_socket(c, server_side=True)
                for _ in range(2):
                    data = t.recv(1000)
                    if not data:
                        break
                    t.sendall(name.encode() + b":" + data)
                t.close()
            except Exception as e:  # noqa: BLE001
                got.setdefault(name + "-err", []).append(repr(e))
        threading.Thread(target=one, daemon=True).start()


def echo(name, s):
    """records every byte it got, and echoes it (an ICE-TCP endpoint's stand-in)"""
    while True:
        c, _ = s.accept()

        def one(c=c):
            c.settimeout(5)
            seen = bytearray()
            got.setdefault(name, []).append(seen)
            try:
                while True:
                    d = c.recv(65536)
                    if not d:
                        break
                    seen.extend(d)
                    c.sendall(d)
            except OSError:
                pass
            c.close()
        threading.Thread(target=one, daemon=True).start()


website, coturn, ap, apps, ice = listener(), listener(), listener(), listener(), listener()
threading.Thread(target=echo, args=("ice", ice), daemon=True).start()
threading.Thread(target=fake, args=("website", website), daemon=True).start()
threading.Thread(target=fake, args=("coturn", coturn), daemon=True).start()
threading.Thread(target=tls_backend, args=("AP", ap, True), daemon=True).start()
threading.Thread(target=tls_backend, args=("APPS", apps, False), daemon=True).start()

have6 = socket.has_ipv6
try:
    socket.socket(socket.AF_INET6).bind(("::1", 0))
except OSError:
    have6 = False
conf = os.path.join(TMP, "sni-443.conf")
with open(conf, "w") as f:
    f.write(f"""# test config
listen  127.0.0.1:0
{'listen  [::]:0' if have6 else ''}
route   Trunk.Example.Org.  127.0.0.1:{ap.getsockname()[1]}  proxy   # case + trailing dot in the config too
route   *.apps.example.org  127.0.0.1:{apps.getsockname()[1]}
default 127.0.0.1:{website.getsockname()[1]}
stun    127.0.0.1:{coturn.getsockname()[1]}
ice     127.0.0.1:{ice.getsockname()[1]}
""")
cfg = sni.load(conf)
ports = []
ready = threading.Event()
threading.Thread(target=sni.serve, args=(cfg, lambda p: (ports.extend(p), ready.set())), daemon=True).start()
ready.wait(5)
port = ports[0]

ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def tls(sni_name, host="127.0.0.1", p=None, idle=0.0):
    ctx = ssl.create_default_context(cafile=CRT)
    ctx.check_hostname = bool(sni_name)
    if not sni_name:
        ctx.verify_mode = ssl.CERT_NONE
    c = socket.create_connection((host, p or port))
    try:
        t = ctx.wrap_socket(c, server_hostname=sni_name)
        t.sendall(b"hello-trunk")
        r = t.recv(100)
        if idle:
            time.sleep(idle)
            t.sendall(b"still-here")
            r += b"|" + t.recv(100)
        t.close()
        return r
    except Exception as e:  # noqa: BLE001
        return repr(e)


# 1. the trunk: TLS end to end through the router, the PROXY line first, naming the client
r = tls("trunk.example.org")
check("trunk.example.org → the access point, TLS end to end, bytes exact", r == b"AP:hello-trunk", r)
pl = got.get("AP-proxy", [""])[-1]
check("PROXY v1 line names the client", pl.startswith("PROXY TCP4 127.0.0.1 127.0.0.1 ") and pl.endswith(f" {port}\r\n"), pl)
# 2. the website and everything else: byte-exact ClientHello, no PROXY line
n = len(got.get("website", []))
tls("www.example.org")
time.sleep(0.2)
first = got["website"][-1] if len(got.get("website", [])) > n else b""
check("www.example.org → website, unchanged (starts with its ClientHello, no PROXY)",
      first[:1] == b"\x16" and sni.sni_of(first) == "www.example.org")
n = len(got.get("website", []))
tls(None)
time.sleep(0.2)
check("TLS without a name (an IP) → website", len(got.get("website", [])) == n + 1)
c = socket.create_connection(("127.0.0.1", port))
c.sendall(b"GET / HTTP/1.1\r\nHost: www.example.org\r\n\r\n")
r = c.recv(100)
c.close()
check("plain http → website", r == b"website", r)
# 3. a wildcard route, and a name merely ending like it
check("x.apps.example.org → the wildcard route (no PROXY)", tls("x.apps.example.org") == b"APPS:hello-trunk")
check("apps.example.org itself is not below *.apps.example.org", sni.route_of(cfg, "apps.example.org")[0] == cfg["default"])
check("evilapps.example.org does not match *.apps.example.org", sni.route_of(cfg, "evilapps.example.org")[0] == cfg["default"])
# 4. STUN / TURN over TCP
stun = (0x0001).to_bytes(2, "big") + (0).to_bytes(2, "big") + b"\x21\x12\xa4\x42" + os.urandom(12)
c = socket.create_connection(("127.0.0.1", port))
c.sendall(stun)
r = c.recv(100)
c.close()
check("STUN/TURN → coturn", r == b"coturn", r)
# 4b. ICE over TCP (RFC 6544): an RFC 4571 frame holding a STUN binding request → the ice backend; what follows
# (framed DTLS / SRTP) passes byte-exact both ways — opaque bytes, nothing parsed
username = b"\x00\x06\x00\x09" + b"abcd:efgh" + b"\x00\x00\x00"
binding = (0x0001).to_bytes(2, "big") + len(username).to_bytes(2, "big") + b"\x21\x12\xa4\x42" + os.urandom(12) + username
framed = len(binding).to_bytes(2, "big") + binding
dtls = os.urandom(300)
c = socket.create_connection(("127.0.0.1", port))
c.sendall(framed)
time.sleep(0.2)
c.sendall(len(dtls).to_bytes(2, "big") + dtls)
want = len(framed) + 2 + len(dtls)
r = b""
c.settimeout(3)
try:
    while len(r) < want:
        d = c.recv(65536)
        if not d:
            break
        r += d
except OSError:
    pass
c.close()
check("ICE-TCP framed STUN → ice backend, then framed DTLS echoed byte-exact", r == framed + len(dtls).to_bytes(2, "big") + dtls,
      f"{len(r)}/{want}")
check("the ice backend got the binding request first, unchanged", bytes(got.get("ice", [b""])[0][:len(framed)]) == framed)
check("framed_stun_head: unframed STUN (TURN) is not ICE-TCP", not sni.framed_stun_head(stun[:8]))
check("framed_stun_head: TLS and http are not ICE-TCP", not sni.framed_stun_head(b"\x16\x03\x01\x02\x00\x01\x00\x01")
      and not sni.framed_stun_head(b"GET / HT"))
n = len(got.get("website", []))
bad = len(binding).to_bytes(2, "big") + binding[:6] + b"\x00\x00\x00\x00" + binding[10:]  # frame + type ok, magic wrong
c = socket.create_connection(("127.0.0.1", port))
c.sendall(bad)
r = c.recv(100)
c.close()
check("a frame with the wrong magic cookie → website, not ice", r == b"website", r)
# 5. a real openssl client (OpenSSL 3: a big ClientHello), the name in another case + trailing dot
n = len(got.get("AP-proxy", []))
subprocess.run(["openssl", "s_client", "-connect", f"127.0.0.1:{port}", "-servername", "TRUNK.Example.Org."],
               input=b"", capture_output=True, timeout=10)
time.sleep(0.3)
check("openssl s_client, 'TRUNK.Example.Org.' → the access point", len(got.get("AP-proxy", [])) == n + 1)
# 6. an idle link outlives the 5 s connect timeout (the upstream-timeout law)
r = tls("trunk.example.org", idle=6)
check("an idle trunk link (6 s) keeps going", r == b"AP:hello-trunk|AP:still-here", r)
# 7. garbage, truncated and slow hellos never crash it
for junk in (b"\x16\x03\x01\x00\x05\x01\x00", b"\x16\x03\x01\xff\xff" + b"\x01" * 50, os.urandom(40), b"\x16"):
    c = socket.create_connection(("127.0.0.1", port))
    c.sendall(junk)
    c.shutdown(socket.SHUT_WR)
    c.settimeout(3)
    try:
        c.recv(10)
    except OSError:
        pass
    c.close()
for sample in (b"", b"\x16", b"\x16\x03\x01\x00\x02\x01\x00", bytes(range(256))):
    sni.sni_of(sample)
got.pop("AP-err", None)  # s_client hangs up after the handshake: the fake ap's reply hits a closed pipe
check("garbage and truncated hellos: no crash, still serving", tls("trunk.example.org") == b"AP:hello-trunk")
check("no TLS errors at the access point after that", not got.get("AP-err"), got.get("AP-err"))
# 8. IPv6: a v6 client gets PROXY TCP6, a v4 client on the dual-stack socket gets TCP4
if have6:
    r = tls("trunk.example.org", host="::1", p=ports[1])
    pl = got.get("AP-proxy", [""])[-1]
    check("IPv6 client → access point, PROXY TCP6 ::1", r == b"AP:hello-trunk" and pl.startswith("PROXY TCP6 ::1 ::1 "), pl)
    r = tls("trunk.example.org", host="127.0.0.1", p=ports[1])
    pl = got.get("AP-proxy", [""])[-1]
    check("IPv4 client on the dual-stack [::] socket → PROXY TCP4 (not ::ffff:)", pl.startswith("PROXY TCP4 127.0.0.1 127.0.0.1 "), pl)
else:
    print("SKIP IPv6 (this machine has none)")
# 9. config errors are named
for bad, why in (("route x\n", "cannot read"), ("listen 0.0.0.0:443\n", "no 'default"), ("default nowhere\n", "not host:port")):
    p = os.path.join(TMP, "bad.conf")
    with open(p, "w") as f:
        f.write(bad)
    try:
        sni.load(p)
        check(f"config error refused: {bad.strip()!r}", False)
    except ValueError as e:
        check(f"config error refused: {bad.strip()!r} ({why})", why in str(e), str(e))

# ── v2 (trunk v1, G3.9): the ufrag ask, SIGHUP reload under live connections, the stricter parser, and a
# replay of today's config (the VPS copy and the kit's render) against the old copies, decision by decision
import random  # noqa: E402
import re  # noqa: E402
import signal  # noqa: E402


def ice_binding(ufrag=b"abcd", sender=b"efgh", magic=b"\x21\x12\xa4\x42", username=True):
    """an RFC 4571-framed STUN binding request, USERNAME "<receiver>:<sender>" (+ PRIORITY, as browsers send)"""
    attrs = b""
    if username:
        u = ufrag + b":" + sender
        attrs += b"\x00\x06" + len(u).to_bytes(2, "big") + u + b"\x00" * (-len(u) % 4)
    attrs += b"\x00\x24\x00\x04" + os.urandom(4)
    msg = b"\x00\x01" + len(attrs).to_bytes(2, "big") + magic + os.urandom(12) + attrs
    return len(msg).to_bytes(2, "big") + msg


asks = []  # the owner stub's request lines


def owner_stub(s):
    """the v1 trunk's GET /t/ice/owner?u= stand-in: OWNED… → 200, SLOW… → 200 after 1 s, BOOM… → 500,
    JUNK… → not http, HANG… → never answers, anything else → 404"""
    while True:
        c, _ = s.accept()

        def one(c=c):
            c.settimeout(5)
            try:
                req = b""
                while b"\r\n\r\n" not in req:
                    d = c.recv(4096)
                    if not d:
                        return
                    req += d
                line = req.split(b"\r\n", 1)[0].decode()
                asks.append(req.decode())
                u = re.search(r"[?&]u=([^ &]*)", line)
                u = u.group(1) if u else ""
                if u.startswith("HANG"):
                    time.sleep(3)
                    return
                if u.startswith("SLOW"):
                    time.sleep(1)
                if u.startswith("JUNK"):
                    c.sendall(b"garbage\r\n\r\n")
                    return
                code = "200 OK" if u.startswith(("OWNED", "SLOW")) else "500 Oops" if u.startswith("BOOM") else "404 Not Found"
                c.sendall(f"HTTP/1.1 {code}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
            except OSError:
                pass
            finally:
                c.close()
        threading.Thread(target=one, daemon=True).start()


owner, ice1 = listener(), listener()
threading.Thread(target=owner_stub, args=(owner,), daemon=True).start()
threading.Thread(target=echo, args=("ice1", ice1), daemon=True).start()
closed = listener()
closed_port = closed.getsockname()[1]
closed.close()  # a port nobody listens on: the owner is down
conf2 = os.path.join(TMP, "sni-443-v2.conf")
OWNER_URL = f"http://127.0.0.1:{owner.getsockname()[1]}/t/ice/owner"


def write_conf2(url=OWNER_URL, budget="200ms"):
    with open(conf2, "w") as f:
        f.write(f"""listen  127.0.0.1:0
route   trunk.example.org  127.0.0.1:{ap.getsockname()[1]}  proxy
default 127.0.0.1:{website.getsockname()[1]}
stun    127.0.0.1:{coturn.getsockname()[1]}
ice     127.0.0.1:{ice.getsockname()[1]}
ice_owner {url}  127.0.0.1:{ice1.getsockname()[1]}  {budget}
""")


write_conf2()
cfg2 = sni.load(conf2)
router2 = sni.Router(cfg2, conf2)
ports2, ready2 = [], threading.Event()
threading.Thread(target=sni.serve, args=(cfg2, lambda p: (ports2.extend(p), ready2.set()), router2), daemon=True).start()
ready2.wait(5)
port2 = ports2[0]


def ice_through(p, framed, chunks=1, dtls_len=200):
    """an ICE-TCP connection through the router at p: the framed binding request (in `chunks` pieces), then
    framed DTLS → (which echo backend took it, everything echoed back is byte-exact?, seconds to the first echo)"""
    before = {k: len(got.get(k, [])) for k in ("ice", "ice1")}
    dtls = os.urandom(dtls_len)
    c = socket.create_connection(("127.0.0.1", p))
    c.settimeout(4)
    t0 = time.monotonic()
    step = max(1, len(framed) // chunks)
    for i in range(0, len(framed), step):
        c.sendall(framed[i:i + step])
        if chunks > 1:
            time.sleep(0.05)
    first, r = None, b""
    try:
        while len(r) < len(framed):
            d = c.recv(65536)
            if not d:
                break
            first = first or time.monotonic() - t0
            r += d
        c.sendall(len(dtls).to_bytes(2, "big") + dtls)
        want = len(framed) + 2 + len(dtls)
        while len(r) < want:
            d = c.recv(65536)
            if not d:
                break
            r += d
    except OSError:
        pass
    c.close()
    time.sleep(0.05)
    took = [k for k in ("ice", "ice1") if len(got.get(k, [])) > before[k]]
    return (took[0] if len(took) == 1 else took), r == framed + len(dtls).to_bytes(2, "big") + dtls, first or 99


# 10. the ufrag ask
sni.STATS.take()
n_asks = len(asks)
b = ice_binding(b"OWNEDuf1")
who, exact, _ = ice_through(port2, b)
check("ask: an owned ufrag (200) → the ice_owner backend, then framed DTLS byte-exact both ways", who == "ice1" and exact, f"{who} {exact}")
check("ask: the owner got exactly GET <path>?u=<ufrag>", len(asks) == n_asks + 1 and
      asks[-1].startswith(f"GET /t/ice/owner?u=OWNEDuf1 HTTP/1.1\r\nHost: 127.0.0.1:{owner.getsockname()[1]}\r\n"), asks[-1:])
check("ask: the ice_owner backend got the whole first frame first, unchanged", bytes(got["ice1"][-1][:len(b)]) == b)
who, exact, _ = ice_through(port2, ice_binding(b"nobodys1"))
check("ask: an unknown ufrag (404) → the ice line (today's path), byte-exact", who == "ice" and exact, f"{who} {exact}")
for kind in ("SLOW", "HANG"):
    who, exact, first = ice_through(port2, ice_binding(kind.encode() + b"uf"))
    check(f"ask: an owner that answers late ({kind}) → the ice line within the 200 ms budget ({first * 1000:.0f} ms)",
          who == "ice" and exact and 0.15 < first < 0.7, f"{who} {exact} {first:.3f}")
for kind, what in (("BOOM", "a 500"), ("JUNK", "a non-http answer")):
    who, exact, _ = ice_through(port2, ice_binding(kind.encode() + b"uf"))
    check(f"ask: {what} → the ice line", who == "ice" and exact, f"{who} {exact}")
st = sni.STATS.take()
check("ask: counted — conns ice_owner 1, errors ask.timeout 2 + ask.error 2", st["conns"].get("ice_owner") == 1 and
      st["errors"].get("ask.timeout") == 2 and st["errors"].get("ask.error") == 2, st)
n_asks = len(asks)
who, exact, _ = ice_through(port2, ice_binding(b"OWNED+a/b"))
check("ask: '+' and '/' in a ufrag are percent-encoded (u=OWNED%2Ba%2Fb)", who == "ice1" and exact and
      asks[-1].startswith("GET /t/ice/owner?u=OWNED%2Ba%2Fb "), asks[-1:])
who, exact, _ = ice_through(port2, ice_binding(b"OWNEDsplit"), chunks=5)
check("ask: a first frame that arrives in 5 pieces is read whole → owned", who == "ice1" and exact, f"{who} {exact}")
n_asks = len(asks)
who, exact, _ = ice_through(port2, ice_binding(username=False))
check("ask: a binding request without USERNAME → the ice line, nothing asked", who == "ice" and exact and len(asks) == n_asks)
who, exact, _ = ice_through(port2, ice_binding(b"OWNED%x"))
check("ask: a ufrag outside the ICE alphabet → the ice line, nothing asked", who == "ice" and exact and len(asks) == n_asks)
who, exact, _ = ice_through(port, ice_binding(b"OWNEDnoask"))
check("no ice_owner line (the v1 config): nothing is asked, the ice line as before", who == "ice" and exact and len(asks) == n_asks)
r = tls("trunk.example.org", p=port2)
check("with ice_owner: TLS routes are unchanged (trunk.example.org → the access point)", r == b"AP:hello-trunk", r)
write_conf2(url=f"http://127.0.0.1:{closed_port}/t/ice/owner")
check("reload (in process): the owner moved to a port nobody listens on", router2.reload())
who, exact, first = ice_through(port2, ice_binding(b"OWNEDdown"))
check(f"ask: the owner is down (refused) → the ice line at once ({first * 1000:.0f} ms)", who == "ice" and exact and first < 0.5, f"{who} {first}")

# 11. reload in process: a bad config, or changed listen lines, leave the config in force
write_conf2()
with open(conf2, "a") as f:
    f.write("route broken\n")
before = router2.cfg
check("reload refused: a config that does not read leaves the old one in force", not router2.reload() and router2.cfg is before)
with open(conf2, "w") as f:
    f.write(f"listen 127.0.0.1:1\ndefault 127.0.0.1:{website.getsockname()[1]}\n")
check("reload refused: changed listen lines leave the old one in force", not router2.reload() and router2.cfg is before)
write_conf2()
check("reload: a good config is in force again", router2.reload() and router2.cfg is not before)


# 12. SIGHUP on the real process, with live connections: none dropped, each stays on its backend; new
# connections follow the new config; a bad config and changed listen lines are refused; a SIGHUP storm
def tagecho(tag, s):
    """answers every piece it gets as TAG|piece (says which backend a connection reached)"""
    while True:
        c, _ = s.accept()

        def one(c=c):
            c.settimeout(30)
            try:
                while True:
                    d = c.recv(65536)
                    if not d:
                        break
                    c.sendall(tag.encode() + b"|" + d)
            except OSError:
                pass
            c.close()
        threading.Thread(target=one, daemon=True).start()


def client_hello(name):
    """the first record of a real TLS client naming `name` (Python's own ClientHello)"""
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
    inc, out = ssl.MemoryBIO(), ssl.MemoryBIO()
    obj = ctx.wrap_bio(inc, out, server_hostname=name)
    try:
        obj.do_handshake()
    except ssl.SSLWantReadError:
        pass
    return out.read()


tags = {t: listener() for t in ("A", "B", "W", "I")}
for t, sk in tags.items():
    threading.Thread(target=tagecho, args=(t, sk), daemon=True).start()
conf3 = os.path.join(TMP, "sni-443-hup.conf")


def write_conf3(trunk_tag, extra=""):
    with open(conf3 + ".new", "w") as f:
        f.write(f"""listen  127.0.0.1:0
route   trunk.example.org  127.0.0.1:{tags[trunk_tag].getsockname()[1]}  proxy
default 127.0.0.1:{tags['W'].getsockname()[1]}
ice     127.0.0.1:{tags['I'].getsockname()[1]}
{extra}""")
    os.replace(conf3 + ".new", conf3)  # as an editor or an installer writes it: never half a file


write_conf3("A")
proc = subprocess.Popen([sys.executable, os.path.join(HERE, "sni-443.py"), "-c", conf3], stderr=subprocess.PIPE,
                        env=dict(os.environ, SNI443_STATS="off"), text=True)
log, log_cv = [], threading.Condition()


def read_log():
    for line in proc.stderr:
        with log_cv:
            log.append(line.rstrip("\n"))
            log_cv.notify_all()


threading.Thread(target=read_log, daemon=True).start()


def wait_log(pat, since, timeout=5):
    end = time.monotonic() + timeout
    with log_cv:
        while True:
            for line in log[since:]:
                if pat in line:
                    return line
            left = end - time.monotonic()
            if left <= 0:
                return None
            log_cv.wait(left)


line = wait_log("listening on 127.0.0.1:", 0)
hport = int(line.rsplit(":", 1)[1]) if line else 0
hello_trunk = client_hello("trunk.example.org")


def first_of(kind):
    return {"trunk": hello_trunk, "ice": ice_binding(b"live"), "web": b"GET / HTTP/1.1\r\nHost: www.example.org\r\n\r\n"}[kind]


def live_conn(kind):
    """a connection through the router that stays open: its first bytes route it; returns (sock, tag). The
    router forwards what it peeked, then the rest: the echo may answer in pieces — all read until quiet"""
    c = socket.create_connection(("127.0.0.1", hport))
    c.sendall(first_of(kind))
    c.settimeout(5)
    r = c.recv(65536)
    c.settimeout(0.2)
    try:
        while True:
            d = c.recv(65536)
            if not d:
                break
            r += d
    except OSError:
        pass
    c.settimeout(5)
    return c, r.split(b"|", 1)[0].decode()


def ping(c, n):
    """one more exchange on a live connection → the tag that answered it (None: the connection is gone)"""
    want, r = f"|ping-{n}".encode(), b""
    try:
        c.sendall(want[1:])
        while not r.endswith(want):
            d = c.recv(65536)
            if not d:
                return None
            r += d
        return r[:-len(want)][-1:].decode()  # the one-letter tag right before "|ping-n"
    except OSError:
        return None


try:
    lives = [(k, *live_conn(k)) for k in ["trunk"] * 10 + ["ice"] * 5 + ["web"] * 5]
    want_tag = {"trunk": "A", "ice": "I", "web": "W"}
    check("SIGHUP rig: 20 live connections (10 trunk, 5 ICE, 5 website) on their backends",
          hport and all(t == want_tag[k] for k, _, t in lives), [t for _, _, t in lives])
    write_conf3("B")
    mark = len(log)
    proc.send_signal(signal.SIGHUP)
    check("SIGHUP: 'reloaded' logged, the process still runs", wait_log("sni-443: reloaded", mark) and proc.poll() is None,
          log[mark:])
    alive = [ping(c, 1) == t for _, c, t in lives]
    check(f"SIGHUP: zero live connections dropped ({sum(alive)}/{len(lives)} still answer, each on its old backend)",
          all(alive))
    c, t = live_conn("trunk")
    check("SIGHUP: a new trunk connection follows the new route (A → B)", t == "B", t)
    c.close()
    with open(conf3, "a") as f:
        f.write("route trunk.example.org 127.0.0.1:1\n")  # a second route for one name: refused
    mark = len(log)
    proc.send_signal(signal.SIGHUP)
    refused = wait_log("reload refused", mark)
    check("SIGHUP with a bad config: refused and logged with file:line", refused and "sni-443-hup.conf:5" in refused, refused)
    c, t = live_conn("trunk")
    check("…the config in force stays (a new trunk connection → B)", t == "B" and proc.poll() is None, t)
    c.close()
    write_conf3("A", "listen 127.0.0.1:0\n")
    with open(conf3) as f:
        txt = f.read()
    with open(conf3, "w") as f:
        f.write(txt.replace("listen  127.0.0.1:0\n", "listen  127.0.0.1:1\n", 1))
    mark = len(log)
    proc.send_signal(signal.SIGHUP)
    refused = wait_log("reload refused", mark)
    check("SIGHUP with changed listen lines: refused (a restart opens sockets)", refused and "listen lines changed" in refused, refused)
    # the storm: 20 SIGHUPs in 2 s (the route flipping A ↔ B) while 4 clients keep opening new connections
    stop, results = threading.Event(), []

    def hammer():
        while not stop.is_set():
            try:
                c, t = live_conn("trunk")
                results.append(t in ("A", "B") and ping(c, 9) == t)
                c.close()
            except OSError:
                results.append(False)
    hs = [threading.Thread(target=hammer, daemon=True) for _ in range(4)]
    for h in hs:
        h.start()
    for i in range(20):
        write_conf3("AB"[i % 2])
        proc.send_signal(signal.SIGHUP)
        time.sleep(0.1)
    time.sleep(0.5)
    stop.set()
    for h in hs:
        h.join(5)
    check(f"SIGHUP storm (20 reloads): {len(results)} new connections, every one answered", len(results) >= 20 and all(results),
          f"{results.count(False)} failed of {len(results)}")
    alive = [ping(c, 2) == t for _, c, t in lives]
    check(f"after the storm: the 20 first connections still answer on their old backends ({sum(alive)}/{len(lives)})",
          all(alive) and proc.poll() is None)
    for _, c, _ in lives:
        c.close()
finally:
    proc.terminate()  # the router this test started, by its own handle
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()

# 13. the stricter parser: each mistake is refused with its file and line; every good config still reads
good = (f"listen 127.0.0.1:0\nlisten [::]:0\nroute a.example.org [::1]:4443 proxy\nroute *.b.example.org 127.0.0.1:2\n"
        f"default 127.0.0.1:8443\nstun 192.0.2.1:3478\nice 127.0.0.1:4479\n"
        f"ice_owner http://10.99.0.2:8080/t/ice/owner 10.99.0.2:4479 50ms\n")
for bad, why in (
        ("default 127.0.0.1:8443\ndefault 127.0.0.1:8444\n", "2: a second 'default' line (the first is at line 1)"),
        ("ice 127.0.0.1:1\nice 127.0.0.1:2\ndefault 127.0.0.1:3\n", "2: a second 'ice' line"),
        ("route a.example.org 127.0.0.1:1\nroute A.Example.Org. 127.0.0.1:2\ndefault 127.0.0.1:3\n", "2: a second route for a.example.org"),
        ("listen 0.0.0.0:443\nlisten 0.0.0.0:443\ndefault 127.0.0.1:3\n", "2: a second 'listen 0.0.0.0:443'"),
        ("default 127.0.0.1:0\n", "1: default: port 0 out of range"),
        ("default 127.0.0.1:70000\n", "1: default: port 70000 out of range"),
        ("route bad!name.org 127.0.0.1:1\ndefault 127.0.0.1:3\n", "1: route: not a server name"),
        ("route a.*.org 127.0.0.1:1\ndefault 127.0.0.1:3\n", "1: route: not a server name"),
        ("route a.org 127.0.0.1:1 prox\ndefault 127.0.0.1:3\n", "1: cannot read"),
        ("default *.example.org:1\n", "1: default: not an address or a host name"),
        ("stun nowhere\ndefault 127.0.0.1:3\n", "1: not host:port"),
        ("default 127.0.0.1:3\nice_owner http://127.0.0.1:8080/t/ice/owner 127.0.0.1:4479\n", "2: ice_owner needs an 'ice' line"),
        ("ice 127.0.0.1:1\nice_owner https://h:1/t/ice/owner 127.0.0.1:2\ndefault 127.0.0.1:3\n", "2: ice_owner: not a plain http"),
        ("ice 127.0.0.1:1\nice_owner http://u:p@h:1/x 127.0.0.1:2\ndefault 127.0.0.1:3\n", "2: ice_owner: not a plain http"),
        ("ice 127.0.0.1:1\nice_owner http://h:1/x?u=1 127.0.0.1:2\ndefault 127.0.0.1:3\n", "2: ice_owner: not a plain http"),
        ("ice 127.0.0.1:1\nice_owner http://h:1/x\ndefault 127.0.0.1:3\n", "2: ice_owner: URL BACKEND [BUDGET]"),
        ("ice 127.0.0.1:1\nice_owner http://h:1/x 127.0.0.1:2 5ms\ndefault 127.0.0.1:3\n", "2: ice_owner: budget '5ms'"),
        ("ice 127.0.0.1:1\nice_owner http://h:1/x 127.0.0.1:2 2000ms\ndefault 127.0.0.1:3\n", "2: ice_owner: budget '2000ms'"),
        ("ice 127.0.0.1:1\nice_owner http://h:1/x 127.0.0.1:2 200\ndefault 127.0.0.1:3\n", "2: ice_owner: budget '200'"),
        ("ice 127.0.0.1:1\nice_owner http://h:1/x 127.0.0.1:2\nice_owner http://h:1/x 127.0.0.1:2\ndefault 127.0.0.1:3\n",
         "3: a second 'ice_owner' line"),
        ("default 127.0.0.1:3\nroutes a.org 127.0.0.1:1\n", "2: cannot read")):
    p = os.path.join(TMP, "bad2.conf")
    with open(p, "w") as f:
        f.write(bad)
    try:
        sni.load(p)
        check(f"parser refuses {bad.splitlines()[-1]!r}…", False, "it was accepted")
    except ValueError as e:
        check(f"parser refuses: bad2.conf:{why}", f"{p}:{why}" in str(e), str(e))
p = os.path.join(TMP, "good2.conf")
with open(p, "w") as f:
    f.write(good)
g = sni.load(p)
check("parser: a full v2 config reads (IPv6 backend, wildcard, ice_owner 50ms)", g["ice_owner"]["budget"] == 0.05 and
      g["routes"][0] == ("a.example.org", ("::1", 4443), True) and g["ice_owner"]["backend"] == ("10.99.0.2", 4479))
kit = subprocess.run(["bash", os.path.join(HERE, "vps-443", "make-conf.sh"), "ap.example.org", "192.0.2.10"],
                     capture_output=True, text=True)
p = os.path.join(TMP, "kit.conf")
with open(p, "w") as f:
    f.write(kit.stdout)
k = sni.load(p)
check("parser: the kit's render (make-conf.sh) reads, no ice_owner", kit.returncode == 0 and k["ice_owner"] is None and
      k["routes"] == [("ap.example.org", ("127.0.0.1", 4443), True)])
r = subprocess.run([sys.executable, os.path.join(HERE, "sni-443.py"), "-c", p, "--check"], capture_output=True, text=True)
r2 = subprocess.run([sys.executable, os.path.join(HERE, "sni-443.py"), "-c", os.path.join(TMP, "bad2.conf"), "--check"],
                    capture_output=True, text=True)
check("--check: exit 0 on a good config, 1 (with the reason) on a bad one", r.returncode == 0 and r2.returncode == 1 and
      "a second 'default' line" not in r2.stderr and "cannot read" in r2.stderr, (r.stderr, r2.stderr))


# 14. today's config routes exactly as before: the VPS copy (read-only, kept outside the repo) and the kit's
# render, replayed through the branch point's sni-443.py (764de9e5), the pre-meter copy (fb189bee, what the
# VPS runs) and this one — every first-bytes case reaches the same backend with the same bytes
def recorder(tag, s, box):
    """records everything a connection sends until 0.25 s of quiet (or EOF), answers its tag, closes"""
    while True:
        c, _ = s.accept()

        def one(c=c):
            c.settimeout(0.25)
            data = b""
            try:
                while True:
                    d = c.recv(65536)
                    if not d:
                        break
                    data += d
            except OSError:
                pass
            box.append((tag, data))
            try:
                c.sendall(tag.encode())
            except OSError:
                pass
            c.close()
        threading.Thread(target=one, daemon=True).start()


def replay_router(src, conf_text):
    """one router (a copy of sni-443.py at `src`) on `conf_text` with every backend → a local recorder"""
    box, out, seen = [], [], {}
    for raw in conf_text.splitlines():
        words = raw.split("#", 1)[0].split()
        if words and words[0] == "listen":
            continue
        if words and words[0] in ("route", "default", "stun", "ice"):
            addr = words[2] if words[0] == "route" else words[1]
            tag = f"route:{words[1].lower().rstrip('.')}" if words[0] == "route" else words[0]
            if addr not in seen:
                sk = listener()
                threading.Thread(target=recorder, args=(tag, sk, box), daemon=True).start()
                seen[addr] = sk.getsockname()[1]
            raw = raw.replace(addr, f"127.0.0.1:{seen[addr]}", 1)
        out.append(raw)
    path = os.path.join(TMP, f"replay-{len(os.listdir(TMP))}.conf")
    with open(path, "w") as f:
        f.write("listen 127.0.0.1:0\n" + "\n".join(out) + "\n")
    pr = subprocess.Popen([sys.executable, src, "-c", path], stderr=subprocess.PIPE, text=True,
                          env=dict(os.environ, SNI443_STATS="off"))
    port_ = None
    for line in pr.stderr:
        if "listening on 127.0.0.1:" in line:
            port_ = int(line.rsplit(":", 1)[1])
            break
    threading.Thread(target=lambda: [None for _ in pr.stderr], daemon=True).start()
    return pr, port_, box


def replay_one(port_, box, chunks, half_close):
    n = len(box)
    c = socket.create_connection(("127.0.0.1", port_))
    c.settimeout(3)
    for i, ch in enumerate(chunks):
        if i:
            time.sleep(0.05)
        c.sendall(ch)
    if half_close:
        c.shutdown(socket.SHUT_WR)
    r = b""
    try:
        while True:
            d = c.recv(65536)
            if not d:
                break
            r += d
    except OSError:
        pass
    c.close()
    for _ in range(20):  # the recorder files a connection at its EOF or after 0.25 s of quiet
        if len(box) > n:
            break
        time.sleep(0.05)
    if len(box) <= n:
        return r, None
    tag, data = box[n]
    m = re.match(rb"PROXY TCP4 127\.0\.0\.1 127\.0\.0\.1 (\d+) (\d+)\r\n", data)
    if m:  # the client's port differs run to run; the router's own port must be the one it listens on
        data = b"PROXY TCP4 127.0.0.1 127.0.0.1 <sport> " + (b"<dport>" if int(m.group(2)) == port_ else m.group(2)) + b"\r\n" + data[m.end():]
    return r, (tag, data)


def replay_cases(names):
    rnd = random.Random(443)
    cs = []
    for nm in names:
        h = client_hello(nm)
        cs += [(f"ClientHello {nm}", [h], False), (f"ClientHello {nm.upper()}.", [client_hello(nm.upper() + ".")], False),
               (f"ClientHello x.{nm}", [client_hello("x." + nm)], False), (f"ClientHello {nm[1:]}", [client_hello(nm[1:])], False),
               (f"ClientHello {nm} in 3 pieces", [h[:3], h[3:40], h[40:]], False),
               (f"plain http Host: {nm}", [f"GET / HTTP/1.1\r\nHost: {nm}\r\n\r\n".encode()], False)]
        big = ssl.create_default_context()
        big.check_hostname, big.verify_mode = False, ssl.CERT_NONE
        big.set_alpn_protocols([f"proto-{i:04d}-" + "x" * 40 for i in range(120)])
        inc, out = ssl.MemoryBIO(), ssl.MemoryBIO()
        try:
            big.wrap_bio(inc, out, server_hostname=nm).do_handshake()
        except ssl.SSLError:
            pass
        cs.append((f"ClientHello {nm} with a 6 KB ALPN list", [out.read()], False))
    stun_ = (0x0001).to_bytes(2, "big") + (0).to_bytes(2, "big") + b"\x21\x12\xa4\x42" + bytes(rnd.getrandbits(8) for _ in range(12))
    fb = ice_binding(b"replay1")
    cs += [("ClientHello www.example.org", [client_hello("www.example.org")], False),
           ("ClientHello without a name", [client_hello(None)], False),
           ("STUN/TURN over TCP", [stun_], False), ("ICE-TCP framed binding request", [fb], False),
           ("ICE-TCP with the wrong cookie", [fb[:6] + b"\x00\x00\x00\x00" + fb[10:]], False),
           ("40 random bytes", [bytes(rnd.getrandbits(8) for _ in range(40))], False),
           ("one 0x16 byte, then EOF", [b"\x16"], True), ("7 bytes of http, then EOF", [b"GET / H"], True),
           ("nothing, then EOF", [], True), ("a TLS header claiming 64 KB, 50 bytes, EOF", [b"\x16\x03\x01\xff\xff" + b"\x01" * 50], True),
           ("half an ICE-TCP head, then EOF", [fb[:8]], True)]
    return cs


olds = {}
for rev in ("764de9e5", "fb189bee"):
    r = subprocess.run(["git", "-C", HERE, "show", f"{rev}:trunk/deploy/sni-443.py"], capture_output=True)
    if r.returncode == 0:
        olds[rev] = os.path.join(TMP, f"sni-443-{rev}.py")
        with open(olds[rev], "wb") as f:
            f.write(r.stdout)
check("replay: the old copies come from git (764de9e5 = the branch point, fb189bee = the VPS's pre-meter copy)",
      len(olds) == 2, sorted(olds))
vps_conf = os.environ.get("SNI443_VPS_CONF", os.path.expanduser("~/.cache/trunk-v1/vps-ro/sni-443.conf"))
confs = [("the kit's render", kit.stdout)]
if os.path.exists(vps_conf):
    with open(vps_conf) as f:
        confs.append(("the VPS copy", f.read()))
else:
    print(f"NOTE replay: no VPS copy at {vps_conf} (SNI443_VPS_CONF) — the kit's render only")
for label, text in confs:
    p = os.path.join(TMP, "replay-src.conf")
    with open(p, "w") as f:
        f.write(text)
    new_cfg = sni.load(p)
    same = True
    for rev, src in olds.items():
        sp = importlib.util.spec_from_file_location(f"old_{rev}", src)
        om = importlib.util.module_from_spec(sp)
        sp.loader.exec_module(om)
        same &= om.load(p) == {k: v for k, v in new_cfg.items() if k != "ice_owner"}
    check(f"replay [{label}]: it reads the same as in both old copies (and has no ice_owner)", same and new_cfg["ice_owner"] is None)
    routers = {"new": replay_router(os.path.join(HERE, "sni-443.py"), text)}
    routers.update({rev: replay_router(src, text) for rev, src in olds.items()})
    try:
        cases = replay_cases([pat for pat, _, _ in new_cfg["routes"] if not pat.startswith("*.")])
        diffs = 0
        for what, chunks, hc in cases:
            res = {}

            def run_one(k, what=what, chunks=chunks, hc=hc):
                _, p_, box = routers[k]
                res[k] = replay_one(p_, box, chunks, hc)
            ts = [threading.Thread(target=run_one, args=(k,)) for k in routers]
            for t_ in ts:
                t_.start()
            for t_ in ts:
                t_.join(10)
            if not all(res.get(k) == res.get("new") for k in routers):
                diffs += 1
                check(f"replay [{label}] {what}: the same backend and bytes in every copy", False,
                      {k: (v[0][:20], v[1] and (v[1][0], len(v[1][1]))) for k, v in res.items()})
        nb = {}
        for k_, (_, _, box) in routers.items():
            nb[k_] = sorted(t for t, _ in box)
        check(f"replay [{label}]: {len(cases)} first-bytes cases, each to the same backend with the same bytes in all "
              f"three copies ({', '.join(f'{t} {nb['new'].count(t)}' for t in sorted(set(nb['new'])))})",
              diffs == 0 and all(v == nb["new"] for v in nb.values()))
    finally:
        for pr, _, _ in routers.values():
            pr.terminate()
            pr.wait(5)

print("VERDICT:", "GREEN" if ok else "RED")
sys.exit(0 if ok else 1)
