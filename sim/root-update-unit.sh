#!/usr/bin/env bash
# Fast, docker-free check of `root.sh --update` (INSTALL-2): it must finish in seconds, take the update
# branch ONCE (the re-exec carries neither --update nor --major), and the re-exec guard must stop a loop.
# Fake signed release (throwaway key) served by python on 127.0.0.1:19290. No network, no root.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMPDIR=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/install}; mkdir -p "$TMPDIR"
W=$(mktemp -d "$TMPDIR/rootupd.XXXXXX"); PORT=19290; SRV=''
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; rm -rf "$W"; }; trap cleanup EXIT
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; fail=$((fail+1)); }
V=1.0.0-unit
mkdir -p "$W/rel/download/v$V" "$W/home" "$W/dir"
ssh-keygen -q -t ed25519 -N '' -C release@yggdrasil -f "$W/key" </dev/null
printf 'release@yggdrasil namespaces="yggdrasil-release" %s\n' "$(cut -d' ' -f1-2 "$W/key.pub")" >"$W/signers"
( cd "$W/rel/download/v$V" && printf x >"bifrost-net-$V-linux-x86_64" && sha256sum -- * >SHA256SUMS \
  && ssh-keygen -q -Y sign -f "$W/key" -n yggdrasil-release SHA256SUMS ) || { echo "cannot make the fake release"; exit 2; }
mkdir -p "$W/rel/latest"; ln -s "../download/v$V" "$W/rel/latest/download"
( cd "$W/rel" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 ) >/dev/null 2>&1 & SRV=$!
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/latest/download/SHA256SUMS" >/dev/null && break; sleep 0.1; done
cp "${ROOT_SH:-$ROOT/root/install/root.sh}" "$W/root.sh"
printf 'VERSION=%s\nROOT_ID=r1\n' "$V" >"$W/dir/root.conf"
run() { # ARGS… — root.sh from a lone copy, bounded
  ( cd "$W" && HOME="$W/home" XDG_DATA_HOME="$W/home/.local/share" YGG_RELEASES="http://127.0.0.1:$PORT" \
    YGG_RELEASE_TEST_SIGNERS="$W/signers" timeout 60 bash root.sh --dir "$W/dir" "$@" ) </dev/null
}
grep -q -- '--dir)' "$W/root.sh" || { echo "root.sh has no --dir"; exit 2; }
s=$(date +%s); run --update >"$W/u.log" 2>&1; rc=$?; e=$(( $(date +%s) - s ))
[ $rc != 124 ] && [ "$e" -lt 30 ] && ok "--update ends on its own (rc $rc, ${e}s)" || bad "--update did not end (rc $rc, ${e}s)"
[ "$(grep -c 'is the newest release' "$W/u.log")" = 1 ] && ok "the update branch ran once" || bad "the update branch ran $(grep -c 'is the newest release' "$W/u.log") times"
grep -q 're-executed itself' "$W/u.log" && bad "the re-exec guard fired" || ok "no re-exec guard hit"
( cd "$W" && YGG_ROOT_REEXEC=4 bash root.sh --update ) >"$W/g.log" 2>&1 </dev/null; rc=$?
[ $rc = 70 ] && grep -q 're-executed itself' "$W/g.log" && ok "guard: a 5th re-exec stops with exit 70" || bad "guard did not stop (rc $rc)"
echo "root-update-unit: $fail failed"; exit $((fail > 0))
