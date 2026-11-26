#!/usr/bin/env python3
"""vps-eye.py LISTEN AP CERT KEY LOG MITM_FILE — the VPS's own eyes on the trunk (sim/trunk-rtc-e2e.sh).

A VPS holds the access point's TLS key, so it can read everything the ap decrypts. This stands
where a curious (or hostile) VPS operator would: between sni-443.py and the ap, terminating TLS
with the ap's own certificate and key (phones and the home bridge's pin accept it — it IS the
VPS's key), re-encrypting to the ap, and writing every decrypted byte to LOG (JSON lines:
t, conn, who = phone | bridge | root, src = the client's address (from the PROXY line), dir =
c2s | s2c, b64). The spec reads it: after pairing, no app data may appear in it; a joined root's
link (`GET /rootlink`, sim/trunk-e2e.sh) is `root`.

MITM_FILE present = an ACTIVE attack: on phone connections, every DTLS fingerprint the VPS
carries (a=fingerprint:sha-256 …, in the /offer answer) is swapped for its own — the phone
must refuse the pinned channel (lib/pinned.ts), and send nothing. When MITM_FILE's text names
"directory", the v1 trunk's directory pins on phone connections (`"dtls_fp":"sha-256 …"` in
/t/me/roots) are swapped too — a phone that remembered the real key must raise the pin-change
alarm (spec §5.2, D3). The v1 trunk's root channel (`GET /t/root`, sim/trunk-rtc-v1-e2e.sh) is
`bridge`, like the v0.9 `GET /ap`.

sni-443.py routes the ap's name here with `proxy`: the PROXY v1 line comes first, and is passed on.
"""
import asyncio
import base64
import json
import os
import re
import ssl
import sys
import time

FP = re.compile(rb"(a=fingerprint:sha-256 )((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})")
DIR_FP = re.compile(rb'("dtls_fp"\s*:\s*"sha-256 )((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})')
FAKE = b":".join([b"66"] * 32)


def parse(a):
    h, p = a.rsplit(":", 1)
    return h, int(p)


def main(listen, ap, cert, key, logpath, mitm_file):
    log = open(logpath, "a")
    sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    sctx.load_cert_chain(cert, key)
    sctx.set_alpn_protocols(["http/1.1"])
    cctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    cctx.check_hostname = False
    cctx.verify_mode = ssl.CERT_NONE
    cctx.set_alpn_protocols(["http/1.1"])
    seq = [0]

    def write(cid, who, d, b, src=""):
        log.write(json.dumps({"t": int(time.time() * 1000), "conn": cid, "who": who, "src": src, "dir": d,
                              "b64": base64.b64encode(b).decode()}) + "\n")
        log.flush()

    async def pipe(r, w, cid, who, src, d, rewrite, first=b""):
        carry = b""
        if first:
            write(cid, who, d, first, src)
            w.write(first)
        while True:
            try:
                b = await asyncio.wait_for(r.read(65536), 0.03) if (rewrite and carry) else await r.read(65536)
            except asyncio.TimeoutError:  # quiet: flush what was held back
                w.write(carry)
                carry = b""
                continue
            except (OSError, ssl.SSLError):
                break
            if not b:
                break
            write(cid, who, d, b, src)
            if rewrite and os.path.exists(mitm_file):
                b = FP.sub(lambda m: m.group(1) + FAKE, carry + b)
                if b"directory" in open(mitm_file, "rb").read():
                    b = DIR_FP.sub(lambda m: m.group(1) + FAKE, b)
                carry, b = b[-120:], b[:-120]  # a fingerprint may straddle two reads
            if b:
                w.write(b)
            try:
                await w.drain()
            except (OSError, ssl.SSLError):
                break
        try:
            if carry:
                w.write(carry)
            w.close()
        except (OSError, ssl.SSLError, RuntimeError):
            pass

    async def one(r, w):
        try:
            line = await asyncio.wait_for(r.readuntil(b"\r\n"), 10)
            await asyncio.wait_for(w.start_tls(sctx), 10)
            ur, uw = await asyncio.open_connection(*parse(ap))
            uw.write(line)
            await uw.drain()
            await asyncio.wait_for(uw.start_tls(cctx, server_hostname="ap"), 10)
            first = await asyncio.wait_for(r.read(65536), 30)
        except (OSError, ssl.SSLError, asyncio.TimeoutError, asyncio.IncompleteReadError):
            w.close()
            return
        seq[0] += 1
        cid = seq[0]
        # the first request line tells the home bridge's channel (GET /ap) and a joined root's link
        # (GET /rootlink) from a phone; the PROXY line names the client's real address
        who = ("bridge" if first.startswith((b"GET /ap ", b"GET /t/root ")) else "root"
               if first.startswith(b"GET /rootlink") else "phone")
        parts = line.split()
        src = parts[2].decode() if len(parts) >= 6 and parts[0] == b"PROXY" else ""
        await asyncio.gather(pipe(r, uw, cid, who, src, "c2s", False, first),
                             pipe(ur, w, cid, who, src, "s2c", who == "phone"))

    async def run():
        srv = await asyncio.start_server(one, *parse(listen))
        print(f"vps-eye: {listen} → {ap}, decrypted bytes → {logpath}", flush=True)
        async with srv:
            await srv.serve_forever()

    asyncio.run(run())


if __name__ == "__main__":
    if len(sys.argv) != 7:
        print(__doc__.splitlines()[0], file=sys.stderr)
        sys.exit(64)
    main(*sys.argv[1:])
