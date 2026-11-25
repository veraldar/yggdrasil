#!/usr/bin/env python3
"""caddy-merge.py — put trunk v1's Caddy blocks into a copy of the VPS's Caddyfile, or take them out again.

    caddy-merge.py phase1  IN OUT [--container IP]   + ljoolq.veraldar.org (https via Caddy → the container)  §10 V0
    caddy-merge.py phase2  IN OUT [--container IP]   phase 1's block → phase 2's (plain http: ACME + redirect) §10 V3
    caddy-merge.py m7-acme IN OUT [--container IP]   http://ap.veraldar.org → the ACME split (host files first)  §11.3
    caddy-merge.py remove  IN OUT                    every trunk-v1 block out, the ap block back as it was
    caddy-merge.py check   IN                        which trunk-v1 blocks IN carries

IN is never written. OUT is IN with only that change: phase 1 is appended after the last byte of IN, phase 2 takes
phase 1's place, the ACME split takes the exact `http://ap.veraldar.org` block's place (and keeps its lines as
`# was|` comments, so `remove` gives IN back byte for byte). Each block sits between `# >>> trunk-v1 …` and
`# <<< trunk-v1 …` lines. Refused, with OUT not written: an IN that names ljoolq.veraldar.org outside our blocks,
an `http://ap.veraldar.org` block that is not today's (root * /var/www/acme + file_server) — the VPS changed
since the rehearsal —, phase 2 without phase 1. The container address defaults to 10.99.0.2
(ljoolq-provision.sh). Validate OUT before any reload: `caddy validate --config OUT --adapter caddyfile`.
Rehearsed by sim/vps-caddy-rehearsal.sh (G4.5) on a copy of the VPS's file in Caddy 2.11.4.
"""
import ipaddress
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BLOCKS = {"phase1": "ljoolq-phase1.caddy", "phase2": "ljoolq-phase2.caddy", "m7-acme": "ap-acme-split.caddy"}
NAME = "ljoolq.veraldar.org"
AP_OPEN = re.compile(r"^http://ap\.veraldar\.org\s*\{\s*$")
TODAY_AP = ["root * /var/www/acme", "file_server"]  # the block's body, whitespace aside (VPS, 11-25)


def die(msg):
    print(f"caddy-merge: {msg} — nothing written", file=sys.stderr)
    sys.exit(1)


def block(kind, container):
    with open(os.path.join(HERE, BLOCKS[kind])) as f:
        text = f.read()
    return text.replace("@CONTAINER@", container)


def spans(lines):
    """[(kind_tag, start, end)] of every trunk-v1 block: lines start..end inclusive (the >>> and <<< lines)."""
    out, i = [], 0
    while i < len(lines):
        m = re.match(r"^# >>> trunk-v1 (.+?) \(", lines[i])
        if m:
            j = i
            while j < len(lines) and not lines[j].startswith("# <<< trunk-v1"):
                j += 1
            if j == len(lines):
                die(f"line {i + 1}: a trunk-v1 block that never ends")
            out.append((m.group(1), i, j))
            i = j
        i += 1
    return out


def kind_of(tag):
    return {"ljoolq phase 1": "phase1", "ljoolq phase 2": "phase2", "M7 ap ACME split": "m7-acme"}.get(tag, tag)


def outside(lines, sp):
    inside = set()
    for _, a, b in sp:
        inside.update(range(a, b + 1))
    return [(n, l) for n, l in enumerate(lines) if n not in inside]


def merge(kind, text, container):
    if not text.endswith("\n"):
        die("IN does not end with a newline")
    lines = text.splitlines(keepends=True)
    sp = spans(lines)
    for n, l in outside(lines, sp):
        if NAME in l.split("#", 1)[0]:
            die(f"line {n + 1} names {NAME} outside a trunk-v1 block: {l.strip()!r}")
    have = {kind_of(t): (a, b) for t, a, b in sp}
    new = block(kind, container).splitlines(keepends=True)
    if kind == "phase1":
        if "phase2" in have:
            die("IN already has phase 2 (phase 1 comes before it)")
        if "phase1" in have:  # again: the same block put back in its place
            a, b = have["phase1"]
            return "".join(lines[:a] + new + lines[b + 1:])
        return text + "\n" + "".join(new)
    if kind == "phase2":
        if "phase2" in have:
            a, b = have["phase2"]
            return "".join(lines[:a] + new + lines[b + 1:])
        if "phase1" not in have:
            die("IN has no phase 1 block to replace")
        a, b = have["phase1"]
        return "".join(lines[:a] + new + lines[b + 1:])
    # m7-acme: today's http://ap.veraldar.org block, exactly, is replaced; its lines ride along as `# was|`
    if "m7-acme" in have:
        a, b = have["m7-acme"]
        was = [l[len("# was|"):] for l in lines[a:b + 1] if l.startswith("# was|")]
        return "".join(lines[:a] + new[:1] + ["# was|" + w for w in was] + new[1:] + lines[b + 1:])
    opens = [n for n, l in outside(lines, sp) if AP_OPEN.match(l)]
    if len(opens) != 1:
        die(f"want exactly one `http://ap.veraldar.org {{` block, found {len(opens)}")
    a = opens[0]
    b = a + 1
    while b < len(lines) and lines[b].strip() != "}":
        b += 1
    if b == len(lines):
        die(f"line {a + 1}: the http://ap.veraldar.org block never ends")
    body = [l.strip() for l in lines[a + 1:b] if l.strip()]
    if body != TODAY_AP:
        die(f"the http://ap.veraldar.org block (lines {a + 1}-{b + 1}) is not today's {TODAY_AP}: {body} — the VPS "
            "changed since G4.5 rehearsed it")
    was = ["# was|" + l for l in lines[a:b + 1]]
    return "".join(lines[:a] + new[:1] + was + new[1:] + lines[b + 1:])


def remove(text):
    lines = text.splitlines(keepends=True)
    sp = spans(lines)
    for tag, a, b in reversed(sp):
        k = kind_of(tag)
        if k == "m7-acme":
            was = [l[len("# was|"):] for l in lines[a:b + 1] if l.startswith("# was|")]
            lines[a:b + 1] = was
        elif k in ("phase1", "phase2"):
            # appended after IN's last byte with one blank line before it: both go
            if a > 0 and lines[a - 1] == "\n":
                a -= 1
            lines[a:b + 1] = []
        else:
            die(f"an unknown trunk-v1 block {tag!r}")
    return "".join(lines)


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.split("\n\n")[0] + "\n" + __doc__.split("\n\n")[1], file=sys.stderr)
        return 64
    cmd, rest = argv[0], argv[1:]
    container = "10.99.0.2"
    if "--container" in rest:
        i = rest.index("--container")
        container = rest[i + 1]
        del rest[i:i + 2]
        try:
            ipaddress.ip_address(container)
        except ValueError:
            die(f"--container {container!r} is not an address")
    if cmd == "check" and len(rest) == 1:
        with open(rest[0]) as f:
            sp = spans(f.read().splitlines(keepends=True))
        print(" ".join(kind_of(t) for t, _, _ in sp) or "none")
        return 0
    if cmd not in (*BLOCKS, "remove") or len(rest) != 2:
        return main([])
    src, dst = rest
    if os.path.abspath(src) == os.path.abspath(dst):
        die("OUT must not be IN")
    with open(src) as f:
        text = f.read()
    out = remove(text) if cmd == "remove" else merge(cmd, text, container)
    with open(dst + ".tmp", "w") as f:
        f.write(out)
    os.replace(dst + ".tmp", dst)
    print(f"caddy-merge: {cmd}: {src} → {dst}" + (f" (container {container})" if cmd != "remove" else ""), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
