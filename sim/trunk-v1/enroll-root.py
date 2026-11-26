#!/usr/bin/env python3
"""enroll-root.py — enroll one root into a v1 trunk the way the installer + the owner do (F3/F4), for rigs.

  1. makes the root's keys in --dir (what root.sh makes): `bifrost-net root-key DIR/root.key`,
     `bifrost-net wg-key DIR/wg.key`, and with --dtls FILE the bridge's DTLS identity
     (`bifrost-net dtls-id FILE`, the bridge's dtls_cert_file) so the trunk's directory pins it
  2. POST /t/roots/enroll (no cookie) {hostname, os, arch, name, root_pub, wg_pub, dtls_fp, has_app, has_voice}
  3. the admin (cookies from claim-admin.py's JSON) finds the card by its code
     (POST /t/roots/enroll/by-code, the headless F4 path) and approves it
     (POST /t/roots/enroll/:id/approve {name}); a 403 step_up → POST /t/auth/step-up with a TOTP
     code computed from the admin's seed (the JSON's last_step is moved on, so no code is used twice)
  4. polls POST /t/roots/enroll/:id/poll {secret} → the approved result, once
  5. writes DIR/enroll.json (0600) and prints it: root_id, name, wg_addr, wg_net, trunk {url,
     trunk_id, trunk_key}, peer_token, dtls_fp, root_pub, wg_pub

    enroll-root.py --url https://ap.tree.test --admin STATE/admin.json --bin bifrost-net \\
                   --dir STATE/home --name home [--hostname home-box] [--has-app] [--has-voice] \\
                   [--dtls STATE/home/bridge-dtls.json] [--origin URL]

https with a self-signed trunk: SSL_CERT_FILE=<the trunk's cert.pem>. The output holds test secrets
(the peer token): keep it in the rig's own dir. Exit 0 = approved. Used by sim/trunk-rtc-v1-e2e.sh
(G3.2: every scenario, incl. `two-voice` = G3.6 step 15).
"""
import argparse, json, os, re, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trunklib import Client, totp_fresh  # noqa: E402


def kv(out, key):
    m = re.search(r'^%s = "([^"]+)"' % re.escape(key), out, re.M)
    if not m:
        raise SystemExit("enroll-root: no %s in %r" % (key, out))
    return m.group(1)


def run(*argv):
    p = subprocess.run(list(argv), capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise SystemExit("enroll-root: %s: %s" % (" ".join(argv[:2]), (p.stdout + p.stderr).strip()))
    return p.stdout


def admin_client(url, origin, admin_path):
    a = json.load(open(admin_path))
    c = Client(url, origin=origin or a.get("origin") or url)
    c.jar["bifrost_device"] = (a["cookies"]["bifrost_device"], "/")
    if a["cookies"].get("bifrost_refresh"):
        c.jar["bifrost_refresh"] = (a["cookies"]["bifrost_refresh"], "/t/auth")
    return c, a


def save_admin(admin_path, a, c):
    a["cookies"] = {k: v for k, (v, _) in c.jar.items()}
    tmp = admin_path + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(a, f, indent=1)
    os.replace(tmp, admin_path)


def step_up(c, a, admin_path):
    code, step = totp_fresh(a["totp_secret"], int(a.get("last_step", 0)))
    r = c.signed("POST", "/t/auth/step-up", {"totp": code})
    if r.status != 200:
        raise SystemExit("enroll-root: step-up: %r" % r)
    a["last_step"] = step
    save_admin(admin_path, a, c)


def enroll(o):
    os.makedirs(o.dir, exist_ok=True)
    root_pub = kv(run(o.bin, "root-key", os.path.join(o.dir, "root.key")), "public_key")
    wg_pub = kv(run(o.bin, "wg-key", os.path.join(o.dir, "wg.key")), "public_key")
    dtls_fp = kv(run(o.bin, "dtls-id", o.dtls), "fingerprint") if o.dtls else ""
    anon = Client(o.url, origin=o.origin or o.url)
    r = anon.post("/t/roots/enroll", {
        "hostname": o.hostname or ("%s-box" % o.name), "os": "linux", "arch": "x86_64", "name": o.name,
        "root_pub": root_pub, "wg_pub": wg_pub, "dtls_fp": dtls_fp,
        "has_app": o.has_app, "has_voice": o.has_voice,
    })
    if r.status != 200:
        raise SystemExit("enroll-root: enroll: %r" % r)
    e = r.data
    c, a = admin_client(o.url, o.origin, o.admin)
    r = c.signed("POST", "/t/roots/enroll/by-code", {"code": e["code"]})
    if r.status != 200 or r.j("id") != e["id"]:
        raise SystemExit("enroll-root: by-code: %r" % r)
    for attempt in range(2):
        r = c.signed("POST", "/t/roots/enroll/%s/approve" % e["id"], {"name": o.name, "code": e["code"]})
        if r.status == 403 and r.j("step_up") and attempt == 0:
            step_up(c, a, o.admin)
            continue
        break
    if r.status != 200:
        raise SystemExit("enroll-root: approve: %r" % r)
    save_admin(o.admin, a, c)
    res = None
    for _ in range(40):
        r = anon.post("/t/roots/enroll/%s/poll" % e["id"], {"secret": e["poll_secret"]})
        if r.status == 200 and r.j("status") == "approved":
            res = r.data
            break
        if r.status != 200 or r.j("status") != "pending":
            raise SystemExit("enroll-root: poll: %r" % r)
        time.sleep(0.25)
    if not res:
        raise SystemExit("enroll-root: never approved")
    out = {
        "root_id": res["root_id"], "name": res.get("name", o.name), "wg_addr": res.get("wg_addr"),
        "wg_net": res.get("wg_net"), "trunk": res["trunk"], "peer_token": res["peer_token"],
        "dtls_fp": dtls_fp, "root_pub": root_pub, "wg_pub": wg_pub,
    }
    path = os.path.join(o.dir, "enroll.json")
    with open(os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(out, f, indent=1)
    os.replace(path + ".tmp", path)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True, help="the trunk (https://host, or http://127.0.0.1:PORT)")
    ap.add_argument("--origin", default=None, help="the trunk's public_url (default: the admin JSON's origin, else --url)")
    ap.add_argument("--admin", required=True, help="claim-admin.py's JSON (cookies, totp_secret, last_step); updated in place")
    ap.add_argument("--bin", default="bifrost-net", help="the bifrost-net binary (root-key, wg-key, dtls-id)")
    ap.add_argument("--dir", required=True, help="the root's own dir: keys + enroll.json")
    ap.add_argument("--name", required=True)
    ap.add_argument("--hostname", default=None)
    ap.add_argument("--has-app", action="store_true")
    ap.add_argument("--has-voice", action="store_true")
    ap.add_argument("--dtls", default=None, help="the bridge's dtls_cert_file (made here; its fingerprint is enrolled)")
    o = ap.parse_args()
    print(json.dumps(enroll(o), indent=1))


if __name__ == "__main__":
    main()
