#!/usr/bin/env python3
"""eye-roots.py EYE.jsonl [SINCE_MS] — the joined roots' links as the VPS reads them (sim/trunk-e2e.sh).

vps-eye.py holds the access point's TLS key and logs every decrypted byte. A joined root's link is a
`GET /rootlink` websocket (who = root); this rebuilds each such connection's two byte streams, cuts
them into ws frames (unmasking the root's), and classifies every frame the way rootlink_tap.py does:
a binary frame is a WireGuard relay frame [n][address][datagram] (trunk/src/wg.rs) — its address
and the WireGuard kind of the datagram (init/response/cookie/data, or null when not WireGuard-
shaped); a text frame is a root-link op (its `op`). The root a connection belongs to is the `root`
of its `root-link.ok` ack.

Prints one JSON object: {conns: [{conn, src, root}], frames: [{conn, root, dir, op, len, addr,
kind, text_op, t}], payload_b64: every payload concatenated (what a reader of the link could read)}.
dir = up (root → VPS) | down. Frames from SINCE_MS on only (the connection is still read whole).
"""
import base64, bisect, json, os, struct, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from rootlink_tap import relay_parts, wg_kind  # noqa: E402


def frames(buf):
    """(op, payload, end) for each whole ws frame in buf (after the HTTP head)."""
    i = 0
    while True:
        b = buf[i:]
        if len(b) < 2:
            return
        op, masked, ln, at = b[0] & 0x0F, b[1] & 0x80, b[1] & 0x7F, 2
        if ln == 126:
            if len(b) < 4:
                return
            ln, at = struct.unpack(">H", b[2:4])[0], 4
        elif ln == 127:
            if len(b) < 10:
                return
            ln, at = struct.unpack(">Q", b[2:10])[0], 10
        mask = b[at:at + 4] if masked else b"\0\0\0\0"
        at += 4 if masked else 0
        if len(b) < at + ln:
            return
        p = b[at:at + ln]
        if masked and p:
            n = len(p)
            p = (int.from_bytes(p, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")).to_bytes(n, "big")
        yield op, p, i + at + ln
        i += at + ln


def main(path, since=0):
    recs = [json.loads(l) for l in open(path) if l.strip()]
    conns = {}
    for r in recs:
        if r.get("who") != "root":
            continue
        c = conns.setdefault(r["conn"], {"src": r.get("src", ""), "c2s": [], "s2c": []})
        c[r["dir"]].append((r["t"], base64.b64decode(r["b64"])))
    out, payload, meta = [], bytearray(), []
    for cid, c in sorted(conns.items()):
        root = None
        streams = {}
        for d in ("c2s", "s2c"):
            data = b"".join(b for _, b in c[d])
            # when each byte arrived: the time of the record it came in
            times, at = ([], []), 0
            for t, b in c[d]:
                times[0].append(at)
                times[1].append(t)
                at += len(b)
            head = data.find(b"\r\n\r\n")
            streams[d] = (data[head + 4:] if head >= 0 else b"", (head + 4) if head >= 0 else 0, times)
        parsed = []
        for d in ("s2c", "c2s"):
            body, off, times = streams[d]
            for op, p, end in frames(body):
                k = bisect.bisect_right(times[0], off + end - 1) - 1
                t = times[1][k] if k >= 0 else 0
                if op == 1 and d == "s2c" and root is None:
                    try:
                        v = json.loads(p)
                        if v.get("op") == "root-link.ok":
                            root = v.get("root")
                    except ValueError:
                        pass
                parsed.append((t, d, op, p))
        meta.append({"conn": cid, "src": c["src"], "root": root})
        for t, d, op, p in sorted(parsed, key=lambda x: x[0]):
            if t < since:
                continue
            addr, dgram = relay_parts(p) if op == 2 else (None, None)
            text_op = None
            if op == 1:
                try:
                    text_op = json.loads(p).get("op")
                except ValueError:
                    text_op = "?"
            out.append({"conn": cid, "root": root, "dir": "up" if d == "c2s" else "down", "op": op, "len": len(p),
                        "addr": addr, "kind": wg_kind(dgram) if dgram is not None else None, "text_op": text_op, "t": t})
            payload += p
    print(json.dumps({"conns": meta, "frames": out, "payload_b64": base64.b64encode(bytes(payload)).decode()}))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__.splitlines()[0], file=sys.stderr)
        sys.exit(64)
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 0)
