#!/usr/bin/env python3
"""drive.py — G3.8 coexistence driver (called by sim/trunk-v1-coexist.sh).

Exercises real v0.9 bifrost-net ap + v0.9 livekit-server AND real v1 bifrost-net trunk + v1 livekit-server
behind ONE trunk/deploy/sni-443.py (v2):
  C01  both trunks answer through sni-443 v2 (ap. → v0.9 app, ljoolq. → v1 /t/state, 302 /login, v1 app)
  C02  v1 real LiveKit /rtc → bridge dynamically registers ufrag → /t/ice/owner returns 200
  C03  v0.9 real LiveKit /rtc at the same time → /t/ice/owner returns 404
  C04  simultaneous real LiveKit ICE-TCP (RFC 4571 STUN) on both v1 and v0.9 through sni-443 v2 (:19143)
  C05  SIGHUP reload of sni-443 v2 with live WS + ICE-TCP + HTTP connections → zero dropped
  C06  v1 trunk stopped (SIGKILL) mid-run → v0.9 app + new v0.9 LiveKit ICE-TCP stay unaffected; v1 recovers
  C07  switchover flip (ap. → v1 trunk via SIGHUP) → live v0.9 conn survives, new ap. hits v1
  C08  rollback flip (ap. → v0.9 ap via SIGHUP) → new ap. hits v0.9 app + v0.9 LiveKit ICE-TCP
"""
import base64
import hashlib
import hmac
import http.server
import json
import os
import re
import signal
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zlib

CFG = json.load(open(sys.argv[1]))
STEPS_FILE = CFG["steps_file"]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
STEPS = []


def record(step, res, what):
    STEPS.append((step, res, what))
    with open(STEPS_FILE, "a") as f:
        f.write(f"{step}\t{res}\t{what}\n")
    print(f"{step:<6} {res:<8} {what}", flush=True)


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def lk_jwt(key, secret, room, identity):
    now = int(time.time())
    hdr = b64u(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    pay = b64u(json.dumps({
        "iss": key, "sub": identity, "nbf": now - 10, "exp": now + 3600,
        "video": {"roomJoin": True, "room": room, "canPublish": True, "canSubscribe": True},
    }, separators=(",", ":")).encode())
    sig = b64u(hmac.new(secret.encode(), f"{hdr}.{pay}".encode(), hashlib.sha256).digest())
    return f"{hdr}.{pay}.{sig}"


def tls_ctx():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def https_req(host, port, path, headers=None, timeout=8):
    raw = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    s = tls_ctx().wrap_socket(raw, server_hostname=host)
    s.settimeout(timeout)
    hdrs = {"Host": f"{host}:{port}", "Connection": "close", **(headers or {})}
    req = f"GET {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in hdrs.items()) + "\r\n"
    s.sendall(req.encode())
    buf = b""
    while True:
        try:
            d = s.recv(4096)
            if not d:
                break
            buf += d
        except socket.timeout:
            break
    s.close()
    head, _, body = buf.partition(b"\r\n\r\n")
    lines = head.decode(errors="replace").split("\r\n")
    code = int(lines[0].split(" ")[1]) if len(lines[0].split(" ")) > 1 else 0
    hmap = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:])}
    return code, hmap, body.decode(errors="replace")


def http_get(url, timeout=5):
    try:
        with OPENER.open(url, timeout=timeout) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


class WsClient:
    """Minimal RFC 6455 client over TLS (for real LiveKit /rtc signaling)."""
    def __init__(self, host, port, path, cookie):
        raw = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.s = tls_ctx().wrap_socket(raw, server_hostname=host)
        self.s.settimeout(10)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"Cookie: bifrost_device={cookie}\r\n\r\n"
        )
        self.s.sendall(req.encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            d = self.s.recv(4096)
            if not d:
                raise RuntimeError("ws handshake closed")
            self.buf += d
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        if " 101 " not in status:
            raise RuntimeError(f"ws upgrade failed: {status}")

    def _read_exact(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d:
                raise EOFError("ws closed")
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_frame(self, timeout=10):
        self.s.settimeout(timeout)
        b0, b1 = self._read_exact(2)
        op = b0 & 0x0F
        masked = (b1 & 0x80) != 0
        ln = b1 & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", self._read_exact(2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", self._read_exact(8))[0]
        mask = self._read_exact(4) if masked else b""
        payload = bytearray(self._read_exact(ln))
        if masked:
            for i in range(len(payload)):
                payload[i] ^= mask[i % 4]
        return op, bytes(payload)

    def send_frame(self, op, payload=b""):
        mask = os.urandom(4)
        hdr = bytearray([0x80 | op])
        ln = len(payload)
        if ln < 126:
            hdr.append(0x80 | ln)
        elif ln < 65536:
            hdr.append(0x80 | 126)
            hdr.extend(struct.pack("!H", ln))
        else:
            hdr.append(0x80 | 127)
            hdr.extend(struct.pack("!Q", ln))
        hdr.extend(mask)
        mp = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.s.sendall(bytes(hdr) + mp)

    def ping(self, data=b"coexist"):
        self.send_frame(0x9, data)
        end = time.time() + 5
        while time.time() < end:
            op, p = self.recv_frame(timeout=max(0.5, end - time.time()))
            if op == 0xA and p == data:
                return True
            if op == 0x9:
                self.send_frame(0xA, p)
        return False

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def _varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _pb_bytes(field, data):
    return _varint((field << 3) | 2) + _varint(len(data)) + data


def livekit_get_ice(host, port, lk_key, lk_secret, cookie, room, identity):
    """Connect to real LiveKit /rtc through sni-443 v2, send Answer SDP, return (ws, ufrag, pwd)."""
    jwt = lk_jwt(lk_key, lk_secret, room, identity)
    path = f"/rtc?access_token={jwt}&auto_subscribe=1&sdk=js&version=2.0.0&protocol=15"
    ws = WsClient(host, port, path, cookie)
    end = time.time() + 15
    ufrag = pwd = offer_sdp = None
    while time.time() < end:
        op, payload = ws.recv_frame(timeout=max(0.5, end - time.time()))
        if op == 0x9:
            ws.send_frame(0xA, payload)
            continue
        if op in (0x1, 0x2):
            text = payload.decode("latin1")
            mu = re.search(r"a=ice-ufrag:([A-Za-z0-9+/]+)", text)
            mp = re.search(r"a=ice-pwd:([A-Za-z0-9+/]+)", text)
            if mu and mp and "v=0" in text:
                ufrag, pwd = mu.group(1), mp.group(1)
                offer_sdp = re.split(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", text[text.index("v=0"):])[0]
                break
    if not ufrag or not pwd or not offer_sdp:
        ws.close()
        raise RuntimeError(f"no ice-ufrag/ice-pwd in LiveKit Offer from {host}")
    ans_sdp = re.sub(r"a=ice-ufrag:[^\r\n]+", "a=ice-ufrag:clnt", offer_sdp)
    ans_sdp = re.sub(r"a=ice-pwd:[^\r\n]+", "a=ice-pwd:clientpassword1234567890", ans_sdp)
    ans_sdp = re.sub(r"a=setup:actpass", "a=setup:active", ans_sdp)
    sd = _pb_bytes(1, b"answer") + _pb_bytes(2, ans_sdp.encode())
    ws.send_frame(0x2, _pb_bytes(2, sd))
    time.sleep(0.15)
    return ws, ufrag, pwd


def build_stun_binding_req(ufrag, pwd, client_ufrag="clnt"):
    """Build an RFC 4571 framed STUN Binding Request with USERNAME + MESSAGE-INTEGRITY + FINGERPRINT."""
    tid = os.urandom(12)
    magic = 0x2112A442
    uname = f"{ufrag}:{client_ufrag}".encode()
    pad = (4 - len(uname) % 4) % 4
    attrs = bytearray()
    # USERNAME (0x0006)
    attrs += struct.pack("!HH", 0x0006, len(uname)) + uname + b"\x00" * pad
    # PRIORITY (0x0024)
    attrs += struct.pack("!HHI", 0x0024, 4, 0x6E001EFF)
    # ICE-CONTROLLED (0x8029) — LiveKit is the offerer (ICE-CONTROLLING)
    attrs += struct.pack("!HHQ", 0x8029, 8, int.from_bytes(os.urandom(8), "big"))
    # MESSAGE-INTEGRITY (0x0008): length in header includes MI (24 bytes)
    hdr_mi = struct.pack("!HHI12s", 0x0001, len(attrs) + 24, magic, tid)
    mac = hmac.new(pwd.encode(), hdr_mi + bytes(attrs), hashlib.sha1).digest()
    attrs += struct.pack("!HH", 0x0008, 20) + mac
    # FINGERPRINT (0x8028): length in header includes FP (8 bytes)
    hdr_fp = struct.pack("!HHI12s", 0x0001, len(attrs) + 8, magic, tid)
    crc = zlib.crc32(hdr_fp + bytes(attrs)) ^ 0x5354554E
    attrs += struct.pack("!HHI", 0x8028, 4, crc)
    msg = hdr_fp + bytes(attrs)
    return tid, struct.pack("!H", len(msg)) + msg


def stun_roundtrip(sock, ufrag, pwd, timeout=5):
    """Send a framed STUN Binding Request on an open ICE-TCP socket and verify Binding Success (0x0101)."""
    tid, frame = build_stun_binding_req(ufrag, pwd)
    sock.sendall(frame)
    end = time.time() + timeout
    while time.time() < end:
        sock.settimeout(max(0.2, end - time.time()))
        hdr2 = b""
        while len(hdr2) < 2:
            d = sock.recv(2 - len(hdr2))
            if not d:
                raise EOFError("ice-tcp closed before STUN response length")
            hdr2 += d
        rlen = struct.unpack("!H", hdr2)[0]
        body = b""
        while len(body) < rlen:
            d = sock.recv(rlen - len(body))
            if not d:
                raise EOFError("ice-tcp closed mid-STUN response")
            body += d
        if len(body) < 20:
            continue
        mtype, mlen, magic, rtid = struct.unpack("!HHI12s", body[:20])
        if magic != 0x2112A442:
            continue
        if mtype == 0x0101 and rtid == tid:
            return True
        if mtype == 0x0001:
            # LiveKit (ICE-CONTROLLING) may send us its own Binding Request; keep reading for our 0x0101
            continue
        raise RuntimeError(f"unexpected STUN response: type=0x{mtype:04x} tid_match={rtid == tid}")
    raise TimeoutError("timed out waiting for STUN Binding Success 0x0101")


def write_sni_conf(ap_target, ap_proxy=True, include_owner=True):
    lines = [
        f"listen 127.0.0.1:{CFG['door_port']}",
        f"route ap.veraldar.org {ap_target}{' proxy' if ap_proxy else ''}",
        f"route ljoolq.veraldar.org 127.0.0.1:{CFG['v1_tls_port']} proxy",
        f"ice 127.0.0.1:{CFG['v0_ice_port']}",
    ]
    if include_owner:
        lines.append(
            f"ice_owner http://127.0.0.1:{CFG['v1_http_port']}/t/ice/owner "
            f"127.0.0.1:{CFG['v1_ice_port']} 200ms"
        )
    lines.append(f"default 127.0.0.1:{CFG['site_port']}")
    tmp = CFG["sni_conf"] + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, CFG["sni_conf"])


def reload_sni():
    log_path = CFG["sni_log"]
    before = open(log_path).read().count("sni-443: reloaded") if os.path.exists(log_path) else 0
    os.kill(CFG["sni_pid"], signal.SIGHUP)
    for _ in range(40):
        if os.path.exists(log_path) and open(log_path).read().count("sni-443: reloaded") > before:
            return True
        time.sleep(0.1)
    return False


def open_streaming_http(host, port, path):
    """Open a TLS HTTP connection to /stream (drips a chunk every 0.3s) and verify first chunk."""
    raw = socket.create_connection(("127.0.0.1", port), timeout=5)
    s = tls_ctx().wrap_socket(raw, server_hostname=host)
    s.settimeout(5)
    s.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n".encode())
    buf = b""
    while b"tick-0\n" not in buf:
        d = s.recv(4096)
        if not d:
            raise EOFError("stream closed early")
        buf += d
    return s


def main():
    door = CFG["door_port"]
    v1_http = CFG["v1_http_port"]
    v0_tok = CFG["v0_dev_token"]
    v1_tok = CFG["v1_dev_token"]
    fails = 0

    # ── C01: both trunks answer through one sni-443 v2 ─────────────────────────────────────────────────
    try:
        c0, _, b0 = https_req("ap.veraldar.org", door, "/")
        cs, _, bs = https_req("ljoolq.veraldar.org", door, "/t/state")
        c1a, h1a, _ = https_req("ljoolq.veraldar.org", door, "/", {"Accept": "text/html"})
        c1b, _, b1b = https_req("ljoolq.veraldar.org", door, "/", {"Cookie": f"bifrost_device={v1_tok}"})
        ok = (
            c0 == 200 and "v0.9-app-ok" in b0
            and cs == 200 and '"claimed":true' in bs
            and c1a == 302 and "/login" in h1a.get("location", "")
            and c1b == 200 and "v1-app-ok" in b1b
        )
        if ok:
            record("C01", "PASS", "both v0.9 ap and v1 trunk answer behind one sni-443 v2")
        else:
            record("C01", "FAIL", f"c0={c0} cs={cs} c1a={c1a}({h1a.get('location')}) c1b={c1b} b1b={b1b[:40]}")
            fails += 1
    except Exception as e:
        record("C01", "FAIL", str(e))
        fails += 1

    # ── C02: v1 real LiveKit /rtc → dynamic ufrag registration → /t/ice/owner 200 ─────────────────────
    ws_v1 = ws_v0 = None
    u1 = p1 = u0 = p0 = None
    try:
        ws_v1, u1, p1 = livekit_get_ice("ljoolq.veraldar.org", door, CFG["lk1_key"], CFG["lk1_secret"], v1_tok, "room-v1", "phone-v1")
        st, body = http_get(f"http://127.0.0.1:{v1_http}/t/ice/owner?u={u1}")
        if st == 200:
            record("C02", "PASS", f"v1 LiveKit /rtc dynamically registered ufrag={u1} (/t/ice/owner → 200)")
        else:
            record("C02", "FAIL", f"v1 ufrag={u1} /t/ice/owner → {st} {body}")
            fails += 1
    except Exception as e:
        record("C02", "FAIL", str(e))
        fails += 1

    # ── C03: v0.9 real LiveKit /rtc at the same time → /t/ice/owner 404 ───────────────────────────────
    try:
        ws_v0, u0, p0 = livekit_get_ice("ap.veraldar.org", door, CFG["lk0_key"], CFG["lk0_secret"], v0_tok, "room-v0", "phone-v0")
        st, body = http_get(f"http://127.0.0.1:{v1_http}/t/ice/owner?u={u0}")
        if st == 404 and u0 != u1:
            record("C03", "PASS", f"v0.9 LiveKit /rtc live simultaneously (ufrag={u0}, /t/ice/owner → 404)")
        else:
            record("C03", "FAIL", f"v0 ufrag={u0} /t/ice/owner → {st} {body}")
            fails += 1
    except Exception as e:
        record("C03", "FAIL", str(e))
        fails += 1

    # ── C04: simultaneous real LiveKit ICE-TCP through sni-443 v2 ──────────────────────────────────────
    ice_v1 = ice_v0 = None
    phase = "init"
    try:
        phase = "v1-connect"
        ice_v1 = socket.create_connection(("127.0.0.1", door), timeout=5)
        phase = "v1-stun-1"
        stun_roundtrip(ice_v1, u1, p1)
        phase = "v0-connect"
        ice_v0 = socket.create_connection(("127.0.0.1", door), timeout=5)
        phase = "v0-stun-1"
        stun_roundtrip(ice_v0, u0, p0)
        # Second roundtrip on BOTH while both stay open simultaneously
        phase = "v1-stun-2"
        stun_roundtrip(ice_v1, u1, p1)
        phase = "v0-stun-2"
        stun_roundtrip(ice_v0, u0, p0)
        record("C04", "PASS", "simultaneous real LiveKit ICE-TCP STUN binding succeeded on both v1 and v0.9 via sni-443 v2")
    except Exception as e:
        record("C04", "FAIL", f"{phase}: {e}")
        fails += 1

    # ── C05: SIGHUP reload with live HTTP + WS + ICE-TCP connections → zero dropped ───────────────────
    stream_s = None
    try:
        stream_s = open_streaming_http("ap.veraldar.org", door, "/stream")
        reloaded = reload_sni()
        # Verify EVERY open connection survived the SIGHUP reload
        ws1_ok = ws_v1.ping(b"after-hup-1") if ws_v1 else False
        ws0_ok = ws_v0.ping(b"after-hup-0") if ws_v0 else False
        ice1_ok = stun_roundtrip(ice_v1, u1, p1) if ice_v1 else False
        ice0_ok = stun_roundtrip(ice_v0, u0, p0) if ice_v0 else False
        stream_s.settimeout(3)
        more = stream_s.recv(4096)
        if reloaded and ws1_ok and ws0_ok and ice1_ok and ice0_ok and b"tick-" in more:
            record("C05", "PASS", "SIGHUP reload kept all 5 live connections (2 /rtc WS, 2 ICE-TCP, 1 HTTP stream) alive")
        else:
            record("C05", "FAIL", f"reloaded={reloaded} ws1={ws1_ok} ws0={ws0_ok} ice1={ice1_ok} ice0={ice0_ok} stream={len(more)}")
            fails += 1
    except Exception as e:
        record("C05", "FAIL", str(e))
        fails += 1
    finally:
        for s in (ice_v1, ice_v0, stream_s):
            if s:
                try:
                    s.close()
                except OSError:
                    pass
        for w in (ws_v1, ws_v0):
            if w:
                w.close()

    # ── C06: v1 trunk stopped (SIGKILL) mid-run → v0.9 app & LiveKit voice unaffected ─────────────────
    try:
        v1_pid = int(open(CFG["v1_trunk_pidfile"]).read().strip())
        os.kill(v1_pid, signal.SIGKILL)
        for _ in range(30):
            st, _ = http_get(f"http://127.0.0.1:{v1_http}/t/state", timeout=1)
            if st == 0:
                break
            time.sleep(0.1)
        # v0.9 app still answers 200
        c0, _, b0 = https_req("ap.veraldar.org", door, "/")
        # New v0.9 LiveKit /rtc + ICE-TCP works while v1 trunk is dead (fast fallback ≤ 200 ms)
        t0 = time.monotonic()
        ws0b, u0b, p0b = livekit_get_ice("ap.veraldar.org", door, CFG["lk0_key"], CFG["lk0_secret"], v0_tok, "room-v0-down", "phone-v0b")
        ice0b = socket.create_connection(("127.0.0.1", door), timeout=5)
        t_ice = time.monotonic()
        stun_roundtrip(ice0b, u0b, p0b)
        ice_ms = int((time.monotonic() - t_ice) * 1000)
        ice0b.close()
        ws0b.close()
        # Restart v1 trunk and wait for v1 bridge to reconnect
        logf = open(CFG["v1_trunk_log"], "ab")
        env = dict(os.environ, TRUNK_TEST_FAST="1")
        p = subprocess.Popen([CFG["bin"], "trunk", "-c", CFG["v1_trunk_toml"]], stdout=logf, stderr=logf, env=env)
        with open(CFG["v1_trunk_pidfile"], "w") as f:
            f.write(str(p.pid))
        recovered = False
        for _ in range(80):
            try:
                c1, _, b1 = https_req("ljoolq.veraldar.org", door, "/", {"Cookie": f"bifrost_device={v1_tok}"}, timeout=2)
                if c1 == 200 and "v1-app-ok" in b1:
                    recovered = True
                    break
            except Exception:
                pass
            time.sleep(0.25)
        if c0 == 200 and "v0.9-app-ok" in b0 and recovered:
            record("C06", "PASS", f"v1 trunk SIGKILL left v0.9 app + new LiveKit ICE-TCP unaffected ({ice_ms} ms); v1 recovered")
        else:
            record("C06", "FAIL", f"c0={c0} recovered={recovered}")
            fails += 1
    except Exception as e:
        record("C06", "FAIL", str(e))
        fails += 1

    # ── C07: switchover flip (ap. → v1 trunk via SIGHUP) with a phone connected ───────────────────────
    live_v0 = None
    try:
        live_v0 = open_streaming_http("ap.veraldar.org", door, "/stream")
        write_sni_conf(f"127.0.0.1:{CFG['v1_tls_port']}", ap_proxy=True, include_owner=True)
        reloaded = reload_sni()
        # Pre-existing v0.9 phone connection still receives bytes
        live_v0.settimeout(3)
        more = live_v0.recv(4096)
        # New connections to ap.veraldar.org now hit v1 trunk
        cs, _, bs = https_req("ap.veraldar.org", door, "/t/state")
        c302, h302, _ = https_req("ap.veraldar.org", door, "/", {"Accept": "text/html"})
        ok = (
            reloaded and b"tick-" in more
            and cs == 200 and '"claimed":true' in bs
            and c302 == 302 and "/login" in h302.get("location", "")
        )
        if ok:
            record("C07", "PASS", "switchover flip (ap. → v1 trunk via SIGHUP): live v0.9 stream survived, new ap. → v1 /t/state 200 + 302 /login")
        else:
            record("C07", "FAIL", f"reloaded={reloaded} more={len(more)} cs={cs} c302={c302} loc={h302.get('location')}")
            fails += 1
    except Exception as e:
        record("C07", "FAIL", str(e))
        fails += 1
    finally:
        if live_v0:
            try:
                live_v0.close()
            except OSError:
                pass

    # ── C08: rollback flip (ap. → v0.9 ap via SIGHUP) ─────────────────────────────────────────────────
    try:
        write_sni_conf(f"127.0.0.1:{CFG['v0_ap_port']}", ap_proxy=True, include_owner=True)
        reloaded = reload_sni()
        c0, _, b0 = https_req("ap.veraldar.org", door, "/")
        ws0c, u0c, p0c = livekit_get_ice("ap.veraldar.org", door, CFG["lk0_key"], CFG["lk0_secret"], v0_tok, "room-v0-rb", "phone-v0c")
        ice0c = socket.create_connection(("127.0.0.1", door), timeout=5)
        stun_roundtrip(ice0c, u0c, p0c)
        ice0c.close()
        ws0c.close()
        if reloaded and c0 == 200 and "v0.9-app-ok" in b0:
            record("C08", "PASS", "rollback flip (ap. → v0.9 ap via SIGHUP): v0.9 app (200) and LiveKit ICE-TCP work again")
        else:
            record("C08", "FAIL", f"reloaded={reloaded} c0={c0} b0={b0[:40]}")
            fails += 1
    except Exception as e:
        record("C08", "FAIL", str(e))
        fails += 1

    sys.exit(0 if fails == 0 else 1)


if __name__ == "__main__":
    main()
