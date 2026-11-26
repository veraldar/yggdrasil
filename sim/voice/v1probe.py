#!/usr/bin/env python3
"""v1probe.py — the part of G5.3 that spends no model tokens: a Pixel 7 phone (the voice sim's phone.mjs)
pairs through a v1 trunk with a console QR, opens MAIN through the door, and the suite's own plumbing is checked.

    v1probe.py --target http://127.0.0.1:18600 --brain http://127.0.0.1:4250 --pair-cmd "bifrost-net trunk-ctl --sock S pair-qr" --out DIR

Prints `PASS name` / `FAIL name` lines; exit 0 only when all pass. No voice, no persona LLM, no TTS/STT.
"""
import argparse, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import hsim  # noqa: E402
import vsim  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True)
    ap.add_argument("--brain", required=True)
    ap.add_argument("--pair-cmd", required=True)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    out = a.out or tempfile.mkdtemp(prefix="v1probe-")
    os.makedirs(out, exist_ok=True)
    fails = 0

    def check(name, fn):
        nonlocal fails
        try:
            detail = fn()
            print(f"PASS {name}" + (f" — {detail}" if detail else ""), flush=True)
        except Exception as e:  # noqa: BLE001
            fails += 1
            print(f"FAIL {name} — {str(e)[:200]}", flush=True)

    brain = hsim.Brain(a.brain)
    main_id = []
    check("brain: MAIN exists", lambda: main_id.append(brain.main_id()) or main_id[0])
    phone = None
    try:
        phone = vsim.Phone("probe", os.path.join(out, "audio"), {"noiseDb": None, "echo": 0, "captureRtc": False})
        line = vsim.Line(phone, {"name": "home", "app": a.target, "brain": a.brain}, {"id": "probe"}, out)
        check("phone: Pixel 7 pairs through the trunk (member QR from the console)", lambda: line.pair_v1(a.pair_cmd)["landed"])
        url = line.root["app"].rstrip("/") + f"/session/main?id={main_id[0]}"
        check("phone: MAIN opens through the trunk's door (composer visible)", lambda: phone.call("open", tab="home", url=url, timeout=90)["url"])
    finally:
        if phone:
            phone.close()
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
