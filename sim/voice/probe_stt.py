#!/usr/bin/env python3
"""probe_stt.py — where a spoken turn loses its words: the phone's mic, the room, the agent's STT.

An own stack (stack.py), one phone, hands-free on MAIN; each WAV is played into the phone's mic
(no persona, no MAIN turn when the wav has no "over"), while room_ear.py records the phone's
track as LiveKit forwards it. Per wav: the phone's mic recording, the room's recording, and the
segments the agent sent to the STT (the speech gate's dump) with their text.

    probe_stt.py WAV [WAV …] [--name vf-probe] [--port 4470] [--gap 20] [--echo 0]
"""
import argparse, glob, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import speech  # noqa: E402
import stack as stackmod  # noqa: E402
import vsim  # noqa: E402

VPY = os.path.join(os.path.dirname(os.path.dirname(HERE)), "branch", "voice", ".venv", "bin", "python")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wavs", nargs="+")
    ap.add_argument("--name", default="vf-probe")
    ap.add_argument("--port", type=int, default=4470)
    ap.add_argument("--gap", type=float, default=20, help="seconds after each wav for the last segments")
    ap.add_argument("--wait", type=float, default=0, help="seconds between hands-free on and the first wav")
    ap.add_argument("--noise", type=float, default=-55)
    ap.add_argument("--out", default=os.path.expanduser("~/.cache/voice-sim/probe-out"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    stackmod.down(a.name)
    st = stackmod.up(a.name, [{"name": "home"}], a.port)
    dump = os.path.join(stackmod.CACHE, a.name, "stt")
    root = st["roots"][0]
    ph = vsim.Phone("probe", a.out, {"noiseDb": a.noise, "noiseColor": "pink", "echo": 0})
    ear = None
    try:
        ln = vsim.Line(ph, root, {"id": "probe"}, a.out)
        ln.open()
        ear = subprocess.Popen([VPY, os.path.join(HERE, "room_ear.py"), a.name, ln.main_id, os.path.join(a.out, "room.wav"), "--secs", "900"])
        time.sleep(3 + a.wait)
        ln.phone.call("pull", tab=ln.tab, bus="mic", path=None)
        for i, w in enumerate(a.wavs):
            seen = set(glob.glob(os.path.join(dump, "*.json")))
            r = ln.phone.call("say", tab=ln.tab, wav=w, timeout=600)
            time.sleep(a.gap)
            mic = os.path.join(a.out, f"w{i + 1}-mic.wav")
            ln.phone.call("pull", tab=ln.tab, bus="mic", path=mic)
            segs = sorted(set(glob.glob(os.path.join(dump, "*.json"))) - seen)
            said = sum(e - s for s, e in speech.loud_spans(w, db=-45))
            got = []
            for f in segs:
                d = json.load(open(f))
                got.append((round(speech.duration(f.replace(".json", ".wav")), 2), d["text"]))
            print(f"\n== {os.path.basename(w)} ({r['dur']:.1f}s, {said:.1f}s of speech): {len(got)} STT segment(s), "
                  f"{sum(g[0] for g in got):.1f}s of audio sent")
            for g in got:
                print(f"   {g[0]:5.2f}s  {g[1]!r}")
            print(f"   heard: {' '.join(g[1] for g in got)!r}", flush=True)
    finally:
        if ear:
            ear.terminate()
        ph.close()
        stackmod.down(a.name, keep_state=True)
    print(f"\nroom recording: {os.path.join(a.out, 'room.wav')}")


if __name__ == "__main__":
    main()
