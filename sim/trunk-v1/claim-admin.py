#!/usr/bin/env python3
"""claim-admin.py — claim a v1 trunk the way the on-device agent and the owner do (F1), for rigs.

  1. reads the live claim code from the console: `trunk-ctl claim-code --json`
  2. POST /t/claim/begin {code} → a ticket; /t/claim/approve
  3. POST /t/auth/signup {ticket, email, password} → the TOTP seed
  4. POST /t/auth/totp/confirm with a code computed from the seed → 10 recovery codes + cookies
  5. prints one JSON object: url, email, password, totp_secret, last_step, recovery_codes, device,
     cookies {bifrost_device, bifrost_refresh}

    claim-admin.py --url http://127.0.0.1:18801 --ctl "bifrost-net trunk-ctl --sock /path/ctl.sock"
                   [--origin https://ljoolq.veraldar.org] [--email owner@example.org] [--xff 203.0.113.9]

The password comes from $CLAIM_ADMIN_PASSWORD, else a random one (printed in the JSON: this is a
rig helper; the output holds test secrets — keep it in the rig's own dir). Exit 0 = claimed.
Used by G3.6 steps 1–3 (LADDER) and sim/trunk-v1-auth.py.
"""
import argparse, json, os, secrets, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trunklib import Client, ctl, totp_fresh  # noqa: E402


def claim(url, ctl_prefix, origin=None, email="owner@example.org", password=None, xff=None):
    password = password or os.environ.get("CLAIM_ADMIN_PASSWORD") or ("rig-" + secrets.token_urlsafe(18))
    ok, out = ctl(ctl_prefix, "claim-code", "--json")
    if not ok:
        raise SystemExit("claim-admin: trunk-ctl claim-code: " + out)
    code = json.loads(out)["code"]
    c = Client(url, origin=origin, xff=xff)
    r = c.post("/t/claim/begin", {"code": code})
    if r.status != 200:
        raise SystemExit("claim-admin: begin: %r" % r)
    ticket = r.j("ticket")
    r = c.post("/t/claim/approve", {"ticket": ticket})
    if r.status != 200:
        raise SystemExit("claim-admin: approve: %r" % r)
    r = c.post("/t/auth/signup", {"ticket": ticket, "email": email, "password": password})
    if r.status != 200:
        raise SystemExit("claim-admin: signup: %r" % r)
    secret = r.j("secret")
    code, step = totp_fresh(secret, 0)
    r = c.post("/t/auth/totp/confirm", {"ticket": ticket, "code": code})
    if r.status != 200:
        raise SystemExit("claim-admin: totp confirm: %r" % r)
    return {
        "url": url,
        "origin": c.origin,
        "email": email,
        "password": password,
        "totp_secret": secret,
        "last_step": step,
        "recovery_codes": r.j("recovery_codes"),
        "device": r.j("device"),
        "cookies": {k: v for k, (v, _) in c.jar.items()},
    }, c


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True, help="where to reach the trunk (http://127.0.0.1:PORT)")
    ap.add_argument("--ctl", default="trunk-ctl", help='console command prefix, e.g. "bifrost-net trunk-ctl --sock X"')
    ap.add_argument("--origin", default=None, help="the trunk's public_url (the Origin its writes need); default --url")
    ap.add_argument("--email", default="owner@example.org")
    ap.add_argument("--xff", default=None, help="X-Forwarded-For to send (the trunk believes it from trusted_proxies)")
    a = ap.parse_args()
    out, _ = claim(a.url, a.ctl, a.origin, a.email, xff=a.xff)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
