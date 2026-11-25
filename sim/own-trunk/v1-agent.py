#!/usr/bin/env python3
"""v1-agent.py — scripted agent for G4.1 (sim/own-trunk-e2e.sh).

Subcommands:
  claim   --url https://trunk --code 123456 --cookies cookies.json [--cacert CA]
          POST /t/claim/begin → approve → signup → totp/confirm; writes cookies.json (0600).
  approve --url https://trunk --cookies cookies.json [--name NAME] [--timeout 60] [--cacert CA]
          Polls GET /t/roots/pending until an enrollment appears, approves it (with Origin),
          prints the approved enrollment id.
  roots   --url https://trunk --cookies cookies.json [--cacert CA]
          GET /t/roots → prints JSON.
"""
import argparse, base64, hashlib, hmac, json, os, ssl, struct, sys, time, urllib.error, urllib.parse, urllib.request


def totp_now(secret_b32):
    pad = "=" * ((8 - len(secret_b32) % 8) % 8)
    key = base64.b32decode(secret_b32.upper() + pad)
    step = int(time.time()) // 30
    mac = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    num = struct.unpack(">I", mac[off : off + 4])[0] & 0x7FFFFFFF
    return "%06d" % (num % 1_000_000)


class Client:
    def __init__(self, url, cacert=None, cookies=None):
        self.url = url.rstrip("/")
        o = urllib.parse.urlsplit(self.url)
        self.origin = f"{o.scheme}://{o.netloc}"
        self.cookies = dict(cookies or {})
        self.ctx = ssl.create_default_context(cafile=cacert) if cacert else ssl.create_default_context()

    def req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        h = {"accept": "application/json", "user-agent": "own-trunk-e2e/1"}
        if data is not None:
            h["content-type"] = "application/json"
            h["origin"] = self.origin
        if self.cookies:
            h["cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=20) as r:
                st, raw, hdrs = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            st, raw, hdrs = e.code, e.read(), e.headers
        for sc in hdrs.get_all("Set-Cookie") or []:
            kv = sc.split(";", 1)[0]
            if "=" in kv:
                k, v = kv.split("=", 1)
                self.cookies[k.strip()] = v.strip()
        try:
            js = json.loads(raw.decode() or "{}")
        except ValueError:
            js = {"raw": raw.decode(errors="replace")}
        return st, js


def cmd_claim(args):
    c = Client(args.url, args.cacert)
    st, r = c.req("POST", "/t/claim/begin", {"code": args.code.replace("-", "").strip()})
    if st != 200 or "ticket" not in r:
        sys.exit(f"claim/begin failed: {st} {r}")
    ticket = r["ticket"]
    st, r = c.req("POST", "/t/claim/approve", {"ticket": ticket})
    if st != 200:
        sys.exit(f"claim/approve failed: {st} {r}")
    st, r = c.req("POST", "/t/auth/signup", {
        "ticket": ticket,
        "email": args.email,
        "password": args.password,
    })
    if st != 200 or "secret" not in r:
        sys.exit(f"auth/signup failed: {st} {r}")
    code = totp_now(r["secret"])
    st, r = c.req("POST", "/t/auth/totp/confirm", {"ticket": ticket, "code": code})
    if st != 200 or len(r.get("recovery_codes", [])) != 10:
        sys.exit(f"auth/totp/confirm failed: {st} {r}")
    fd = os.open(args.cookies, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(c.cookies, f)
    print(json.dumps({"claimed": True, "recovery_count": len(r["recovery_codes"])}))


def cmd_approve(args):
    cookies = json.load(open(args.cookies))
    c = Client(args.url, args.cacert, cookies)
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        st, pending = c.req("GET", "/t/roots/pending")
        if st == 200 and isinstance(pending, list) and pending:
            item = pending[0]
            eid = item["id"]
            body = {}
            if args.name:
                body["name"] = args.name
            st2, r2 = c.req("POST", f"/t/roots/enroll/{eid}/approve", body)
            if st2 == 200:
                print(json.dumps({"approved": eid, "result": r2}))
                return
            sys.exit(f"approve {eid} failed: {st2} {r2}")
        time.sleep(0.5)
    sys.exit("timeout waiting for pending root enrollment")


def cmd_roots(args):
    cookies = json.load(open(args.cookies))
    c = Client(args.url, args.cacert, cookies)
    st, r = c.req("GET", "/t/roots")
    if st != 200:
        sys.exit(f"GET /t/roots failed: {st} {r}")
    print(json.dumps(r))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("claim")
    p1.add_argument("--url", required=True)
    p1.add_argument("--code", required=True)
    p1.add_argument("--cookies", required=True)
    p1.add_argument("--cacert")
    p1.add_argument("--email", default="owner@tree.test")
    p1.add_argument("--password", default="correct-horse-battery-staple-99!")
    p1.set_defaults(fn=cmd_claim)

    p2 = sub.add_parser("approve")
    p2.add_argument("--url", required=True)
    p2.add_argument("--cookies", required=True)
    p2.add_argument("--name")
    p2.add_argument("--timeout", type=int, default=60)
    p2.add_argument("--cacert")
    p2.set_defaults(fn=cmd_approve)

    p3 = sub.add_parser("roots")
    p3.add_argument("--url", required=True)
    p3.add_argument("--cookies", required=True)
    p3.add_argument("--cacert")
    p3.set_defaults(fn=cmd_roots)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
