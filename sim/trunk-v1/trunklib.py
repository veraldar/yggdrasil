"""trunklib — shared bits for the v1 trunk rigs (sim/trunk-v1-*.py, sim/trunk-v1/claim-admin.py).

A cookie-keeping HTTP client that sends the trunk's Origin on writes and never follows redirects,
RFC 6238 TOTP, the console client, and a throwaway trunk (`bifrost-net trunk`) on a free port of
a given range with its own state dir. Test rigs only: nothing here is meant for a real trunk.
"""
import base64, hashlib, hmac, json, os, shlex, socket, struct, subprocess, time
import urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.realpath(os.path.join(HERE, "..", ".."))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def b32decode(s):
    s = s.replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def totp_at(secret_b32, step):
    key = b32decode(secret_b32)
    mac = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    off = mac[19] & 0x0F
    n = (struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return "%06d" % n


def step_now():
    return int(time.time()) // 30


def totp_fresh(secret_b32, last_step):
    """A code for the first step the trunk will still take (now-1..now+1, newer than last_step)."""
    now = step_now()
    for s in (now - 1, now, now + 1):
        if s > last_step:
            return totp_at(secret_b32, s), s
    # all three used: wait for the next step
    time.sleep(30 - time.time() % 30 + 0.2)
    return totp_fresh(secret_b32, last_step)


class Client:
    """One browser: a cookie jar (path-aware, as the trunk scopes bifrost_refresh to /t/auth)."""

    def __init__(self, base, origin=None, ua="Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/130 Mobile Safari/537.36", xff=None):
        self.base = base.rstrip("/")
        self.origin = (origin or base).rstrip("/")
        self.ua = ua
        self.xff = xff
        self.jar = {}  # name -> (value, path)

    def cookie_header(self, path):
        parts = ["%s=%s" % (k, v) for k, (v, p) in self.jar.items() if path.startswith(p)]
        return "; ".join(parts)

    def take_cookies(self, headers):
        for h in headers.get_all("Set-Cookie") or []:
            first, *attrs = [x.strip() for x in h.split(";")]
            name, _, value = first.partition("=")
            path, age = "/", None
            for a in attrs:
                k, _, v = a.partition("=")
                if k.lower() == "path":
                    path = v
                elif k.lower() == "max-age":
                    age = int(v)
            if age == 0 or value == "":
                self.jar.pop(name, None)
            else:
                self.jar[name] = (value, path)

    def req(self, method, path, body=None, headers=None, origin=True, cookies=True, xff=None, raw=None, timeout=30):
        h = {"user-agent": self.ua}
        if body is not None:
            h["content-type"] = "application/json"
        if origin is True and method not in ("GET", "HEAD"):
            h["origin"] = self.origin
        elif isinstance(origin, str):
            h["origin"] = origin
        ip = xff or self.xff
        if ip:
            h["x-forwarded-for"] = ip
        if cookies and self.jar:
            c = self.cookie_header(path)
            if c:
                h["cookie"] = c
        h.update(headers or {})
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        t0 = time.monotonic()
        try:
            with OPENER.open(r, timeout=timeout) as resp:
                status, rb, rh = resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as e:
            status, rb, rh = e.code, e.read(), e.headers
        dt = time.monotonic() - t0
        if cookies:
            self.take_cookies(rh)
        try:
            parsed = json.loads(rb or b"null")
        except ValueError:
            parsed = rb.decode(errors="replace")
        return Resp(status, parsed, rh, dt)

    def get(self, path, **k):
        return self.req("GET", path, **k)

    def signed(self, method, path, body=None, **k):
        """What the page script does: an expired (or moved) access token is refreshed once."""
        r = self.req(method, path, body, **k)
        if r.status == 401 and isinstance(r.data, dict) and r.data.get("reauth") == "refresh":
            f = self.req("POST", "/t/auth/refresh", {}, xff=k.get("xff"))
            if f.status == 200:
                r = self.req(method, path, body, **k)
        return r

    def post(self, path, body=None, **k):
        return self.req("POST", path, body if body is not None else {}, **k)


class Resp:
    def __init__(self, status, data, headers, dt):
        self.status, self.data, self.headers, self.dt = status, data, headers, dt

    def j(self, k, default=None):
        return self.data.get(k, default) if isinstance(self.data, dict) else default

    def __repr__(self):
        d = self.data if not isinstance(self.data, str) else self.data[:120]
        return "<%s %r>" % (self.status, d)


def ctl(cmd_prefix, *args):
    """Run a console command; (ok, stdout+stderr)."""
    argv = (shlex.split(cmd_prefix) if isinstance(cmd_prefix, str) else list(cmd_prefix)) + list(args)
    p = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    return p.returncode == 0, (p.stdout + p.stderr).strip()


def free_port(lo, hi):
    for p in range(lo, hi + 1):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("no free port in %d-%d" % (lo, hi))


class Trunk:
    """A throwaway `bifrost-net trunk` (its own dir, port from the range, TRUNK_TEST_FAST=1)."""

    def __init__(self, bin_path, root, port_lo=18800, port_hi=18899, fast=True, public_url=None, extra=""):
        self.bin = bin_path
        self.root = root
        os.makedirs(os.path.join(root, "cred"), exist_ok=True)
        self.port = free_port(port_lo, port_hi)
        self.url = "http://127.0.0.1:%d" % self.port
        self.public_url = public_url or "http://localhost:%d" % self.port
        self.cfg = os.path.join(root, "trunk.toml")
        self.sock = os.path.join(root, "cred", "ctl.sock")
        if len(self.sock.encode()) > 100:
            # SUN_LEN is 108: a deep TMPDIR (the ladder's) would make bind() fail. Put the socket in a short private dir.
            import atexit, shutil, tempfile
            short = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
            sd = tempfile.mkdtemp(prefix="tv1-", dir=short if os.path.isdir(short) else "/tmp")
            atexit.register(shutil.rmtree, sd, True)
            self.sock = os.path.join(sd, "ctl.sock")
        self.fast = fast
        with open(self.cfg, "w") as f:
            f.write(
                'public_url = "%s"\nlisten_http = "127.0.0.1:%d"\ntrusted_proxies = ["127.0.0.1/32"]\n'
                'db = "%s/trunk.db"\nstate_dir = "%s"\ncred_dir = "%s/cred"\nctl_socket = "%s"\nacme_webroot = "%s/acme"\n%s'
                % (self.public_url, self.port, root, root, root, self.sock, root, extra)
            )
        subprocess.run([self.bin, "trunk-kek", os.path.join(root, "cred", "trunk-kek")], check=True, capture_output=True)
        self.proc = None
        self.log = os.path.join(root, "trunk.log")
        # e.g. ["taskset", "-c", "0"] (it execs the trunk: the PID stays ours)
        self.bin_prefix = []

    @property
    def ctl_prefix(self):
        return [self.bin, "trunk-ctl", "--sock", self.sock]

    def ctl(self, *args):
        return ctl(self.ctl_prefix, *args)

    def start(self):
        env = dict(os.environ)
        if self.fast:
            env["TRUNK_TEST_FAST"] = "1"
        self.proc = subprocess.Popen(self.bin_prefix + [self.bin, "trunk", "-c", self.cfg], stdout=open(self.log, "ab"), stderr=subprocess.STDOUT, env=env)
        deadline = time.time() + 15
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("trunk exited: " + open(self.log).read()[-2000:])
            try:
                c = Client(self.url)
                if c.get("/t/state").status == 200:
                    return self
            except OSError:
                pass
            time.sleep(0.1)
        raise RuntimeError("trunk did not answer on %s" % self.url)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()  # our own child, by PID
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        self.proc = None

    def client(self, **k):
        return Client(self.url, origin=self.public_url, **k)
