#!/usr/bin/env python3
"""v1smoke.py — G53.3: one spoken turn through a v1 trunk, no model tokens beyond the brain's own upstream (a mock in the dry run).

A Pixel 7 (sim/voice/phone.mjs) pairs by a console QR, opens MAIN through the trunk's door, turns hands-free on (a voice
token over /api/token, LiveKit signalling over the trunk's /rtc, media over the trunk's ICE-TCP), SPEAKS a scripted question
(the persona's own TTS on the local speech server — no persona LLM, no judge), and the reply MAIN's upstream gives must come
back spoken over the room. Checks (each printed `PASS`/`FAIL`): voice agent in the room · the box heard the turn (voice user
message) · MAIN answered · the reply was spoken on the phone (reply audio captured, how == spoken).

    v1smoke.py --target http://127.0.0.1:18600 --brain http://127.0.0.1:4250 --pair-cmd "bifrost-net trunk-ctl --sock S pair-qr" --out DIR
"""
import argparse, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import vsim  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True)
    ap.add_argument("--brain", required=True)
    ap.add_argument("--pair-cmd", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--say", default="Hello there. Please tell me a short sentence about the weather.")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    fails = 0

    def check(name, ok, detail=""):
        nonlocal fails
        fails += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""), flush=True)

    phone = vsim.Phone("smoke", os.path.join(a.out, "audio"), {"noiseDb": None, "echo": 0, "captureRtc": False})
    try:
        roots = [{"name": "home", "app": a.target, "brain": a.brain, "work": None, "sim": None, "pair_cmd": a.pair_cmd}]
        spec = {"id": "smoke", "persona": "", "goals": [], "roots": ["home"], "voice": {}}
        p = vsim.Persona(spec, {}, roots, phone, a.out)
        rec = p.turn({"text": a.say})
        u = rec["utterances"][0]
        check("voice: agent joined the room, turn committed", bool(u.get("commit")), "; ".join(rec["incidents"]))
        check("voice: the box heard the spoken turn (voice user message)", bool(u.get("box_heard")), repr(u.get("box_heard")))
        check("voice: MAIN answered", bool(rec["main_replies"]), (rec["main_replies"] or [""])[0][:80])
        rw = rec.get("reply_wait") or {}
        check("voice: the reply was spoken back on the phone", rw.get("how") == "spoken", json.dumps(rw))
        json.dump(rec, open(os.path.join(a.out, "turn.json"), "w"), indent=1, default=str)
    except Exception as e:  # noqa: BLE001
        check("voice: smoke ran", False, str(e)[:300])
    finally:
        phone.close()
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
