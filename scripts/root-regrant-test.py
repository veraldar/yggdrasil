#!/usr/bin/env python3
"""root-regrant-test.py — scripts/root-regrant.py on a throwaway state dir (never the hub's).

    python3 scripts/root-regrant-test.py
"""
import json, os, stat, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "root-regrant.py")
FAILS = []


def check(name, ok, detail=""):
    print("%s %s%s" % ("PASS" if ok else "FAIL", name, (" — " + detail) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def dev(i, created, revoked=False, at=None, why=None, roots=None):
    d = {"id": i, "name": "Android", "created": created, "revoked": revoked, "region": "public",
         "lastRegion": "public", "regionChanges": 0, "lastSeen": created, "refreshHash": "ab" * 32,
         "refreshExp": 1, "prevRefresh": [], "access": []}
    if revoked:
        d.update(revokedAt=at, revokedWhy=why)
    if roots is not None:
        d["roots"] = roots
    return d


def state(tmp, devices, roots):
    s = os.path.join(tmp, "state")
    os.makedirs(s, exist_ok=True)
    for n, v in (("devices.json", {"version": 2, "killEpoch": 0, "devices": devices, "codes": []}),
                 ("roots.json", {"version": 1, "wg": {"net": "10.35.49.0/24"}, "roots": roots})):
        with open(os.path.join(s, n), "w") as f:
            f.write(json.dumps(v, indent=2) + "\n")
        os.chmod(os.path.join(s, n), 0o600)
    return s


def root(i, d, **kw):
    r = {"id": i, "name": i, "os": "macos", "host": i, "joined_at": "2026-11-22T13:05:09.219Z", "dev": d,
         "secretHash": "cd" * 32, "delivered_at": "2026-11-22T13:05:09.343Z",
         "wg_pub": "fLEEnkRkqP61vQpARykAc7VUgM6DCkIyguRJ+DJXYz8=", "wg_ip": "10.35.49.2"}
    r.update(kw)
    return r


def run(tmp, s, *args):
    env = dict(os.environ, HOME=tmp)
    p = subprocess.run([sys.executable, TOOL, "--state", s, "--wg", "", *args], capture_output=True, text=True,
                       env=env, timeout=60)
    return p.returncode, p.stdout + p.stderr


def load(s, n):
    with open(os.path.join(s, n)) as f:
        return json.load(f)


# the live shape of 2026-11-23: approver re-paired twice, the phone now is the third device
T1, T2 = "2026-11-23T11:41:17.925Z", "2026-11-23T15:32:25.723Z"
CHAIN = [
    dev("dev_a", "2026-11-22T12:37:16.841Z", True, T1, "re-paired", ["mac"]),
    dev("dev_b", T1, True, T2, "re-paired"),
    dev("dev_probe", "2026-11-23T13:10:12.069Z", True, "2026-11-23T13:10:38.696Z", "revoked from the device list"),
    dev("dev_c", T2, roots=["lab", "box"]),
]
ROOTS = [root("mac", "dev_a", share_model=True), root("lab", "dev_c", wg_ip="10.35.49.3"),
         root("box", "dev_c", wg_ip="10.35.49.4")]

with tempfile.TemporaryDirectory(dir=os.path.expanduser("~/.cache")) as tmp:
    s = state(tmp, CHAIN, ROOTS)
    before = {n: open(os.path.join(s, n), "rb").read() for n in ("devices.json", "roots.json")}

    rc, out = run(tmp, s, "--root", "mac")
    check("dry run: exit 0, follows dev_a → dev_b → dev_c, prints the grant to confirm",
          rc == 0 and "dev_a → dev_b → dev_c" in out and "confirm   mac:dev_c" in out, out)
    check("dry run writes nothing",
          all(open(os.path.join(s, n), "rb").read() == b for n, b in before.items()))
    check("dry run: no backup either", not os.path.exists(os.path.join(tmp, ".cache")))

    rc, out = run(tmp, s, "--root", "mac", "--apply")
    check("--apply without --confirm is refused (exit 2) and writes nothing",
          rc == 2 and all(open(os.path.join(s, n), "rb").read() == b for n, b in before.items()), out)
    rc, out = run(tmp, s, "--root", "mac", "--apply", "--confirm", "mac:dev_b")
    check("--confirm naming another grant is refused (exit 2)", rc == 2, out)

    # a token refresh by the app races the repair: it read devices.json before the repair wrote it
    # and writes its (rotated) copy after — the repair must notice and add the root again, and the
    # app's rotation must survive
    dpath = os.path.join(s, "devices.json")
    stop = threading.Event()

    def stale_app_write():
        snap = open(dpath, "rb").read()
        while not stop.is_set():
            cur = open(dpath, "rb").read()
            if cur != snap:  # the repair wrote: answer once with the app's stale read + a rotation
                reg = json.loads(snap)
                for d in reg["devices"]:
                    if d["id"] == "dev_c":
                        d["refreshHash"] = "ef" * 32
                tmpf = dpath + ".app.tmp"
                with open(tmpf, "w") as f:
                    f.write(json.dumps(reg, indent=2) + "\n")
                os.chmod(tmpf, 0o600)
                os.replace(tmpf, dpath)
                return
            time.sleep(0.005)

    th = threading.Thread(target=stale_app_write, daemon=True)
    th.start()
    rc, out = run(tmp, s, "--root", "mac", "--apply", "--confirm", "mac:dev_c")
    stop.set()
    th.join(2)
    regs, rts = load(s, "devices.json"), load(s, "roots.json")
    c = next(d for d in regs["devices"] if d["id"] == "dev_c")
    mac = next(r for r in rts["roots"] if r["id"] == "mac")
    check("apply: exit 0", rc == 0, out)
    check("apply: dev_c's allowlist gains mac (re-added after the racing stale write), keeps lab + box",
          c.get("roots") == ["lab", "box", "mac"], str(c.get("roots")))
    check("apply: the app's racing rotation survives", c["refreshHash"] == "ef" * 32)
    check("apply: roots.json mac.dev = dev_c, the rest of the record untouched",
          mac["dev"] == "dev_c" and mac.get("share_model") is True and mac["wg_ip"] == "10.35.49.2")
    check("apply: lab and box untouched", [r["dev"] for r in rts["roots"][1:]] == ["dev_c", "dev_c"])
    check("apply: no other device changed (dev_a stays revoked)",
          [d["revoked"] for d in regs["devices"]] == [True, True, True, False])
    check("apply: both files stay mode 600",
          all(stat.S_IMODE(os.stat(os.path.join(s, n)).st_mode) == 0o600 for n in ("devices.json", "roots.json")))
    check("apply: no tmp file left", not [n for n in os.listdir(s) if n.endswith(".tmp")], str(os.listdir(s)))
    bk = os.path.join(tmp, ".cache", "root-sim", "backups")
    dirs = os.listdir(bk) if os.path.isdir(bk) else []
    check("apply: a backup of both files (mode 600) before the change",
          len(dirs) == 1 and open(os.path.join(bk, dirs[0], "roots.json"), "rb").read() == before["roots.json"]
          and stat.S_IMODE(os.stat(os.path.join(bk, dirs[0], "devices.json")).st_mode) == 0o600)

    rc, out = run(tmp, s, "--root", "mac")
    check("after: the approver is live — nothing to repair", rc == 0 and "nothing to repair" in out, out)

with tempfile.TemporaryDirectory(dir=os.path.expanduser("~/.cache")) as tmp:
    owner_revoked = [dev("dev_x", "2026-11-22T00:00:00.000Z", True, "2026-11-23T00:00:00.000Z",
                         "revoked from the device list", ["mac"]), dev("dev_c", T2)]
    s = state(tmp, owner_revoked, [root("mac", "dev_x")])
    rc, out = run(tmp, s, "--root", "mac")
    check("an approver revoked on purpose (device list) is not followed", rc == 1 and "not re-paired" in out, out)
    rc, out = run(tmp, s, "--root", "mac", "--to", "dev_c")
    check("…unless the heir is named with --to (still a dry run)", rc == 0 and "confirm   mac:dev_c" in out, out)

    s = state(tmp, CHAIN, [root("mac", "dev_a", revoked=True, revoked_at="2026-11-24T00:00:00Z")])
    rc, out = run(tmp, s, "--root", "mac")
    check("a root removed from the tree is never granted back", rc == 1 and "removed" in out, out)

    twins = CHAIN[:2] + [dev("dev_c", T2), dev("dev_d", T2)]
    s = state(tmp, twins, [root("mac", "dev_a")])
    rc, out = run(tmp, s, "--root", "mac")
    check("two devices created at the re-pair instant: refuses to guess", rc == 1 and "--to" in out, out)

    dead_end = CHAIN[:1] + [dev("dev_b", T1, True, "2026-11-24T00:00:00.000Z", "kill-switch")]
    s = state(tmp, dead_end, [root("mac", "dev_a")])
    rc, out = run(tmp, s, "--root", "mac", "--to", "dev_b")
    check("a revoked heir is refused", rc == 1 and "not a live paired device" in out, out)

print("\n%d failed" % len(FAILS) if FAILS else "\nall passed")
sys.exit(1 if FAILS else 0)
