#!/usr/bin/env python3
"""clips.py RUN [name …] — the voice for the three short films of a recording run (after cut.py).

Each caption cut.py burned in is also said, at the second it appears: the narrator reads it; in the talk
film the person's question is said in the person's voice while the tree listens, and the answer in the
voice a home computer answers with. RUN/<name>.mp4 (silent, from cut.py) becomes RUN/<name>.mp4 and
RUN/<name>.webm with sound; the silent one is kept as RUN/<name>-silent.mp4.
"""
import json, pathlib, re, shutil, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
LEAD = 1.2        # films.mjs: the silence in the microphone's WAV before the sentence


def lines(meta):
    marks = meta["marks"]
    start = next(m["t"] for m in marks if m.get("mark") == "start")
    out = []
    for m in marks:
        if "cap" not in m:
            continue
        t, cap = round(max(0.15, m["t"] - start + 0.15), 2), m["cap"]
        q = re.search(r"“(.+)”", cap)
        if cap.startswith("Speak") and q:
            out.append({"t": round(t + LEAD, 2), "voice": "you", "text": q.group(1)})
        elif cap.startswith("It answers out loud") and q:
            out.append({"t": t, "voice": "app", "text": q.group(1)})
        elif cap == "Let go.":
            out.append({"t": t, "voice": "narrator", "text": "Let go. It answers out loud."})
        else:
            out.append({"t": t, "voice": "narrator", "text": cap})
    return out


def main():
    run = pathlib.Path(sys.argv[1])
    names = sys.argv[2:] or ["talk", "tree", "file"]
    rc = 0
    for n in names:
        silent = run / f"{n}-silent.mp4"
        if not silent.exists():
            shutil.copy(run / f"{n}.mp4", silent)
        vo = run / f".{n}-vo.json"
        vo.write_text(json.dumps(lines(json.loads((run / f"{n}.json").read_text())), indent=1))
        r = subprocess.run([sys.executable, "-I", str(HERE / "sound.py"), "--queue", str(silent), str(vo), str(run / n)])
        rc = rc or r.returncode
    return rc


if __name__ == "__main__":
    sys.exit(main())
