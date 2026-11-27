#!/usr/bin/env python3
"""repair-keeps-roots-e2e.py — a phone re-pair never cuts the roots it approved.

The REAL app (node server.mjs on a `next build`, devices mode) and a REAL hub WireGuard node
(`bifrost-net wg` reading the app's roots.json + devices.json, the way hub-wg does), on a
throwaway state dir and free loopback ports — never the live hub's files or ports.

  1. a phone pairs (POST /api/pair/code from the console, POST /api/pair/claim)
  2. a machine joins with a WireGuard key; the phone approves it; the machine collects
  3. the hub's node pins it (GET /_wg/_roots lists it)
  4. the phone re-pairs with its old refresh cookie (what a fresh QR scan does)
     -> a watcher polls the node every 50 ms throughout: the root is never missing,
        wg.log never says REVOKED; roots.json names the new device; the old one is revoked
        're-paired'; the new device carries the root in its allowlist; refill answers 200
  5. control: revoking the new device from the device list still cuts the root (within ~2 s)

    repair-keeps-roots-e2e.py [--app BRANCH_DIR] [--bin-trunk PATH] [--keep]

2026-11-23 11:41:17Z, before the fix: step 4 dropped mac-studio at the hub (its approver was the
retired device) and its refill got 409 device-revoked.
"""
import argparse, json, os, shutil, socket, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.realpath(os.path.join(HERE, ".."))
NEVER = {4100, 4101, 4191, 4310, 4320, 4502, 4503, 4505, 4506, 4507, 4508, 8080, 8090, 8101, 8191, 4096, 8447}
FAILS = []
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def free_port(udp=False):
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM if udp else socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            p = s.getsockname()[1]
        if p not in NEVER:
            return p


def check(name, ok, detail=""):
    print("%s %s%s" % ("PASS" if ok else "FAIL", name, (" — " + str(detail)) if detail and not ok else ""), flush=True)
    if not ok:
        FAILS.append(name)


def http(method, url, body=None, headers=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", **(headers or {})})
    def parsed(raw):
        try:
            return json.loads(raw or b"null")
        except ValueError:  # a page, not an API answer
            return raw.decode(errors="replace")[:200]

    try:
        with OPENER.open(req, timeout=timeout) as r:
            return r.status, parsed(r.read()), r.headers
    except urllib.error.HTTPError as e:
        return e.code, parsed(e.read()), e.headers


def cookie(headers, name):
    for v in headers.get_all("set-cookie") or []:
        k, _, rest = v.partition("=")
        if k.strip() == name:
            return urllib.parse.unquote(rest.split(";")[0])
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default=os.path.join(REPO, "branch"), help="the branch dir holding a `next build`")
    ap.add_argument("--bin-trunk", default=os.path.expanduser("~/.local/share/yggdrasil/hub/current/bin/bifrost-net"))
    ap.add_argument("--keep", action="store_true", help="keep the state dir and logs")
    a = ap.parse_args()
    if not os.path.isfile(os.path.join(a.app, ".next", "BUILD_ID")):
        sys.exit("no `next build` in %s — run npm run build there first" % a.app)
    if not os.access(a.bin_trunk, os.X_OK):
        sys.exit("no bifrost-net at %s (--bin-trunk)" % a.bin_trunk)

    tmp = tempfile.mkdtemp(prefix="repair-keeps-roots-", dir=os.path.expanduser("~/.cache"))
    procs, logs = [], {}

    def spawn(name, argv, env=None, cwd=None):
        logs[name] = os.path.join(tmp, name + ".log")
        p = subprocess.Popen(argv, stdout=open(logs[name], "w"), stderr=subprocess.STDOUT, env=env, cwd=cwd,
                             start_new_session=True)
        procs.append(p)
        return p

    def log(name):
        return open(logs[name]).read() if os.path.exists(logs.get(name, "")) else ""

    try:
        state = os.path.join(tmp, "state")
        os.makedirs(state, mode=0o700)
        devices, roots = os.path.join(state, "devices.json"), os.path.join(state, "roots.json")
        secret = os.path.join(state, "rootlink-secret")
        with open(secret, "w") as f:
            f.write(os.urandom(32).hex() + "\n")
        os.chmod(secret, 0o600)
        # the hub node's key (its .pub is what the app hands a joiner) and the joining machine's key
        for k in ("hub", "mac"):
            subprocess.run([a.bin_trunk, "wg-key", os.path.join(tmp, k + ".key")], check=True, capture_output=True)
        mac_pub = open(os.path.join(tmp, "mac.key.pub")).read().strip()

        app_p, wg_http = free_port(), free_port()
        wg_udp, relay_udp = free_port(True), free_port(True)
        with open(os.path.join(tmp, "wg-hub.toml"), "w") as f:
            f.write('[wg]\nkey_file = "%s"\nudp = "127.0.0.1:%d"\nrelay = "127.0.0.1:%d"\nhttp = "127.0.0.1:%d"\n'
                    'roots_file = "%s"\ndevices_file = "%s"\n' % (os.path.join(tmp, "hub.key"), wg_udp, relay_udp, wg_http,
                                                                  roots, devices))
        spawn("wg", [a.bin_trunk, "wg", "-c", os.path.join(tmp, "wg-hub.toml")])

        env = {k: v for k, v in os.environ.items() if not k.startswith(("BIFROST_", "YGG_", "OPENCODE_"))}
        env.update(PORT=str(app_p), HOST="127.0.0.1", NODE_ENV="production", BIFROST_AUTH="devices",
                   BIFROST_DEVICES_FILE=devices, BIFROST_ROOTS_FILE=roots, BIFROST_NET_BIN=a.bin_trunk,
                   BIFROST_ROOTLINK_SECRET_FILE=secret, BIFROST_WG_PUB_FILE=os.path.join(tmp, "hub.key.pub"),
                   BIFROST_ROOTLINK_URL="wss://127.0.0.1:1/rootlink", YGG_ROOT_NAME="home",
                   OPENCODE_URL="http://127.0.0.1:1", BIFROST_BRIDGE_URL="http://127.0.0.1:1",
                   NEXT_TELEMETRY_DISABLED="1")
        spawn("app", ["node", "server.mjs"], env=env, cwd=a.app)
        base, wg = "http://127.0.0.1:%d" % app_p, "http://127.0.0.1:%d" % wg_http
        for _ in range(120):
            try:
                if http("GET", base + "/pair", timeout=3)[0] in (200, 302, 307, 401):
                    break
            except OSError:
                pass
            time.sleep(0.5)
        else:
            sys.exit("the app never answered:\n" + log("app")[-2000:])

        def pair(prev_refresh=None):
            st, out, _ = http("POST", base + "/api/pair/code", {"name": "Android"})
            if st != 200:
                sys.exit("pair code: %s %s" % (st, out))
            code = urllib.parse.parse_qs(urllib.parse.urlparse(out["url"]).fragment)["code"][0]
            hdr = {"cookie": "bifrost_refresh=" + urllib.parse.quote(prev_refresh)} if prev_refresh else {}
            st, out, h = http("POST", base + "/api/pair/claim", {"code": code, "name": "Android"}, hdr)
            if st != 200:
                sys.exit("pair claim: %s %s" % (st, out))
            return out["id"], out["accessToken"], cookie(h, "bifrost_refresh")

        def reg(path):
            with open(path) as f:
                return json.load(f)

        def wg_roots():
            try:
                with OPENER.open(wg + "/_wg/_roots", timeout=2) as r:
                    return [p.get("id") for p in json.loads(r.read() or b"[]")]
            except (OSError, ValueError):
                return None

        # 1-2: pair, join, approve, collect
        dev_a, tok_a, ref_a = pair()
        check("1 a phone pairs from a console code (devices mode)", dev_a.startswith("dev_") and bool(ref_a))
        st, j, _ = http("POST", base + "/api/roots/join", {"name": "mac-studio", "os": "macos", "host": "mac-studio",
                                                            "wg_pub": mac_pub})
        check("2a the machine asks to join with its WireGuard key", st == 201, j)
        st, ok, _ = http("POST", base + "/api/roots/join/%s/approve" % j["req"], {}, {"authorization": "Bearer " + tok_a})
        check("2b the phone approves it", st == 200 and ok.get("root_id") == "mac-studio", ok)
        st, got, _ = http("GET", base + "/api/roots/join/%s" % j["req"], None, {"x-join-secret": j["secret"]})
        check("2c the machine collects its credentials and 20 link tokens",
              st == 200 and len(got.get("link_tokens") or []) == 20 and got.get("wg", {}).get("ip"), got)
        root_secret = got.get("root_secret", "")

        # 3: the hub's node pins it
        for _ in range(40):
            if "mac-studio" in (wg_roots() or []):
                break
            time.sleep(0.25)
        check("3 the hub's WireGuard node pins mac-studio", "mac-studio" in (wg_roots() or []), log("wg")[-800:])

        # 4: re-pair with the old cookie while a watcher polls the node
        seen, missing, stop = [0], [], threading.Event()

        def watch():
            while not stop.is_set():
                ids = wg_roots()
                if ids is not None:
                    seen[0] += 1
                    if "mac-studio" not in ids:
                        missing.append(time.time())
                time.sleep(0.05)

        th = threading.Thread(target=watch, daemon=True)
        th.start()
        time.sleep(1.2)
        dev_b, tok_b, ref_b = pair(ref_a)
        time.sleep(3.5)  # three of the node's 1 s reloads
        stop.set()
        th.join(2)
        d, r = reg(devices), reg(roots)
        old = next(x for x in d["devices"] if x["id"] == dev_a)
        new = next(x for x in d["devices"] if x["id"] == dev_b)
        mac = next(x for x in r["roots"] if x["id"] == "mac-studio")
        check("4a the re-pair retires the old device ('re-paired')", old["revoked"] is True and old.get("revokedWhy") == "re-paired", old)
        check("4b roots.json names the new device as mac-studio's approver", mac["dev"] == dev_b, mac["dev"])
        check("4c the new device carries mac-studio in its allowlist", new.get("roots") == ["mac-studio"], new.get("roots"))
        check("4d the hub's node never dropped mac-studio (%d polls across the re-pair)" % seen[0],
              seen[0] > 40 and not missing, "missing in %d of %d polls" % (len(missing), seen[0]))
        check("4e wg.log: no REVOKED", "REVOKED" not in log("wg"), log("wg")[-800:])
        st, out, _ = http("POST", base + "/api/roots/mac-studio/tokens", {}, {"x-root-secret": root_secret})
        check("4f refill after the re-pair: 200 with 20 tokens (was 409 device-revoked)",
              st == 200 and len(out.get("link_tokens") or []) == 20, (st, out))
        st, _, _ = http("POST", base + "/api/roots/join/%s/approve" % j["req"], {}, {"authorization": "Bearer " + tok_a})
        check("4g the old device's access token is dead (401)", st == 401, st)

        # 5: control — the cut still happens when the owner revokes the approver on purpose
        st, out, _ = http("DELETE", base + "/api/pair/devices", {"id": dev_b}, {"authorization": "Bearer " + tok_b})
        gone = False
        for _ in range(16):
            ids = wg_roots()
            if ids is not None and "mac-studio" not in ids:
                gone = True
                break
            time.sleep(0.25)
        check("5 control: revoking the approver from the device list still cuts mac-studio",
              st == 200 and gone and "REVOKED" in log("wg"), (st, out, log("wg")[-400:]))
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
        if a.keep or FAILS:
            print("state + logs kept in %s" % tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    print("\n%d failed" % len(FAILS) if FAILS else "\nall passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
