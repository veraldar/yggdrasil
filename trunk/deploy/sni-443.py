#!/usr/bin/env python3
"""sni-443.py — one TCP port 443 for your website AND your yggdrasil trunk, shared by TLS name (SNI).

It reads the first bytes of every connection and forwards the connection, bytes untouched:
  * a TLS ClientHello naming a routed name  → that route's backend (with `proxy`: a PROXY v1 line
    first, so the backend learns the client's real address — the trunk's ap.toml proxy_protocol);
  * STUN / TURN over TCP (magic cookie 0x2112A442), when a `stun` backend is set → there;
  * ICE over TCP (RFC 6544: RFC 4571 frames — a 2-byte length, then a STUN message, its magic
    cookie at offset 6), when an `ice` backend is set → there (the access point's raw `ice`
    forward: a phone's WebRTC media to the box at home, DTLS/SRTP end to end — opaque here);
  * anything else (other names, no name, plain http, garbage)               → the `default` backend.
TLS is never terminated here: every backend keeps its own certificate and key.

    sni-443.py -c /etc/yggdrasil-trunk/sni-443.conf

Config, one directive per line (# starts a comment):
    listen  0.0.0.0:443                  repeatable; [::]:443 listens on IPv6 (and IPv4, dual-stack)
    route   trunk.example.org 127.0.0.1:4443 proxy
    route   *.apps.example.org 127.0.0.1:9443     any name below apps.example.org
    default 127.0.0.1:8443               required
    stun    127.0.0.1:3478               optional
    ice     127.0.0.1:4479               optional (ap.toml [[ap.tcp]] listen of the ICE forward)
    ice_owner http://10.99.0.2:8080/t/ice/owner 10.99.0.2:4479 200ms
                                         optional (v2, coexistence of two trunks, spec §5.7): see below
Names match without case and without a trailing dot. trunk/deploy/sni-443-test.py is its test.

v2 (trunk v1, spec §5.7 and §10 V3):
  * SIGHUP reloads the config (systemd: ExecReload). Connections already forwarded keep going,
    untouched; every connection accepted after the reload is routed by the new config. A config
    that does not read (any error below), or whose `listen` lines differ (only a restart opens or
    closes a socket), is refused: the config in force stays, one `sni-443: reload refused …` line
    says why. `sni-443.py -c CONFIG --check` reads a config and says so, without serving.
  * `ice_owner URL BACKEND [BUDGET]`: for ICE over TCP, the receiver ufrag of the first STUN
    binding request (USERNAME "<receiver>:<sender>", the parse of trunk/src/ap.rs
    stun_receiver_ufrag) is asked at `URL?u=<ufrag>` (plain http, one GET). 200 → BACKEND;
    404, any other answer, an error or no answer within BUDGET (default 200ms, 10ms–1000ms) →
    the `ice` line, exactly as without the ask. The whole first frame (≤ 2 KiB) is read before
    the ask and forwarded unchanged. Without an `ice_owner` line nothing is asked and nothing
    is read beyond what v1 read.
  * The parser is stricter: a second `default`/`stun`/`ice`/`ice_owner` line, a second route for
    one name, a second `listen` for one address, a port out of range, a name that is not a
    server name, `ice_owner` without `ice`: each is an error naming the file and the line.
  * Stats compat: the VPS ran the 11-19 copy, older than the meter (no SNI443_STATS: it sends
    nothing). This copy sends one datagram a minute to 127.0.0.1:4481 unless SNI443_STATS=off; a
    trunk-ap without that listener drops it (the send error is ignored). New counts, only when
    `ice_owner` is set: conns `ice_owner`, errors `ask.timeout` / `ask.error`; `reload` errors.

The meter (trunk observability): once a minute, connections and bytes per route and failures by
kind go to the journal as one `sni-443: minute {…}` line, and to the access point as one UDP
datagram on loopback (SNI443_STATS, default 127.0.0.1:4481): the ap folds it into the minute line
it sends home. Counts only — never a name or an address. SNI443_STATS=off: neither.
"""
import ipaddress
import json
import os
import re
import signal
import socket
import sys
import threading
import time
from urllib.parse import quote, urlsplit

MAGIC = b"\x21\x12\xa4\x42"
PEEK_SECS = 10
MAX_CONNS = 1024
MAX_ICE_FRAME = 2048  # the first ICE-TCP frame read whole for the ufrag ask (a binding request is < 600 B)
ASK_DEFAULT_MS, ASK_MIN_MS, ASK_MAX_MS = 200, 10, 1000
# a TLS server name (a leading "*." for a wildcard route), and an ICE ufrag (RFC 8839 ice-char)
NAME_RE = re.compile(r"^(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$")
UFRAG_RE = re.compile(r"^[A-Za-z0-9+/]{1,256}$")
STATS_TO = os.environ.get("SNI443_STATS", "127.0.0.1:4481")


class Stats:
    """This minute's counts: conns and bytes per route kind, failures by kind (never a name)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.conns, self.bytes, self.errors = {}, {}, {}

    def conn(self, route):
        with self.lock:
            self.conns[route] = self.conns.get(route, 0) + 1

    def add_bytes(self, route, n):
        with self.lock:
            self.bytes[route] = self.bytes.get(route, 0) + n

    def error(self, kind):
        with self.lock:
            self.errors[kind] = self.errors.get(kind, 0) + 1

    def take(self):
        with self.lock:
            out = {"conns": self.conns, "bytes": self.bytes, "errors": self.errors}
            self.reset()
        return out


STATS = Stats()


def stats_loop():
    if STATS_TO == "off":
        return
    try:
        to = parse_addr(STATS_TO)
    except ValueError:
        return
    udp = socket.socket(socket.AF_INET6 if ":" in to[0] else socket.AF_INET, socket.SOCK_DGRAM)
    while True:
        time.sleep(60 - time.time() % 60 + 0.2)
        m = STATS.take()
        m["ts"] = int(time.time() // 60 * 60 * 1000)
        line = json.dumps(m, separators=(",", ":"), sort_keys=True)
        if m["conns"] or m["errors"]:
            print(f"sni-443: minute {line}", file=sys.stderr, flush=True)
        try:
            udp.sendto(line.encode(), to)
        except OSError:
            pass


def parse_addr(text):
    """'127.0.0.1:443' / '[::]:443' / 'host:443' → (host, port)."""
    host, sep, port = text.strip().rpartition(":")
    if not sep or not port.isdigit() or not host:
        raise ValueError(f"not host:port: {text!r}")
    return host.strip("[]"), int(port)


def check_port(host, port, what, zero_ok=False):
    """A port in range and a host that is an address or a host name; ValueError otherwise."""
    if not (0 if zero_ok else 1) <= port <= 65535:
        raise ValueError(f"{what}: port {port} out of range")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not NAME_RE.match(host.lower()) or host.startswith("*"):
            raise ValueError(f"{what}: not an address or a host name: {host!r}") from None
    return host, port


def parse_ice_owner(args):
    """`ice_owner URL BACKEND [BUDGET]` → dict(url, host, port, path, backend, budget)."""
    if len(args) not in (2, 3):
        raise ValueError("ice_owner: URL BACKEND [BUDGET]")
    u = urlsplit(args[0])
    if u.scheme != "http" or not u.hostname or u.username or u.password or u.query or u.fragment or "@" in u.netloc:
        raise ValueError(f"ice_owner: not a plain http://host:port/path URL: {args[0]!r}")
    try:
        port = u.port or 80
    except ValueError:
        raise ValueError(f"ice_owner: bad port in {args[0]!r}") from None
    host, port = check_port(u.hostname, port, "ice_owner URL")
    budget = ASK_DEFAULT_MS
    if len(args) == 3:
        m = re.fullmatch(r"([0-9]{1,4})ms", args[2])
        if not m or not ASK_MIN_MS <= int(m.group(1)) <= ASK_MAX_MS:
            raise ValueError(f"ice_owner: budget {args[2]!r} is not {ASK_MIN_MS}ms…{ASK_MAX_MS}ms")
        budget = int(m.group(1))
    backend = check_port(*parse_addr(args[1]), "ice_owner backend")
    return {"url": args[0], "host": host, "port": port, "path": u.path or "/", "backend": backend,
            "budget": budget / 1000}


def load(path):
    """The config file → dict(listen=[addr], routes=[(name, addr, proxy)], default=addr, stun=addr|None,
    ice=addr|None, ice_owner=dict|None). Any line it cannot read is an error naming the file and line."""
    cfg = {"listen": [], "routes": [], "default": None, "stun": None, "ice": None, "ice_owner": None}
    seen = {}  # what a line set → the line that set it (a second one is an error)
    with open(path) as f:
        for n, raw in enumerate(f, 1):
            words = raw.split("#", 1)[0].split()
            if not words:
                continue
            try:
                key, args = words[0], words[1:]

                def once(what):
                    if what in seen:
                        raise ValueError(f"a second {what} (the first is at line {seen[what]})")
                    seen[what] = n
                if key == "listen" and len(args) == 1:
                    addr = check_port(*parse_addr(args[0]), "listen", zero_ok=True)
                    if addr[1]:
                        once(f"'listen {args[0]}'")
                    cfg["listen"].append(addr)
                elif key == "route" and len(args) in (2, 3) and (len(args) == 2 or args[2] == "proxy"):
                    name = args[0].lower().rstrip(".")
                    if len(name) > 253 or not NAME_RE.match(name):
                        raise ValueError(f"route: not a server name: {args[0]!r}")
                    once(f"route for {name}")
                    cfg["routes"].append((name, check_port(*parse_addr(args[1]), f"route {name}"), len(args) == 3))
                elif key in ("default", "stun", "ice") and len(args) == 1:
                    addr = parse_addr(args[0])
                    once(f"'{key}' line")
                    cfg[key] = check_port(*addr, key)
                elif key == "ice_owner":
                    once("'ice_owner' line")
                    cfg[key] = parse_ice_owner(args)
                else:
                    raise ValueError(f"cannot read: {raw.strip()!r}")
            except ValueError as e:
                raise ValueError(f"{path}:{n}: {e}") from None
    if not cfg["default"]:
        raise ValueError(f"{path}: no 'default BACKEND' line (where your website's https goes)")
    if cfg["ice_owner"] and not cfg["ice"]:
        line = seen["'ice_owner' line"]
        raise ValueError(f"{path}:{line}: ice_owner needs an 'ice' line (where an unknown ufrag goes)")
    if not cfg["listen"]:
        cfg["listen"].append(("0.0.0.0", 443))
    return cfg


def describe(cfg):
    """The lines a start (and a reload) prints: where each name goes."""
    out = [f"{pat} → {h}:{p}{' (PROXY v1)' if proxy else ''}" for pat, (h, p), proxy in cfg["routes"]]
    if cfg.get("ice_owner"):
        o = cfg["ice_owner"]
        out.append(f"ICE-TCP: ask {o['url']} (≤{int(o['budget'] * 1000)}ms) — 200 → {o['backend'][0]}:{o['backend'][1]}, "
                   f"else → {cfg['ice'][0]}:{cfg['ice'][1]}")
    out.append(f"everything else → {cfg['default'][0]}:{cfg['default'][1]}")
    return out


def route_kind(cfg, backend, proxy):
    """A route's kind for the counts: the proxied trunk name, another name, the website, STUN, ICE."""
    if backend == cfg["stun"]:
        return "stun"
    if backend == cfg["ice"]:
        return "ice"
    if backend == cfg["default"]:
        return "default"
    return "trunk" if proxy else "named"


def route_of(cfg, name):
    """(backend, proxy?) for a TLS server name (None = no name)."""
    if name:
        for pat, addr, proxy in cfg["routes"]:
            if name == pat or (pat.startswith("*.") and name.endswith(pat[1:]) and len(name) > len(pat) - 1):
                return addr, proxy
    return cfg["default"], False


def sni_of(rec):
    """The server name in a TLS record holding a ClientHello, or None."""
    try:
        if rec[0] != 0x16 or rec[5] != 0x01:
            return None
        p = 5 + 4 + 2 + 32  # record header, handshake header, version, random
        p += 1 + rec[p]  # session id
        p += 2 + int.from_bytes(rec[p:p + 2], "big")  # cipher suites
        p += 1 + rec[p]  # compression methods
        end = min(len(rec), p + 2 + int.from_bytes(rec[p:p + 2], "big"))
        p += 2
        while p + 4 <= end:
            kind, size = int.from_bytes(rec[p:p + 2], "big"), int.from_bytes(rec[p + 2:p + 4], "big")
            p += 4
            if kind == 0:  # server_name: list length, then (type, length, name)…
                q = p + 2
                while q + 3 <= min(end, p + size):
                    nt, nl = rec[q], int.from_bytes(rec[q + 1:q + 3], "big")
                    q += 3
                    if nt == 0:
                        return rec[q:q + nl].decode("ascii").lower().rstrip(".")
                    q += nl
                return None
            p += size
    except (IndexError, UnicodeDecodeError):
        pass
    return None


def framed_stun_head(peek):
    """The first 8 bytes look like an RFC 4571 frame holding a STUN message (ICE-TCP): frame length =
    STUN length + 20, a 4-aligned STUN length, a STUN message type (top two bits 0), and the first
    half of the magic cookie at offset 6 (the caller reads 2 more bytes for the second half)."""
    if len(peek) < 8 or peek[2] & 0xC0 or peek[6:8] != MAGIC[:2]:
        return False
    frame, size = int.from_bytes(peek[0:2], "big"), int.from_bytes(peek[4:6], "big")
    return frame == size + 20 and size % 4 == 0


def recv_exact(sock, have, want):
    while len(have) < want:
        d = sock.recv(want - len(have))
        if not d:
            break
        have += d
    return have


def stun_receiver_ufrag(msg):
    """The receiver's ufrag in an ICE binding request: USERNAME = "<receiver>:<sender>" (the same
    parse as trunk/src/ap.rs stun_receiver_ufrag). None when it is not there."""
    if len(msg) < 20 or msg[4:8] != MAGIC:
        return None
    end = min(20 + int.from_bytes(msg[2:4], "big"), len(msg))
    p = 20
    while p + 4 <= end:
        t, size = int.from_bytes(msg[p:p + 2], "big"), int.from_bytes(msg[p + 2:p + 4], "big")
        v = msg[p + 4:p + 4 + size]
        if len(v) < size:
            return None
        if t == 0x0006:
            try:
                return v.decode("utf-8").split(":", 1)[0]
            except UnicodeDecodeError:
                return None
        p += 4 + (size + 3) // 4 * 4
    return None


def ask_owner(owner, ufrag):
    """GET <url>?u=<ufrag> within the budget → "owned" (200) | "unknown" (404) | "timeout" | "error"."""
    deadline = time.monotonic() + owner["budget"]
    head = (f"GET {owner['path']}?u={quote(ufrag, safe='')} HTTP/1.1\r\nHost: {owner['host']}:{owner['port']}\r\n"
            "User-Agent: sni-443\r\nConnection: close\r\n\r\n").encode()
    buf = b""
    try:
        s = socket.create_connection((owner["host"], owner["port"]), timeout=owner["budget"])
        try:
            s.settimeout(max(0.001, deadline - time.monotonic()))
            s.sendall(head)
            while b"\r\n" not in buf and len(buf) < 512:
                left = deadline - time.monotonic()
                if left <= 0:
                    return "timeout"
                s.settimeout(left)
                d = s.recv(512)
                if not d:
                    break
                buf += d
        finally:
            s.close()
    except socket.timeout:
        return "timeout"
    except OSError:
        return "error"
    status = buf.split(b"\r\n", 1)[0].split()
    if len(status) < 2 or not status[0].startswith(b"HTTP/1."):
        return "error"
    return {b"200": "owned", b"404": "unknown"}.get(status[1], "error")


def ice_owner_of(owner, client, peek):
    """The ufrag ask for one ICE-TCP connection: the first frame read whole (it is forwarded
    unchanged either way) → (bytes read, owned?)."""
    want = 2 + int.from_bytes(peek[0:2], "big")
    if want > MAX_ICE_FRAME:
        return peek, False
    peek = recv_exact(client, peek, want)
    ufrag = stun_receiver_ufrag(peek[2:want]) if len(peek) == want else None
    if not ufrag or not UFRAG_RE.match(ufrag):
        return peek, False
    r = ask_owner(owner, ufrag)
    if r in ("timeout", "error"):
        STATS.error(f"ask.{r}")
    return peek, r == "owned"


def proxy_line(client):
    """PROXY v1 for this connection: the client's address as this router saw it."""
    (src, sport), (dst, dport) = client.getpeername()[:2], client.getsockname()[:2]
    a, b = ipaddress.ip_address(src), ipaddress.ip_address(dst)
    if a.version == 6 and a.ipv4_mapped:
        a = a.ipv4_mapped
    if b.version == 6 and b.ipv4_mapped:
        b = b.ipv4_mapped
    if a.version != b.version:  # cannot happen on one socket; never send a half-truth
        return b"PROXY UNKNOWN\r\n"
    return f"PROXY TCP{a.version} {a} {b} {sport} {dport}\r\n".encode()


def pipe(a, b, route=None):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
            if route:
                STATS.add_bytes(route, len(d))
    except OSError:
        pass
    for s in (a, b):
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        s.close()


def handle(cfg, client):
    """One connection: peek, pick the backend, forward both ways until either side closes."""
    client.settimeout(PEEK_SECS)
    route, stage = None, "peek"
    try:
        peek = recv_exact(client, b"", 8)
        if not peek:
            STATS.error("empty")
            client.close()
            return
        prefix = b""
        proxy = owned = False
        if cfg["ice"] and framed_stun_head(peek):
            peek = recv_exact(client, peek, 10)
        if len(peek) >= 8 and peek[4:8] == MAGIC and cfg["stun"]:
            backend = cfg["stun"]
        elif cfg["ice"] and len(peek) >= 10 and framed_stun_head(peek) and peek[6:10] == MAGIC:
            backend = cfg["ice"]
            if cfg.get("ice_owner"):  # v2: two trunks share :443's ICE-TCP — ask who owns the ufrag
                peek, owned = ice_owner_of(cfg["ice_owner"], client, peek)
                if owned:
                    backend = cfg["ice_owner"]["backend"]
        elif peek[0] == 0x16 and len(peek) >= 5:
            peek = recv_exact(client, peek, 5 + min(int.from_bytes(peek[3:5], "big"), 16384))
            backend, proxy = route_of(cfg, sni_of(peek))
            if proxy:
                prefix = proxy_line(client)
        else:
            backend = cfg["default"]
        route, stage = ("ice_owner" if owned else route_kind(cfg, backend, proxy)), "upstream"
        STATS.conn(route)
        upstream = socket.create_connection(backend, timeout=5)
    except OSError:
        STATS.error(f"{stage}" + (f".{route}" if route else ""))
        try:
            client.close()
        except OSError:
            pass
        return
    # no timeout from here on: a websocket may sit idle for minutes (a 5 s connect timeout left on
    # the upstream socket once cut every idle trunk link)
    client.settimeout(None)
    upstream.settimeout(None)
    try:
        upstream.sendall(prefix + peek)
    except OSError:
        upstream.close()
        client.close()
        return
    threading.Thread(target=pipe, args=(client, upstream, route), daemon=True).start()
    pipe(upstream, client, route)


class Router:
    """The config in force. reload() swaps it whole, never edits it in place: a connection is routed
    by the config it was accepted under, and a connection already forwarded never looks at it again."""

    def __init__(self, cfg, path=None):
        self.cfg, self.path = cfg, path
        self.lock = threading.Lock()

    def reload(self):
        """Read the config file again → True when the new one is in force (else the old one stays)."""
        with self.lock:
            try:
                new = load(self.path)
            except (OSError, ValueError) as e:
                STATS.error("reload")
                print(f"sni-443: reload refused: {e} — the config in force stays", file=sys.stderr, flush=True)
                return False
            if new["listen"] != self.cfg["listen"]:
                STATS.error("reload")
                print("sni-443: reload refused: the listen lines changed (only a restart opens or closes a socket)"
                      " — the config in force stays", file=sys.stderr, flush=True)
                return False
            self.cfg = new
            for line in describe(new):
                print(f"sni-443: {line}", file=sys.stderr, flush=True)
            print(f"sni-443: reloaded {self.path}", file=sys.stderr, flush=True)
            return True


def serve(cfg, ready=None, router=None):
    router = router or Router(cfg)
    slots = threading.BoundedSemaphore(MAX_CONNS)
    socks = []
    for host, port in cfg["listen"]:
        fam = socket.AF_INET6 if ":" in host else socket.AF_INET
        s = socket.socket(fam, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if fam == socket.AF_INET6:
            s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        s.bind((host, port))
        s.listen(128)
        socks.append(s)
        print(f"sni-443: listening on {s.getsockname()[0]}:{s.getsockname()[1]}", file=sys.stderr, flush=True)
    for line in describe(cfg):
        print(f"sni-443: {line}", file=sys.stderr, flush=True)
    if ready:
        ready([s.getsockname()[1] for s in socks])

    def accept(s):
        while True:
            try:
                c, _ = s.accept()
            except OSError:
                continue
            if not slots.acquire(blocking=False):
                STATS.error("slots")
                c.close()
                continue

            def run(c=c, cfg=router.cfg):
                try:
                    handle(cfg, c)
                finally:
                    slots.release()
            threading.Thread(target=run, daemon=True).start()

    threading.Thread(target=stats_loop, daemon=True).start()
    for s in socks[1:]:
        threading.Thread(target=accept, args=(s,), daemon=True).start()
    accept(socks[0])


def main(argv):
    check = "--check" in argv
    argv = [a for a in argv if a != "--check"]
    if len(argv) != 2 or argv[0] != "-c":
        print(__doc__.split("\n\n")[0] + "\nusage: sni-443.py -c CONFIG [--check]", file=sys.stderr)
        return 64
    # SIGHUP = reload (systemd ExecReload). Its default action would end the process: the handler is
    # set before anything else, and only wakes the reloader (no work inside a signal handler)
    want = threading.Event()
    if not check:
        signal.signal(signal.SIGHUP, lambda *_: want.set())
    try:
        cfg = load(argv[1])
    except (OSError, ValueError) as e:
        print(f"sni-443: {e}", file=sys.stderr)
        return 1
    if check:
        print(f"sni-443: {argv[1]} reads: " + " · ".join(describe(cfg)), file=sys.stderr)
        return 0
    router = Router(cfg, argv[1])

    def reloader():
        while True:
            want.wait()
            want.clear()
            router.reload()
    threading.Thread(target=reloader, daemon=True).start()
    serve(cfg, router=router)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
