#!/usr/bin/env bash
# notice-8447.sh — for a shell OUTSIDE the :8447 sandbox (the :8443 opencode, or a terminal on omarchy):
# tree-next HEAD's brain + app onto :8447 (11-17: the notification digest, the queued-message fix, the list ordered by the owner's messages) — the brain's tests + build, then, once no
# session is working (a brain restart ends a turn in flight, the one that asked for this included),
# the brain on the new binary and verify-8447.sh (app, live helper, the phone suites incl. the
# notification spec). The verdict ("== DEPLOY: GREEN|RED …") is posted back into the session that
# asked for it, so it wakes and tells the owner.
#   setsid nohup bash ~/Work/root-coord/lab/root-sim/notice-8447.sh > ~/Work/root-coord/lab/root-sim/notice-8447.log 2>&1 < /dev/null &
set -uo pipefail
for d in "$HOME/.cargo/bin" "$HOME"/.local/share/mise/installs/rust/*/bin "$HOME/.local/bin" "$HOME/.local/share/mise/installs/node/latest/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
HERE="$HOME/Work/root-coord/lab/root-sim"
ROOT="$HOME/Work/tree-next/root"
B=https://omarchy.tail5435b1.ts.net:8447
ASKER=ses_88f9338e5f7d4f00a2a98b1e0badd913 # "Where were we at · Claude Code (new)"

tell() { # the verdict, into the asking session (a new turn there)
  echo "$1"
  python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "async": True}))' \
    "[auto: notice-8447.sh] $1 — log: ~/Work/root-coord/lab/root-sim/notice-8447.log (and verify-8447.log). Read it and report to the owner." |
    curl -s -m 30 -X POST "$B/api/session/$ASKER/messages" -H 'Content-Type: application/json' -H "X-Session-Pin: $ASKER" -d @- >/dev/null
}

echo "== brain tests $(date +%T)"
command -v cargo >/dev/null || { tell "== DEPLOY: RED (no cargo on PATH)"; exit 1; }
# this shell must be able to build the app and restart units, or nothing is touched (11-18: a seat that
# could not run node restarted the brain twice and then failed the app build)
node -e 'process.exit(0)' >/dev/null 2>&1 || { tell "== DEPLOY: RED (node cannot run in this shell — a sandbox without JIT; nothing was restarted, run it from a normal shell)"; exit 1; }
systemctl --user show-environment >/dev/null 2>&1 || { tell "== DEPLOY: RED (no user systemd in this shell; nothing was restarted)"; exit 1; }
# (pipefail: a failing cargo fails the subshell, whatever grep finds)
( cd "$ROOT" && cargo test --release 2>&1 | grep -E '^test result|FAILED|panicked|error(\[|:)' ); rc=$?
[ "$rc" = 0 ] || { tell "== DEPLOY: RED (cargo test, exit $rc)"; exit 1; }
echo "== brain build $(date +%T)"
( cd "$ROOT" && cargo build --release 2>&1 | tail -2 ) || { tell "== DEPLOY: RED (cargo build)"; exit 1; }

echo "== waiting until no session is working $(date +%T)"
for i in $(seq 1 360); do
  busy=$(curl -s -m 15 "$B/api/session" | python3 -c 'import json,sys
try: rows=json.load(sys.stdin)
except Exception: rows=None
print("?" if not isinstance(rows,list) else sum(1 for r in rows if r.get("pending")))')
  [ "$busy" = 0 ] && break
  [ $((i % 12)) = 1 ] && echo "   $(date +%T) working: $busy"
  sleep 5
done
[ "$busy" = 0 ] || { tell "== DEPLOY: RED (sessions kept working for 30 min — the brain was NOT restarted; the app and the brain build are ready)"; exit 1; }
sleep 20 # the asking turn's own tail (its reply lands, then the run ends)

echo "== brain on the new binary $(date +%T)"
bash "$HERE/preview-up.sh" "$ROOT/target/release/yggdrasil" 2>&1 | tail -5 || { tell "== DEPLOY: RED (preview-up.sh)"; exit 1; }
for i in $(seq 1 30); do curl -sf -m 3 http://127.0.0.1:4101/session >/dev/null && break; sleep 1; done

echo "== verify $(date +%T)"
bash "$HERE/verify-8447.sh" > "$HERE/verify-8447.log" 2>&1 < /dev/null
grep -E '^== |passed|failed|^\s+[0-9]+\) |notice: |shown: ' "$HERE/verify-8447.log"
v=$(grep -E '^== VERIFY' "$HERE/verify-8447.log" | tail -1)
case "$v" in *GREEN*) tell "== DEPLOY: GREEN — brain + app deployed on :8447, $v" ;; *) tell "== DEPLOY: RED — $v" ;; esac
