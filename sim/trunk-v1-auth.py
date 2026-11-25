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
  roots     has_roots flips with WIRE's first root row; then pages go to the door (/offline)
  helper    sim/trunk-v1/claim-admin.py claims a second trunk end to end
  tls       the phase-2 listener: PROXY v1 believed only from trusted_proxies, then TLS; the client
            address is the PROXY line's (XFF ignored)

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
    check("surface: /install/root.sh placeholder names this trunk", r.status == 503 and t.public_url in str(r.data), r)
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", default=os.path.join(REPO, "trunk", "target", "release", "bifrost-net"))
    ap.add_argument("--keep", action="store_true", help="keep the rig dir")
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
        t_has_roots(t)
        t_tamper(t)
        t_helper(a.bin, root)
        t_tls(a.bin, root)
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
