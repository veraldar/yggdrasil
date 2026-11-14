#!/usr/bin/env python3
"""tap.py LISTEN TARGET LOG — a byte-exact TCP relay that records what crosses it (sim/trunk-rtc-e2e.sh).

Sits on the VPS between sni-443.py's `ice` route and the access point's raw `livekit-ice` forward:
the one place the phone's media exists on the VPS outside the channel's TLS. It forwards every byte
untouched and classifies each RFC 4571 frame (2-byte length + one packet) the way RFC 7983
demultiplexes a WebRTC 5-tuple, by the packet's first byte:
    0..3 STUN (+ the magic cookie at 4..8)   20..63 DTLS (content type 20 ccs, 21 alert, 22 handshake,
    23 application data)   128..191 RTP/RTCP — SRTP/SRTCP here   anything else: "other"
One JSON line per frame to LOG: {"conn", "dir": "up"|"down", "cls", "len", "dtls"?, "t" (ms)}; nothing
of the payload is kept except the first 4 bytes (hex) — the spec checks that nothing readable
(no "other", no plaintext RTP) ever crossed.
"""
import json
import socket
import sys
import threading
import time

MAGIC = b"\x21\x12\xa4\x42"
lock = threading.Lock()
seq = [0]


def parse(addr):
    h, p = addr.rsplit(":", 1)
    return h, int(p)


def classify(pkt):
    if not pkt:
        return "empty", None
    b = pkt[0]
    if b <= 3 and pkt[4:8] == MAGIC:
        return "stun", None
    if 20 <= b <= 63:
        return "dtls", b
    if 128 <= b <= 191:
        return "srtp", None
    return "other", None


def pipe(conn_id, src, dst, direction, log):
    buf = b""
    try:
        while True:
            d = src.recv(65536)
            if not d:
                break
            dst.sendall(d)
            buf += d
            while len(buf) >= 2:
                n = int.from_bytes(buf[:2], "big")
                if len(buf) < 2 + n:
                    break
                pkt, buf = buf[2:2 + n], buf[2 + n:]
                cls, ct = classify(pkt)
                rec = {"conn": conn_id, "dir": direction, "cls": cls, "len": n, "head": pkt[:4].hex(),
                       "t": int(time.time() * 1000)}
                if ct is not None:
                    rec["dtls"] = ct
                with lock:
                    log.write(json.dumps(rec) + "\n")
                    log.flush()
    except OSError:
        pass
    for s in (src, dst):
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    with lock:
        log.write(json.dumps({"conn": conn_id, "dir": direction, "cls": "closed", "t": int(time.time() * 1000)}) + "\n")
        log.flush()


def main(listen, target, path):
    log = open(path, "a")
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(parse(listen))
    s.listen(64)
    print(f"tap: {listen} → {target}, frames → {path}", flush=True)
    while True:
        c, _ = s.accept()
        try:
            u = socket.create_connection(parse(target), timeout=5)
            u.settimeout(None)
        except OSError:
            c.close()
            continue
        for x in (c, u):
            x.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        with lock:
            seq[0] += 1
            cid = seq[0]
            log.write(json.dumps({"conn": cid, "cls": "open", "t": int(time.time() * 1000)}) + "\n")
            log.flush()
        threading.Thread(target=pipe, args=(cid, c, u, "up", log), daemon=True).start()
        threading.Thread(target=pipe, args=(cid, u, c, "down", log), daemon=True).start()


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__.splitlines()[0], file=sys.stderr)
        sys.exit(64)
    main(*sys.argv[1:])
