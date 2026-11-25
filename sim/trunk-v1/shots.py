#!/usr/bin/env python3
"""shots.py — start a throwaway v1 trunk (18800–18899) and screenshot every shell page at 360 px
(Pixel 7, Chromium) with sim/trunk-v1/shots.cjs. Shots land in --out (default
~/.cache/trunk-v1/tmp/idp/shots). Exit 0 = every page drawn, no console error, nothing wider
than the screen.

    sim/trunk-v1/shots.py [--bin trunk/target/release/bifrost-net] [--out DIR]
"""
import argparse, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from trunklib import REPO, Trunk  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(REPO, "trunk", "target", "release", "bifrost-net"))
    ap.add_argument("--out", default=os.path.expanduser("~/.cache/trunk-v1/tmp/idp/shots"))
    a = ap.parse_args()
    base = os.environ.get("TMPDIR") or os.path.expanduser("~/.cache/trunk-v1/tmp/idp")
    root = tempfile.mkdtemp(prefix="trunk-v1-shots-", dir=base)
    if os.path.isdir(a.out):
        for f in os.listdir(a.out):
            if f.endswith(".png") or f == "problems.json":
                os.remove(os.path.join(a.out, f))
    os.makedirs(a.out, exist_ok=True)
    t = Trunk(a.bin, root, fast=False)
    t.start()
    try:
        env = dict(os.environ, NODE_PATH=os.path.join(REPO, "branch", "node_modules"))
        p = subprocess.run(["node", os.path.join(HERE, "shots.cjs"), t.public_url, a.out, json.dumps(t.ctl_prefix), os.path.join(root, "trunk.db")], env=env, timeout=300)
        code = p.returncode
    finally:
        t.stop()
    if code == 0:
        shutil.rmtree(root, ignore_errors=True)
    sys.exit(code)


if __name__ == "__main__":
    main()
