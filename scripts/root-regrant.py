#!/usr/bin/env python3
"""root-regrant.py — give a joined root back its approval after a phone re-pair cut it.

ONE-TIME REPAIR, A TRUST GRANT: run --apply only after the owner's own message says yes.

Before fix-repair-keeps-roots, re-pairing the phone revoked the old device and left every root it
had approved pointing at it (roots.json `dev`). The hub's WireGuard node pins a root only while
that device is live (trunk/src/wg.rs), refill refuses it (409 device-revoked), so the root went
dark although it was healthy (mac-studio, 2026-11-23 11:41:17Z). This does by hand what a fixed
re-pair now does on its own (lib/devices.ts claimPairCode + lib/roots.ts handOverRoots):

  1. devices.json: the root joins the heir device's `roots` allowlist
  2. roots.json:   the root's `dev` becomes the heir device

The heir is found by following the re-pair chain from the root's approver: a device revoked
with why "re-paired" was replaced by the device created at that same instant. It must end in
ONE live device, else name it with --to.

    root-regrant.py --root mac-studio                  # dry run: shows the chain and the grant
    root-regrant.py --root mac-studio --apply --confirm mac-studio:dev_xxxxxxxx

--confirm must repeat the grant the dry run printed (root:heir), so what runs is what the owner
saw. Both files are written the way the app writes them (tmp + rename, mode 600), and only if
they did not change since they were read (the app rewrites devices.json on every token refresh:
a stale write would undo a rotation); afterwards the change is read back. Copies of both files
before the change go to ~/.cache/root-sim/backups/root-regrant-<time>/ (for the record only:
never copy devices.json back while the app runs). The way back is the roots sheet's remove.
"""
import argparse, json, os, sys, time, urllib.request

STATE = os.path.expanduser("~/.local/share/yggdrasil/hub/state")
BACKUPS = os.path.expanduser("~/.cache/root-sim/backups")


def fail(msg, code=1):
    print("root-regrant: " + msg, file=sys.stderr)
    sys.exit(code)


def read(path):
    with open(path, "rb") as f:
        raw = f.read()
    return raw, json.loads(raw)


def dump(v):
    # the app's own format: JSON.stringify(v, null, 2) + "\n"
    return (json.dumps(v, indent=2, ensure_ascii=False) + "\n").encode()


def cas_write(path, before, after):
    """Write `after` over `path` only if it still holds `before`. False: it changed meanwhile."""
    tmp = "%s.regrant.%d.tmp" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(after)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    with open(path, "rb") as f:
        if f.read() != before:
            os.unlink(tmp)
            return False
    os.replace(tmp, path)
    return True


def heir_of(devs, start):
    """Follow re-pairs from `start` to a live device: (heir or None, chain, why-not)."""
    by_id = {d.get("id"): d for d in devs}
    chain, cur = [start], by_id.get(start)
    if cur is None:
        return None, chain, "the approving device %s is not in devices.json" % start
    for _ in range(32):
        if cur.get("revoked") is not True:
            return cur, chain, ""
        if cur.get("revokedWhy") != "re-paired":
            return None, chain, "%s was revoked (%s), not re-paired — that cut was meant" % (
                cur.get("id"), cur.get("revokedWhy"))
        nxt = [d for d in devs if d.get("created") and d.get("created") == cur.get("revokedAt")]
        if len(nxt) != 1:
            return None, chain, "%s was re-paired at %s, but %d devices were created then — name the heir with --to" % (
                cur.get("id"), cur.get("revokedAt"), len(nxt))
        cur = nxt[0]
        chain.append(cur.get("id"))
    return None, chain, "the re-pair chain is too long"


def plan(state, root_id, to):
    roots_raw, roots = read(os.path.join(state, "roots.json"))
    devs_raw, reg = read(os.path.join(state, "devices.json"))
    devs = reg.get("devices") or []
    rec = next((r for r in roots.get("roots") or [] if r.get("id") == root_id), None)
    if rec is None:
        fail("no root %r in roots.json" % root_id)
    if rec.get("revoked"):
        fail("root %r was removed from the tree (%s): not granting it back" % (root_id, rec.get("revoked_at")))
    approver = next((d for d in devs if d.get("id") == rec.get("dev")), None)
    if approver is not None and approver.get("revoked") is False:
        return rec, approver, [rec.get("dev")], None
    if to:
        heir = next((d for d in devs if d.get("id") == to), None)
        chain = [rec.get("dev"), to]
        if heir is None:
            fail("no device %r in devices.json" % to)
    else:
        heir, chain, why = heir_of(devs, rec.get("dev"))
        if heir is None:
            fail(why)
    if heir.get("revoked") is not False or not isinstance(heir.get("refreshHash"), str):
        fail("the heir %s is not a live paired device" % heir.get("id"))
    return rec, approver, chain, heir


def show(rec, approver, chain, heir):
    print("root      %s (%s, %s) — wg_ip %s, joined %s" % (
        rec.get("id"), rec.get("host"), rec.get("os"), rec.get("wg_ip") or "-", rec.get("joined_at")))
    if heir is None:
        print("approver  %s is live: nothing to repair" % rec.get("dev"))
        return
    a = approver or {}
    print("approver  %s — revoked %s (%s)" % (rec.get("dev"), a.get("revokedAt"), a.get("revokedWhy")))
    print("chain     %s" % " → ".join(chain))
    print("heir      %s %r — created %s, last seen %s, allowlist %s" % (
        heir.get("id"), heir.get("name"), heir.get("created"), heir.get("lastSeen"), heir.get("roots")))
    print("grant     roots.json %s.dev: %s → %s; devices.json %s.roots += %s" % (
        rec.get("id"), rec.get("dev"), heir.get("id"), heir.get("id"), rec.get("id")))
    print("confirm   %s:%s" % (rec.get("id"), heir.get("id")))


def apply(state, root_id, heir_id, old_dev):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    bdir = os.path.join(BACKUPS, "root-regrant-%s" % stamp)
    os.makedirs(bdir, mode=0o700, exist_ok=True)
    for n in ("devices.json", "roots.json"):
        raw, _ = read(os.path.join(state, n))
        fd = os.open(os.path.join(bdir, n), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
    print("backup    %s" % bdir)

    # 1. the heir's allowlist first: it is live already, so the hub never sees a gap
    dpath = os.path.join(state, "devices.json")
    for attempt in range(10):
        raw, reg = read(dpath)
        d = next((x for x in reg.get("devices") or [] if x.get("id") == heir_id), None)
        if d is None or d.get("revoked") is not False:
            fail("the heir %s is no longer live" % heir_id)
        have = [r for r in d.get("roots") or [] if isinstance(r, str)]
        if root_id in have:
            break
        d["roots"] = have + [root_id]
        if cas_write(dpath, raw, dump(reg)):
            time.sleep(1.5)  # a refresh that read the file before this write rewrites it after
            continue         # read back (the loop ends once the root is in the allowlist)
        time.sleep(0.2)
    else:
        fail("devices.json kept changing: the allowlist was not written (nothing else was)")
    print("devices   %s.roots ∋ %s" % (heir_id, root_id))

    # 2. the root's approver
    rpath = os.path.join(state, "roots.json")
    for attempt in range(10):
        raw, f = read(rpath)
        rec = next((r for r in f.get("roots") or [] if r.get("id") == root_id), None)
        if rec is None or rec.get("revoked"):
            fail("root %s is gone or removed now" % root_id)
        if rec.get("dev") == heir_id:
            break
        if rec.get("dev") != old_dev:
            fail("root %s's approver changed to %s meanwhile — run the dry run again" % (root_id, rec.get("dev")))
        rec["dev"] = heir_id
        if cas_write(rpath, raw, dump(f)):
            continue
        time.sleep(0.2)
    else:
        fail("roots.json kept changing: the approver was not written")
    print("roots     %s.dev = %s" % (root_id, heir_id))


def wg_check(url, root_id, wait):
    """The hub's WireGuard node lists the root once it pins it (and `up` after a handshake)."""
    deadline, last = time.time() + wait, None
    while time.time() < deadline:
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=3) as r:
                peers = json.loads(r.read() or b"[]")
            last = next((p for p in peers if p.get("id") == root_id), None)
            if last and last.get("up"):
                break
        except Exception as e:  # noqa: BLE001 — a check, never a failure of the repair
            last = {"error": str(e)}
        time.sleep(1)
    print("wg        %s" % (json.dumps(last) if last else "not listed (yet) — the root handshakes every few seconds"))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", required=True, help="the joined root id (roots.json)")
    ap.add_argument("--to", help="the heir device id (default: follow the re-pair chain)")
    ap.add_argument("--state", default=STATE, help="the hub's state dir (devices.json, roots.json)")
    ap.add_argument("--apply", action="store_true", help="write it (needs --confirm)")
    ap.add_argument("--confirm", help="root:heir exactly as the dry run printed it")
    ap.add_argument("--wg", default="http://127.0.0.1:4506/_wg/_roots",
                    help="after --apply, watch the hub's WireGuard node list the root ('' = skip)")
    ap.add_argument("--wg-wait", type=float, default=20)
    o = ap.parse_args()

    rec, approver, chain, heir = plan(o.state, o.root, o.to)
    show(rec, approver, chain, heir)
    if heir is None:
        return 0
    want = "%s:%s" % (rec.get("id"), heir.get("id"))
    if not o.apply:
        print("dry run   nothing written. A trust grant: apply only on the owner's own yes, with\n"
              "          --apply --confirm %s" % want)
        return 0
    if o.confirm != want:
        fail("--confirm %r does not match the grant %r — run the dry run again" % (o.confirm, want), 2)
    apply(o.state, rec["id"], heir["id"], rec.get("dev"))
    if o.wg:
        wg_check(o.wg, rec["id"], o.wg_wait)
    return 0


if __name__ == "__main__":
    sys.exit(main())
