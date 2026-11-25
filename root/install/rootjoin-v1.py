#!/usr/bin/env python3
"""rootjoin-v1 — the v1 enrollment helper root.sh runs (no deps, stdlib only).

  rootjoin-v1.py enroll --state DIR --trunk URL --name N --os OS --host H --arch A
                        --root-pub KEY --wg-pub KEY --brain-port P --app-port P --bridge-port P
                        [--upstream FILE | --upstream-env-from-env]

The trunk's enrollment API (WIRE.md):
  POST /t/roots/enroll {name, hostname, os, arch, version, build_id, has_app, has_voice,
                        root_pub, wg_pub, dtls_fp}
     → 201 {id, poll_secret, poll_every_s, approve_url, code, code_expires_in, expires_in}
  POST /t/roots/enroll/:id/poll {secret}   (every 2 s)
     → 200 {status: pending, code, code_expires_in, expires_in}
     → 200 {status: approved, root_id, name, wg_addr, wg_net, trunk{url, trunk_id, trunk_key},
             peer_token, directory}
     → 410 {status: delivered} (the result is handed out once)

Desktop (a browser here): opens /auth/root?e=<id> and polls; headless: prints hostname,
fingerprints, the rotating code with a countdown, and a terminal QR of approve_url#c=<code>.

On approval this writes state/root.json (0600): everything root.sh needs.
"""
import json, os, re, struct, subprocess, sys, time, urllib.error, urllib.parse, urllib.request, zlib

EXIT_OK, EXIT_ERR, EXIT_REFUSED, EXIT_EXPIRED, EXIT_USAGE = 0, 1, 3, 4, 64
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
WG_KEY = re.compile(r"^[A-Za-z0-9+/]{43}=$")
POLL_SECS = 2.0


def say(msg):
    print(msg, flush=True)


def fail(msg, code=EXIT_ERR):
    print("rootjoin: " + msg, file=sys.stderr, flush=True)
    sys.exit(code)


def write_private(path, text):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, text.encode())
    finally:
        os.close(fd)
    os.replace(tmp, path)


class NetError(Exception):
    pass


def http(method, url, body=None, headers=None, timeout=15):
    """-> (status, parsed JSON dict). Every POST carries Origin: <the trunk> (WIRE)."""
    data = json.dumps(body).encode() if body is not None else None
    h = {"accept": "application/json", "user-agent": "yggdrasil-root/1"}
    origin = urllib.parse.urlsplit(url)
    origin = "%s://%s" % (origin.scheme, origin.netloc)
    if data is not None:
        h["content-type"] = "application/json"
        h["origin"] = origin
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except (urllib.error.URLError, OSError) as e:
        raise NetError("%s %s: %s" % (method, url.split("?")[0], getattr(e, "reason", e)))
    try:
        parsed = json.loads(raw.decode() or "{}")
    except ValueError:
        parsed = {}
    return status, parsed if isinstance(parsed, dict) else {}


# QR code, byte mode, error correction level M — after Project Nayuki's reference algorithm.
_ECC_M = (-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
          26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28)
_BLOCKS_M = (-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
             17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49)


def _gf_mul(x, y):
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(deg):
    r, root = [0] * (deg - 1) + [1], 1
    for _ in range(deg):
        for j in range(deg):
            r[j] = _gf_mul(r[j], root)
            if j + 1 < deg:
                r[j] ^= r[j + 1]
        root = _gf_mul(root, 2)
    return r


def _rs_rem(data, div):
    r = [0] * len(div)
    for b in data:
        f = b ^ r.pop(0)
        r.append(0)
        for i, c in enumerate(div):
            r[i] ^= _gf_mul(c, f)
    return r


def _raw_modules(v):
    r = (16 * v + 128) * v + 64
    if v >= 2:
        n = v // 7 + 2
        r -= (25 * n - 10) * n - 55
        if v >= 7:
            r -= 36
    return r


def _penalty(m):
    n, p = len(m), 0
    for line in [list(r) for r in m] + [list(c) for c in zip(*m)]:
        run = 1
        for i in range(1, n + 1):
            if i < n and line[i] == line[i - 1]:
                run += 1
            else:
                if run >= 5:
                    p += run - 2
                run = 1
        s = "0000" + "".join("1" if c else "0" for c in line) + "0000"
        p += 40 * (s.count("00001011101") + s.count("10111010000"))
    for y in range(n - 1):
        for x in range(n - 1):
            if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                p += 3
    dark = sum(sum(1 for c in r if c) for r in m)
    total = n * n
    p += 10 * ((abs(dark * 20 - total * 10) + total - 1) // total - 1)
    return p


def qr_matrix(text):
    """-> square list of rows of bools (True = dark), no quiet zone."""
    data = text.encode("utf-8")
    for v in range(1, 41):
        cap = (_raw_modules(v) // 8 - _ECC_M[v] * _BLOCKS_M[v]) * 8
        cbits = 8 if v < 10 else 16
        if 4 + cbits + 8 * len(data) <= cap:
            break
    else:
        raise ValueError("text too long for a QR code")
    bits = []

    def put(val, n):
        bits.extend((val >> i) & 1 for i in range(n - 1, -1, -1))

    put(4, 4)
    put(len(data), cbits)
    for b in data:
        put(b, 8)
    put(0, min(4, cap - len(bits)))
    put(0, (-len(bits)) % 8)
    pad = 0xEC
    while len(bits) < cap:
        put(pad, 8)
        pad ^= 0xEC ^ 0x11
    words = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]

    nb, ecl, raw = _BLOCKS_M[v], _ECC_M[v], _raw_modules(v) // 8
    nshort, shortlen = nb - raw % nb, raw // nb
    div, blocks, k = _rs_divisor(ecl), [], 0
    for i in range(nb):
        d = words[k:k + shortlen - ecl + (0 if i < nshort else 1)]
        k += len(d)
        e = _rs_rem(d, div)
        if i < nshort:
            d = d + [0]
        blocks.append(d + e)
    cw = [b[i] for i in range(len(blocks[0])) for j, b in enumerate(blocks) if i != shortlen - ecl or j >= nshort]

    size = v * 4 + 17
    m = [[False] * size for _ in range(size)]
    fn = [[False] * size for _ in range(size)]

    def setf(x, y, dark):
        m[y][x], fn[y][x] = dark, True

    for i in range(size):
        setf(6, i, i % 2 == 0)
        setf(i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    setf(x, y, max(abs(dx), abs(dy)) not in (2, 4))
    if v > 1:
        n = v // 7 + 2
        step = (v * 8 + n * 3 + 5) // (n * 4 - 4) * 2
        pos = [6] + sorted(size - 7 - i * step for i in range(n - 1))
        for i, a in enumerate(pos):
            for j, b in enumerate(pos):
                if (i, j) in ((0, 0), (0, n - 1), (n - 1, 0)):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        setf(a + dx, b + dy, max(abs(dx), abs(dy)) != 1)

    def format_bits(mask):
        d = mask                      # level M = 0b00
        r = d
        for _ in range(10):
            r = (r << 1) ^ ((r >> 9) * 0x537)
        fb = ((d << 10) | r) ^ 0x5412

        def g(i):
            return (fb >> i) & 1 == 1
        for i in range(6):
            setf(8, i, g(i))
        setf(8, 7, g(6))
        setf(8, 8, g(7))
        setf(7, 8, g(8))
        for i in range(9, 15):
            setf(14 - i, 8, g(i))
        for i in range(8):
            setf(size - 1 - i, 8, g(i))
        for i in range(8, 15):
            setf(8, size - 15 + i, g(i))
        setf(8, size - 8, True)

    format_bits(0)
    if v >= 7:
        r = v
        for _ in range(12):
            r = (r << 1) ^ ((r >> 11) * 0x1F25)
        vb = (v << 12) | r
        for i in range(18):
            bit = (vb >> i) & 1 == 1
            a, b = size - 11 + i % 3, i // 3
            setf(a, b, bit)
            setf(b, a, bit)

    i, right = 0, size - 1
    while right >= 1:
        if right == 6:
            right = 5
        up = ((right + 1) & 2) == 0
        for vert in range(size):
            y = size - 1 - vert if up else vert
            for x in (right, right - 1):
                if not fn[y][x] and i < len(cw) * 8:
                    m[y][x] = (cw[i >> 3] >> (7 - (i & 7))) & 1 == 1
                    i += 1
        right -= 2

    masks = (lambda x, y: (x + y) % 2 == 0, lambda x, y: y % 2 == 0, lambda x, y: x % 3 == 0,
             lambda x, y: (x + y) % 3 == 0, lambda x, y: (x // 3 + y // 2) % 2 == 0,
             lambda x, y: x * y % 2 + x * y % 3 == 0, lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
             lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0)

    def apply(k):
        f = masks[k]
        for y in range(size):
            for x in range(size):
                if not fn[y][x] and f(x, y):
                    m[y][x] = not m[y][x]

    best = None
    for k in range(8):
        apply(k)
        format_bits(k)
        p = _penalty(m)
        if best is None or p < best[0]:
            best = (p, k)
        apply(k)
    apply(best[1])
    format_bits(best[1])
    return m


def qr_terminal(m, border=2):
    """Two modules per character cell (upper half block), black on white whatever the theme."""
    n = len(m)

    def dark(x, y):
        return 0 <= x < n and 0 <= y < n and m[y][x]
    out = []
    for y in range(-border, n + border, 2):
        out.append("".join("\x1b[%d;%dm\u2580" % (30 if dark(x, y) else 97, 40 if dark(x, y + 1) else 107)
                           for x in range(-border, n + border)) + "\x1b[0m")
    return "\n".join(out)


def qr_png(m, path, scale=8, border=4):
    n = len(m)
    side = (n + 2 * border) * scale
    rows = []
    for y in range(-border, n + border):
        line = b"".join((b"\x00" if 0 <= x < n and 0 <= y < n and m[y][x] else b"\xff") * scale
                        for x in range(-border, n + border))
        rows.extend([b"\x00" + line] * scale)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", side, side, 8, 0, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(png)
    os.replace(tmp, path)


def show_qr(text):
    """The QR in the terminal (qrencode when present, else this file's own encoder)."""
    import shutil
    qrencode = None if os.environ.get("JOIN_NO_QRENCODE") else shutil.which("qrencode")
    if qrencode:
        r = subprocess.run([qrencode, "-t", "ANSIUTF8", "-m", "2", text], capture_output=True, text=True)
        if r.returncode == 0:
            sys.stdout.write(r.stdout)
            return
    say(qr_terminal(qr_matrix(text)))


# ── dtls identity: the bridge makes it on first start; we only need its fingerprint for the
# ── enrollment card. The bridge's own dtls_cert_file (state/bridge-dtls.json) is created by
# ── `bifrost-net bridge` when it first runs; enrollment sends the fingerprint the trunk will
# ── show on the card. We cannot know it before the bridge runs, so: empty at enrollment (the
# ── trunk allows ""), and the phone pins it at first /offer (B5: directory pins + alarm).
# ── (WIRE's dtls_fp is optional; a root may also update it later.)


def build_id():
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "RELEASE")) as f:
            return f.read().split("\n", 1)[0].split(" ", 1)[-1].strip()
    except OSError:
        return "dev"


def cmd_enroll(o):
    state, trunk = o.state, o.trunk.rstrip("/")
    os.makedirs(state, mode=0o700, exist_ok=True)
    pend_path, root_path = os.path.join(state, "pending.json"), os.path.join(state, "root.json")
    if os.path.exists(root_path):
        say("==> already enrolled (root.json) — nothing to do")
        return EXIT_OK
    pend = None
    if os.path.exists(pend_path):
        pend = json.load(open(pend_path))
        if pend.get("trunk") != trunk or pend.get("deadline", 0) < time.time() + 5:
            pend = None
    body = {
        "name": o.name, "hostname": o.host, "os": o.os, "arch": o.arch,
        "version": "1.0.0", "build_id": build_id(),
        "has_app": True, "has_voice": True,
        "root_pub": o.root_pub, "wg_pub": o.wg_pub, "dtls_fp": "",
    }
    if pend:
        say("==> resuming the enrollment sent earlier (no new request)")
    else:
        say('==> asking %s to enroll this computer as a root ("%s", %s, host %s)' % (trunk, o.name, o.os, o.host))
        st, ans = http("POST", trunk + "/t/roots/enroll", body)
        if st != 201:
            fail("the trunk answered %d to the enrollment: %s" % (st, ans.get("error") or ans or "(no body)"))
        miss = [k for k in ("id", "poll_secret", "approve_url", "code", "expires_in") if k not in ans]
        if miss:
            fail("the enrollment answer lacks %s" % ", ".join(miss))
        pend = {"trunk": trunk, "id": str(ans["id"]), "secret": str(ans["poll_secret"]),
                "approve_url": urllib.parse.urljoin(trunk + "/", str(ans["approve_url"])),
                "deadline": time.time() + float(ans["expires_in"]), "name": o.name}
        write_private(pend_path, json.dumps(pend, indent=1) + "\n")

    # desktop or headless
    browser = _browser()
    if browser:
        url = pend["approve_url"]
        say("==> opening %s in your browser — approve this computer there" % url)
        try:
            subprocess.Popen(browser + [url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            say("    (could not open the browser — open it yourself: %s)" % url)
        say("    Waiting for the approval (polling every %.0f s; Ctrl-C to stop, re-run to resume)" % POLL_SECS)
    else:
        say("")
        say("    No browser here. On any signed-in admin device of your tree:")
        say("      1. open  %s/add-root" % trunk)
        say("      2. enter the code below (or scan the QR)")
        say("")
        url_base = pend["approve_url"]
        _headless_banner(trunk, pend, url_base)
        say("")
    return _poll(o, pend, pend_path, root_path)


def _browser():
    import shutil
    env = os.environ.get("BROWSER", "")
    if env:
        return [env]
    if sys.platform == "darwin":
        return ["open"]
    if os.environ.get("WSL_DISTRO_NAME") or "microsoft" in _proc_version():
        return ["wslview"] if shutil.which("wslview") else ["cmd.exe", "/c", "start"]
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        for b in ("xdg-open", "x-www-browser"):
            if shutil.which(b):
                return [b]
    return None


def _proc_version():
    try:
        with open("/proc/version") as f:
            return f.read()
    except OSError:
        return ""


def _headless_banner(trunk, pend, url_base):
    """The rotating code + countdown + QR of approve_url#c=<code>, refreshed as it rotates."""
    deadline = pend["deadline"]
    last_code, shown = None, 0
    while time.time() < deadline:
        st, ans = http("POST", "%s/t/roots/enroll/%s/poll" % (trunk, pend["id"]), {"secret": pend["secret"]})
        if st == 200 and ans.get("status") == "pending":
            code = str(ans.get("code") or last_code or "")
            left = int(ans.get("code_expires_in") or 0)
            if code != last_code:
                if shown:
                    say("\r\033[K    code rotated")
                last_code = code
                shown = 1
                say("    code:  %s   (checked against the code on your admin device)" % code)
                say("    scan:  %s#c=%s" % (url_base, code))
                show_qr("%s#c=%s" % (url_base, code))
            # countdown line, redrawn every second
            end = time.time() + left
            while time.time() < end and time.time() < deadline:
                sys.stdout.write("\r\033[K    code %s valid %3d s   enrollment valid %4d s " %
                                 (last_code, max(0, end - time.time()), max(0, deadline - time.time())))
                sys.stdout.flush()
                time.sleep(1)
            sys.stdout.write("\r\033[K")
            continue
        return _poll_result(trunk, pend, st, ans, pend["id"], pend["secret"], None, None)
    fail("the enrollment expired before it was approved — run root.sh again for a new code", EXIT_EXPIRED)


def _poll(o, pend, pend_path, root_path):
    trunk = pend["trunk"]
    net_warned = False
    while True:
        if time.time() > pend["deadline"] + 5:
            try:
                os.unlink(pend_path)
            except OSError:
                pass
            fail("the enrollment expired before it was approved — run root.sh again", EXIT_EXPIRED)
        try:
            st, ans = http("POST", "%s/t/roots/enroll/%s/poll" % (trunk, pend["id"]), {"secret": pend["secret"]})
            net_warned = False
        except NetError as e:
            if not net_warned:
                print("!!  trunk unreachable (%s) — still waiting" % e, file=sys.stderr, flush=True)
                net_warned = True
            time.sleep(POLL_SECS * 3)
            continue
        r = _poll_result(trunk, pend, st, ans, pend_path, root_path)
        if r is not None:
            return r
        time.sleep(POLL_SECS)


def _poll_result(trunk, pend, st, ans, pend_path, root_path):
    """One poll answer handled: an int exit code when finished, None when still pending."""
    status = ans.get("status")
    if st == 200 and status == "pending":
        return None
    if st == 200 and status == "approved":
        return _save(trunk, pend, ans, pend_path, root_path)
    if st == 410 or status in ("delivered",):
        fail("the enrollment's result was already collected (this enrollment is done)", EXIT_ERR)
    if status == "refused":
        try:
            os.unlink(pend_path)
        except OSError:
            pass
        fail("the enrollment was REFUSED on your admin device — nothing was installed", EXIT_REFUSED)
    if status in ("expired",):
        try:
            os.unlink(pend_path)
        except OSError:
            pass
        fail("the enrollment expired — run root.sh again", EXIT_EXPIRED)
    if st == 404:
        fail("the trunk no longer knows this enrollment (expired) — run root.sh again", EXIT_EXPIRED)
    if st in (401, 403):
        fail("the trunk refused the enrollment secret (%d) — run root.sh again" % st, EXIT_ERR)
    if st == 429:
        time.sleep(float(ans.get("retry_in", 30)))
        return None
    print("!!  unexpected answer while waiting: %d %s" % (st, ans), file=sys.stderr, flush=True)
    time.sleep(POLL_SECS * 2)
    return None


def _save(trunk, pend, ans, pend_path, root_path):
    root_id = ans.get("root_id")
    trunk_info = ans.get("trunk") or {}
    if not (isinstance(root_id, str) and SAFE_ID.match(root_id)):
        fail("the trunk's root_id %r is not a plain id" % (root_id,))
    peer_token = str(ans.get("peer_token") or "")
    if not peer_token:
        fail("the approval has no peer_token")
    tk = trunk_info.get("trunk_key")
    if not (isinstance(tk, str) and re.match(r"^[A-Za-z0-9_-]{40,90}$", tk)):
        fail("the approval's trunk key is malformed")
    wg_addr = ans.get("wg_addr")
    if not (isinstance(wg_addr, str) and re.match(r"^\d+\.\d+\.\d+\.\d+(/\d+)?$", wg_addr or "")):
        fail("the approval's wg_addr %r is malformed" % (wg_addr,))
    root = {"trunk": trunk, "root_id": root_id, "name": pend.get("name"),
            "wg_addr": wg_addr, "wg_net": ans.get("wg_net"),
            "trunk_key": tk, "trunk_id": trunk_info.get("trunk_id"),
            "peer_token": peer_token,
            "joined_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    write_private(root_path, json.dumps(root, indent=1) + "\n")
    try:
        os.unlink(pend_path)
    except OSError:
        pass
    say("==> approved: this computer is root %s of the trunk at %s" % (root_id, trunk))
    return EXIT_OK


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="rootjoin-v1")
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("enroll")
    e.add_argument("--state", required=True)
    e.add_argument("--trunk", required=True)
    e.add_argument("--name", required=True)
    e.add_argument("--os", required=True)
    e.add_argument("--host", required=True)
    e.add_argument("--arch", required=True)
    e.add_argument("--root-pub", required=True)
    e.add_argument("--wg-pub", required=True)
    e.add_argument("--brain-port", type=int, default=4180)
    e.add_argument("--app-port", type=int, default=4182)
    e.add_argument("--bridge-port", type=int, default=4190)
    e.add_argument("--upstream")
    e.add_argument("--upstream-env-from-env", action="store_true")
    o = ap.parse_args(argv)
    return {"enroll": cmd_enroll}[o.cmd](o)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\nstopped — re-run root.sh to resume the enrollment", file=sys.stderr)
        sys.exit(130)
