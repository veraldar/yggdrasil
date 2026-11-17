#!/usr/bin/env bash
# cc-live-up.sh — (re)start the Claude Code live helper next to a preview: unit rc-<preview>-cclive.
# preview-up.sh runs it; it also runs alone (the brain is not touched).
#
#   cc-live-up.sh             the preview you open (:8447 → app :8101): helper on 127.0.0.1:4320
#   PREVIEW=ui cc-live-up.sh  the scratch pair (app :8191): helper on 127.0.0.1:4321
#
# Unsandboxed on purpose: `claude attach` needs the Claude Code daemon's sockets (/tmp/cc-daemon-*,
# /run/user/*/cc-socks), the claude binary and its sign-in, which the brain's sandbox doesn't have.
# What it may run is fixed in cc_live.py (claude agents --json, claude attach <id>, transcript
# reads); loopback only; every call needs the token in ~/.cache/root-sim/cc-live.token (0600, not
# bound into the brain's sandbox), which the app reads (CC_LIVE_TOKEN_FILE in its env file).
set -euo pipefail
NAME=${PREVIEW:-preview}
case "$NAME" in preview) PORT=4320 ;; ui) PORT=4321 ;; *) PORT=${CC_LIVE_PORT:?CC_LIVE_PORT for $NAME} ;; esac
UNIT="rc-$NAME-cclive"
TOK="$HOME/.cache/root-sim/cc-live.token"
LOG="$HOME/.cache/root-sim/cc-live-$NAME.log"
# the helper's code: the tree's (the :8447 brain runs tree-next's since 11-16; CC_LIVE_DIR to override)
HERE=${CC_LIVE_DIR:-$HOME/Work/tree-next/root/cc-live}
# full access (11-17, the preview you open only): the owner's key + the grants, outside the brain's
# sandbox (it binds ~/.cache/root-sim/$NAME, never this) — full-access-enroll.sh writes the key
ACCESS=()
[ "$NAME" = preview ] && ACCESS=(--access-dir "$HOME/.cache/root-sim/full-access")
CLAUDE_BIN=$(command -v claude || true)
[ -n "$CLAUDE_BIN" ] || CLAUDE_BIN="$HOME/.local/share/mise/installs/claude/latest/claude"
[ -x "$CLAUDE_BIN" ] || { echo "cc-live: no claude binary"; exit 1; }

systemctl --user stop "$UNIT" 2>/dev/null || true
systemctl --user reset-failed "$UNIT" 2>/dev/null || true
systemd-run --user --unit "$UNIT" --collect -q -p "StandardOutput=append:$LOG" -p "StandardError=append:$LOG" \
  --setenv=HOME="$HOME" --setenv=PATH="$(dirname "$CLAUDE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  python3 "$HERE/cc_live.py" --port "$PORT" --token-file "$TOK" --claude "$CLAUDE_BIN" --live-file "$HOME/.cache/root-sim/$NAME/harness-live.json" "${ACCESS[@]}"
for _ in $(seq 1 30); do
  [ -s "$TOK" ] && curl -sf -m 3 -H "x-cc-live-token: $(cat "$TOK")" "http://127.0.0.1:$PORT/sessions" >/dev/null && break
  sleep 0.3
done
curl -sf -m 5 -H "x-cc-live-token: $(cat "$TOK")" "http://127.0.0.1:$PORT/sessions" |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print("cc-live up ('"$NAME"', :'"$PORT"'):", [(s["name"], s["kind"], s["status"]) for s in d["sessions"]])'
