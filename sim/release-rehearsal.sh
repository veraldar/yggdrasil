#!/usr/bin/env bash
# release-rehearsal.sh — the REAL release path (scripts/release.sh, plain version, clean HEAD, tag, sign) run end to
# end in a throwaway copy, with a stand-in key in the place of the release key. Nothing here can publish: the copy's
# origin is a bare clone in the scratch dir, the real release key signs nothing, GitHub is never asked.
#
#   sim/release-rehearsal.sh [--mac-host HOST] [VERSION]      VERSION default 0.8.99 (no tag of that name exists;
#                                                             the rig's update steps serve 0.9.1-test as "newer")
# What it checks after release.sh:
#   r1 release.sh exit 0 on the real path (not a TEST release)       r2 every asset (Linux, macOS, Windows, scripts)
#   r3 SHA256SUMS signed by the stand-in key, every file matches     r4 the tag: made by release.sh at HEAD, AFTER the
#   r5 the macOS archive: Mach-O arm64 brain + node, RELEASE           signature, never pushed (origin has none)
#   r6 the installers are real-stamped (YGG_RELEASE=VERSION, TEST '') and embed the stand-in key
#   r7 the Windows installer embeds this release's join.sh byte for byte (7z), so it installs exactly this release
# Then (printed, not run): the rig against this dist, and the Mac bootstrap check.
# Scratch: $REH (default ~/.cache/p4-rehearsal); release cache: YGG_RELEASE_CACHE (default: release.sh's own).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=0.8.99 MAC=()
while [ $# -gt 0 ]; do case $1 in --mac-host) MAC=(--mac-host "$2"); shift ;; *) VERSION=$1 ;; esac; shift; done
REH=${REH:-$HOME/.cache/p4-rehearsal}
rm -rf "$REH"; mkdir -p "$REH"
RESULTS=$REH/results.tsv; : >"$RESULTS"
pass() { printf 'PASS\t%s\t%s\n' "$1" "$2" >>"$RESULTS"; printf '\033[32mPASS\033[0m %-3s %s\n' "$1" "$2"; }
fail() { printf 'FAIL\t%s\t%s\n' "$1" "$2" >>"$RESULTS"; printf '\033[31mFAIL\033[0m %-3s %s\n' "$1" "$2"; }
check() { local id=$1 what=$2; shift 2; if "$@" >>"$REH/checks.log" 2>&1; then pass "$id" "$what"; else fail "$id" "$what"; fi; }

# ------------------------------------------------------------------- the copy, its origin, the stand-in key
git -C "$ROOT" diff --quiet HEAD || echo "note: $ROOT has uncommitted changes — the rehearsal uses its HEAD only"
git clone -q --bare "$ROOT" "$REH/origin.git" && git clone -q "$REH/origin.git" "$REH/c" || exit 2
SRC_COMMIT=$(git -C "$ROOT" rev-parse HEAD)
ssh-keygen -q -t ed25519 -N '' -C release@yggdrasil -f "$REH/standin" </dev/null
PUB=$(cut -d' ' -f1-2 "$REH/standin.pub")
LINE="release@yggdrasil namespaces=\"yggdrasil-release\" $PUB"
[ "$PUB" != "$(cut -d' ' -f1-2 "$ROOT/RELEASE-KEY.pub")" ] || { echo "the stand-in is the real key?"; exit 2; }
cd "$REH/c" || exit 2
git config user.email rehearsal@local; git config user.name rehearsal   # who makes the tag here
printf '%s release@yggdrasil\n' "$PUB" >RELEASE-KEY.pub; printf '%s\n' "$LINE" >allowed_signers
for f in root/install/install.sh root/install/join.sh root/install/root.sh trunk/install/trunk.sh root/install/rootjoin.py root/install/rootjoin-v1.py; do
  python3 - "$f" "$LINE" <<'PY' || exit 2
import re, sys
p, line = sys.argv[1], sys.argv[2]
s = open(p).read()
s2, n = re.subn(r"^(YGG_SIGNER *= *)'.*'$", lambda m: m.group(1) + "'" + line + "'", s, count=1, flags=re.M)
assert n == 1, p
open(p, "w").write(s2)
PY
done
git checkout -q -B rehearsal || exit 2   # (the source may be a detached checkout)
git commit -qam "rehearsal: a stand-in release key" || exit 2
git push -q origin HEAD:refs/heads/rehearsal || exit 2   # origin = the bare copy: what release.sh's tag check asks
echo "rehearsal of $SRC_COMMIT as v$VERSION in $REH/c (stand-in key $(ssh-keygen -lf "$REH/standin" | awk '{print $2}'))"

# ------------------------------------------------------------------------------------- release.sh, real path
START=$(date +%s)
YGG_RELEASE_KEY=$REH/standin DIST=$REH/dist bash scripts/release.sh "$VERSION" "${MAC[@]}" >"$REH/release.log" 2>&1; rc=$?
D=$REH/dist/$VERSION
check r1 "release.sh $VERSION ${MAC[*]} on the real path: exit 0 ($rc), not a TEST release" \
  bash -c "[ $rc = 0 ] && ! grep -q 'TEST release' '$REH/release.log' && grep -q 'is signed (SHA256SUMS.sig' '$REH/release.log'"
want=(install.sh join.sh root.sh trunk.sh sni-443.py SHA256SUMS SHA256SUMS.sig "yggdrasil-$VERSION-linux-x86_64.tar.gz"
  "bifrost-net-$VERSION-linux-x86_64" "bifrost-net-root-$VERSION-linux-x86_64" "Veraldar-Setup-$VERSION.exe")
[ ${#MAC[@]} = 0 ] || want+=("yggdrasil-$VERSION-macos-aarch64.tar.gz")
check r2 "every asset is there: ${want[*]}" bash -c "cd '$D' && for f in ${want[*]}; do [ -s \"\$f\" ] || { echo missing \$f; exit 1; }; done"
check r3 "SHA256SUMS: signed by the stand-in key, every asset listed and matching" \
  bash -c "cd '$D' && ssh-keygen -Y verify -f '$REH/c/allowed_signers' -I release@yggdrasil -n yggdrasil-release -s SHA256SUMS.sig <SHA256SUMS &&
    sha256sum -c --quiet SHA256SUMS && [ \$(wc -l <SHA256SUMS) = \$(ls | grep -vc '^SHA256SUMS') ]"
check r4 "tag v$VERSION: made by release.sh at HEAD after the signature, local only (origin has none)" \
  bash -c "[ \"\$(git -C '$REH/c' rev-parse 'v$VERSION^{commit}')\" = \"\$(git -C '$REH/c' rev-parse HEAD)\" ] &&
    [ \"\$(git -C '$REH/c' for-each-ref --format='%(taggerdate:unix)' refs/tags/v$VERSION)\" -ge \"\$(stat -c %Y '$D/SHA256SUMS.sig')\" ] &&
    [ \"\$(git -C '$REH/c' for-each-ref --format='%(taggerdate:unix)' refs/tags/v$VERSION)\" -ge $START ] &&
    [ -z \"\$(git -C '$REH/origin.git' tag -l 'v$VERSION')\" ]"
if [ ${#MAC[@]} != 0 ]; then
  mkdir -p "$REH/mac" && tar -xzf "$D/yggdrasil-$VERSION-macos-aarch64.tar.gz" -C "$REH/mac" 2>/dev/null
  check r5 "the macOS archive: brain + node Mach-O arm64, join.sh + rootjoin.py + root-dial.py, RELEASE names v$VERSION and macOS" \
    bash -c "m='$REH/mac/yggdrasil-$VERSION'; file -b \$m/bin/yggdrasil | grep -q 'Mach-O 64-bit.*arm64' && file -b \$m/bin/bifrost-net-root | grep -q 'Mach-O 64-bit.*arm64' &&
      [ -f \$m/root/install/join.sh ] && [ -f \$m/root/install/rootjoin.py ] && [ -f \$m/trunk/scripts/root-dial.py ] &&
      grep -qx 'yggdrasil $VERSION' \$m/RELEASE && grep -q '^built on macOS' \$m/RELEASE"
fi
check r6 "the installers: real-stamped (YGG_RELEASE='$VERSION', YGG_RELEASE_TEST=''), embedding the stand-in key" \
  bash -c "for f in install.sh join.sh root.sh trunk.sh; do grep -qx \"YGG_RELEASE='$VERSION'\" '$D'/\$f && grep -qx \"YGG_RELEASE_TEST=''\" '$D'/\$f &&
    grep -qF '$PUB' '$D'/\$f || exit 1; done"
check r7 "the Windows installer embeds this release's root.sh byte for byte (YGG_RELEASE='$VERSION' inside)" \
  bash -c "rm -rf '$REH/exe' && mkdir -p '$REH/exe' && docker run --rm -v '$D:/d:ro' -v '$REH/exe:/o' debian:stable-slim bash -c \
    'apt-get update -qq && apt-get install -y -qq p7zip-full >/dev/null && 7z x -y -o/o /d/Veraldar-Setup-$VERSION.exe >/dev/null && chown -R $(id -u):$(id -g) /o' &&
    j=\$(find '$REH/exe' -name root.sh | head -1) && [ -n \"\$j\" ] && cmp -s \"\$j\" '$D/root.sh'"
echo; column -t -s $'\t' "$RESULTS"
echo "dist: $D   key: $REH/standin   logs: $REH"
! grep -q '^FAIL' "$RESULTS"
