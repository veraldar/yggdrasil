#!/usr/bin/env python3
"""cut.py — from a recording to a film for the site (stdlib + ffmpeg).

    cut.py DIR [name …]      DIR = $FILMS_OUT of sim/films/films.mjs: <name>.json + raw/<name>.ffconcat

Per film: cut from its "start" to its "end" mark, the phone's screen on a dark 1080 × 1920 stage,
the captions burned in under it (no sound is needed to follow), then
    <name>.mp4 (h264) · <name>.webm (vp9) · <name>.jpg (the poster: the frame at its "poster" mark)
    <name>-sheet.jpg   one frame per second, in one picture: what a person checks by eye
and the checks every film must pass: under 30 s, no blank frame (the phone's screen never one flat
colour), every caption on screen at least 1.2 s, both files play to the end.
Exit 0 only if every film passes. Font: FILMS_FONT (default: the site's Commit Mono).
"""
import json, os, pathlib, re, subprocess, sys, textwrap

W, H = 1080, 1920                   # the stage, 9:16
PH = 1560                           # the phone's height on it
PW = int(PH * 412 / 839) // 2 * 2   # 766
PX, PY = (W - PW) // 2, 36
BAND_Y = PY + PH + 34               # the captions' band
BG, INK, DIM, EDGE = "0x080810", "0xe8e8f0", "0x8888aa", "0x2a2a3a"
SIZE, LINE_H, WRAP = 43, 60, 38
FONT = os.environ.get("FILMS_FONT") or os.path.expanduser("~/Work/veraldar-site/fonts/commit-mono-400-regular.woff")
MAX_S = 30.0


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def duration(path):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]).stdout.strip())


def captions(marks, start, end):
    caps = [m for m in marks if "cap" in m]
    out = []
    for i, c in enumerate(caps):
        a = max(c["t"], start) - start
        b = (caps[i + 1]["t"] if i + 1 < len(caps) else end) - start
        b = min(b, end - start)
        if b - a > 0.05:
            out.append((round(a, 2), round(b, 2), c["cap"]))
    return out


def film(d, name):
    meta = json.loads((d / f"{name}.json").read_text())
    marks = meta["marks"]
    at = lambda k: next(m["t"] for m in marks if m.get("mark") == k)
    start, end = at("start"), at("end")
    poster_t = at("poster") - start + 0.6
    caps = captions(marks, start, end)
    length = end - start
    work = d / f".{name}"
    work.mkdir(exist_ok=True)

    f = [f"[0:v]fps=30,trim=start={start}:end={end},setpts=PTS-STARTPTS,scale={PW}:{PH}:flags=lanczos[ph]",
         f"color=c={BG}:s={W}x{H}:r=30:d={length:.2f}[bg]",
         f"[bg][ph]overlay={PX}:{PY}:shortest=1,drawbox=x={PX - 3}:y={PY - 3}:w={PW + 6}:h={PH + 6}:color={EDGE}:t=3[st0]"]
    last, n = "st0", 0
    for a, b, text in caps:
        lines = textwrap.wrap(text, WRAP)[:4]
        y0 = BAND_Y + max(0, (4 - len(lines))) * LINE_H // 2
        for j, line in enumerate(lines):
            tf = work / f"cap{n}.txt"
            tf.write_text(line)
            f.append(f"[{last}]drawtext=fontfile='{FONT}':textfile='{tf}':fontsize={SIZE}:fontcolor={INK}:"
                     f"x=(w-text_w)/2:y={y0 + j * LINE_H}:enable='between(t,{a},{b})'[c{n}]")
            last, n = f"c{n}", n + 1
    f.append(f"[{last}]fade=t=in:st=0:d=0.25,fade=t=out:st={max(0, length - 0.3):.2f}:d=0.3,format=yuv420p[v]")
    graph = work / "graph.txt"
    graph.write_text(";\n".join(f))
    raw = d / meta["frames"]
    mp4, webm, jpg, sheet = (d / f"{name}{x}" for x in (".mp4", ".webm", ".jpg", "-sheet.jpg"))
    base = ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(raw), "-/filter_complex", str(graph), "-map", "[v]", "-an"]
    run(base + ["-c:v", "libx264", "-preset", "slow", "-crf", "25", "-movflags", "+faststart", str(mp4)])
    run(["ffmpeg", "-v", "error", "-y", "-i", str(mp4), "-an", "-c:v", "libvpx-vp9", "-crf", "38", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", str(webm)])
    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{min(poster_t, length - 0.2):.2f}", "-i", str(mp4), "-frames:v", "1", "-q:v", "3", str(jpg)])
    cols = 6
    rows = -(-int(length + 1) // cols)
    run(["ffmpeg", "-v", "error", "-y", "-i", str(mp4), "-vf", f"fps=1,scale=360:-2,tile={cols}x{rows}", "-frames:v", "1", "-q:v", "4", str(sheet)])

    # ---- the checks
    problems = []
    for p in (mp4, webm):
        dur = duration(p)
        if dur >= MAX_S:
            problems.append(f"{p.name} is {dur:.1f} s (must be under {MAX_S:.0f})")
        if abs(dur - length) > 0.6:
            problems.append(f"{p.name} plays {dur:.1f} s of {length:.1f}")
    # a blank frame: the phone's screen one flat colour (4 frames a second, the phone's area only)
    stats = subprocess.run(["ffmpeg", "-v", "error", "-i", str(mp4), "-vf",
                            f"fps=4,crop={PW}:{PH}:{PX}:{PY},signalstats,metadata=print:file=-", "-f", "null", "-"],
                           capture_output=True, text=True).stdout
    frames, cur = [], {}
    for line in stats.splitlines():
        m = re.match(r"frame:(\d+)\s+pts:\S+\s+pts_time:(\S+)", line)
        if m:
            cur = {"t": float(m.group(2))}
            frames.append(cur)
        m = re.match(r"lavfi\.signalstats\.(YMIN|YMAX|YAVG)=(\S+)", line)
        if m:
            cur[m.group(1)] = float(m.group(2))
    blank = [fr["t"] for fr in frames if 0.3 <= fr["t"] <= length - 0.35 and fr.get("YMAX", 255) - fr.get("YMIN", 0) < 40]
    if not frames:
        problems.append("no frames could be read back")
    if blank:
        problems.append(f"blank frames at {', '.join(f'{t:.2f}' for t in blank[:8])} s")
    short = [(a, b, t) for a, b, t in caps if b - a < 1.2]
    if short:
        problems.append("captions under 1.2 s: " + "; ".join(f"“{t[:30]}” {b - a:.1f} s" for a, b, t in short))
    kb = lambda p: p.stat().st_size // 1024
    print(f"{'PASS' if not problems else 'FAIL'}  {name}: {length:.1f} s · {len(caps)} captions · {len(frames)} frames checked · "
          f"mp4 {kb(mp4)} kB · webm {kb(webm)} kB · poster {kb(jpg)} kB")
    for a, b, t in caps:
        print(f"        {a:5.1f}–{b:4.1f}  {t}")
    for p in problems:
        print(f"      ↳ {p}")
    return not problems


if __name__ == "__main__":
    d = pathlib.Path(sys.argv[1])
    names = sys.argv[2:] or sorted(p.stem for p in d.glob("*.json"))
    if not names:
        sys.exit(f"no recordings in {d}")
    ok = [film(d, n) for n in names]
    sys.exit(0 if all(ok) else 1)
