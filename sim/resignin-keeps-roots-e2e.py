#!/usr/bin/env python3
"""resignin-keeps-roots-e2e.py — G2.3: signing in again never drops roots; revoking still cuts them.

The REAL v1 trunk (`bifrost-net trunk`), REAL bridges in `[trunk]` mode, REAL WireGuard nodes
(`bifrost-net wg` reading `trunk-state.json`), and REAL app (`node server.mjs`, `BIFROST_AUTH=trunk`),
on a throwaway state dir and free loopback ports — never live files or ports.

  1. admin claims the v1 trunk (`claim-admin.py` -> device A)
  2. home (has_app) and mac-studio enroll via POST /t/roots/enroll; device A approves; both collect once
  3. home's WireGuard node pins mac-studio (GET /_wg/_roots lists it); both roots online in /t/me/roots
  4. the owner signs in again (device B) and logs out the original approver (device A) while a watcher
     polls home's wg node every 50 ms throughout:
       - mac-studio is NEVER missing from /_wg/_roots
       - device A is dead (401 login on trunk and app)
       - device B reaches the app through the trunk and refreshes cleanly
       - v1 never writes devices.json or roots.json
  5. control: revoking mac-studio (DELETE /t/roots/<id>) cuts it at home's wg node within 1.5 s (P13)

    resignin-keeps-roots-e2e.py [--app BRANCH_DIR] [--bin-trunk PATH] [--keep]
"""
import argparse, json, os, shutil, socket, subprocess, sys, tempfile, threading, time
import urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.realpath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "trunk-v1"))
from trunklib import Client  # noqa: E402

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


def http(method, url, body=None, headers=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", **(headers or {})})

    def parsed(raw):
        try:
            return json.loads(raw or b"null")
        except ValueError:
            return raw.decode(errors="replace")[:200]

    try:
        with OPENER.open(req, timeout=timeout) as r:
            return r.status, parsed(r.read()), r.headers
    except urllib.error.HTTPError as e:
        return e.code, parsed(e.read()), e.headers
    except OSError as e:
        return 0, str(e), {}


def kv(out):
    return {l.split(" = ")[0]: l.split('"')[1] for l in out.splitlines() if " = " in l and '"' in l}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default=os.path.join(REPO, "branch"), help="the branch dir holding a `next build`")
    ap.add_argument("--bin-trunk", default=os.path.join(REPO, "trunk", "target", "release", "bifrost-net"))
    ap.add_argument("--keep", action="store_true", help="keep the state dir and logs")
    a = ap.parse_args()
    if not os.path.isfile(os.path.join(a.app, ".next", "BUILD_ID")):
        sys.exit("no `next build` in %s — run npm run build there first" % a.app)
    if not os.access(a.bin_trunk, os.X_OK):
        sys.exit("no bifrost-net at %s (--bin-trunk)" % a.bin_trunk)

    scratch = os.environ.get("TMPDIR") or os.path.expanduser("~/.cache/trunk-v1/tmp/ladder")
    os.makedirs(scratch, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="resignin-keeps-roots-", dir=scratch)
    procs, logs = [], {}

    def spawn(name, argv, env=None, cwd=None):
        logs[name] = os.path.join(tmp, name + ".log")
        p = subprocess.Popen(argv, stdout=open(logs[name], "w"), stderr=subprocess.STDOUT, env=env, cwd=cwd,
                             start_new_session=True)
        procs.append(p)
        return p

    def log(name):
        return open(logs[name]).read() if os.path.exists(logs.get(name, "")) else ""

    def bn(*args, env=None):
        r = subprocess.run([a.bin_trunk, *args], capture_output=True, text=True, env={**os.environ, **(env or {})})
        if r.returncode != 0:
            raise RuntimeError("bifrost-net %s: %s" % (args[0], r.stderr.strip()))
        return r.stdout

    try:
        # ---- v1 trunk ----
        trunk_p, ice_p, app_p = free_port(), free_port(), free_port()
        trunk_url = "http://127.0.0.1:%d" % trunk_p
        td = os.path.join(tmp, "trunk")
        os.makedirs(os.path.join(td, "cred"), mode=0o700)
        bn("trunk-kek", os.path.join(td, "cred", "trunk-kek"))
        cfg = os.path.join(td, "trunk.toml")
        with open(cfg, "w") as f:
            f.write(
                f'public_url = "{trunk_url}"\n'
                f'listen_http = "127.0.0.1:{trunk_p}"\n'
                f'listen_ice = "127.0.0.1:{ice_p}"\n'
                f'db = "{td}/trunk.db"\n'
                f'state_dir = "{td}"\n'
                f'cred_dir = "{td}/cred"\n'
                f'ctl_socket = "{td}/ctl.sock"\n'
                f'rp_id = "127.0.0.1"\n'
                f'origins = ["{trunk_url}"]\n'
                f'ice_owner_from = ["127.0.0.1/32"]\n'
            )
        fast_env = {**os.environ, "TRUNK_TEST_FAST": "1"}
        spawn("trunk", [a.bin_trunk, "trunk", "-c", cfg], env=fast_env)
        if not wait(lambda: http("GET", trunk_url + "/t/state")[0] == 200, 15):
            sys.exit("trunk did not come up:\n" + log("trunk")[-2000:])

        # ---- 1: claim admin (device A) ----
        import importlib.util
        spec = importlib.util.spec_from_file_location("claim_admin", os.path.join(HERE, "trunk-v1", "claim-admin.py"))
        claim_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(claim_mod)
        ctl_cmd = "%s trunk-ctl --sock %s/ctl.sock" % (a.bin_trunk, td)
        claimed, client_a = claim_mod.claim(trunk_url, ctl_cmd, origin=trunk_url)
        dev_raw = claimed.get("device")
        dev_a = dev_raw.get("id", "") if isinstance(dev_raw, dict) else str(dev_raw or "")
        tok_a = claimed["cookies"].get("bifrost_device", "")
        ref_a = claimed["cookies"].get("bifrost_refresh", "")
        check("1 admin claims the v1 trunk (device A + refresh cookie)", dev_a.startswith("dev_") and bool(tok_a) and bool(ref_a), claimed.get("device"))

        # ---- 2: enroll home (has_app) and mac-studio (light) ----
        admin_a = {"cookie": "bifrost_device=" + tok_a, "origin": trunk_url}
        roots = {}
        for name, has_app in (("home", True), ("mac-studio", False)):
            d = os.path.join(tmp, name)
            os.makedirs(d, mode=0o700)
            rk = kv(bn("root-key", os.path.join(d, "root.key")))
            wk = kv(bn("wg-key", os.path.join(d, "wg.key")))
            st, start, _ = http("POST", trunk_url + "/t/roots/enroll", {
                "hostname": name, "os": "macos" if name == "mac-studio" else "linux", "arch": "x86_64",
                "root_pub": rk["public_key"], "wg_pub": wk["public_key"],
                "has_app": has_app, "has_voice": False,
            })
            if name == "mac-studio":
                check("2a mac-studio asks to enroll with its root + WireGuard keys", st == 200 and bool(start.get("id")), (st, start))
            st, ok, _ = http("POST", "%s/t/roots/enroll/%s/approve" % (trunk_url, start["id"]), {"name": name}, admin_a)
            if name == "mac-studio":
                check("2b device A approves mac-studio", st == 200, (st, ok))
            st, res, _ = http("POST", "%s/t/roots/enroll/%s/poll" % (trunk_url, start["id"]), {"secret": start["poll_secret"]})
            st2, again, _ = http("POST", "%s/t/roots/enroll/%s/poll" % (trunk_url, start["id"]), {"secret": start["poll_secret"]})
            if name == "mac-studio":
                check("2c mac-studio collects its credentials once (second poll -> 410)",
                      st == 200 and res.get("status") == "approved" and res.get("peer_token", "").startswith("ygp-") and st2 == 410,
                      (st, res, st2, again))
            roots[name] = {
                "dir": d, "id": res["root_id"], "trunk_key": res["trunk"]["trunk_key"],
                "token": res["peer_token"], "has_app": has_app,
                "bridge_http": free_port(), "media": free_port(True),
                "wg_http": free_port(), "wg_udp": free_port(True), "relay_udp": free_port(True),
            }

        # ---- start home & mac-studio bridges + wg nodes + home app ----
        for name, r in roots.items():
            d = r["dir"]
            with open(os.path.join(d, "wg.toml"), "w") as f:
                f.write(
                    f'[wg]\nkey_file = "{d}/wg.key"\n'
                    f'udp = "127.0.0.1:{r["wg_udp"]}"\n'
                    f'relay = "127.0.0.1:{r["relay_udp"]}"\n'
                    f'http = "127.0.0.1:{r["wg_http"]}"\n'
                    f'trunk_state = "{d}/trunk-state.json"\n'
                    f'trunk_key = "{r["trunk_key"]}"\n'
                )
            spawn("wg-" + name, [a.bin_trunk, "wg", "-c", os.path.join(d, "wg.toml")])
            priv = kv(bn("keygen"))["private_key"]
            with open(os.path.join(d, "bridge.toml"), "w") as f:
                f.write(
                    f'[node]\nname = "{name}"\nprivate_key = "{priv}"\n\n'
                    f'[bridge]\nhttp = "127.0.0.1:{r["bridge_http"]}"\nmedia = "127.0.0.1:{r["media"]}"\n'
                    f'tokens_file = "{d}/devices.json"\nopencode_url = "http://127.0.0.1:1"\n\n'
                    f'[trunk]\nurl = "{trunk_url}"\ntrunk_key = "{r["trunk_key"]}"\n'
                    f'root_key_file = "{d}/root.key"\nroot_id = "{r["id"]}"\n'
                    f'state_file = "{d}/trunk-state.json"\n'
                    f'upstream = "127.0.0.1:{app_p if r["has_app"] else 1}"\n'
                    f'ice_tcp = []\nwg_relay = "127.0.0.1:{r["relay_udp"]}"\nwg_local = "127.0.0.1:{r["wg_udp"]}"\n'
                )
            spawn("bridge-" + name, [a.bin_trunk, "bridge", "-c", os.path.join(d, "bridge.toml")])

        home_state = os.path.join(roots["home"]["dir"], "trunk-state.json")
        wait(lambda: os.path.isfile(home_state), 15)

        app_env = {k: v for k, v in os.environ.items() if not k.startswith(("BIFROST_", "YGG_", "OPENCODE_"))}
        app_env.update(
            PORT=str(app_p), HOST="127.0.0.1", NODE_ENV="production",
            BIFROST_AUTH="trunk", BIFROST_TRUNK_STATE=home_state, BIFROST_TRUNK_URL=trunk_url,
            BIFROST_TRUST_PROXY="1", OPENCODE_URL="http://127.0.0.1:1",
            NEXT_TELEMETRY_DISABLED="1",
        )
        spawn("app", ["node", "server.mjs"], env=app_env, cwd=a.app)
        wait(lambda: http("GET", "http://127.0.0.1:%d/api/build" % app_p, timeout=3)[0] in (200, 401), 60)

        mac_id = roots["mac-studio"]["id"]
        wg_url = "http://127.0.0.1:%d/_wg/_roots" % roots["home"]["wg_http"]

        def wg_roots():
            st, body, _ = http("GET", wg_url, timeout=2)
            return [p.get("id") for p in body] if st == 200 and isinstance(body, list) else None

        # ---- 3: home's wg node pins mac-studio ----
        pinned = wait(lambda: mac_id in (wg_roots() or []), 20)
        check("3 home's WireGuard node pins mac-studio from trunk-state.json", bool(pinned), (wg_roots(), log("wg-home")[-600:]))

        # ---- 4: sign in again (device B) + log out approver (device A) while watcher polls wg ----
        seen, missing, stop = [0], [], threading.Event()

        def watch():
            while not stop.is_set():
                ids = wg_roots()
                if ids is not None:
                    seen[0] += 1
                    if mac_id not in ids:
                        missing.append(time.time())
                time.sleep(0.05)

        th = threading.Thread(target=watch, daemon=True)
        th.start()
        time.sleep(1.0)

        client_b = Client(trunk_url, origin=trunk_url)
        r1 = client_b.post("/t/auth/login", {"email": claimed["email"], "password": claimed["password"]})
        r2 = client_b.post("/t/auth/mfa", {"mfa_ticket": r1.j("mfa_ticket"), "recovery": claimed["recovery_codes"][0]})
        dev_b_raw = r2.j("device") if r2.status == 200 else None
        dev_b = dev_b_raw.get("id", "") if isinstance(dev_b_raw, dict) else str(dev_b_raw or "")
        tok_b = (client_b.jar.get("bifrost_device") or ("", ""))[0]
        ref_b = (client_b.jar.get("bifrost_refresh") or ("", ""))[0]
        check("4a signing in again creates a new device B with fresh cookies",
              r2.status == 200 and dev_b.startswith("dev_") and dev_b != dev_a and bool(tok_b) and bool(ref_b), (r1.status, r2.status, r2.body))

        # log out the original approver (device A)
        lo = client_a.post("/t/auth/logout", {})
        time.sleep(3.5)
        stop.set()
        th.join(2)

        st_a_me, _, _ = http("GET", trunk_url + "/t/me", headers={"cookie": "bifrost_device=" + tok_a})
        st_a_app, body_a_app, _ = http("GET", trunk_url + "/api/build", headers={"cookie": "bifrost_device=" + tok_a})
        check("4b logging out approver device A revokes it (401 login on trunk and app)",
              lo.status == 200 and st_a_me == 401 and st_a_app == 401 and isinstance(body_a_app, dict) and body_a_app.get("reauth") == "login",
              (lo.status, st_a_me, st_a_app, body_a_app))

        st_b_app, body_b_app, _ = http("GET", trunk_url + "/api/build", headers={"cookie": "bifrost_device=" + tok_b})
        st_b_roots, body_b_roots, _ = http("GET", trunk_url + "/t/me/roots", headers={"cookie": "bifrost_device=" + tok_b})
        check("4c device B reaches the app through the trunk and sees both roots online",
              st_b_app == 200 and isinstance(body_b_app, dict) and body_b_app.get("auth") == "trunk"
              and st_b_roots == 200 and len(body_b_roots or []) == 2 and all(x.get("online") for x in body_b_roots),
              (st_b_app, body_b_app, st_b_roots, body_b_roots))

        check("4d home's wg node never dropped mac-studio (%d polls across re-sign-in + logout)" % seen[0],
              seen[0] > 40 and not missing, "missing in %d of %d polls" % (len(missing), seen[0]))
        check("4e wg-home.log and bridge-mac-studio.log: no REVOKED",
              "REVOKED" not in log("wg-home") and "REVOKED" not in log("bridge-mac-studio"),
              (log("wg-home")[-400:], log("bridge-mac-studio")[-400:]))

        ref = client_b.post("/t/auth/refresh", {})
        tok_b2 = (client_b.jar.get("bifrost_device") or ("", ""))[0]
        check("4f device B refreshes cleanly (200) and mac-studio stays pinned",
              ref.status == 200 and bool(tok_b2) and mac_id in (wg_roots() or []), (ref.status, ref.body))

        mode = os.stat(home_state).st_mode & 0o777
        no_v09 = not os.path.exists(os.path.join(roots["home"]["dir"], "devices.json")) and not os.path.exists(os.path.join(roots["home"]["dir"], "roots.json"))
        check("4g trunk-state.json is 0600 and v1 never writes devices.json or roots.json",
              mode == 0o600 and no_v09, (oct(mode), no_v09))

        # ---- 5: control — revoking mac-studio cuts it within 1.5 s (P13) ----
        t0 = time.time()
        st_del, body_del, _ = http("DELETE", "%s/t/roots/%s" % (trunk_url, mac_id),
                                   headers={"cookie": "bifrost_device=" + tok_b2, "origin": trunk_url})
        gone = wait(lambda: mac_id not in (wg_roots() or []), 5, 0.02)
        cut_ms = (time.time() - t0) * 1000
        rev_logged = wait(lambda: "REVOKED by trunk" in log("bridge-mac-studio"), 5, 0.1)
        check("5 control: revoking mac-studio cuts it at home's wg node in %.0f ms (<= 1500 ms, P13)" % cut_ms,
              st_del == 200 and bool(gone) and cut_ms <= 1500 and bool(rev_logged),
              (st_del, body_del, cut_ms, log("bridge-mac-studio")[-400:]))
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
