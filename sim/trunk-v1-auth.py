#!/usr/bin/env python3
"""trunk-v1-auth.py — G3.7: the v1 trunk's §8 security requirements as tests (M1 parts).

A real `bifrost-net trunk` (TRUNK_TEST_FAST=1: minutes become seconds, counts unchanged) on a free
loopback port in 18800–18899, its own state dir, trusted_proxies = 127.0.0.1 so each case speaks
from its own client address (X-Forwarded-For). Nothing live is touched.

  surface   unclaimed redirects, security headers + the §8 CSP, P12 (chunked 411, conflicting
            Content-Length 400), canonical paths only, ACME name rule, ctl socket + claim file 0600
  csrf      every write without the trunk's Origin → 403 (and changes nothing)
  claim     5 wrong codes in total across rotations AND a restart → locked; the right code is
            refused while locked; claim-reset; refuse burns the ticket; signup before approve 409;
            password rules (length, the top-100k list); TOTP confirm; 410 forever after
  generic   unknown email vs wrong password: same status, same body, same argon2 time
  lockouts  password 5 → 1 min doubling (fast: 1 s, 2 s); TOTP 5 → 15 min (fast 15 s), still
            locked after a restart; per /24 20 failures → 429 (another /24 unaffected)
  replays   TOTP step reuse; recovery code reuse; refresh theft (replay past the 30 s grace →
            device revoked, its newest tokens dead); a replay inside the grace is not theft
  tokens    access expiry → refresh; region change → refresh (policy "refresh"); kill epoch n/a
  step-up   fresh 600 s (fast 10 s) gates 2FA changes; step-up by TOTP; password change
  console   account list / reset-password / reset-2fa (→ enrol at next sign-in) / unlock,
            backup + backup check, audit verify; an edited audit row is caught
  devices   /t/devices list, rename, role with the 2fa-on-device rule, revoke (burns refresh
            lineage), member sees only itself, console devices list|revoke
  pair      QR mint/status/regenerate (kills the old token)/close (burns)/redeem → member device;
            replay 410 used; member and no-token cannot mint
  kill      kill-switch: everything revoked, QRs burned, epoch moved, lockdown blocks sign-in,
            unlock; audit chain still verifies
  audit     /t/audit rows, limit/before/action filter, chain_ok; member 403
  roots     has_roots flips with WIRE's first root row; then pages go to the door (/offline)
  helper    sim/trunk-v1/claim-admin.py claims a second trunk end to end
  tls       the phase-2 listener: PROXY v1 believed only from trusted_proxies, then TLS; the client
            address is the PROXY line's (XFF ignored)
  passkeys  (M4, Chromium + CDP virtual authenticator) enrol on /account (step-up first), sign in
            with the passkey alone (→ admin device), password + passkey as the second factor; forged
            assertions signed with the credential's own key: another origin, another RP ID, no UV, a
            counter that did not move, a used or wrong-kind challenge, webauthn.create, bad signatures
            ×5 → lockout; a cloned authenticator (old counter) refused on /login; step-up by passkey;
            remove; audit chain
  oauth     (M4) a mock OpenID Connect provider + a GitHub-shaped app (sim/trunk-v1/mock-oidc.cjs,
            18890–18899): the claim through each (mandatory TOTP before the claim completes), sign-in
            + second factor; refused and audited: unknown/replayed/other-browser state, wrong nonce,
            another key, alg none, other issuer/audience/azp, expired, email_verified false or missing,
            an unbound identity, a cancel, an unpublished kid; a rotated key re-fetches the JWKS;
            ES256; lockdown; no secret in any file but its own
  load      (M4) 50 concurrent password sign-ins against a trunk pinned to one CPU
  kill-live (fix) a real door root (bridge [trunk], enrolled through the API) serves held event
            streams to an admin and a member device; POST /t/kill → both cut ≤ 1 s, the root's
            halves end, the old token is refused; lockdown, unlock

    sim/trunk-v1-auth.py [--bin trunk/target/release/bifrost-net] [--keep]

Exit 0 = every check passed. Prints PASS/FAIL per check and a summary line.
"""
import argparse, json, os, shutil, sqlite3, statistics, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "trunk-v1"))
from trunklib import REPO, Client, Trunk, step_now, totp_at, totp_fresh  # noqa: E402

FAILS, PASSES = [], []
EMAIL = "owner@example.org"
PASSWORD = "correct horse battery staple 7"


def check(name, ok, detail=""):
    print("%s %s%s" % ("PASS" if ok else "FAIL", name, (" — " + str(detail)) if detail and not ok else ""), flush=True)
    (PASSES if ok else FAILS).append(name)
    return ok


def ip(net, host=7):
    """A client address in its own /24, all in one region (cgnat) so tokens stay valid."""
    return "100.64.%d.%d" % (net, host)


class State:
    totp = None
    last_step = 0
    recovery = []
    admin = None  # Client with the admin's cookies

    def code(self):
        c, s = totp_fresh(self.totp, self.last_step)
        self.last_step = s
        return c

    def recovery_code(self):
        return self.recovery.pop()


S = State()


def raw_http(t, text):
    """One raw request on its own connection; (status, everything the trunk sent)."""
    import socket
    with socket.create_connection(("127.0.0.1", t.port), timeout=10) as s:
        s.sendall(text.encode())
        buf = b""
        while True:
            try:
                b = s.recv(65536)
            except socket.timeout:
                break
            if not b:
                break
            buf += b
    try:
        return int(buf.split(b" ", 2)[1]), buf
    except (IndexError, ValueError):
        return 0, buf


def wait_until(pred, timeout, every=0.2):
    end = time.time() + timeout
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(every)
    return None


def claim_code_from_file(t):
    with open(os.path.join(t.root, "cred", "claim")) as f:
        return json.load(f)["code"]


def wrong(code):
    return "%06d" % ((int(code) + 1) % 1_000_000)


def login(t, xff, email=EMAIL, password=None, second=None):
    """Sign in a new browser; returns (client, mfa response)."""
    password = password or PASSWORD
    c = t.client(xff=xff)
    r = c.post("/t/auth/login", {"email": email, "password": password})
    if r.status != 200:
        return c, r
    body = {"mfa_ticket": r.j("mfa_ticket")}
    body.update(second or {"totp": S.code()})
    m = c.post("/t/auth/mfa", body)
    return c, m


# ---------------------------------------------------------------------------------------------

def t_surface(t):
    c = t.client(xff=ip(1))
    r = c.get("/t/state")
    check("surface: /t/state unclaimed", r.status == 200 and r.data == {"claimed": False, "has_roots": False, "lockdown": False, "providers": []}, r)
    h = r.headers
    check("surface: HSTS, nosniff, no-referrer on the API", h.get("Strict-Transport-Security") == "max-age=31536000" and h.get("X-Content-Type-Options") == "nosniff" and h.get("Referrer-Policy") == "no-referrer", dict(h))
    check("surface: one request per connection", h.get("Connection") == "close")
    for path in ("/", "/login", "/account"):
        r = c.get(path, headers={"accept": "text/html"})
        check("surface: unclaimed %s → 302 /claim" % path, r.status == 302 and r.headers.get("Location") == "/claim", r)
    r = c.get("/claim", headers={"accept": "text/html"})
    csp = r.headers.get("Content-Security-Policy")
    check("surface: /claim page with the §8 CSP", r.status == 200 and csp == "default-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", csp)
    check("surface: page is the utopia look, no inline script", 'data-theme="utopia"' in r.data and "/t/s/brand.css" in r.data and "<script src=\"/t/s/shell.js\"" in r.data and r.data.count("<script") == 1)
    for a, ct in (("tokens.css", "text/css"), ("brand.css", "text/css"), ("shell.js", "text/javascript"), ("CommitMono-400-Regular.otf", "font/otf")):
        r = c.get("/t/s/" + a)
        check("surface: asset %s" % a, r.status == 200 and (r.headers.get("Content-Type") or "").startswith(ct), r.status)
    origin = t.public_url
    st, _ = raw_http(t, "POST /t/claim/begin HTTP/1.1\r\nHost: x\r\nOrigin: %s\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n" % origin)
    check("surface: P12 chunked body → 411", st == 411, st)
    st, _ = raw_http(t, "POST /t/claim/begin HTTP/1.1\r\nHost: x\r\nOrigin: %s\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}" % origin)
    check("surface: P12 conflicting content-length → 400", st == 400, st)
    st, rest = raw_http(t, "GET /t/state HTTP/1.1\r\nHost: x\r\n\r\nGET /t/state HTTP/1.1\r\nHost: x\r\n\r\n")
    check("surface: P12 a pipelined second request is never answered", st == 200 and rest.count(b"HTTP/1.1 ") == 1, rest[:200])
    r = c.get("/T/state")
    check("surface: a non-canonical path into /t is a 404 (never relayed)", r.status == 404, r)
    r = c.get("/x/../t/state")
    check("surface: dot segments into /t are a 404", r.status in (400, 404), r)
    os.makedirs(os.path.join(t.root, "acme", ".well-known", "acme-challenge"), exist_ok=True)
    tok = "abcdefghijklmnop_-1234"
    with open(os.path.join(t.root, "acme", ".well-known", "acme-challenge", tok), "w") as f:
        f.write("tok.thumb")
    r = c.get("/.well-known/acme-challenge/" + tok)
    check("surface: ACME token served from the webroot", r.status == 200 and r.data == "tok.thumb", r)
    r = c.get("/.well-known/acme-challenge/short")
    check("surface: ACME name rule ([A-Za-z0-9_-]{16,128})", r.status == 404, r)
    r = c.get("/install/root.sh")
    check("surface: /install/root.sh is INSTALL's real script and names this trunk", r.status == 200 and t.public_url in str(r.data) and str(r.data).startswith("#!"), r.status)
    mode = lambda p: oct(os.stat(p).st_mode & 0o777)
    check("surface: ctl socket 0600", mode(t.sock) == "0o600", mode(t.sock))
    check("surface: claim code file 0600", mode(os.path.join(t.root, "cred", "claim")) == "0o600")
    ok, out = t.ctl("claim-code", "--json")
    j = json.loads(out) if ok else {}
    check("surface: trunk-ctl claim-code --json", ok and len(j.get("code", "")) == 6 and j.get("attempts_left") == 5 and j.get("url") == t.public_url, out)


def t_csrf(t):
    c = t.client(xff=ip(2))
    code = claim_code_from_file(t)
    r = c.post("/t/claim/begin", {"code": code}, origin=False)
    check("csrf: claim/begin without Origin → 403", r.status == 403 and r.j("why") == "origin", r)
    r = c.post("/t/claim/begin", {"code": code}, origin="https://evil.example")
    check("csrf: claim/begin from another origin → 403", r.status == 403, r)
    r = c.post("/t/claim/begin", {"code": code}, origin=t.public_url + ".evil.example")
    check("csrf: an origin that only starts like ours → 403", r.status == 403, r)
    ok, out = t.ctl("claim-code", "--json")
    check("csrf: refused writes changed nothing (5 tries left)", ok and json.loads(out)["attempts_left"] == 5, out)


def t_claim_lockout(t):
    c = t.client()
    code = claim_code_from_file(t)
    r = c.post("/t/claim/begin", {"code": wrong(code)}, xff=ip(10))
    check("claim: wrong code 1 → 401, 4 left", r.status == 401 and r.j("left") == 4, r)
    r = c.post("/t/claim/begin", {"code": wrong(code)}, xff=ip(11))
    check("claim: wrong code 2 (another address) → 3 left", r.status == 401 and r.j("left") == 3, r)
    t.stop()
    t.start()
    ok, out = t.ctl("claim-code", "--json")
    check("claim: the count survives a restart (3 left)", ok and json.loads(out)["attempts_left"] == 3, out)
    first = claim_code_from_file(t)
    rotated = wait_until(lambda: claim_code_from_file(t) != first and claim_code_from_file(t), 9)
    check("claim: the code rotates (fast: 5 s)", bool(rotated))
    code = claim_code_from_file(t)
    r1 = c.post("/t/claim/begin", {"code": wrong(code)}, xff=ip(12))
    r2 = c.post("/t/claim/begin", {"code": wrong(code)}, xff=ip(13))
    check("claim: wrong codes 3 and 4 across the rotation → 1 left", r1.status == 401 and r2.j("left") == 1, (r1, r2))
    prev = claim_code_from_file(t)
    wait_until(lambda: claim_code_from_file(t) != prev, 9)
    code = claim_code_from_file(t)
    r = c.post("/t/claim/begin", {"code": wrong(code)}, xff=ip(14))
    check("claim: the 5th wrong code in total → locked (423)", r.status == 423 and r.j("why") == "locked", r)
    r = c.post("/t/claim/begin", {"code": claim_code_from_file(t)}, xff=ip(15))
    check("claim: the right code is refused while locked", r.status == 423, r)
    ok, out = t.ctl("claim-code", "--json")
    check("claim: claim-code refuses while locked", not ok and "claim-reset" in out, out)
    ok, out = t.ctl("claim-reset")
    check("claim: trunk-ctl claim-reset", ok, out)
    ok, out = t.ctl("claim-code", "--json")
    code = json.loads(out)["code"] if ok else ""
    r = c.post("/t/claim/begin", {"code": code}, xff=ip(16))
    check("claim: after the reset the right code gives a ticket", r.status == 200 and len(r.j("ticket", "")) == 43 and r.j("url", "").startswith(t.public_url + "/claim#t="), r)
    ticket = r.j("ticket")
    r = c.post("/t/claim/begin", {"code": code}, xff=ip(16))
    check("claim: a code that began a claim is spent", r.status == 401, r)
    r = c.post("/t/claim/refuse", {"ticket": ticket}, xff=ip(16))
    check("claim: refuse", r.status == 200, r)
    r = c.post("/t/claim/ticket", {"ticket": ticket}, xff=ip(16))
    check("claim: a refused ticket is dead", r.status == 401 and r.j("why") == "ticket", r)
    ok, out = t.ctl("audit", "tail", "40")
    acts = [json.loads(l)["action"] for l in out.splitlines()] if ok else []
    check("claim: audit has wrong codes, the lock, the reset, begin, refuse",
          all(a in acts for a in ("claim.wrong_code", "claim.locked", "claim.reset", "claim.begin", "claim.refuse")), acts)


def t_claim_flow(t):
    c = t.client(xff=ip(20))
    ok, out = t.ctl("claim-code", "--json")
    code = json.loads(out)["code"]
    r = c.post("/t/claim/begin", {"code": code})
    ticket = r.j("ticket")
    r = c.post("/t/claim/ticket", {"ticket": ticket})
    check("claim: the page shows the agent's digits", r.status == 200 and r.j("code") == code[:3] + "-" + code[3:] and r.j("state") == "begun" and r.j("via") == "agent", r)
    r = c.post("/t/auth/signup", {"ticket": ticket, "email": EMAIL, "password": PASSWORD})
    check("claim: signup before approve → 409", r.status == 409, r)
    r = c.post("/t/claim/approve", {"ticket": ticket})
    check("claim: approve", r.status == 200, r)
    r = c.post("/t/auth/signup", {"ticket": "x" * 43, "email": EMAIL, "password": PASSWORD})
    check("claim: signup needs the ticket", r.status == 401, r)
    r = c.post("/t/auth/signup", {"ticket": ticket, "email": EMAIL, "password": "short pw"})
    check("claim: password under 12 characters refused", r.status == 400 and "12" in r.j("error", ""), r)
    r = c.post("/t/auth/signup", {"ticket": ticket, "email": EMAIL, "password": "Q1W2E3R4T5Y6"})
    check("claim: a password from the top-100k list refused (any case)", r.status == 400 and "100,000" in r.j("error", ""), r)
    r = c.post("/t/auth/signup", {"ticket": ticket, "email": EMAIL, "password": "x" * 129})
    check("claim: password over 128 characters refused", r.status == 400, r)
    r = c.post("/t/auth/signup", {"ticket": ticket, "email": "not-an-email", "password": PASSWORD})
    check("claim: a bad email refused", r.status == 400, r)
    r = c.post("/t/auth/signup", {"ticket": ticket, "email": EMAIL, "password": PASSWORD})
    uri = r.j("totp_uri", "")
    check("claim: signup → totp_uri (SHA1/6/30) + QR", r.status == 200 and uri.startswith("otpauth://totp/") and "algorithm=SHA1&digits=6&period=30" in uri and r.j("qr_svg", "").lstrip().startswith(("<svg", "<?xml")), r.status)
    S.totp = r.j("secret")
    check("claim: 160-bit seed", len(S.totp) == 32)
    st = c.get("/t/state")
    check("claim: not claimed before TOTP is confirmed", st.j("claimed") is False, st)
    r = c.post("/t/auth/totp/confirm", {"ticket": ticket, "code": wrong(totp_at(S.totp, step_now()))})
    check("claim: a wrong TOTP code → 401", r.status == 401, r)
    r = c.post("/t/auth/totp/confirm", {"ticket": ticket, "code": S.code()})
    codes = r.j("recovery_codes", [])
    check("claim: TOTP confirm → 10 recovery codes, shown once", r.status == 200 and len(codes) == 10 and len(set(codes)) == 10 and all(len(x) == 9 and x[4] == "-" for x in codes), r)
    check("claim: cookies set (access on /, refresh on /t/auth)", c.jar.get("bifrost_device", ("", ""))[1] == "/" and c.jar.get("bifrost_refresh", ("", ""))[1] == "/t/auth", c.jar)
    sc = " ".join(r.headers.get_all("Set-Cookie") or [])
    check("claim: cookies HttpOnly; Secure; SameSite=Strict", sc.count("HttpOnly") == 2 and sc.count("Secure") == 2 and sc.count("SameSite=Strict") == 2, sc)
    S.recovery = list(codes)
    S.admin = c
    r = c.get("/t/me")
    check("claim: the claiming browser is the admin device", r.status == 200 and r.j("account")["role"] == "admin" and r.j("device")["created_via"] == "claim" and r.j("device")["fresh"] is True, r)
    check("claim: /t/state claimed", c.get("/t/state").j("claimed") is True)
    r = c.get("/claim", headers={"accept": "text/html"})
    check("claim: /claim → 410 forever", r.status == 410 and "claimed" in r.data, r.status)
    r = t.client(xff=ip(21)).post("/t/claim/begin", {"code": code})
    check("claim: /t/claim/begin → 410", r.status == 410, r)
    r = t.client(xff=ip(21)).post("/t/auth/signup", {"ticket": ticket, "email": "other@example.org", "password": PASSWORD})
    check("claim: nobody else can register (403)", r.status == 403, r)
    ok, out = t.ctl("claim-code", "--json")
    check("claim: claim-code says claimed", not ok and "claimed" in out, out)
    check("claim: the claim code file is gone (rotation stopped)", not os.path.exists(os.path.join(t.root, "cred", "claim")))


def t_pages_signed_in(t):
    c = S.admin
    r = c.get("/", headers={"accept": "text/html"})
    check("pages: / signed in, no roots → the empty-trunk page", r.status == 200 and 'data-page="empty"' in r.data and ("curl -fsSL %s/install/root.sh | bash" % t.public_url) in r.data, r.status)
    r = c.get("/login", headers={"accept": "text/html"})
    check("pages: /login when signed in → 302 /", r.status == 302 and r.headers.get("Location") == "/", r)
    r = c.get("/account", headers={"accept": "text/html"})
    check("pages: /account signed in", r.status == 200 and 'data-page="account"' in r.data, r.status)
    anon = t.client(xff=ip(22))
    r = anon.get("/", headers={"accept": "text/html"})
    check("pages: / without a token → 302 /login", r.status == 302 and r.headers.get("Location") == "/login", r)
    r = anon.get("/account", headers={"accept": "text/html"})
    check("pages: /account without a token → /login?next=/account", r.status == 302 and r.headers.get("Location") == "/login?next=/account", r)
    r = anon.get("/sessions/abc", headers={"accept": "text/html"})
    check("pages: a door page without a token → /login?next=<it> (the login page refreshes first)", r.status == 302 and r.headers.get("Location") == "/login?next=/sessions/abc", r)
    r = anon.get("/api/session")
    check("pages: an API call without a token → 401 {why: missing, reauth: login}", r.status == 401 and r.data == {"why": "missing", "reauth": "login"}, r)
    r = c.get("/api/session")
    check("pages: an API call signed in, no root yet → 503", r.status == 503 and r.j("why") == "no-roots", r)


def t_generic(t):
    known, unknown = [], []
    for i in range(8):
        a = t.client(xff=ip(30 + i)).post("/t/auth/login", {"email": "nobody%d@example.org" % i, "password": PASSWORD + "x"})
        b = t.client(xff=ip(40 + i)).post("/t/auth/login", {"email": EMAIL, "password": PASSWORD + "x"})
        unknown.append(a)
        known.append(b)
        if i % 4 == 3:
            t.ctl("account", "unlock")
    check("generic: unknown email and wrong password answer alike",
          all(x.status == 401 for x in known + unknown) and len({json.dumps(x.data, sort_keys=True) for x in known + unknown}) == 1, (known[0], unknown[0]))
    mk, mu = statistics.median(x.dt for x in known), statistics.median(x.dt for x in unknown)
    check("generic: same argon2 time (median %.0f ms vs %.0f ms)" % (mk * 1000, mu * 1000), 0.5 <= mu / mk <= 2.0, (mk, mu))
    t.ctl("account", "unlock")


def t_password_lockout(t):
    c = t.client(xff=ip(50))
    for _ in range(4):
        c.post("/t/auth/login", {"email": EMAIL, "password": "wrong password one"})
    r = c.post("/t/auth/login", {"email": EMAIL, "password": "wrong password one"})
    check("lockout: password 5 wrong → 429 (1 min; fast 1 s)", r.status == 429 and r.j("retry_after") == 1, r)
    r = t.client(xff=ip(51)).post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    check("lockout: the right password is refused during the lock (any address)", r.status == 429, r)
    time.sleep(1.2)
    for _ in range(4):
        c.post("/t/auth/login", {"email": EMAIL, "password": "wrong password two"})
    r = c.post("/t/auth/login", {"email": EMAIL, "password": "wrong password two"})
    check("lockout: the next 5 → doubled (fast 2 s)", r.status == 429 and r.j("retry_after") == 2, r)
    time.sleep(2.2)
    r = c.post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    check("lockout: after the lock the right password works", r.status == 200 and r.j("mfa_ticket"), r)
    for _ in range(5):
        r = c.post("/t/auth/login", {"email": EMAIL, "password": "wrong password three"})
    check("lockout: a success starts the doubling again (fast 1 s)", r.status == 429 and r.j("retry_after") == 1, r)
    time.sleep(1.2)


def t_mfa(t):
    c = t.client(xff=ip(60))
    r = c.post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    check("mfa: password → mfa_ticket (no cookies yet)", r.status == 200 and r.j("mfa") == ["totp", "recovery"] and not c.jar, r)
    ticket = r.j("mfa_ticket")
    code = S.code()
    m = c.post("/t/auth/mfa", {"mfa_ticket": ticket, "totp": code})
    check("mfa: TOTP → signed in as a new admin device", m.status == 200 and "bifrost_device" in c.jar and c.get("/t/me").j("device")["created_via"] == "login", m)
    c2 = t.client(xff=ip(61))
    r = c2.post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    m = c2.post("/t/auth/mfa", {"mfa_ticket": r.j("mfa_ticket"), "totp": code})
    check("mfa: the same TOTP step twice → refused", m.status == 401, m)
    m = c.post("/t/auth/mfa", {"mfa_ticket": ticket, "totp": S.code()})
    check("mfa: an mfa ticket works once", m.status == 401 and m.j("why") == "ticket", m)
    rc = S.recovery_code()
    m = c2.post("/t/auth/mfa", {"mfa_ticket": r.j("mfa_ticket"), "recovery": rc.lower().replace("-", "")})
    check("mfa: a recovery code (any case, no dash) → in, 9 left", m.status == 200 and m.j("recovery_left") == 9, m)
    c3 = t.client(xff=ip(62))
    r = c3.post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    m = c3.post("/t/auth/mfa", {"mfa_ticket": r.j("mfa_ticket"), "recovery": rc})
    check("mfa: a used recovery code → refused", m.status == 401, m)
    # TOTP lockout: 5 wrong (the used recovery code above was the 1st) → 15 min (fast 15 s)
    t4 = r.j("mfa_ticket")
    for i in range(3):
        c3.post("/t/auth/mfa", {"mfa_ticket": t4, "totp": "000000" if i else "999999"})
    m = c3.post("/t/auth/mfa", {"mfa_ticket": t4, "totp": "123456"})
    check("lockout: TOTP/recovery 5 wrong → 429 (15 min; fast 15 s)", m.status == 429 and 14 <= m.j("retry_after", 0) <= 15, m)
    m = c3.post("/t/auth/mfa", {"mfa_ticket": t4, "totp": totp_at(S.totp, step_now() + 1)})
    check("lockout: the right code is refused during the lock", m.status == 429, m)
    t.stop()
    t.start()
    c5 = t.client(xff=ip(63))
    r = c5.post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    m = c5.post("/t/auth/mfa", {"mfa_ticket": r.j("mfa_ticket"), "recovery": S.recovery[-1]})
    check("lockout: still locked after a restart (persisted)", m.status == 429, m)
    ok, out = t.ctl("account", "unlock")
    check("console: account unlock", ok and "unlocked" in out, out)
    m = c5.post("/t/auth/mfa", {"mfa_ticket": r.j("mfa_ticket"), "recovery": S.recovery_code()})
    check("mfa: unlocked → in", m.status == 200, m)
    S.admin = c5


def t_net(t):
    hits = []
    for i in range(20):
        hits.append(t.client(xff="100.64.99.%d" % (10 + i)).post("/t/auth/login", {"email": "probe%d@example.org" % i, "password": "not the password"}))
    check("lockout: per /24 — the 20th failure in an hour → 429", all(h.status == 401 for h in hits[:19]) and hits[19].status == 429, [h.status for h in hits])
    r = t.client(xff="100.64.99.200").post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    check("lockout: per /24 — even the right password from that /24 → 429", r.status == 429, r)
    r = t.client(xff="100.64.98.1").post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    check("lockout: per /24 — another /24 is unaffected", r.status == 200, r)


def t_refresh(t):
    c, m = login(t, ip(70), second={"recovery": S.recovery_code()})
    me = c.get("/t/me").j("device")["id"]
    r0 = c.jar["bifrost_refresh"][0]
    r = c.post("/t/auth/refresh")
    r1 = c.jar["bifrost_refresh"][0]
    check("refresh: rotates (a new refresh and access cookie)", r.status == 200 and r1 != r0, r)
    # A7: the body carries the new access token (for pinned.ts over the tunnel); never the bfnr-
    at = r.j("access_token", "")
    check("refresh: body carries access_token = the new cookie (A7)", r.status == 200 and at.startswith("v4.public.") and at == c.jar["bifrost_device"][0], (at[:20], c.jar.get("bifrost_device", ("",))[0][:20]))
    check("refresh: the bfnr- refresh token never appears in the body", "bfnr-" not in json.dumps(r.data), json.dumps(r.data)[:80])
    check("refresh: the refresh cookie is sent only to /t/auth", "bifrost_refresh" not in c.cookie_header("/t/me") and "bifrost_refresh" in c.cookie_header("/t/auth/refresh"))
    racer = t.client(xff=ip(70))
    racer.jar["bifrost_refresh"] = (r0, "/t/auth")
    r = racer.post("/t/auth/refresh")
    check("refresh: the replaced token inside the 30 s grace (two tabs) → rotates, no revoke", r.status == 200 and c.get("/t/me").status == 200, r)
    time.sleep(3.3)
    thief = t.client(xff=ip(71))
    thief.jar["bifrost_refresh"] = (r0, "/t/auth")
    r = thief.post("/t/auth/refresh")
    check("replay: a replaced refresh token past the grace → 401 revoked (theft)", r.status == 401 and r.j("why") == "revoked" and r.j("reauth") == "login", r)
    r = c.get("/t/me")
    check("replay: the owner's access token is dead too (device revoked)", r.status == 401 and r.j("why") == "revoked", r)
    r = racer.post("/t/auth/refresh")
    check("replay: the newest refresh token of that device is dead", r.status == 401, r)
    ok, out = t.ctl("audit", "tail", "5")
    check("replay: audit says theft", ok and any(json.loads(l).get("target_id") == me and "theft" in json.dumps(json.loads(l)["detail"]) for l in out.splitlines()), out[-400:])


def t_expiry_region(t):
    c, m = login(t, ip(80), second={"recovery": S.recovery_code()})
    check("tokens: signed in", m.status == 200, m)
    time.sleep(20.5)
    r = c.get("/t/me")
    check("tokens: access expires (15 min; fast 20 s) → 401 expired, reauth refresh", r.status == 401 and r.data == {"why": "expired", "reauth": "refresh"}, r)
    r = c.get("/", headers={"accept": "text/html"})
    check("tokens: an expired token on a page → 302 /login", r.status == 302, r)
    r = c.post("/t/auth/refresh")
    check("tokens: refresh → a new access token", r.status == 200 and c.get("/t/me").status == 200, r)
    r = c.get("/t/me", xff="8.8.4.4")
    check("tokens: from another region → 401 region, reauth refresh", r.status == 401 and r.data == {"why": "region", "reauth": "refresh"}, r)
    r = c.post("/t/auth/refresh", xff="8.8.4.4")
    check("tokens: refresh from the new region (policy refresh) → in", r.status == 200 and c.get("/t/me", xff="8.8.4.4").status == 200, r)
    r = c.get("/t/me")
    check("tokens: the new token is bound to the new region", r.status == 401 and r.j("why") == "region", r)
    S.admin = c
    S.admin.xff = "8.8.4.4"


def t_step_up(t):
    c, m = login(t, ip(90))
    r = c.signed("POST", "/t/account/recovery/regenerate", {})
    check("step-up: fresh after sign-in → recovery regenerate", r.status == 200 and len(r.j("recovery_codes", [])) == 10, r)
    S.recovery = list(r.j("recovery_codes", []))
    time.sleep(10.5)
    r = c.signed("POST", "/t/account/recovery/regenerate", {})
    check("step-up: stale (600 s; fast 10 s) → 403 step_up", r.status == 403 and r.j("step_up") is True, r)
    r = c.signed("POST", "/t/account/totp/reset", {})
    check("step-up: TOTP reset needs it too", r.status == 403 and r.j("step_up") is True, r)
    r = c.signed("POST", "/t/account/password", {"current": PASSWORD, "new": PASSWORD + "!"})
    check("step-up: a password change needs it too", r.status == 403, r)
    r = c.post("/t/auth/step-up", {"totp": "123456"}, origin=False)
    check("csrf: step-up without Origin → 403 (cookies alone are not enough)", r.status == 403 and r.j("why") == "origin", r)
    r = c.signed("POST", "/t/auth/step-up", {"totp": "000000"})
    check("step-up: a wrong code → 401", r.status == 401, r)
    r = c.signed("POST", "/t/auth/step-up", {"totp": S.code()})
    check("step-up: TOTP → fresh", r.status == 200 and c.signed("GET", "/t/me").j("device")["fresh"] is True, r)
    r = c.signed("POST", "/t/account/password", {"current": "not it at all", "new": PASSWORD + "!"})
    check("step-up: password change needs the current password", r.status == 401, r)
    r = c.signed("POST", "/t/account/password", {"current": PASSWORD, "new": "123qweasdzxc"})
    check("step-up: the new password follows the rules", r.status == 400, r)
    r = c.signed("POST", "/t/account/password", {"current": PASSWORD, "new": PASSWORD + "!"})
    check("step-up: password changed", r.status == 200, r)
    r = t.client(xff=ip(91)).post("/t/auth/login", {"email": EMAIL, "password": PASSWORD + "!"})
    check("step-up: the new password signs in", r.status == 200, r)
    r = t.client(xff=ip(92)).post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    check("step-up: the old one does not", r.status == 401, r)
    r = c.signed("GET", "/t/account")
    check("account: view", r.status == 200 and r.j("totp")["enrolled"] is True and r.j("recovery")["left"] == 10, r)
    return c


def t_logout(t, c):
    c.post("/t/auth/refresh")  # a live access token, so the check below sees "revoked", not "expired"
    access = c.jar["bifrost_device"][0]
    refresh = c.jar["bifrost_refresh"][0]
    r = c.post("/t/auth/logout")
    check("logout: cookies cleared", r.status == 200 and not c.jar, (r, c.jar))
    old = t.client(xff=ip(90))
    old.jar["bifrost_device"] = (access, "/")
    r = old.get("/t/me")
    check("logout: the old access token → 401 revoked", r.status == 401 and r.j("why") == "revoked", r)
    old.jar["bifrost_refresh"] = (refresh, "/t/auth")
    r = old.post("/t/auth/refresh")
    check("logout: the old refresh token → 401", r.status == 401, r)


def t_console(t):
    global PASSWORD
    ok, out = t.ctl("account", "list")
    a = json.loads(out.splitlines()[0]) if ok else {}
    check("console: account list", ok and a.get("email") == EMAIL and a.get("role") == "admin" and a.get("totp_enrolled_at"), out)
    ok, out = t.ctl("account", "reset-password")
    newpw = out.split(": ", 1)[1].split("\n")[0] if ok and ": " in out else ""
    check("console: reset-password prints a new one once", ok and len(newpw) == 24, out)
    r = t.client(xff=ip(100)).post("/t/auth/login", {"email": EMAIL, "password": newpw})
    check("console: the new password signs in (2FA still asked)", r.status == 200 and r.j("mfa") == ["totp", "recovery"], r)
    PASSWORD = newpw
    ok, out = t.ctl("account", "reset-2fa")
    check("console: reset-2fa", ok, out)
    c = t.client(xff=ip(101))
    r = c.post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    enroll = r.j("enroll") or {}
    check("console: after reset-2fa the sign-in enrols a new authenticator", r.status == 200 and enroll.get("totp_uri", "").startswith("otpauth://") and enroll.get("secret"), r)
    S.totp, S.last_step = enroll.get("secret"), 0
    m = c.post("/t/auth/mfa", {"mfa_ticket": r.j("mfa_ticket"), "totp": S.code()})
    check("console: enrolled → in, with 10 new recovery codes", m.status == 200 and len(m.j("recovery_codes", [])) == 10, m)
    S.recovery = list(m.j("recovery_codes", []))
    ok, out = t.ctl("backup")
    path = out.split("  ")[0] if ok else ""
    check("console: backup (encrypted, 0600)", ok and os.path.exists(path) and oct(os.stat(path).st_mode & 0o777) == "0o600" and open(path, "rb").read(8) == b"YGGTBK1\0", out)
    ok, out = t.ctl("backup", "check", path)
    check("console: backup check opens it", ok and "SQLite" in out, out)
    ok, out = t.ctl("audit", "verify")
    check("console: audit verify", ok and out.startswith("audit chain ok"), out)
    mirror = os.path.join(t.root, "audit")
    files = os.listdir(mirror) if os.path.isdir(mirror) else []
    check("audit: daily JSONL mirror, 0600", len(files) >= 1 and all(oct(os.stat(os.path.join(mirror, f)).st_mode & 0o777) == "0o600" for f in files), files)
    ok, out = t.ctl("audit", "tail", "1000")
    rows = [json.loads(l) for l in out.splitlines()] if ok else []
    acts = {r["action"] for r in rows}
    want = {"claim.begin", "claim.approve", "claim.complete", "account.create", "totp.enroll", "auth.login", "auth.login_fail", "lockout.password",
            "lockout.mfa", "lockout.net", "auth.step_up", "device.revoke", "account.password", "account.reset_password", "account.reset_2fa", "account.unlock", "backup"}
    check("audit: every auth, claim and lockout event", want <= acts, sorted(want - acts))
    check("audit: addresses truncated to /24, no secrets", all((r["ip"] or "x.0/24").endswith(("0/24", "::/48")) for r in rows) and PASSWORD not in out and S.totp not in out, "")


def t_tamper(t):
    t.stop()
    db = sqlite3.connect(os.path.join(t.root, "trunk.db"))
    seq = db.execute("SELECT seq FROM audit WHERE action = 'auth.login' ORDER BY seq LIMIT 1").fetchone()[0]
    db.execute("UPDATE audit SET actor_device = 'dev_someone_else' WHERE seq = ?", (seq,))
    db.commit()
    db.close()
    t.start()
    ok, out = t.ctl("audit", "verify")
    check("audit: an edited row is caught by trunk-ctl audit verify", not ok and ("entry %d" % seq) in out, out)


def t_devices_m3(t):
    """M3: /t/devices list, rename, role change (2FA-on-device rule), revoke, member visibility."""
    # a member device (joined through a QR minted by the console, for the rig)
    ok, out = t.ctl("pair-qr", "--json") if False else t.ctl("pair-qr")
    try:
        mj = json.loads(out) if ok else {}
    except ValueError:
        mj = {}
    check("devices: trunk-ctl pair-qr mints a member link (json)", ok and mj.get("url", "").startswith(t.public_url + "/pair#v=2&t=") and mj.get("role") == "member", out)
    phone = t.client(xff=ip(120))
    r = phone.post("/t/pair/redeem", {"token": mj.get("url", "").split("t=", 1)[1] if mj else ""})
    check("devices: a console QR redeems into a member device with cookies", r.status == 200 and "bifrost_device" in phone.jar and r.j("device", {}).get("role") == "member", r)
    member = phone
    # admin list
    admin, a = login(t, xff=ip(121), password=PASSWORD, second={"recovery": S.recovery_code()})
    check("devices: admin signs in for device management", a.status == 200, a)
    r = admin.get("/t/devices")
    check("devices: GET /t/devices (admin: every device + roots + itself)", r.status == 200 and r.j("role") == "admin" and len(r.j("devices", [])) >= 2 and r.j("self_id"), (r.status, len(r.j("devices", []))))
    devs = r.j("devices", [])
    try:
        mem_dev = next(d for d in devs if d["role"] == "member" and not d.get("revoked_at"))
    except StopIteration:
        mem_dev = None
        print("DEBUG devices:", json.dumps(devs)[:1200])
    my_id = r.j("self_id")
    # rename
    r = admin.signed("PATCH", "/t/devices/" + my_id, {"name": "Pixel 9"})
    check("devices: rename self", r.status == 200 and r.j("device", {}).get("name") == "Pixel 9", r)
    # role changes: the §8 rule — a device may become admin only if the admin's own 2FA happened
    # on THAT device (last_2fa_at set). The QR phone never had one → 403; the claim device did.
    qr_dev = mem_dev
    r = admin.signed("PATCH", "/t/devices/" + qr_dev["id"], {"role": "admin"})
    check("devices: promoting a QR phone (no 2FA on it) → 403 no-2fa-on-device", r.status == 403 and r.j("why") == "no-2fa-on-device", r)
    claim_dev = next((d for d in devs if d.get("created_via") == "claim" and not d.get("revoked_at")), None)
    if claim_dev:
        r = admin.signed("PATCH", "/t/devices/" + claim_dev["id"], {"role": "member"})
        check("devices: demoting the claim device (fresh) → ok", r.status == 200, r)
        r = admin.signed("PATCH", "/t/devices/" + claim_dev["id"], {"role": "admin"})
        check("devices: promoting it back (the admin's 2FA happened on it) → ok", r.status == 200, r)
    # member sees only itself
    r = member.get("/t/devices")
    check("devices: a member sees only itself", r.status == 200 and len(r.j("devices", [])) == 1 and r.j("role") == "member", r)
    # member cannot revoke/rename the admin's device
    admin_id = next((d["id"] for d in devs if d["role"] == "admin" and d["id"] != my_id), None) or my_id
    r = member.signed("DELETE", "/t/devices/" + admin_id, {})
    check("devices: a member cannot revoke someone else's device", r.status == 403, r)
    # rename someone else as member → 403
    if admin_id != my_id:
        r = member.signed("PATCH", "/t/devices/" + admin_id, {"name": "x"})
        check("devices: a member cannot rename someone else's device", r.status == 403, r)
    # admin revokes the member's phone
    r = admin.signed("DELETE", "/t/devices/" + (mem_dev or qr_dev)["id"], {})
    check("devices: admin revokes the phone", r.status == 200, r)
    r = member.get("/t/me")
    check("devices: the revoked phone's token is dead (401 revoked)", r.status == 401 and r.j("why") == "revoked", r)
    r = member.post("/t/auth/refresh")
    check("devices: its refresh token is dead too", r.status == 401, r)
    ok, out = t.ctl("devices", "list")
    check("devices: trunk-ctl devices list", ok and "Pixel 9" in out and "member" in out, out[:200])
    ok, out = t.ctl("devices", "revoke", my_id)
    check("devices: trunk-ctl devices revoke (this device: revokes and answers)", ok, out)
    r = admin.get("/t/me")
    check("devices: the console-revoked device is dead", r.status == 401 and r.j("why") == "revoked", r)


def t_pair_m3(t):
    """M3: the QR lifecycle — mint, status, regenerate kills the old token, close burns, replay 410/used."""
    admin, a = login(t, xff=ip(130), password=PASSWORD, second={"recovery": S.recovery_code()})
    check("pair: admin signs in", a.status == 200, a)
    r = admin.post("/t/pair/qr")
    check("pair: POST /t/pair/qr (admin, fresh) → id + token + qr", r.status == 200 and r.j("id") and r.j("token", "").startswith("bfnp-") and r.j("qr_svg", "").lstrip().startswith(("<svg", "<?xml")) and r.j("url", "").startswith(t.public_url + "/pair#v=2&t="), r)
    qr_id, tok1 = r.j("id"), r.j("token")
    check("pair: 16 B token (22 b64url chars)", len(tok1) == len("bfnp-") + 22, tok1)
    r = admin.get("/t/pair/qr/" + qr_id)
    check("pair: status waiting", r.status == 200 and r.j("status") == "waiting" and r.j("expires_in", 0) > 0, r)
    # regenerate kills the old token
    r = admin.post("/t/pair/qr/" + qr_id + "/regenerate")
    check("pair: regenerate → a new token (the old QR is dead)", r.status == 200 and r.j("token", "").startswith("bfnp-") and r.j("token") != tok1, r.j("id"))
    tok2 = r.j("token")
    phone = t.client(xff=ip(131))
    r = phone.post("/t/pair/redeem", {"token": tok1})
    check("pair: the regenerated-away token is dead (410)", r.status == 410, r)
    # second scan of the live one → 410 used
    r = phone.post("/t/pair/redeem", {"token": tok2})
    check("pair: redeem → member device + cookies", r.status == 200 and "bifrost_device" in phone.jar, r)
    r = t.client(xff=ip(132)).post("/t/pair/redeem", {"token": tok2})
    check("pair: a second scan → 410 used", r.status == 410 and r.j("why") == "used", r)
    r = admin.get("/t/pair/qr/" + qr_id)
    check("pair: the old QR's status says what happened (burned/regenerated)", r.status == 200 and r.j("status") in ("burned", "expired"), r)
    # mint a new one and close it: burned
    r = admin.post("/t/pair/qr")
    qr_id2, tok3 = r.j("id"), r.j("token")
    r = admin.req("DELETE", "/t/pair/qr/" + qr_id2, {})
    check("pair: close (DELETE) burns it", r.status == 200 and r.j("burned") is True, r)
    r = t.client(xff=ip(133)).post("/t/pair/redeem", {"token": tok3})
    check("pair: redeem after close → 410", r.status == 410, r)
    # a member (the QR-redeemed phone above) cannot mint, regenerate, read or close
    r = phone.post("/t/pair/qr")
    check("pair: a member cannot mint a QR (403)", r.status == 403 and r.j("why") == "role", r)
    r = phone.post("/t/pair/qr/" + qr_id2 + "/regenerate")
    check("pair: a member cannot regenerate (403)", r.status == 403, r)
    r = phone.get("/t/pair/qr/" + qr_id)
    check("pair: a member cannot read a QR's status (403)", r.status == 403, r)
    r = phone.req("DELETE", "/t/pair/qr/" + qr_id, {})
    check("pair: a member cannot close a QR (403)", r.status == 403, r)
    # a stale admin token cannot mint
    r = t.client(xff=ip(135)).post("/t/pair/qr")
    check("pair: no token, no QR (401)", r.status == 401, r)


def t_kill_m3(t):
    """M3: the kill-switch — everything revoked, QRs burned, epoch moved, lockdown, unlock."""
    admin, a = login(t, xff=ip(140), password=PASSWORD, second={"recovery": S.recovery_code()})
    ok, out = t.ctl("pair-qr")
    mj = json.loads(out) if ok else {}
    tok = mj.get("url", "").split("t=", 1)[1] if mj else ""
    phone = t.client(xff=ip(141))
    phone.post("/t/pair/redeem", {"token": tok})
    access = admin.jar.get("bifrost_device", ("",))[0]
    r = admin.signed("POST", "/t/kill", {"lockdown": True})
    check("kill: POST /t/kill with lockdown → ok, epoch moved", r.status == 200 and r.j("kill_epoch", 0) >= 1, r)
    oldc = t.client(xff=ip(144))
    oldc.jar["bifrost_device"] = (access, "/")
    r = oldc.get("/t/me")
    check("kill: the killer's own token is dead (401 revoked)", r.status == 401 and r.j("why") == "revoked", r)
    r = phone.get("/t/me")
    check("kill: the phone's token is dead", r.status == 401, r)
    r = t.client(xff=ip(142)).post("/t/auth/login", {"email": EMAIL, "password": PASSWORD})
    check("kill + lockdown: sign-in is blocked (403 lockdown)", r.status == 403 and r.j("why") == "lockdown", r)
    ok, out = t.ctl("unlock")
    r = t.client(xff=ip(142)).post("/t/pair/redeem", {"token": tok})
    check("kill: the QR is burned (410)", r.status == 410, r)
    check("kill: trunk-ctl unlock lifts the lockdown", ok, out)
    c, m = login(t, xff=ip(143), password=PASSWORD, second={"recovery": S.recovery_code()})
    check("kill: after unlock, sign-in works again (fresh epoch in the new token)", m.status == 200 and c.get("/t/me").j("token", {}).get("exp"), m)
    ok, out = t.ctl("audit", "verify")
    check("kill: audit chain still verifies after the kill", ok and out.startswith("audit chain ok"), out)
    ok, out = t.ctl("audit", "tail", "300")
    acts = [json.loads(l)["action"] for l in out.splitlines()] if ok else []
    check("kill: audit has the kill and the device revokes", "kill.switch" in acts and acts.count("device.revoke") >= 2, sorted(set(acts))[-12:])
    return c


def t_audit_page_m3(t, c):
    """M3: /t/audit (admin only), filter, pagination, chain flag; a member gets 403."""
    r = c.signed("GET", "/t/audit")
    check("audit page api: admin sees entries with chain ok", r.status == 200 and len(r.j("entries", [])) > 0 and r.j("chain_ok") is True and "actions" in r.data, r.status)
    r = c.signed("GET", "/t/audit?limit=5")
    check("audit page api: limit + before pagination", r.status == 200 and len(r.j("entries", [])) <= 5, r.status)
    first_seq = r.j("entries", [{}])[0]["seq"]
    r2 = c.signed("GET", "/t/audit?limit=5&before=" + str(first_seq))
    check("audit page api: before= works", r2.status == 200 and r2.j("entries", [{}])[0]["seq"] < first_seq, r2.status)
    r = c.signed("GET", "/t/audit?action=auth.login")
    check("audit page api: action filter", r.status == 200 and all(e["action"] == "auth.login" for e in r.j("entries", [])), r.status)
    # a genuine member (QR-redeemed) gets 403; an admin device does not
    ok, out = t.ctl("pair-qr")
    mj = json.loads(out) if ok else {}
    mem, r = t.client(xff=ip(151)), None
    if mj:
        r = mem.post("/t/pair/redeem", {"token": mj.get("url", "").split("t=", 1)[1]})
    check("audit page api: the member device joined", r.status == 200, r)
    r = mem.signed("GET", "/t/audit")
    check("audit page api: a member gets 403", r.status == 403, r)


def t_has_roots(t):
    """WIRE's stand-in: a row in its roots table flips has_roots; signed-in pages then go to the door."""
    c, m = login(t, ip(110), second={"recovery": S.recovery_code()})
    db = sqlite3.connect(os.path.join(t.root, "trunk.db"))
    # a row in WIRE's roots table (migration 100), as an enrollment would leave it
    db.execute("INSERT INTO roots (id, name, hostname, os, arch, root_pub, wg_pub, wg_addr, peer_token_hash, enrolled_at) VALUES ('rt_test', 'test', 'test', 'linux', 'x86_64', 'pub_test', 'wg_test', '10.77.0.250', '00', 0)")
    db.commit()
    r = c.get("/t/state")
    check("roots: /t/state has_roots flips with the first root", r.status == 200 and r.j("has_roots") is True, r)
    r = c.get("/", headers={"accept": "text/html"})
    check("roots: with a root but no door yet → /offline (WIRE relays here)", r.status == 302 and r.headers.get("Location") == "/offline", r)
    r = c.get("/api/session")
    check("roots: an API call with no door → 503 offline", r.status == 503 and r.j("why") == "offline", r)
    db.execute("UPDATE roots SET revoked_at = 1")
    db.commit()
    db.close()
    check("roots: a revoked root does not count", c.get("/t/state").j("has_roots") is False)


def t_tls(binp, root):
    """The phase-2 listener: own TLS, PROXY v1 first, believed only from trusted_proxies."""
    import socket, ssl
    d = os.path.join(root, "tls")
    os.makedirs(d, exist_ok=True)
    subprocess.run([binp, "ap-cert", os.path.join(d, "cert"), "localhost", "127.0.0.1"], check=True, capture_output=True)
    from trunklib import free_port
    tls_port = free_port(18850, 18899)
    extra = 'listen_tls = "127.0.0.1:%d"\nproxy_protocol = true\ncert_path = "%s/cert/cert.pem"\nkey_path = "%s/cert/key.pem"\n' % (tls_port, d, d)
    t3 = Trunk(binp, os.path.join(d, "trunk"), extra=extra)
    # only 127.0.0.2 is the router; 127.0.0.1 is not
    with open(t3.cfg) as f:
        cfg = f.read().replace('trusted_proxies = ["127.0.0.1/32"]', 'trusted_proxies = ["127.0.0.2/32"]')
    with open(t3.cfg, "w") as f:
        f.write(cfg)
    t3.start()
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        def ask(src, proxy_line, req):
            s = socket.socket()
            s.settimeout(5)
            s.bind((src, 0))
            s.connect(("127.0.0.1", tls_port))
            try:
                s.sendall(proxy_line)
                tl = ctx.wrap_socket(s, server_hostname="localhost")
                tl.sendall(req)
                buf = b""
                while True:
                    b = tl.recv(65536)
                    if not b:
                        break
                    buf += b
                return buf
            except (OSError, ssl.SSLError) as e:
                return repr(e).encode()
            finally:
                s.close()

        get = b"GET /t/state HTTP/1.1\r\nHost: localhost\r\n\r\n"
        out = ask("127.0.0.2", b"PROXY TCP4 203.0.113.50 127.0.0.1 40000 443\r\n", get)
        check("tls: PROXY v1 from the router, then TLS → /t/state", out.startswith(b"HTTP/1.1 200") and b'"claimed":false' in out and b"Strict-Transport-Security" in out, out[:120])
        out = ask("127.0.0.1", b"PROXY TCP4 203.0.113.50 127.0.0.1 40000 443\r\n", get)
        check("tls: a PROXY line from anyone else → the connection is dropped", not out.startswith(b"HTTP/"), out[:120])
        code = claim_code_from_file(t3)
        body = json.dumps({"code": wrong(code)}).encode()
        req = b"POST /t/claim/begin HTTP/1.1\r\nHost: localhost\r\nOrigin: %s\r\nX-Forwarded-For: 6.6.6.6\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s" % (t3.public_url.encode(), len(body), body)
        out = ask("127.0.0.2", b"PROXY TCP4 198.51.100.77 127.0.0.1 40000 443\r\n", req)
        ok, tail = t3.ctl("audit", "tail", "1")
        row = json.loads(tail) if ok and tail else {}
        check("tls: the client address is the PROXY line's (XFF ignored on TLS)", out.startswith(b"HTTP/1.1 401") and row.get("ip") == "198.51.100.0/24", (out[:60], row.get("ip")))
    finally:
        t3.stop()


def t_helper(binp, root):
    t2 = Trunk(binp, os.path.join(root, "helper")).start()
    try:
        p = subprocess.run([sys.executable, os.path.join(HERE, "trunk-v1", "claim-admin.py"), "--url", t2.url, "--origin", t2.public_url,
                            "--ctl", " ".join(t2.ctl_prefix), "--xff", "100.64.200.1"], capture_output=True, text=True, timeout=60)
        out = json.loads(p.stdout) if p.returncode == 0 else {}
        check("helper: claim-admin.py claims a trunk and prints the cookies", p.returncode == 0 and out.get("cookies", {}).get("bifrost_device", "").startswith("v4.public.") and len(out.get("recovery_codes", [])) == 10, p.stderr[-400:])
        c = t2.client(xff="100.64.200.1")
        for k, v in out.get("cookies", {}).items():
            c.jar[k] = (v, "/t/auth" if k == "bifrost_refresh" else "/")
        r = c.get("/t/me")
        check("helper: its cookies are the admin's", r.status == 200 and r.j("account")["role"] == "admin", r)
    finally:
        t2.stop()


# ---- M4 · OAuth (mock OIDC + GitHub-shaped provider) -------------------------------------------

class Mock:
    """sim/trunk-v1/mock-oidc.cjs on a free port of 18890–18899 (our own child, stopped by PID)."""

    def __init__(self, root):
        from trunklib import free_port
        self.root = root
        self.port = free_port(18890, 18899)
        self.url = "http://127.0.0.1:%d" % self.port
        self.proc = None
        self.cfg = os.path.join(root, "mock.json")

    def start(self, clients):
        fd = os.open(self.cfg, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"clients": clients}, f)
        self.log = open(os.path.join(self.root, "mock.log"), "ab")
        self.proc = subprocess.Popen(["node", os.path.join(HERE, "trunk-v1", "mock-oidc.cjs"), str(self.port), self.cfg],
                                     stdout=subprocess.PIPE, stderr=self.log)
        line = self.proc.stdout.readline().decode()
        if '"ready":true' not in line:
            raise RuntimeError("mock-oidc did not start: " + line)
        return self

    def c(self):
        return Client(self.url)

    def next(self, **profile):
        return self.c().post("/_mock/next", profile)

    def stats(self):
        return self.c().get("/_mock/stats").data

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(5)


def oauth_cfg(mock):
    return ('\n[oauth.mock]\nissuer = "%s"\nclient_id = "trunk-mock"\nclient_secret_file = "oauth-mock"\ndisplay = "Mock ID"\n'
            '[oauth.github]\nclient_id = "trunk-gh"\nclient_secret_file = "oauth-github"\n'
            'authorize_url = "%s/gh/login/oauth/authorize"\ntoken_url = "%s/gh/login/oauth/access_token"\napi_url = "%s/gh/api"\n'
            '[oauth.google]\nclient_id = "x.apps.googleusercontent.com"\nclient_secret_file = "oauth-google-not-here"\n'
            % (mock.url, mock.url, mock.url, mock.url))


def put_secret(t, name, value):
    p = os.path.join(t.root, "cred", name)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(value + "\n")


def last_audit(t, n=1):
    ok, out = t.ctl("audit", "tail", str(n))
    try:
        return [json.loads(x) for x in out.splitlines() if x.strip()] if ok else []
    except ValueError:
        return []


def oauth_flow(t, mock, c, provider, intent="login", ticket=None, profile=None, mangle=None, other=None):
    """Start on the trunk, sign in at the mock, come back to the callback (as browser `other`
    when given). Returns (the callback's response, the callback path)."""
    if profile is not None:
        mock.next(**profile)
    if intent == "claim":
        r = c.post("/t/auth/oauth/%s/start" % provider, {"intent": "claim", "ticket": ticket})
        if r.status != 200:
            return r, None
        loc = r.j("url")
    else:
        r = c.get("/t/auth/oauth/%s/start?intent=login" % provider)
        if r.status != 302:
            return r, None
        loc = r.headers.get("Location", "")
    if not loc.startswith(mock.url):
        return r, None
    a = mock.c().get(loc[len(mock.url):])
    cb = a.headers.get("Location", "") if a.status == 302 else ""
    if not cb.startswith(t.public_url):
        return a, None
    path = cb[len(t.public_url):]
    if mangle:
        path = mangle(path)
    return (other or c).get(path), path


def refused_as(t, name, r, why, c=None):
    loc = r.headers.get("Location", "") if r.status == 302 else ""
    a = last_audit(t, 1)
    row = a[-1] if a else {}
    ok = r.status == 302 and loc.endswith("#e=oauth") and row.get("action") == "auth.oauth_fail" and row.get("detail", {}).get("why") == why
    if c is not None:
        ok = ok and "bifrost_device" not in c.jar
    check("oauth: %s → refused (%s), audited" % (name, why), ok, (r.status, loc, row.get("action"), row.get("detail")))


def oauth_claim(t, mock, provider, xff):
    """Claim trunk `t` through `provider`: approve, sign in at the mock, enrol TOTP. → (client, totp secret, codes)."""
    c = t.client(xff=xff)
    ok, out = t.ctl("claim-code", "--json")
    ticket = c.post("/t/claim/begin", {"code": json.loads(out)["code"]}).j("ticket")
    r = c.post("/t/auth/oauth/%s/start" % provider, {"intent": "claim", "ticket": ticket})
    check("oauth claim (%s): start before approve → 409" % provider, r.status == 409, r)
    c.post("/t/claim/approve", {"ticket": ticket})
    if provider == "mock":
        # someone holding a leaked `state` (but not this browser's binding cookie) learns nothing
        thief = t.client(xff="100.64.230.1")
        r, _ = oauth_flow(t, mock, c, provider, intent="claim", ticket=ticket, other=thief)
        loc = r.headers.get("Location", "") if r.status == 302 else ""
        check("oauth claim (mock): a leaked state finished in another browser → refused, the claim ticket not revealed",
              loc == "/login#e=oauth" and ticket not in loc and "bifrost_device" not in thief.jar, (r, loc))
        page_shots([{"name": "m4-claim-oauth", "url": t.public_url + "/claim#t=" + ticket, "wait": "#c-oauth .oauth-btn"}])
    r, path = oauth_flow(t, mock, c, provider, intent="claim", ticket=ticket)
    if provider == "mock":
        page_shots([{"name": "m4-claim-oauth-totp", "url": t.public_url + "/claim#t=%s&via=mock" % ticket, "wait": "#c-totp:not([hidden])"}])
    loc = r.headers.get("Location", "") if r.status == 302 else ""
    check("oauth claim (%s): the provider sends the browser back to /claim (no device yet)" % provider,
          loc.startswith("/claim#t=" + ticket) and "via=" + provider in loc and "bifrost_device" not in c.jar, (r, loc))
    info = c.post("/t/claim/ticket", {"ticket": ticket})
    check("oauth claim (%s): the account exists, bound to the provider, TOTP still owed" % provider,
          info.j("state") == "approved" and info.j("pending_via") == "oauth:" + provider and c.get("/t/state").j("claimed") is False, info)
    r = c.get("/t/auth/oauth/%s/start?intent=login" % provider)
    check("oauth claim (%s): no OAuth sign-in before the claim completes" % provider, r.status == 302 and r.headers.get("Location") == "/login#e=oauth", r)
    v = c.post("/t/claim/totp", {"ticket": ticket})
    secret = v.j("secret", "")
    check("oauth claim (%s): mandatory TOTP enrolment (QR + 160-bit key)" % provider, v.status == 200 and len(secret) == 32 and v.j("totp_uri", "").startswith("otpauth://totp/"), v)
    r = c.post("/t/auth/totp/confirm", {"ticket": ticket, "code": wrong(totp_at(secret, step_now()))})
    check("oauth claim (%s): a wrong code does not finish the claim" % provider, r.status == 401 and c.get("/t/state").j("claimed") is False, r)
    code, step = totp_fresh(secret, 0)
    r = c.post("/t/auth/totp/confirm", {"ticket": ticket, "code": code})
    check("oauth claim (%s): TOTP confirm → claimed, 10 recovery codes, admin cookies" % provider,
          r.status == 200 and len(r.j("recovery_codes", [])) == 10 and "bifrost_device" in c.jar and c.get("/t/state").j("claimed") is True, r)
    me = c.get("/t/me")
    acct = c.get("/t/account")
    check("oauth claim (%s): admin, e-mail from the provider, no password, the identity listed" % provider,
          me.j("account", {}).get("role") == "admin" and me.j("account", {}).get("email") == "owner@example.org" and acct.j("password") is False
          and [o.get("provider") for o in acct.j("oauth", [])] == [provider], (me, acct.j("oauth")))
    r = t.client(xff=xff).post("/t/auth/login", {"email": "owner@example.org", "password": PASSWORD})
    check("oauth claim (%s): the OAuth admin has no password to sign in with (generic 401)" % provider, r.status == 401 and r.j("why") == "credentials", r)
    return c, secret, step, r


def t_oauth(binp, root):
    d = os.path.join(root, "oauth")
    os.makedirs(d, exist_ok=True)
    import secrets as _s
    sec_mock, sec_gh = "mock-" + _s.token_urlsafe(24), "gh-" + _s.token_urlsafe(24)
    mock = Mock(d)  # its port is picked now, bound last
    trunks = []
    for name in ("t1", "t2"):
        # each trunk binds before the next picks a port
        t = Trunk(binp, os.path.join(d, name), extra=oauth_cfg(mock))
        put_secret(t, "oauth-mock", sec_mock)
        put_secret(t, "oauth-github", sec_gh)
        t.start()
        trunks.append(t)
    t1, t2 = trunks
    cb = lambda t, p: "%s/t/auth/oauth/%s/callback" % (t.public_url, p)  # noqa: E731
    mock.start({"trunk-mock": {"secret": sec_mock, "redirect_uris": [cb(t1, "mock"), cb(t2, "mock")]},
                "trunk-gh": {"secret": sec_gh, "redirect_uris": [cb(t1, "github"), cb(t2, "github")]}})
    try:
        c = t1.client(xff=ip(60))
        r = c.get("/t/state")
        check("oauth: /t/state lists the providers whose secret is in place ({id, name}); no secret → no button",
              r.j("providers") == [{"id": "github", "name": "GitHub"}, {"id": "mock", "name": "Mock ID"}], r)
        r = c.post("/t/auth/oauth/google/start", {"intent": "login"})
        check("oauth: a provider without its secret file cannot start", r.status == 404, r)
        r = c.get("/t/auth/oauth/mock/start?intent=login")
        check("oauth: OAuth sign-in before the claim → refused (back to /login)", r.status == 302 and r.headers.get("Location") == "/login#e=oauth", r)

        # the claim through the generic OIDC provider (t1) and through the GitHub preset (t2)
        admin1, sec1, step1, _ = oauth_claim(t1, mock, "mock", ip(61))
        st = mock.stats()
        q = st.get("last_authorize") or {}
        check("oauth: the provider saw code flow + PKCE S256 + state + nonce; the trunk proved the verifier (client_secret_basic)",
              q.get("response_type") == "code" and q.get("code_challenge_method") == "S256" and len(q.get("code_challenge", "")) == 43
              and len(q.get("state", "")) == 43 and len(q.get("nonce", "")) >= 32 and st.get("last_verifier_ok") is True and st.get("last_token_auth") == "basic", st)
        admin2, sec2, step2, _ = oauth_claim(t2, mock, "github", ip(62))
        st = mock.stats()
        check("oauth: the GitHub preset: PKCE, client_secret in the form, identity from the API", st.get("last_token_auth") == "post" and st.get("gh_api_calls", 0) >= 2 and st.get("last_verifier_ok") is True, st)

        # sign-in with a known identity: the second factor is still owed
        last = {"t1": step1, "t2": step2}

        def code_for(key, secret):
            code, s = totp_fresh(secret, last[key])
            last[key] = s
            return code

        b = t1.client(xff=ip(63))
        f0 = mock.stats().get("jwks_fetches", 0)
        r, _ = oauth_flow(t1, mock, b, "mock")
        loc = r.headers.get("Location", "") if r.status == 302 else ""
        check("oauth: a known identity → /login#mfa=… (no device, no cookies yet)", loc.startswith("/login#mfa=") and "via=mock" in loc and "bifrost_device" not in b.jar, (r, loc))
        ticket = loc.split("mfa=", 1)[1].split("&", 1)[0] if "mfa=" in loc else ""
        o = b.post("/t/auth/mfa/options", {"mfa_ticket": ticket})
        check("oauth: the second step offers TOTP + recovery codes", o.status == 200 and o.j("mfa") == ["totp", "recovery"] and o.j("via") == "mock", o)
        m = b.post("/t/auth/mfa", {"mfa_ticket": ticket, "totp": code_for("t1", sec1)})
        me = b.get("/t/me")
        check("oauth: OAuth + TOTP → an admin device", m.status == 200 and me.j("account", {}).get("role") == "admin" and me.j("device", {}).get("role") == "admin", (m, me))
        row = [a for a in last_audit(t1, 3) if a.get("action") == "auth.login"]
        check("oauth: audited as first=oauth (provider mock), second=totp", row and row[-1]["detail"] == {"first": "oauth", "second": "totp", "provider": "mock"}, row)
        m2 = t1.client(xff=ip(63)).post("/t/auth/mfa", {"mfa_ticket": ticket, "totp": code_for("t1", sec1)})
        sb = t1.client(xff=ip(63))
        r, _ = oauth_flow(t1, mock, sb, "mock")
        tk = r.headers.get("Location", "").split("mfa=", 1)[-1].split("&", 1)[0]
        page_shots([{"name": "m4-login-oauth", "url": t1.public_url + "/login", "wait": "#l-oauth .oauth-btn"},
                    {"name": "m4-login-oauth-second-step", "url": t1.public_url + "/login#mfa=%s&via=mock" % tk, "wait": "#l-via:not([hidden])"}])
        check("oauth: the second-factor ticket works once", m2.status == 401 and m2.j("why") == "ticket", m2)
        check("oauth: the JWKS is cached (no fetch for a known kid)", mock.stats().get("jwks_fetches", 0) == f0, mock.stats())

        # the refusals, each from its own network and browser
        n = [64]

        def fresh():
            n[0] += 1
            return t1.client(xff=ip(n[0]))

        bb = fresh()
        r, _ = oauth_flow(t1, mock, bb, "mock", mangle=lambda p: p.replace("state=", "state=x"))
        refused_as(t1, "a state the trunk never issued", r, "state", bb)
        bb = fresh()
        r, path = oauth_flow(t1, mock, bb, "mock")
        ok1 = r.status == 302 and r.headers.get("Location", "").startswith("/login#mfa=")
        r = bb.get(path)
        check("oauth: replaying a used callback (state is one-use) — the first one worked", ok1)
        refused_as(t1, "the same state a second time", r, "state", None)
        bb, other = fresh(), fresh()
        r, _ = oauth_flow(t1, mock, bb, "mock", other=other)
        refused_as(t1, "a callback finished in another browser (no binding cookie)", r, "state", other)
        for name, prof, why in [
            ("an ID token with the wrong nonce", {"tamper": "nonce"}, "nonce"),
            ("an ID token signed by another key", {"tamper": "sig"}, "signature"),
            ("an ID token with alg none", {"tamper": "alg"}, "alg"),
            ("an ID token from another issuer", {"tamper": "iss"}, "iss"),
            ("an ID token for another client", {"tamper": "aud"}, "aud"),
            ("an ID token authorized for another party (azp)", {"tamper": "azp"}, "aud"),
            ("an expired ID token", {"tamper": "exp"}, "exp"),
            ("email_verified: false", {"email_verified": False}, "email_unverified"),
            ("no email_verified claim", {"email_verified": None}, "email_unverified"),
            ("an identity nobody bound (outside the claim)", {"sub": "stranger-9", "email": "stranger@example.org"}, "unknown_identity"),
            ("the owner cancelling at the provider", {"deny": True}, "denied"),
        ]:
            if prof.get("email_verified", 1) is None:
                prof = {"email_verified": "__drop__"}
            bb = fresh()
            r, _ = oauth_flow(t1, mock, bb, "mock", profile=prof)
            refused_as(t1, name, r, why, bb)
        # a key the trunk has not cached yet: the JWKS is fetched again, once
        mock.c().post("/_mock/rotate", {})
        f1 = mock.stats().get("jwks_fetches", 0)
        bb = fresh()
        r, _ = oauth_flow(t1, mock, bb, "mock", profile={"tamper": "rotate"})
        check("oauth: a rotated provider key (unknown kid) → the JWKS is fetched again and the token verifies",
              r.status == 302 and r.headers.get("Location", "").startswith("/login#mfa=") and mock.stats().get("jwks_fetches", 0) == f1 + 1, (r, mock.stats().get("jwks_fetches"), f1))
        bb = fresh()
        r, _ = oauth_flow(t1, mock, bb, "mock", profile={"tamper": "kid"})
        refused_as(t1, "a kid the provider never published", r, "kid", bb)
        bb = fresh()
        r, _ = oauth_flow(t1, mock, bb, "mock", profile={"tamper": "es256"})
        check("oauth: an ES256-signed ID token verifies", r.status == 302 and r.headers.get("Location", "").startswith("/login#mfa="), r)
        bb = fresh()
        r, _ = oauth_flow(t1, mock, bb, "github")
        refused_as(t1, "a GitHub identity nobody bound", r, "unknown_identity", bb)

        # GitHub preset on t2: sign in, and refuse an account with no verified primary e-mail
        b2 = t2.client(xff=ip(90))
        r, _ = oauth_flow(t2, mock, b2, "github")
        loc = r.headers.get("Location", "") if r.status == 302 else ""
        ticket = loc.split("mfa=", 1)[1].split("&", 1)[0] if "mfa=" in loc else ""
        m = b2.post("/t/auth/mfa", {"mfa_ticket": ticket, "totp": code_for("t2", sec2)})
        check("oauth: GitHub sign-in + TOTP → an admin device", m.status == 200 and b2.get("/t/me").j("device", {}).get("role") == "admin", (r, m))
        b3 = t2.client(xff=ip(91))
        r, _ = oauth_flow(t2, mock, b3, "github", profile={"gh_emails": [{"email": "owner@example.org", "primary": True, "verified": False}]})
        refused_as(t2, "GitHub with no verified primary e-mail", r, "email_unverified", b3)
        b3 = t2.client(xff=ip(92))
        r, _ = oauth_flow(t2, mock, b3, "mock")
        refused_as(t2, "the OIDC identity bound on another trunk", r, "unknown_identity", b3)

        # the same sign-in in a real Chromium: the SameSite=Lax binding cookie survives the cross-site return
        last["t1"] = node_checks("oauth", "oauth-browser.cjs", [t1.public_url, json.dumps({"secret": sec1, "last_step": last["t1"]})], last["t1"])

        # the state expires (fast: 60 s) — checked by the unit tests; here: lockdown stops OAuth sign-in
        ok, out = t1.ctl("kill", "--lockdown")
        r = fresh().get("/t/auth/oauth/mock/start?intent=login")
        check("oauth: lockdown → no OAuth sign-in", ok and r.status == 302 and r.headers.get("Location") == "/login#e=oauth", (out, r))
        t1.ctl("unlock")

        # the secrets never left their files
        leaks = []
        for t in (t1, t2):
            blobs = []
            for dirpath, _, files in os.walk(t.root):
                for fn in files:
                    if fn in ("oauth-mock", "oauth-github"):
                        continue
                    try:
                        blobs.append((fn, open(os.path.join(dirpath, fn), "rb").read()))
                    except OSError:
                        pass
            for fn, b in blobs:
                for sec in (sec_mock, sec_gh):
                    if sec.encode() in b:
                        leaks.append(fn)
        check("oauth: the client secrets appear in no log, config, db or audit file", not leaks, leaks)
        ok, out = t1.ctl("audit", "verify")
        ok2, out2 = t2.ctl("audit", "verify")
        check("oauth: both audit chains verify", ok and ok2, (out, out2))
    finally:
        t1.stop()
        t2.stop()
        mock.stop()


SHOTS = os.path.expanduser("~/.cache/trunk-v1/tmp/idp/shots-m4")


def node_env():
    return dict(os.environ, NODE_PATH=os.path.join(REPO, "branch", "node_modules"))


def page_shots(items):
    """360 px screenshots (sim/trunk-v1/page-shot.cjs) → a check per page."""
    os.makedirs(SHOTS, exist_ok=True)
    p = subprocess.run(["node", os.path.join(HERE, "trunk-v1", "page-shot.cjs"), SHOTS, json.dumps(items)], capture_output=True, text=True, timeout=180, env=node_env())
    try:
        res = json.loads(p.stdout.strip().splitlines()[-1])["shots"]
    except (ValueError, IndexError, KeyError):
        check("shots: page-shot.cjs ran", False, (p.stdout[-400:], p.stderr[-400:]))
        return
    for r in res:
        check("shot %s (360 px): drawn, no console error, nothing wider than the screen" % r["name"], r["ok"], r["problems"])


def node_checks(label, script, args, last_step):
    """Run a Chromium script that prints {"check", "ok", "detail"} lines, then {"done", "last_step"}.
    → the last TOTP step it used (the trunk takes each step once)."""
    p = subprocess.Popen(["node", os.path.join(HERE, "trunk-v1", script)] + list(args),
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=node_env())
    done = False
    try:
        for line in p.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if "check" in o:
                check(label + ": " + o["check"], o["ok"], o.get("detail"))
            elif o.get("done"):
                done = True
                last_step = max(last_step, o.get("last_step", 0))
        p.wait(timeout=300)
    finally:
        if p.poll() is None:
            p.terminate()  # our own child, by PID
    if not done:
        check(label + ": %s finished" % script, False, p.stderr.read()[-800:] if p.stderr else "")
    return last_step


def t_passkeys(t):
    """The browser half of the passkey cases (sim/trunk-v1/passkeys.cjs, Chromium + CDP virtual authenticator)."""
    os.makedirs(SHOTS, exist_ok=True)
    params = {"email": EMAIL, "password": PASSWORD, "secret": S.totp, "last_step": S.last_step}
    S.last_step = node_checks("passkeys", "passkeys.cjs", [t.public_url, SHOTS, json.dumps(params)], S.last_step)
    ok, out = t.ctl("audit", "verify")
    check("passkeys: the audit chain still verifies", ok, out)


def t_load(binp, root):
    """§12 load check: 50 concurrent sign-ins on one CPU (taskset), argon2id m=19 MiB t=2 p=1, at most 2 at once."""
    import concurrent.futures as cf
    d = os.path.join(root, "load")
    t = Trunk(binp, os.path.join(d, "trunk"))
    env_cpu = shutil.which("taskset")
    if env_cpu:
        t.bin_prefix = ["taskset", "-c", "0"]
    t.start()
    try:
        p = subprocess.run([sys.executable, os.path.join(HERE, "trunk-v1", "claim-admin.py"), "--url", t.url, "--origin", t.public_url,
                            "--ctl", " ".join(t.ctl_prefix), "--xff", "100.64.250.1"], capture_output=True, text=True, timeout=60)
        ok = p.returncode == 0
        try:
            cpus = [l.split(":", 1)[1].strip() for l in open("/proc/%d/status" % t.proc.pid) if l.startswith("Cpus_allowed_list")][0]
        except (OSError, IndexError):
            cpus = "?"
        check("load: a throwaway trunk pinned to one CPU (Cpus_allowed_list %s), claimed" % cpus, ok and cpus == "0", (p.stderr[-300:], env_cpu, cpus))
        if not ok:
            return
        email = json.loads(p.stdout).get("email", "owner@example.org")
        pw = json.loads(p.stdout).get("password", PASSWORD)

        def one(i):
            c = t.client(xff="100.65.%d.%d" % (i // 200, i % 200 + 1))
            t0 = time.monotonic()
            r = c.post("/t/auth/login", {"email": email, "password": pw}, timeout=120)
            return r.status, time.monotonic() - t0, bool(r.j("mfa_ticket"))

        t0 = time.monotonic()
        with cf.ThreadPoolExecutor(max_workers=50) as ex:
            res = list(ex.map(one, range(50)))
        wall = time.monotonic() - t0
        lat = sorted(x[1] for x in res)
        p95 = lat[int(len(lat) * 0.95) - 1]
        okc = sum(1 for s, _, tk in res if s == 200 and tk)
        print("  load: 50 concurrent sign-ins on 1 CPU: %d ok, wall %.1f s, p50 %.2f s, p95 %.2f s, max %.2f s" % (okc, wall, lat[24], p95, lat[-1]), flush=True)
        check("load: 50 concurrent password sign-ins on 1 CPU all answer 200 with a second-factor ticket", okc == 50, [s for s, _, _ in res])
        check("load: … within 30 s wall, p95 under 20 s (argon2 queued 2 at a time)", wall < 30 and p95 < 20, (wall, p95))
        r = t.client(xff="100.66.0.1").get("/t/state")
        check("load: the trunk still answers right after", r.status == 200 and r.j("claimed") is True, r)
    finally:
        t.stop()


def sse_app():
    """A root's app whose every answer is a held event stream (like /api/run-events): a tick every
    50 ms until its connection goes. → (port, live-stream counter, server)."""
    import socketserver, threading
    live = {"n": 0}
    lock = threading.Lock()

    class H(socketserver.BaseRequestHandler):
        def handle(self):
            buf = b""
            while b"\r\n\r\n" not in buf:
                b = self.request.recv(4096)
                if not b:
                    return
                buf += b
            with lock:
                live["n"] += 1
            try:
                self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
                i = 0
                while True:
                    i += 1
                    self.request.sendall(b"data: tick %d\n\n" % i)
                    time.sleep(0.05)
            except OSError:
                pass
            finally:
                with lock:
                    live["n"] -= 1

    class S(socketserver.ThreadingTCPServer):
        daemon_threads = True
        allow_reuse_address = True

    from trunklib import free_port
    port = free_port(18870, 18889)
    srv = S(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return port, live, srv


def udp_free(lo, hi):
    import socket
    for p in range(lo, hi + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as u:
            try:
                u.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("no free udp port in %d-%d" % (lo, hi))


def hold_stream(t, client, path="/api/run-events"):
    """A device's held event stream through the trunk to its door root. → (socket, the first bytes)."""
    import socket
    s = socket.create_connection(("127.0.0.1", t.port), timeout=10)
    cookie = "; ".join("%s=%s" % (k, v) for k, (v, pth) in client.jar.items() if path.startswith(pth))
    s.sendall(("GET %s HTTP/1.1\r\nHost: %s\r\nCookie: %s\r\nX-Forwarded-For: %s\r\nAccept: text/event-stream\r\nUser-Agent: %s\r\n\r\n"
               % (path, t.public_url.split("://", 1)[1], cookie, client.xff, client.ua)).encode())
    got = b""
    while b"data: tick" not in got:
        b = s.recv(4096)
        if not b:
            break
        got += b
    return s, got


def t_kill_live(binp, root):
    """The kill switch cuts every live relayed device stream ≤ 1 s (spec §5.4, B13/P14): a real root
    (bridge [trunk], enrolled through the API) is the door; an admin and a member device each hold
    an event stream through the trunk; POST /t/kill {lockdown} → both streams end, the root's halves
    end, the old tokens are refused; then lockdown and unlock as before."""
    import threading
    d = os.path.join(root, "killlive")
    t = Trunk(binp, os.path.join(d, "trunk"))
    t.start()
    bridge, srv = None, None
    try:
        env = dict(os.environ, CLAIM_ADMIN_PASSWORD=PASSWORD)
        p = subprocess.run([sys.executable, os.path.join(HERE, "trunk-v1", "claim-admin.py"), "--url", t.url, "--origin", t.public_url,
                            "--ctl", " ".join(t.ctl_prefix), "--xff", "100.64.240.1"], capture_output=True, text=True, timeout=60, env=env)
        out = json.loads(p.stdout) if p.returncode == 0 else {}
        admin = t.client(xff="100.64.240.1")
        for k, v in out.get("cookies", {}).items():
            admin.jar[k] = (v, "/t/auth" if k == "bifrost_refresh" else "/")
        secret, step = out.get("totp_secret", ""), out.get("last_step", 0)
        if not check("kill-live: a claimed trunk with an admin device", p.returncode == 0 and admin.get("/t/me").status == 200, p.stderr[-300:]):
            return

        def bn(*args):
            r = subprocess.run([binp, *args], capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError("bifrost-net %s: %s" % (args[0], r.stderr.strip()))
            return {l.split(" = ")[0]: l.split('"')[1] for l in r.stdout.splitlines() if " = " in l and '"' in l}

        # the door root: enrolled through the API, its bridge dialing OUT to /t/root
        rd = os.path.join(d, "door")
        os.makedirs(rd, exist_ok=True)
        rk, wk = bn("root-key", os.path.join(rd, "root.key")), bn("wg-key", os.path.join(rd, "wg.key"))
        inst = t.client(xff="100.64.242.1")
        r = inst.post("/t/roots/enroll", {"hostname": "door-box", "os": "linux", "arch": "x86_64", "root_pub": rk["public_key"],
                                          "wg_pub": wk["public_key"], "has_app": True, "has_voice": False})
        code, step = totp_fresh(secret, step)
        admin.post("/t/auth/step-up", {"totp": code})
        a = admin.post("/t/roots/enroll/%s/approve" % r.j("id"), {"name": "door"})
        res = inst.post("/t/roots/enroll/%s/poll" % r.j("id"), {"secret": r.j("poll_secret")})
        if not check("kill-live: the door root enrolled (installer → admin approve → poll)", r.status == 200 and a.status == 200 and res.j("status") == "approved", (r, a, res)):
            return
        app_port, live, srv = sse_app()
        from trunklib import free_port
        http_port, media_port = free_port(18870, 18889), udp_free(18870, 18889)
        with open(os.path.join(rd, "bridge.toml"), "w") as f:
            f.write('[node]\nname = "door"\nprivate_key = "%s"\n\n' % bn("keygen")["private_key"]
                    + '[bridge]\nhttp = "127.0.0.1:%d"\nmedia = "127.0.0.1:%d"\ntokens_file = "%s/devices.json"\nopencode_url = "http://127.0.0.1:9"\n\n'
                    % (http_port, media_port, rd)
                    + '[trunk]\nurl = "%s"\ntrunk_key = "%s"\nroot_key_file = "%s/root.key"\nroot_id = "%s"\nstate_file = "%s/trunk-state.json"\n'
                      'upstream = "127.0.0.1:%d"\nice_tcp = []\n' % (t.url, res.j("trunk")["trunk_key"], rd, res.j("root_id"), rd, app_port))
        blog = open(os.path.join(rd, "bridge.log"), "ab")
        bridge = subprocess.Popen([binp, "bridge", "-c", os.path.join(rd, "bridge.toml")], stdout=blog, stderr=subprocess.STDOUT)
        online = wait_until(lambda: any(x.get("online") for x in (admin.signed("GET", "/t/me/roots").data or [])), 20)
        if not check("kill-live: the door root dialed out and linked", online, open(os.path.join(rd, "bridge.log")).read()[-400:]):
            return

        # a member phone (QR) and the admin, each holding a live event stream through the trunk
        ok, q = t.ctl("pair-qr")
        member = t.client(xff="100.64.243.1")
        m = member.post("/t/pair/redeem", {"token": json.loads(q)["url"].split("t=", 1)[1]}) if ok else None
        check("kill-live: a member device joined by QR", m is not None and m.status == 200 and m.j("device", {}).get("role") == "member", m)
        held = {}
        for name, c in (("admin", admin), ("member", member)):
            sock, first = hold_stream(t, c)
            held[name] = sock
            check("kill-live: the %s's event stream is live through the trunk (ticks arriving)" % name, first.startswith(b"HTTP/1.1 200") and b"data: tick" in first, first[:200])
        check("kill-live: the root's app holds both streams", wait_until(lambda: live["n"] == 2, 5), live)
        ended = {}

        def watch(name, sock):
            sock.settimeout(5)
            try:
                while sock.recv(4096):
                    pass
            except OSError:
                pass
            ended[name] = time.monotonic()

        ths = [threading.Thread(target=watch, args=(n, s_), daemon=True) for n, s_ in held.items()]
        for th in ths:
            th.start()
        time.sleep(0.3)
        check("kill-live: both streams still open before the kill", not ended, ended)
        t0 = time.monotonic()
        k = admin.post("/t/kill", {"lockdown": True})
        for th in ths:
            th.join(5)
        cut = {n: round((v - t0) * 1000) for n, v in ended.items()}
        print("  kill-live: POST /t/kill → stream ends (ms): %s" % cut, flush=True)
        check("kill-live: POST /t/kill (lockdown) → ok", k.status == 200 and k.j("lockdown") is True, k)
        check("kill-live: the admin's and the member's live streams are both cut ≤ 1 s", set(cut) == {"admin", "member"} and all(v <= 1000 for v in cut.values()), cut)
        rt = wait_until(lambda: live["n"] == 0, 3)
        check("kill-live: the root ended its halves too (its app's streams closed) ≤ 1 s", rt and time.monotonic() - t0 <= 1.5 and live["n"] == 0, (live, time.monotonic() - t0))
        r = member.get("/api/run-events", headers={"accept": "text/event-stream"})
        check("kill-live: the member's old token is refused (401 login)", r.status == 401 and r.j("reauth") == "login", r)
        # lockdown and unlock, as before
        r = t.client(xff="100.64.244.1").post("/t/auth/login", {"email": "owner@example.org", "password": PASSWORD})
        check("kill-live: lockdown → sign-in refused", r.status == 403 and r.j("why") == "lockdown", r)
        ok, o = t.ctl("unlock")
        c2 = t.client(xff="100.64.244.1")
        r = c2.post("/t/auth/login", {"email": "owner@example.org", "password": PASSWORD})
        code, step = totp_fresh(secret, step)
        m2 = c2.post("/t/auth/mfa", {"mfa_ticket": r.j("mfa_ticket"), "totp": code})
        check("kill-live: trunk-ctl unlock → password + TOTP sign in again", ok and r.status == 200 and m2.status == 200, (o, r, m2))
        ok, o = t.ctl("audit", "verify")
        check("kill-live: the audit chain verifies", ok, o)
    finally:
        if bridge and bridge.poll() is None:
            bridge.terminate()  # our own child, by PID
            try:
                bridge.wait(5)
            except subprocess.TimeoutExpired:
                bridge.kill()
        if srv:
            srv.shutdown()
            srv.server_close()
        t.stop()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", default=os.path.join(REPO, "trunk", "target", "release", "bifrost-net"))
    ap.add_argument("--keep", action="store_true", help="keep the rig dir")
    ap.add_argument("--skip-browser", action="store_true", help="skip the Chromium passkey cases")
    a = ap.parse_args()
    base = os.environ.get("TMPDIR") or os.path.expanduser("~/.cache/trunk-v1/tmp/idp")
    os.makedirs(base, exist_ok=True)
    root = tempfile.mkdtemp(prefix="trunk-v1-auth-", dir=base)
    t = Trunk(a.bin, os.path.join(root, "trunk"))
    t0 = time.time()
    try:
        t.start()
        print("trunk-v1-auth: trunk on %s (rig %s)" % (t.url, root), flush=True)
        t_surface(t)
        t_csrf(t)
        t_claim_lockout(t)
        t_claim_flow(t)
        t_pages_signed_in(t)
        t_generic(t)
        t_password_lockout(t)
        t_mfa(t)
        t_net(t)
        t_refresh(t)
        t_expiry_region(t)
        c = t_step_up(t)
        t_logout(t, c)
        t_console(t)
        t_devices_m3(t)
        t_pair_m3(t)
        c = t_kill_m3(t)
        t_audit_page_m3(t, c)
        if not a.skip_browser:
            t_passkeys(t)
        t_has_roots(t)
        t_tamper(t)
        t_helper(a.bin, root)
        t_tls(a.bin, root)
        t_oauth(a.bin, root)
        t_load(a.bin, root)
        t_kill_live(a.bin, root)
    except Exception as e:  # a rig error is a failure, never a pass
        import traceback
        traceback.print_exc()
        check("rig: ran to the end", False, repr(e))
    finally:
        t.stop()
        if not a.keep and not FAILS:
            shutil.rmtree(root, ignore_errors=True)
    print("trunk-v1-auth: %d passed, %d failed (%.0f s)%s" % (len(PASSES), len(FAILS), time.time() - t0, "" if not FAILS else " — " + "; ".join(FAILS)), flush=True)
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
