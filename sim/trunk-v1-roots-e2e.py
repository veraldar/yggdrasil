#!/usr/bin/env python3
"""trunk-v1-roots-e2e.py — G3.4 on trunk v1: real brains (yggdrasil) peering THROUGH a v1 trunk.
The relay moved from the hub's bridge to the trunk; the tap still sees only ciphertext.
Deterministic on root/mock/mock_upstream.py. Never touches a live service (ports 18900–18999).

    v1 trunk (bifrost-net trunk, plain http on loopback, TRUNK_TEST_FAST=1)
      ▲  WS /t/root (proto 2: root-key auth, mux, CTRL, WG frames)   ◀── TAP (every byte, both ways)
      │
    home (has_app)            mac (light)               lab (light)
    bridge [trunk] ⇄ wg node   bridge [trunk] ⇄ wg node   bridge [trunk] ⇄ wg node
    brain  YGG_PEERS_FROM=<its node>/_wg/_roots, YGG_PEER_TOKEN=<its OWN token>

Walks:
  * enrollment through the trunk's API: the installer starts (POST /t/roots/enroll), an admin
    device approves (fresh, same origin), the poll hands over the result once (root id, address,
    trunk key, the root's own peer token, the signed directory) — three roots
  * each bridge dials OUT to /t/root and links; trunk-state.json is written (0600, link up, the
    signed directory); each wg node takes its peers from it; each brain learns the others
  * brain ↔ brain inside WireGuard: home → mac, mac → home, mac ↔ lab; per-root peer tokens (P6/X9):
    the sender's own token passes, none or another root's token is refused (401)
  * MAIN on home runs `session_start … root=<mac>` → runs on mac → the report comes home (inbox,
    /tree done); MAIN on mac runs one on lab → back to mac
  * a device's request goes to its door root (home): the trunk's C3 check, then the root's own
  * the TAP: WG frames are WireGuard-shaped, and no brain-call text, no peer token, no brief or
    report crossed any root's link readable
  * revoking lab (DELETE /t/roots/:id): its link is cut and refused, its state says revoked, mac's
    node drops it within 1.5 s (P13), mac → lab refused
  * a bench: latency of GET /root and 1 MB each way, home → mac

    trunk-v1-roots-e2e.py [--bin-root PATH] [--bin-trunk PATH] [--keep]
"""
import argparse, json, os, shutil, socket, statistics, struct, subprocess, sys, threading, time
import urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.realpath(os.path.join(HERE, ".."))
YGG = os.path.join(REPO, "root")
TRUNK = os.path.join(REPO, "trunk")
FAILS = []
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
BASE = 18900  # CONTRACTS.md C7: WIRE's ports 18900–18999

P = {  # every port this rig uses (all checked free first: rigs on the same ports collide silently)
    "trunk": BASE + 1, "ice": BASE + 2, "mock": BASE + 3, "tap": BASE + 4, "app": BASE + 5,
    "brain": {"home": BASE + 10, "mac": BASE + 11, "lab": BASE + 12},
    "bridge": {"home": BASE + 20, "mac": BASE + 21, "lab": BASE + 22},
    "media": {"home": BASE + 25, "mac": BASE + 26, "lab": BASE + 27},  # udp
    "wg_http": {"home": BASE + 30, "mac": BASE + 31, "lab": BASE + 32},
    "wg_udp": {"home": BASE + 35, "mac": BASE + 36, "lab": BASE + 37},  # udp
    "relay": {"home": BASE + 40, "mac": BASE + 41, "lab": BASE + 42},  # udp
}
UDP = ("media", "wg_udp", "relay")


def ports_free():
    busy = []
    for k, v in P.items():
        for p in (v.values() if isinstance(v, dict) else [v]):
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM if k in UDP else socket.SOCK_STREAM) as s:
                if k not in UDP:  # a listener in TIME_WAIT is free for the processes (they set SO_REUSEADDR too)
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    s.bind(("127.0.0.1", p))
                except OSError:
                    busy.append(p)
    return busy


def call(port, method, path, body=None, headers=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json", **(headers or {})}
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers=h)
    try:
        with OPENER.open(r, timeout=timeout) as resp:
            raw, st = resp.read(), resp.status
    except urllib.error.HTTPError as e:
        raw, st = e.read(), e.code
    except (urllib.error.URLError, OSError) as e:
        return 0, str(e)
    try:
        return st, json.loads(raw) if raw else None
    except ValueError:
        return st, raw.decode(errors="replace")


def req(port, method, path, body=None, headers=None, timeout=30):
    st, v = call(port, method, path, body, headers, timeout)
    if st >= 300 or st == 0:
        raise RuntimeError(f"{method} {path}: {st} {str(v)[:300]}")
    return v


def check(name, ok, detail=""):
    print(f"{'ok  ' if ok else 'FAIL'} {name}{'' if ok else ' — ' + str(detail)[:500]}", flush=True)
    if not ok:
        FAILS.append(name)
    return ok


def wait(pred, timeout=30, step=0.2):
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


def tool(calls):
    """A one-step tool script for the mock: [[name, args], ...] (tree-e2e.py's helper)."""
    return "tool:" + json.dumps([calls])


def wg_kind(d):
    if len(d) < 4 or d[1:4] != b"\0\0\0":
        return None
    return {1: "init" if len(d) == 148 else None, 2: "response" if len(d) == 92 else None,
            3: "cookie" if len(d) == 64 else None, 4: "data" if len(d) >= 32 else None}.get(d[0])


class Tap:
    """A TCP tap between the roots' bridges and the trunk: forwards byte for byte, and parses the
    websocket frames both ways (root → trunk masked, trunk → root not), unmasked, per connection.
    A connection's root is the `root_id` of its proto-2 `auth`."""

    def __init__(self, listen, upstream):
        self.up = upstream
        self.lock = threading.Lock()
        self.frames = []   # (conn, dir, mux kind, payload)   dir: "up" = root → trunk
        self.roots = {}
        self.conns = 0
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", listen))
        self.srv.listen(16)
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            try:
                u = socket.create_connection(("127.0.0.1", self.up))
            except OSError:
                c.close()
                continue
            for s in (c, u):  # small WireGuard frames must not wait for a delayed ACK (FINDINGS: Nagle)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            with self.lock:
                self.conns += 1
                n = self.conns
            threading.Thread(target=self._pump, args=(n, c, u, "up"), daemon=True).start()
            threading.Thread(target=self._pump, args=(n, u, c, "down"), daemon=True).start()

    def _pump(self, conn, src, dst, d):
        buf, head_done = b"", False
        while True:
            try:
                b = src.recv(65536)
            except OSError:
                b = b""
            if not b:
                for s in (src, dst):
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                return
            try:
                dst.sendall(b)
            except OSError:
                return
            buf += b
            if not head_done:
                i = buf.find(b"\r\n\r\n")
                if i < 0:
                    continue
                buf, head_done = buf[i + 4:], True
            while True:
                f = self._frame(buf)
                if f is None:
                    break
                op, payload, used = f
                buf = buf[used:]
                if op == 2 and len(payload) >= 5:
                    kind = payload[0]
                    body = payload[5:]
                    if kind == 16 and d == "up":
                        try:
                            m = json.loads(body)
                            if m.get("t") == "auth":
                                with self.lock:
                                    self.roots[conn] = m.get("root_id")
                        except ValueError:
                            pass
                    with self.lock:
                        self.frames.append((conn, d, kind, body))

    @staticmethod
    def _frame(b):
        if len(b) < 2:
            return None
        op, masked, n, i = b[0] & 0x0F, b[1] & 0x80, b[1] & 0x7F, 2
        if n == 126:
            if len(b) < 4:
                return None
            n, i = struct.unpack(">H", b[2:4])[0], 4
        elif n == 127:
            if len(b) < 10:
                return None
            n, i = struct.unpack(">Q", b[2:10])[0], 10
        key = b""
        if masked:
            if len(b) < i + 4:
                return None
            key, i = b[i:i + 4], i + 4
        if len(b) < i + n:
            return None
        p = b[i:i + n]
        if masked:
            p = bytes(x ^ key[j % 4] for j, x in enumerate(p))
        return op, p, i + n

    def of(self, root_id):
        with self.lock:
            return [(c, d, k, p) for c, d, k, p in self.frames if self.roots.get(c) == root_id]


def bench(port, prefix, headers, n=30):
    lat = []
    for _ in range(n):
        t = time.perf_counter()
        st, _ = call(port, "GET", f"{prefix}/root", headers=headers)
        lat.append((time.perf_counter() - t) * 1000)
        if st != 200:
            return None
    lat.sort()
    blob = "x" * (1 << 20)
    t = time.perf_counter()
    st, _ = call(port, "PUT", f"{prefix}/shared-prompt", {"prompt": blob}, headers, timeout=120)
    up = (1 / (time.perf_counter() - t)) if st == 200 else 0
    t = time.perf_counter()
    st2, v2 = call(port, "GET", f"{prefix}/shared-prompt", headers=headers, timeout=120)
    down = (1 / (time.perf_counter() - t)) if st2 == 200 and isinstance(v2, dict) and len(v2.get("prompt", "")) == len(blob) else 0
    call(port, "PUT", f"{prefix}/shared-prompt", {"prompt": ""}, headers)
    return statistics.median(lat), lat[int(len(lat) * 0.9) - 1], up, down


def fake_app():
    """home's app (what the door serves): names itself and what the bridge stamped."""
    import http.server

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({"app": "home", "path": self.path, "xff": self.headers.get("x-forwarded-for"),
                               "cookie": self.headers.get("cookie") is not None}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    s = http.server.ThreadingHTTPServer(("127.0.0.1", P["app"]), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin-root", default=os.path.join(YGG, "target", "release", "yggdrasil"))
    ap.add_argument("--bin-trunk", default=os.path.join(TRUNK, "target", "release", "bifrost-net"))
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    for b in (a.bin_root, a.bin_trunk):
        if not os.path.exists(b):
            sys.exit(f"missing {b} — cargo build --release first")
    busy = ports_free()
    if busy:
        sys.exit(f"ports in use (another rig?): {busy}")
    scratch = os.environ.get("TMPDIR") or os.path.expanduser("~/.cache/trunk-v1/tmp/wire")
    os.makedirs(scratch, exist_ok=True)
    tmp = os.path.join(scratch, f"trunk-v1-roots-{os.getpid()}")
    os.makedirs(tmp)
    procs, logs = {}, {}

    def spawn(name, cmd, env=None):
        logs[name] = os.path.join(tmp, f"{name}.log")
        procs[name] = subprocess.Popen(cmd, stdout=open(logs[name], "w"), stderr=subprocess.STDOUT,
                                       env={**os.environ, **(env or {})}, cwd=tmp)

    def log(name):
        return open(logs[name]).read() if name in logs and os.path.exists(logs[name]) else ""

    def kv(out):
        return {l.split(" = ")[0]: l.split('"')[1] for l in out.splitlines() if " = " in l and '"' in l}

    def bn(*args, env=None):
        r = subprocess.run([a.bin_trunk, *args], capture_output=True, text=True, env={**os.environ, **(env or {})})
        if r.returncode != 0:
            raise RuntimeError(f"bifrost-net {args[0]}: {r.stderr.strip()}")
        return r.stdout

    trunk_url = f"http://127.0.0.1:{P['trunk']}"
    fast = {"TRUNK_TEST_FAST": "1"}
    try:
        # ---- the model and the trunk ----
        spawn("mock", [sys.executable, os.path.join(YGG, "mock", "mock_upstream.py"), str(P["mock"])])
        td = os.path.join(tmp, "trunk")
        os.makedirs(os.path.join(td, "cred"))
        bn("trunk-kek", os.path.join(td, "cred", "trunk-kek"))
        cfg = os.path.join(td, "trunk.toml")
        with open(cfg, "w") as f:
            f.write(f'public_url = "{trunk_url}"\nlisten_http = "127.0.0.1:{P["trunk"]}"\nlisten_ice = "127.0.0.1:{P["ice"]}"\n'
                    f'db = "{td}/trunk.db"\nstate_dir = "{td}"\ncred_dir = "{td}/cred"\nctl_socket = "{td}/ctl.sock"\n'
                    f'rp_id = "127.0.0.1"\norigins = ["{trunk_url}"]\nice_owner_from = ["127.0.0.1/32"]\n')
        spawn("trunk", [a.bin_trunk, "trunk", "-c", cfg], fast)
        check("the v1 trunk is up (/t/state)", wait(lambda: call(P["trunk"], "GET", "/t/state")[0] == 200, 15), log("trunk")[-400:])
        print(bn("trunk-rig", "seed-admin", "-c", cfg, "--device", "dev_rig_admin", env=fast).strip())
        admin_tok = bn("trunk-rig", "mint", "-c", cfg, "--device", "dev_rig_admin", env=fast).strip()
        admin = {"cookie": f"bifrost_device={admin_tok}", "origin": trunk_url}
        check("signed in (an admin device that just stepped up): GET /t/me/roots → []", call(P["trunk"], "GET", "/t/me/roots", headers=admin) == (200, []))
        fake_app()
        tap = Tap(P["tap"], P["trunk"])

        # ---- three roots enroll through the API; each gets its own result once ----
        roots = {}
        for name, has_app in (("home", True), ("mac", False), ("lab", False)):
            d = os.path.join(tmp, name)
            os.makedirs(os.path.join(d, "work"))
            rk = kv(bn("root-key", os.path.join(d, "root.key")))
            wk = kv(bn("wg-key", os.path.join(d, "wg.key")))
            st, start = call(P["trunk"], "POST", "/t/roots/enroll", {"hostname": f"{name}-box", "os": "linux", "arch": "x86_64",
                                                                     "root_pub": rk["public_key"], "wg_pub": wk["public_key"],
                                                                     "has_app": has_app, "has_voice": False})
            if not check(f"{name}: the installer's enrollment started (code {start.get('code') if isinstance(start, dict) else '?'})", st == 200, (st, start)):
                raise RuntimeError("enroll")
            st, ok = call(P["trunk"], "POST", f"/t/roots/enroll/{start['id']}/approve", {"name": name}, admin)
            check(f"{name}: approved on the desktop card (admin, fresh, same origin)", st == 200, (st, ok))
            st, res = call(P["trunk"], "POST", f"/t/roots/enroll/{start['id']}/poll", {"secret": start["poll_secret"]})
            check(f"{name}: the poll hands over the result (root id, address, trunk key, own peer token)",
                  st == 200 and res.get("status") == "approved" and res.get("peer_token", "").startswith("ygp-"), (st, res))
            st2, again = call(P["trunk"], "POST", f"/t/roots/enroll/{start['id']}/poll", {"secret": start["poll_secret"]})
            check(f"{name}: …once (a second poll → 410 delivered)", st2 == 410, (st2, again))
            roots[name] = {"dir": d, "id": res["root_id"], "addr": res["wg_addr"], "trunk_key": res["trunk"]["trunk_key"],
                           "token": res["peer_token"], "wg_pub": wk["public_key"], "has_app": has_app}
        ids = {n: r["id"] for n, r in roots.items()}
        name_of = {r["id"]: n for n, r in roots.items()}

        # ---- each root: brain, wg node (peers from the signed directory), bridge [trunk] ----
        base = {"YGG_UPSTREAM_BASE_URL": f"http://127.0.0.1:{P['mock']}", "YGG_UPSTREAM_STYLE": "anthropic",
                "YGG_UPSTREAM_API_KEY": "mock", "YGG_UPSTREAM_MODEL": "mock", "YGG_WAKE_DEBOUNCE_MS": "400",
                "YGG_PROVIDERS": os.path.join(tmp, "no-providers.json"), "YGG_ARTIFACTS_DIR": os.path.join(tmp, "artifacts")}
        for name, r in roots.items():
            d = r["dir"]
            wg_http = P["wg_http"][name]
            spawn(name, [a.bin_root], dict(base, YGG_LISTEN=f"127.0.0.1:{P['brain'][name]}", YGG_DATA_DIR=os.path.join(d, "data"),
                                           YGG_PROFILES=os.path.join(d, "agents.json"), YGG_PROJECT_DIR=os.path.join(d, "work"),
                                           YGG_ROOT_NAME=r["id"], YGG_PEER_TOKEN=r["token"],
                                           YGG_PEERS_FROM=f"http://127.0.0.1:{wg_http}/_wg/_roots",
                                           YGG_PEERS_VIA=f"http://127.0.0.1:{wg_http}/_wg/{{id}}"))
            with open(os.path.join(d, "wg.toml"), "w") as f:
                f.write(f'[wg]\nkey_file = "{d}/wg.key"\nudp = "127.0.0.1:{P["wg_udp"][name]}"\nrelay = "127.0.0.1:{P["relay"][name]}"\n'
                        f'http = "127.0.0.1:{wg_http}"\nbrain = "http://127.0.0.1:{P["brain"][name]}"\n'
                        f'trunk_state = "{d}/trunk-state.json"\ntrunk_key = "{r["trunk_key"]}"\n')
            spawn(f"wg-{name}", [a.bin_trunk, "wg", "-c", os.path.join(d, "wg.toml")])
            priv = kv(bn("keygen"))["private_key"]
            with open(os.path.join(d, "bridge.toml"), "w") as f:
                f.write(f'[node]\nname = "{name}"\nprivate_key = "{priv}"\n\n'
                        f'[bridge]\nhttp = "127.0.0.1:{P["bridge"][name]}"\nmedia = "127.0.0.1:{P["media"][name]}"\n'
                        f'tokens_file = "{d}/devices.json"\nopencode_url = "http://127.0.0.1:{P["brain"][name]}"\n\n'
                        f'[trunk]\nurl = "http://127.0.0.1:{P["tap"]}"\ntrunk_key = "{r["trunk_key"]}"\nroot_key_file = "{d}/root.key"\n'
                        f'root_id = "{r["id"]}"\nstate_file = "{d}/trunk-state.json"\nupstream = "127.0.0.1:{P["app"] if r["has_app"] else P["brain"][name]}"\n'
                        f'ice_tcp = []\nwg_relay = "127.0.0.1:{P["relay"][name]}"\nwg_local = "127.0.0.1:{P["wg_udp"][name]}"\n')
            spawn(f"bridge-{name}", [a.bin_trunk, "bridge", "-c", os.path.join(d, "bridge.toml")])
        check("brains up", wait(lambda: all(req(P["brain"][n], "GET", "/root") for n in roots), 20))
        me = lambda: {x["id"]: x for x in req(P["trunk"], "GET", "/t/me/roots", headers=admin)}
        check("every root dialed OUT to /t/root and linked (GET /t/me/roots: online)",
              wait(lambda: all(v["online"] for v in me().values()) and len(me()) == 3, 20), (me(), log("bridge-mac")[-400:]))
        check("home is this device's door (the only root with the app)", me()[ids["home"]]["door"] is True, me())

        def state(n):
            with open(os.path.join(roots[n]["dir"], "trunk-state.json")) as f:
                return json.load(f)
        check("trunk-state.json: 0600, link up, the signed directory with all three, the token key",
              wait(lambda: all(state(n)["link"]["state"] == "up" and len(state(n)["directory"]["roots"]) == 3 and state(n)["keys"]
                               and os.stat(os.path.join(roots[n]["dir"], "trunk-state.json")).st_mode & 0o777 == 0o600 for n in roots), 10),
              {n: (state(n)["link"], len(state(n)["directory"].get("roots", []))) for n in roots})
        wg_ids = lambda n: sorted(p["id"] for p in req(P["wg_http"][n], "GET", "/_wg/_roots"))
        check("each wg node took the other two roots from the directory",
              wait(lambda: all(wg_ids(n) == sorted(i for m, i in ids.items() if m != n) for n in roots), 10), {n: wg_ids(n) for n in roots})
        listed = {p["id"]: p for p in req(P["wg_http"]["mac"], "GET", "/_wg/_roots")}
        import hashlib
        check("…with each root's name and its peer token's sha256 (never the token)",
              listed[ids["home"]].get("peer_token_sha256") == hashlib.sha256(roots["home"]["token"].encode()).hexdigest()
              and listed[ids["home"]].get("name") == "home" and roots["home"]["token"] not in json.dumps(listed), listed)
        check("each brain learned the others (YGG_PEERS_FROM = its node's list)",
              wait(lambda: all(set(req(P["brain"][n], "GET", "/root")["peers"]) >= {i for m, i in ids.items() if m != n} for n in roots), 30),
              {n: req(P["brain"][n], "GET", "/root")["peers"] for n in roots})

        # ---- brain ↔ brain inside WireGuard, per-root peer tokens ----
        tok = lambda n: {"x-ygg-peer": roots[n]["token"]}
        st, v = call(P["wg_http"]["home"], "GET", f"/_wg/{ids['mac']}/root", headers=tok("home"))
        check("home → mac: answered by the mac brain (inside WireGuard)", st == 200 and isinstance(v, dict) and v.get("name") == ids["mac"], (st, v))
        st, v = call(P["wg_http"]["mac"], "GET", f"/_wg/{ids['home']}/root", headers=tok("mac"))
        check("mac → home: answered by the home brain", st == 200 and isinstance(v, dict) and v.get("name") == ids["home"], (st, v))
        st, v = call(P["wg_http"]["home"], "POST", f"/_wg/{ids['mac']}/tree/report", {"proxy": "nope", "event": {}})
        check("a peer call without a token is refused by mac (401)", st == 401, (st, v))
        st, v = call(P["wg_http"]["home"], "POST", f"/_wg/{ids['mac']}/tree/report", {"proxy": "nope", "event": {}}, tok("lab"))
        check("…and with ANOTHER root's token (lab's, from home's tunnel): 401 — per-root, not shared", st == 401, (st, v))
        st, v = call(P["wg_http"]["home"], "POST", f"/_wg/{ids['mac']}/tree/report", {"proxy": "nope", "event": {}}, tok("home"))
        check("…with home's own token it passes the check (unknown proxy → 404)", st == 404, (st, v))

        # ---- MAIN on home starts a session on mac; the report comes home ----
        hp = P["brain"]["home"]
        main_id = req(hp, "POST", "/session", {"title": "[MAIN]"})["id"]
        r = req(hp, "POST", f"/session/{main_id}/message", {"parts": [{"type": "text", "text": tool(
            [["session_start", {"title": "on mac", "agent": "build", "brief": "Reply with exactly: MAC-DONE", "root": ids["mac"]}]])}]}, timeout=90)
        out = [p for p in r["parts"] if p["type"] == "tool"][0]["state"]["output"]
        check("MAIN's session_start ran on root mac", out.startswith("STARTED") and ids["mac"] in out, out)
        tree = lambda port: {x["title"]: x for x in req(port, "GET", "/tree")}
        done = wait(lambda: (tree(hp).get("on mac", {}).get("card") or {}).get("status") == "done", 45)
        card = tree(hp).get("on mac", {}).get("card") or {}
        check("home's /tree: the proxy on mac is done with mac's result", done and "MAC-DONE" in (card.get("headline") or ""), card)
        proxy = tree(hp)["on mac"]["id"]
        check("MAIN's inbox has the report from mac", wait(lambda: [e for e in req(hp, "GET", f"/session/{main_id}/inbox") if e.get("from") == proxy], 20))
        mp = P["brain"]["mac"]
        mac_main = req(mp, "POST", "/session", {"title": "[MAIN]"})["id"]
        r = req(mp, "POST", f"/session/{mac_main}/message", {"parts": [{"type": "text", "text": tool(
            [["session_start", {"title": "on lab", "agent": "build", "brief": "Reply with exactly: LAB-DONE", "root": ids["lab"]}]])}]}, timeout=90)
        done = wait(lambda: (tree(mp).get("on lab", {}).get("card") or {}).get("status") == "done", 45)
        card = tree(mp).get("on lab", {}).get("card") or {}
        check("MAIN on mac ran a session on lab; lab's report came back to mac", done and "LAB-DONE" in (card.get("headline") or ""), card)

        # ---- a device's request: the trunk's C3 check, then the door root's ----
        st, v = call(P["trunk"], "GET", "/api/hello", headers={"cookie": f"bifrost_device={admin_tok}"})
        check("a device's request goes to its door (home's app), real client address in X-Forwarded-For",
              st == 200 and isinstance(v, dict) and v.get("app") == "home" and v.get("xff") == "127.0.0.1", (st, v))
        st, v = call(P["trunk"], "GET", "/api/hello")
        check("…without a token: 401 login (C3), nothing relayed", st == 401 and isinstance(v, dict) and v.get("reauth") == "login", (st, v))

        # ---- the tap ----
        markers = [b"Reply with exactly", b"MAC-DONE", b"LAB-DONE", b"/tree/report", b"POST /session", b"GET /root",
                   b"x-ygg-peer", b"on mac", b"on lab"] + [r["token"].encode() for r in roots.values()]
        for n in roots:
            fr = tap.of(ids[n])
            wg = [p for _, _, k, p in fr if k == 17]
            kinds = {}
            for p in wg:
                kk = wg_kind(p[1 + p[0]:]) if p and p[0] < len(p) else None
                kinds[kk] = kinds.get(kk, 0) + 1
            seen = b"".join(p for _, _, _, p in fr)
            leaked = [m.decode(errors="replace") for m in markers if m in seen]
            check(f"the tap on {n}'s link: {len(wg)} WG frames, all WireGuard ({kinds}); nothing readable",
                  len(wg) > 10 and None not in kinds and kinds.get("data", 0) > 5 and not leaked, (kinds, leaked))
        ctrl_types = sorted({json.loads(p).get("t") for _, d, k, p in tap.of(ids["mac"]) if k == 16})
        check(f"the control plane the tap saw on mac's link: {ctrl_types}", {"hello", "auth", "welcome", "keys", "kill", "directory"} <= set(ctrl_types), ctrl_types)

        # ---- the bench ----
        b = bench(P["wg_http"]["home"], f"/_wg/{ids['mac']}", tok("home"))
        if check("bench ran", b is not None):
            print(f"BENCH v1 trunk relay (home → mac, WireGuard): GET /root median {b[0]:.1f} ms p90 {b[1]:.1f} ms · "
                  f"1 MB up {b[2]:.1f} MB/s · 1 MB down {b[3]:.1f} MB/s", flush=True)

        # ---- revoking lab ----
        t0 = time.time()
        st, v = call(P["trunk"], "DELETE", f"/t/roots/{ids['lab']}", headers=admin)
        check("DELETE /t/roots/<lab> (admin, same origin)", st == 200, (st, v))
        gone = wait(lambda: ids["lab"] not in wg_ids("mac") and call(P["wg_http"]["mac"], "GET", f"/_wg/{ids['lab']}/root", headers=tok("mac"), timeout=5)[0] != 200, 5, 0.02)
        cut_ms = (time.time() - t0) * 1000
        check(f"revoking lab: mac's node dropped it in {cut_ms:.0f} ms (≤ 1500, P13), mac → lab refused", gone and cut_ms <= 1500, wg_ids("mac"))
        print(f"ROOT REVOKE → WireGuard cut (rig): {cut_ms:.0f} ms", flush=True)
        check("lab's bridge: 'REVOKED by trunk', its state file says revoked",
              wait(lambda: "REVOKED by trunk" in log("bridge-lab") and state("lab")["link"]["state"] == "revoked", 5), log("bridge-lab")[-300:])
        check("the trunk lists lab no more; home and mac stay online",
              wait(lambda: ids["lab"] not in me() and me()[ids["home"]]["online"] and me()[ids["mac"]]["online"], 5), me())
        time.sleep(2)
        check("lab never links again (its key is refused)", ids["lab"] not in me() and "link up" not in log("bridge-lab").split("REVOKED")[-1], log("bridge-lab")[-300:])
        st, v = call(P["wg_http"]["home"], "GET", f"/_wg/{ids['mac']}/root", headers=tok("home"))
        check("…and home ↔ mac is untouched", st == 200 and v.get("name") == ids["mac"], (st, v))
    except Exception as e:  # noqa: BLE001
        check("rig ran to the end", False, repr(e))
    finally:
        for name, p in reversed(list(procs.items())):
            p.terminate()
        for p in procs.values():
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        if FAILS:
            for name in ("trunk", "bridge-home", "bridge-mac", "bridge-lab", "wg-mac", "mac", "home"):
                if name in logs and os.path.exists(logs[name]):
                    print(f"--- {name}.log (tail)\n" + open(logs[name]).read()[-1500:])
        if a.keep or FAILS:
            print(f"scratch kept: {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'GREEN' if not FAILS else 'RED'}: {len(FAILS)} failure(s) {FAILS if FAILS else ''}")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
