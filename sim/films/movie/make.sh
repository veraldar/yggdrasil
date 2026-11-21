#!/usr/bin/env bash
# make.sh RUN [OUT] — the main film, "what yggdrasil is", from a passing recording run of record.sh.
#   RUN = the run's folder (its raw/<name>.ffconcat and <name>.json: the real app's frames and cut marks)
#   OUT = where the film goes (default RUN/movie): yggdrasil.mp4 · yggdrasil.webm (both with the voice) · yggdrasil.jpg · sheet
# STILLS="3,12,30" make.sh RUN   only writes those seconds as pictures (to look before a full render).
# Checks: the length, no blank frame, both files play to the end. Then look at yggdrasil-sheet.jpg by eye.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
RUN=${1:?the recording run}; OUT=${2:-$RUN/movie}
FONT=${FILMS_FONT:-$HOME/Work/veraldar-site/fonts/commit-mono-400-regular.woff}
grep -q "^rig+cut exit 0" "$RUN/record.log" || { echo "that run did not pass"; exit 1; }
mkdir -p "$OUT/footage"
cp "$HERE/movie.html" "$OUT/movie.html"; cp "$FONT" "$OUT/font.woff"
for n in talk tree file; do
  if [ ! -f "$OUT/footage/$n/00001.jpg" ]; then
    mkdir -p "$OUT/footage/$n"
    read -r a b < <(python3 -I -c "import json,sys; m=json.load(open(sys.argv[1]))['marks']; g=lambda k: next(x['t'] for x in m if x.get('mark')==k); print(g('start'), g('end'))" "$RUN/$n.json")
    ffmpeg -v error -y -f concat -safe 0 -i "$RUN/raw/$n.ffconcat" -vf "fps=30,trim=start=$a:end=$b,setpts=PTS-STARTPTS,scale=660:1344:flags=lanczos" -q:v 3 "$OUT/footage/$n/%05d.jpg"
  fi
done
if [ -n "${STILLS:-}" ]; then RENDER_STILLS=$STILLS APP_DIR="$ROOT/branch" node "$HERE/render.mjs" "$OUT"; ls "$OUT"/still-*.png; exit 0; fi
# the frames depend on movie.html and the footage: another movie.html = shoot again
sig=$(cat "$HERE/movie.html" "$RUN"/{talk,tree,file}.json | sha256sum | cut -c1-16)
[ "$(cat "$OUT/frames.sig" 2>/dev/null)" = "$sig" ] || { rm -rf "$OUT/frames"; echo "$sig" > "$OUT/frames.sig"; }
APP_DIR="$ROOT/branch" nice -n 10 node "$HERE/render.mjs" "$OUT"
cd "$OUT"
ffmpeg -v error -y -framerate 30 -i frames/%05d.jpg -c:v libx264 -preset fast -crf 14 -pix_fmt yuv420p movie-raw.mp4
ffmpeg -v error -y -i movie-raw.mp4 -an -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart yggdrasil-silent.mp4
# the voice (vo.json: the lines movie.html names, written by render.mjs) → yggdrasil.mp4 + yggdrasil.webm
python3 -I "$HERE/../voice/sound.py" yggdrasil-silent.mp4 vo.json yggdrasil
ffmpeg -v error -y -ss "${POSTER_AT:-23.6}" -i movie-raw.mp4 -frames:v 1 -q:v 3 yggdrasil.jpg
ffmpeg -v error -y -i movie-raw.mp4 -vf "fps=1/3,scale=270:-2,tile=8x4" -frames:v 1 -q:v 4 yggdrasil-sheet.jpg
python3 -I - <<'PY'
import re, subprocess, sys
d = lambda f: float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f],capture_output=True,text=True).stdout)
bad = []
a, b = d("yggdrasil.mp4"), d("yggdrasil.webm")
if abs(a - b) > 0.5: bad.append(f"mp4 {a:.1f} s, webm {b:.1f} s")
if a > 95: bad.append(f"{a:.1f} s is too long")
for f in ("yggdrasil.mp4", "yggdrasil.webm"):
    if not subprocess.run(["ffprobe","-v","error","-select_streams","a","-show_entries","stream=codec_name","-of","csv=p=0",f],capture_output=True,text=True).stdout.strip(): bad.append(f"{f} has no sound")
st = subprocess.run(["ffmpeg","-v","error","-i","yggdrasil.mp4","-vf","fps=2,signalstats,metadata=print:file=-","-f","null","-"],capture_output=True,text=True).stdout
t, blank = 0.0, []
for line in st.splitlines():
    m = re.match(r"frame:\d+\s+pts:\S+\s+pts_time:(\S+)", line)
    if m: t = float(m.group(1))
    m = re.match(r"lavfi\.signalstats\.YMAX=(\S+)", line)
    if m and float(m.group(1)) < 60 and 0.6 < t < a - 0.7: blank.append(t)
if blank: bad.append("blank frames at " + ", ".join(f"{x:.1f}" for x in blank[:8]))
import os
print(("PASS" if not bad else "FAIL") + f"  yggdrasil: {a:.1f} s · mp4 {os.path.getsize('yggdrasil.mp4')//1024} kB · webm {os.path.getsize('yggdrasil.webm')//1024} kB · poster {os.path.getsize('yggdrasil.jpg')//1024} kB")
for x in bad: print("      ↳ " + x)
sys.exit(1 if bad else 0)
PY
