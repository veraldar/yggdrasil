#!/usr/bin/env bash
# fake-join.sh — stands in for root/install/join.sh in the installer tests (bootstrap-test.sh, launcher-test.sh):
# prints what the real one prints in each case (its die() lines verbatim) and exits with its code.
#   FAKE_JOIN_MODE (else the file FAKE_JOIN_FILE, default /tmp/fake-join-mode): ok | run | refused | expired | sig |
#     net | hubnet | model | other | secret | wait        FAKE_WAIT: seconds the code stays up (default 1)
#   FAKE_ROOTJOIN: rootjoin.py (draws the real QR PNG)   FAKE_BRAIN_PORT: what root.conf names for "ok"
# Its arguments go to $HOME/fake-join-args (one per line); an --upstream-env file's content to $HOME/fake-upstream.
set -u
mode=${FAKE_JOIN_MODE:-$(cat "${FAKE_JOIN_FILE:-/tmp/fake-join-mode}" 2>/dev/null || echo ok)}
QR='' DIR=$HOME/.local/share/yggdrasil-root UP=''
printf '%s\n' "$@" >"$HOME/fake-join-args"
while [ $# -gt 0 ]; do
  case $1 in
    --qr-png) QR=$2; shift ;;
    --dir) DIR=$2; shift ;;
    --upstream-env) UP=$2; shift ;;
  esac
  shift
done
[ -n "$UP" ] && cat "$UP" >"$HOME/fake-upstream"
say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m  %s\n' "$1" >&2; exit "${2:-1}"; }
REL=https://github.com/veraldar/yggdrasil/releases/download/v0.9.1
code() {
  say "release: $REL/SHA256SUMS (+ its signature)"
  say "release: signature OK (the yggdrasil release key)"
  say 'asking https://ap.veraldar.org to let "PC" join as a root (wsl, host pc)'
  [ -n "$QR" ] && python3 "${FAKE_ROOTJOIN:?}" qr "https://ap.veraldar.org/join?r=4f9c2e1a7b3d5f60a8c4e2b9d1f3a5c7" --png "$QR" >/dev/null
  echo "    Scan this QR with the phone that is already paired with your tree, and approve."
  echo "    Code (check it matches the phone):  K7QM2XWP"
  echo "    Or open on that phone:              https://ap.veraldar.org/join?r=4f9c2e1a7b3d5f60a8c4e2b9d1f3a5c7"
  say "waiting for your approval (until 12:34:56; Ctrl-C to stop — re-run to resume)"
  sleep "${FAKE_WAIT:-1}"
}
joined() { # PORT
  mkdir -p "$DIR"
  printf 'HUB=https://ap.veraldar.org\nNAME=PC\nBRAIN_PORT=%s\nPEER_PORT=4181\n' "$1" >"$DIR/root.conf"
  echo "approved: root r-7 of https://ap.veraldar.org"
}
case $mode in
  ok) code; joined "${FAKE_BRAIN_PORT:-4180}"; say "brain up on http://127.0.0.1:${FAKE_BRAIN_PORT:-4180}"; exit 0 ;;
  run) code; joined 9; printf '\033[1;33m!!\033[0m  %s\n' "the brain is not answering on http://127.0.0.1:9 yet — see the log (nohup)" >&2; exit 0 ;;
  refused) code; echo "xx  the join was refused on the phone — nothing was installed" >&2; exit 3 ;;
  expired) code; echo "xx  the join request expired — run join.sh again for a new QR" >&2; exit 4 ;;
  sig) say "release: $REL/SHA256SUMS (+ its signature)"
       die "the SHA256SUMS at $REL is NOT signed by the yggdrasil release key — refusing it (a tampered or foreign release)" ;;
  net) echo "curl: (6) Could not resolve host: github.com" >&2
       die "cannot download $REL/SHA256SUMS — check the network and that the release exists" ;;
  hubnet) say "release: signature OK (the yggdrasil release key)"
          echo "rootjoin: cannot reach the hub: <urlopen error [Errno -2] Name or service not known>" >&2
          die "join failed (exit 1)" ;;
  model) die "no model upstream. Pass --upstream-env FILE with lines like
      YGG_UPSTREAM_BASE_URL=https://api.openai.com/v1
      YGG_UPSTREAM_API_KEY=sk-...
      YGG_UPSTREAM_MODEL=gpt-4o-mini
    (YGG_UPSTREAM_STYLE=anthropic for an Anthropic-shaped API), or export those variables." 64 ;;
  other) die "could not make the WireGuard key ($DIR/wg.key) with $DIR/bin/bifrost-net" ;;
  secret) echo "YGG_UPSTREAM_API_KEY=sk-live-abcdefghijklmnop1234567890"
          echo "token sk-proj-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2"
          echo "link token: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc"
          echo "x-join-secret: hunter2hunter2"
          echo "wg = Q2xhdWRlIGlzIG5vdCBhIHNlY3JldCBidXQgdGhpcyBpcz0+/abc="
          echo "path /home/me/.local/share/yggdrasil-root/bin/start and $REL/SHA256SUMS stay readable"
          code; joined "${FAKE_BRAIN_PORT:-4180}"; exit 0 ;;
  wait) code; sleep 600; exit 0 ;;
  *) die "fake-join: unknown mode $mode" ;;
esac
