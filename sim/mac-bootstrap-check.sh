#!/usr/bin/env bash
# mac-bootstrap-check.sh — a release's join.sh on a real Mac, the way a person downloads it, up to the point where
# it asks a hub to join (no hub is given): signature check, the macOS archive, both binaries start (Gatekeeper),
# the Mac's own python3 runs the helper, the WireGuard key. Everything happens in ONE test folder on the Mac
# (~/.cache/yggdrasil-release-mac/check-<pid>), served from the Mac's loopback; nothing else there is touched
# (LaunchAgents and ~/.local/share are compared before/after) and the folder is removed at the end.
#
#   sim/mac-bootstrap-check.sh HOST DIST_DIR [SIGNERS]
#     DIST_DIR  release.sh's dist/VERSION (a draft, a rehearsal, a test release)
#     SIGNERS   only for a TEST release (YGG_RELEASE_TEST='1'): its allowed_signers file
set -uo pipefail
HOST=${1:?usage: mac-bootstrap-check.sh HOST DIST_DIR [SIGNERS]}; D=$(cd "${2:?DIST_DIR}" && pwd) || exit 2; SIGNERS=${3:-}
V=$(basename "$D"); TGZ=yggdrasil-$V-macos-aarch64.tar.gz
[ -s "$D/$TGZ" ] || { echo "$D has no $TGZ"; exit 2; }
R=.cache/yggdrasil-release-mac/check-$$
ssh -o BatchMode=yes "$HOST" "mkdir -p ~/$R/files/releases/download/v$V && ls ~/Library/LaunchAgents | wc -l >~/$R/agents-before && ls ~/.local/share >~/$R/share-before" || exit 2
scp -q -o BatchMode=yes "$D/SHA256SUMS" "$D/SHA256SUMS.sig" "$D/join.sh" "$D/$TGZ" "$HOST:$R/files/releases/download/v$V/" || exit 2
TSENV=''
if [ -n "$SIGNERS" ]; then scp -q "$SIGNERS" "$HOST:$R/signers" && TSENV="YGG_RELEASE_TEST_SIGNERS=\$T/signers"; fi
ssh -o BatchMode=yes "$HOST" "R=$R V=$V TSENV='$TSENV' bash -s" <<'EOF'
set -u
T=$HOME/$R; cd "$T" || exit 2
P=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
(cd "$T/files" && exec python3 -m http.server "$P" --bind 127.0.0.1 >"$T/http.log" 2>&1) & HP=$!
sleep 1
mkdir -p "$T/dl" && cd "$T/dl" && curl -fsSLO "http://127.0.0.1:$P/releases/download/v$V/join.sh"
eval "env XDG_DATA_HOME=\"$T/share\" YGG_RELEASES=\"http://127.0.0.1:$P/releases\" $TSENV" \
  YGG_UPSTREAM_BASE_URL=http://127.0.0.1:9/v1 YGG_UPSTREAM_API_KEY=none YGG_UPSTREAM_MODEL=none YGG_UPSTREAM_STYLE=openai \
  bash join.sh --dir "$T/root" --hub https://127.0.0.1:9 --name mac-check --supervisor nohup --no-start </dev/null >"$T/join.log" 2>&1
rc=$?
kill "$HP" 2>/dev/null; wait "$HP" 2>/dev/null
L=$(sed 's/\x1b\[[0-9;]*m//g' "$T/join.log")
ok() { printf 'PASS  %s\n' "$1"; }; no() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }; FAILS=0
t() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
echo "macOS $(sw_vers -productVersion) $(uname -m) · join.sh exit $rc (expected 1: no hub given)"
t "signature checked against the key join.sh embeds" grep -q 'release: signature OK' <<<"$L"
t "the macOS archive picked, sha256 checked, unpacked" grep -q "release: $V unpacked in $T/share/yggdrasil/release/$V (signature + sha256 checked)" <<<"$L"
t "stopped only where it asks the hub" grep -q 'cannot reach the hub' <<<"$L"
for b in yggdrasil bifrost-net; do
  f=$T/root/bin/$b
  t "$b: Mach-O arm64, no quarantine flag, ad-hoc signed" bash -c "file -b '$f' | grep -q 'Mach-O 64-bit executable arm64' && ! xattr -p com.apple.quarantine '$f' && codesign -dv '$f' 2>&1 | grep -q 'Signature=adhoc'"
done
t "the brain starts (asks for its model, as it must without one)" bash -c "'$T/root/bin/yggdrasil' 2>&1 | grep -q 'YGG_UPSTREAM_BASE_URL is required'"
t "the node starts (its usage)" bash -c "'$T/root/bin/bifrost-net' 2>&1 | grep -q '^usage'"
t "the WireGuard key made, mode 600" bash -c "[ \"\$(stat -f %Lp '$T/root/wg.key')\" = 600 ]"
t "RELEASE names v$V, built on macOS" bash -c "grep -qx 'yggdrasil $V' '$T/share/yggdrasil/release/$V/RELEASE' && grep -q '^built on macOS' '$T/share/yggdrasil/release/$V/RELEASE'"
t "nothing outside the test folder: LaunchAgents unchanged" bash -c "[ \"\$(ls ~/Library/LaunchAgents | wc -l)\" = \"\$(cat '$T/agents-before')\" ]"
t "nothing outside the test folder: ~/.local/share unchanged" bash -c "diff <(ls ~/.local/share) '$T/share-before'"
printf '%s\n' "$L" | tail -6 | sed 's/^/    | /'
cd / && rm -rf "$T"
echo "test folder removed · $FAILS failed"
[ "$FAILS" = 0 ]
EOF
