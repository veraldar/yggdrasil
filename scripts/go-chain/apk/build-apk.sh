#!/usr/bin/env bash
# build-apk.sh — go-chain Lane C: build bifrost.apk WITHOUT gradle.
# aapt2 (native) + javac + d8 + zipalign + apksigner, all inside the eclipse
# temurin JDK docker image (this box's cgroup forbids JVMs; docker is the
# honest workaround). Self-contained: builds an icon with python (no PIL).
#
#   bash scripts/go-chain/apk/build-apk.sh [out.apk]
#
# SDK pieces expected (already on this box):
#   ~/Android/Sdk/build-tools/36.0.0/{aapt2,d8,zipalign,apksigner}
#   ~/Android/Sdk/platforms/android-36/android.jar
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SDK="$HOME/Android/Sdk"
BT="$SDK/build-tools/36.0.0"
PLATFORM="$SDK/platforms/android-36/android.jar"
OUT="${1:-$HERE/bifrost.apk}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac   # resolve NOW: the script cd's into its workdir later
WORK=$(mktemp -d)
trap 'docker run --rm -v /tmp:/tmp alpine rm -rf "$WORK" 2>/dev/null; rm -rf "$WORK" 2>/dev/null' EXIT

[ -x "$BT/aapt2" ] || { echo "no aapt2 at $BT — install android-sdk build-tools" >&2; exit 1; }
[ -f "$PLATFORM" ] || { echo "no android.jar at $PLATFORM" >&2; exit 1; }

# 1. icon: 48x48 and 192x192 PNG, no PIL needed — a rainbow arc on midnight
for s in 48 192; do
  python3 - "$WORK/icon-$s.png" "$s" <<'PY'
import struct, sys, zlib
path, S = sys.argv[1], int(sys.argv[2])
def colorwheel(h):
    h = (h % 360) / 60.0
    i = int(h) % 6; f = h - int(h)
    q = [ (255,int(255*(1-f)*0.85),60), (int(255*0.85*(1-f)),255,60), (60,255,int(255*f*0.85)),
          (60,int(255*(1-f)*0.85),255), (int(255*f*0.85),60,255), (255,60,int(255*(1-f)*0.85)) ]
    return q[i]
def chunk(t, d):
    c = struct.pack('>I', len(d)) + t + d
    return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
rows = []
for y in range(S):
    row = b'\x00'
    for x in range(S):
        cx, cy = x - S/2, (y - S*0.62) * 1.6
        r = (cx*cx + cy*cy) ** 0.5
        if S*0.30 < r < S*0.42:
            rgb = colorwheel(int(x / S * 360))
        elif S*0.44 < r < S*0.46:
            rgb = (235, 235, 245)
        else:
            rgb = (16, 16, 20)
        row += bytes(rgb)
    rows.append(row)
png = b'\x89PNG\r\n\x1a\n'
ihdr = struct.pack('>IIBBBBB', S, S, 8, 2, 0, 0, 0)
png += chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b'')
open(path, 'wb').write(png)
PY
done

echo "[apk] aapt2 compile+link …"
mkdir -p "$WORK/gen" "$WORK/obj" "$WORK/res/drawable"
cp "$WORK/icon-192.png" "$WORK/res/drawable/icon.png"
"$BT/aapt2" compile --dir "$WORK/res" -o "$WORK/res.zip"
"$BT/aapt2" link -o "$WORK/base.apk" -I "$PLATFORM" --manifest "$HERE/AndroidManifest.xml" \
  -R "$WORK/res.zip" --java "$WORK/gen" --auto-add-overlay

echo "[apk] javac + d8 …"
docker run --rm -v "$HERE":/src:ro -v "$SDK":/sdk:ro -v "$WORK":/work -w /work \
  eclipse-temurin:21 javac --release 11 -cp /sdk/platforms/android-36/android.jar \
  -d /work/obj /work/gen/dev/veraldar/bifrost/R.java /src/src/dev/veraldar/bifrost/MainActivity.java

docker run --rm -v "$SDK":/sdk:ro -v "$WORK":/work -w /work \
  eclipse-temurin:21 bash -c '/sdk/build-tools/36.0.0/d8 --min-api 24 --lib /sdk/platforms/android-36/android.jar --output /work /work/obj/dev/veraldar/bifrost/*.class'

echo "[apk] package …"
cd "$WORK"
cp "$WORK/base.apk" "$WORK/unsigned.apk"
cp "$WORK"/classes.dex . 2>/dev/null || true
zip -q -j unsigned.apk classes.dex
"$BT/zipalign" -f 4 unsigned.apk aligned.apk

echo "[apk] sign (debug key, keystore minted if missing) …"
KS="$HERE/bifrost.keystore"
if [ ! -f "$KS" ]; then
  docker run --rm -v "$WORK":/work -w /work eclipse-temurin:21 keytool -genkeypair \
    -keystore /work/bifrost.keystore -alias bifrost -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass bifrost -keypass bifrost -dname "CN=bifrost, OU=veraldar, O=veraldar" >/dev/null 2>&1
  cat "$WORK/bifrost.keystore" > "$KS"   # cat, not cp: stays owned by me (docker wrote as root)
  echo "[apk] minted $KS (storepass/keypass: bifrost — keep for updates)"
fi
# apksigner is java (this cgroup forbids JVMs) — run its jar in docker; the
# signed apk lands in $WORK and is cat'ed out (my ownership)
docker run --rm -v "$HERE":/src:ro -v "$SDK":/sdk:ro -v "$WORK":/work -w /work \
  eclipse-temurin:21 java -jar /sdk/build-tools/36.0.0/lib/apksigner.jar sign \
  --ks /src/bifrost.keystore --ks-pass pass:bifrost --key-pass pass:bifrost \
  --min-sdk-version 24 --out /work/signed.apk aligned.apk
cat "$WORK/signed.apk" > "$OUT"
docker run --rm -v "$HERE":/src:ro -v "$SDK":/sdk:ro -v "$WORK":/work -w /work \
  eclipse-temurin:21 java -jar /sdk/build-tools/36.0.0/lib/apksigner.jar verify \
  --min-sdk-version 24 --print-certs "/src/$(basename "$OUT")" | head -3 || true
ls -la "$OUT"
echo "[apk] DONE: $OUT"
