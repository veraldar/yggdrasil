#!/usr/bin/env bash
# build-win.sh VERSION JOIN_SH OUTDIR — the Windows installer: OUTDIR/Veraldar-Setup-VERSION.exe
#
#   VERSION   the release, e.g. 0.9.1 (or 0.9.1-rc.1): goes into the exe (window, Apps list, file properties)
#             and its name
#   ROOT_SH   the root.sh the installer embeds and runs inside WSL — the STAMPED one of this release
#             (scripts/release.sh calls this after stamping the installers and before SHA256SUMS is signed,
#             so the exe is in the signed list). For tests: root/install/join.sh as it is in the tree.
#   OUTDIR    where the exe goes
#
# makensis runs in docker (debian:stable-slim + apt nsis, cached as $NSIS_IMAGE, default veraldar-nsis:local):
# nothing to install here. The sources are copied with Windows line endings for .bat/.vbs and Unix ones for .sh,
# whatever the checkout did.
set -euo pipefail
VERSION=${1:-} ROOT_SH=${2:-} OUTDIR=${3:-}
[ -n "$VERSION" ] && [ -n "$ROOT_SH" ] && [ -n "$OUTDIR" ] || { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
VERSION=${VERSION#v}
case $VERSION in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "build-win: VERSION must look like 0.9.1 (got $VERSION)" >&2; exit 64 ;;
esac
case $VERSION in *[!0-9A-Za-z.+-]*) echo "build-win: unexpected characters in VERSION $VERSION" >&2; exit 64 ;; esac
[ -f "$ROOT_SH" ] || { echo "build-win: no root.sh at $ROOT_SH" >&2; exit 1; }
head -1 "$ROOT_SH" | grep -q '^#!.*bash' || { echo "build-win: $ROOT_SH is not a bash script" >&2; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
WIN=$REPO/win
IMAGE=${NSIS_IMAGE:-veraldar-nsis:local}
# file version for Windows: four numbers (0.9.1-rc.1 -> 0.9.1.0)
core=${VERSION%%[-+]*}
VIVERSION=$core.0

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "build-win: building $IMAGE (debian:stable-slim + nsis)" >&2
  docker build -q -t "$IMAGE" - >/dev/null <<'EOF'
FROM debian:stable-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends nsis >/dev/null && rm -rf /var/lib/apt/lists/*
EOF
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
for f in veraldar.nsi launcher.bat keepalive.vbs; do sed 's/\r$//; s/$/\r/' "$WIN/$f" >"$STAGE/$f"; done
sed 's/\r$//' "$WIN/wsl-bootstrap.sh" >"$STAGE/wsl-bootstrap.sh"
# root.sh goes in byte for byte: a stamped root.sh checks its own sha256 against the release's signed SHA256SUMS
if grep -q $'\r' "$ROOT_SH"; then echo "build-win: $ROOT_SH has CR line endings — refusing it" >&2; exit 1; fi
cp "$ROOT_SH" "$STAGE/root.sh"
mkdir -p "$OUTDIR"
OUT=$(cd "$OUTDIR" && pwd)/Veraldar-Setup-$VERSION.exe
docker run --rm -u "$(id -u):$(id -g)" -v "$STAGE:/src" -w /src "$IMAGE" \
  makensis -V2 -DAPPVERSION="$VERSION" -DVIVERSION="$VIVERSION" -DJOIN_SH=root.sh -DOUTFILE=/src/out.exe veraldar.nsi >&2
mv -f "$STAGE/out.exe" "$OUT"
echo "$OUT"
