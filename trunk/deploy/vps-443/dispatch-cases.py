"""dispatch-cases.py — today's VPS :443 dispatcher test, case for case, with the names as parameters
(AP_NAME, SITE_NAME in the environment; superset-test.py runs it). It loads `turn-dispatcher.py` from
its own directory — superset-test.py puts a shim there that is sni-443.py with the new sni-443.conf —
and checks every route of today's dispatcher + byte-exact passthrough; then the one new route: ICE
over TCP → the ap's raw forward, byte-exact both ways, and TURN still going to coturn beside it."""
import importlib.util, os, socket, ssl, subprocess, sys, threading, time
S = os.path.dirname(os.path.abspath(__file__))
AP_NAME, SITE = os.environ["AP_NAME"], os.environ["SITE_NAME"]
spec = importlib.util.spec_from_file_location("d", os.path.join(S, "turn-dispatcher.py"))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
got = {}


def listener():
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", 0))
    s.listen(16)
    return s


def fake(name, s):  # records the first bytes, answers "<name>"
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


def tls_ap(s):  # PROXY line, then a real TLS server echoing
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.path.join(S, "dt.crt"), os.path.join(S, "dt.key"))
    while True:
        c, _ = s.accept()
        c.settimeout(5)
        line = b""
        while not line.endswith(b"\r\n"):
            line += c.recv(1)
        got.setdefault("ap-proxy", []).append(line.decode())
        try:
            t = ctx.wrap_socket(c, server_side=True)
            data = t.recv(1000)
            t.sendall(b"AP:" + data)
            t.close()
        except Exception as e:
            got.setdefault("ap-err", []).append(repr(e))


def ice_fwd(s):  # the ap's raw forward: echoes every byte back, records what came
    while True:
        c, _ = s.accept()

        def run(c=c):
            c.settimeout(5)
            buf = b""
            try:
                while True:
                    b = c.recv(65536)
                    if not b:
                        break
                    buf += b
                    c.sendall(b)
            except OSError:
                pass
            got.setdefault("ice", []).append(buf)
            c.close()
        threading.Thread(target=run, daemon=True).start()


caddy, coturn, ap, ice = listener(), listener(), listener(), listener()
for f, s in ((lambda s: fake("caddy", s), caddy), (lambda s: fake("coturn", s), coturn), (tls_ap, ap), (ice_fwd, ice)):
    threading.Thread(target=f, args=(s,), daemon=True).start()
d.CADDY, d.COTURN, d.AP, d.ICE = caddy.getsockname(), coturn.getsockname(), ap.getsockname(), ice.getsockname()
front = listener()
port = front.getsockname()[1]


def serve():
    while True:
        c, _ = front.accept()
        threading.Thread(target=d.handle, args=(c,), daemon=True).start()


threading.Thread(target=serve, daemon=True).start()
ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


def tls(sni):
    ctx = ssl.create_default_context(cafile=os.path.join(S, "dt.crt"))
    ctx.check_hostname = bool(sni)
    if not sni:
        ctx.verify_mode = ssl.CERT_NONE
    c = socket.create_connection(("127.0.0.1", port))
    try:
        t = ctx.wrap_socket(c, server_hostname=sni)
        t.sendall(b"hello-trunk")
        r = t.recv(100)
        t.close()
        return r
    except Exception as e:
        return repr(e)


# ---- today's cases (turn-dispatcher.py's dispatch_test.py, in order) ----
# 1. the access point: full TLS through, PROXY line first with the real client address
r = tls(AP_NAME)
check(f"{AP_NAME} → access point, TLS handshake end to end, bytes exact", r == b"AP:hello-trunk", r)
pl = got.get("ap-proxy", [""])[-1]
check("PROXY v1 line names the client", pl.startswith("PROXY TCP4 127.0.0.1 127.0.0.1 ") and pl.endswith(f" {port}\r\n"), pl.strip())
# 2. the website and everything else keep going to caddy, byte-exact ClientHello, no PROXY line
n = len(got.get("caddy", []))
tls(SITE)
time.sleep(0.2)
first = got["caddy"][-1] if len(got.get("caddy", [])) > n else b""
check(f"{SITE} → caddy, unchanged (starts with the ClientHello, no PROXY)", first[:1] == b"\x16" and d.sni_of(first) == SITE)
n = len(got.get("caddy", []))
tls(None)
time.sleep(0.2)
check("TLS without a name (IP) → caddy", len(got.get("caddy", [])) == n + 1)
c = socket.create_connection(("127.0.0.1", port))
c.sendall(f"GET / HTTP/1.1\r\nHost: {SITE}\r\n\r\n".encode())
r = c.recv(100)
c.close()
check("plain http → caddy", r == b"caddy")
stun = (0x0001).to_bytes(2, "big") + (0).to_bytes(2, "big") + b"\x21\x12\xa4\x42" + os.urandom(12)
c = socket.create_connection(("127.0.0.1", port))
c.sendall(stun)
r = c.recv(100)
c.close()
check("STUN/TURN → coturn", r == b"coturn")
# 3. real openssl client (OpenSSL 3.x: big post-quantum ClientHello), name in another case + trailing dot
odd = ".".join(w[:1].upper() + w[1:] for w in AP_NAME.split(".")).replace(AP_NAME[:2], AP_NAME[:2].upper(), 1) + "."
n = len(got.get("ap-proxy", []))
p = subprocess.run(["openssl", "s_client", "-connect", f"127.0.0.1:{port}", "-servername", odd], input=b"", capture_output=True, timeout=10)
time.sleep(0.2)
check(f"openssl s_client, '{odd}' → access point", len(got.get("ap-proxy", [])) == n + 1)
# 4. garbage and a slow / truncated hello never crash the dispatcher
for junk in (b"\x16\x03\x01\x00\x05\x01\x00", b"\x16\x03\x01\xff\xff" + b"\x01" * 50, os.urandom(40)):
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
    d.sni_of(sample)
got.pop("ap-err", None)  # s_client hangs up after the handshake: the fake ap's reply hits a closed pipe (expected)
check("garbage and truncated hellos: no crash, still serving", tls(AP_NAME) == b"AP:hello-trunk")
check("no handshake errors at the access point after that", not got.get("ap-err"), got.get("ap-err"))

# ---- the new route: ICE over TCP (RFC 6544) → the ap's raw livekit-ice forward ----
body = (0).to_bytes(2, "big") + b"\x21\x12\xa4\x42" + os.urandom(12)        # a STUN binding, framed (RFC 4571)
framed = (len(body) + 2).to_bytes(2, "big") + (0x0001).to_bytes(2, "big") + body
dtls = b"\x00\x30" + b"\x16\xfe\xfd" + os.urandom(45)                        # then a framed DTLS record
c = socket.create_connection(("127.0.0.1", port))
c.sendall(framed)
echo = b""
c.settimeout(3)
while len(echo) < len(framed):
    echo += c.recv(65536)
c.sendall(dtls)
while len(echo) < len(framed) + len(dtls):
    echo += c.recv(65536)
c.close()
time.sleep(0.2)
check("ICE over TCP (framed STUN) → the ap's livekit-ice forward, then DTLS, byte-exact both ways",
      echo == framed + dtls and got.get("ice", [b""])[-1] == framed + dtls)
c = socket.create_connection(("127.0.0.1", port))
c.sendall(stun)
r = c.recv(100)
c.close()
check("TURN over TCP still → coturn beside it (cookie at byte 4, not framed)", r == b"coturn")
n = len(got.get("caddy", []))
c = socket.create_connection(("127.0.0.1", port))
c.sendall(b"\x00\x14\x00\x01\x00\x00\xde\xad" + os.urandom(12))              # framed, but no STUN cookie
c.settimeout(3)
try:
    c.recv(10)
except OSError:
    pass
c.close()
time.sleep(0.2)
check("a framed look-alike without the STUN cookie → caddy, not the ap", len(got.get("caddy", [])) == n + 1)
check(f"{AP_NAME} still → access point after all that", tls(AP_NAME) == b"AP:hello-trunk")
print("VERDICT:", "GREEN" if ok else "RED")
sys.exit(0 if ok else 1)
