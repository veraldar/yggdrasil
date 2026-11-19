#!/usr/bin/env bash
# verify-twin.sh — the phase-0/1+ acceptance suites, on the TWIN (plan G7.3: e2e never touches the
# live preview by default). Boots the twin from the current worktree (twin-up.sh), runs the suites
# that write (list-order, notify-per-session) against its app, then only the READ-ONLY suites
# against the live :8447 — the live store stays clean.   verify-twin.sh [run]
# The verdict is the last line: "== VERIFY: GREEN|RED".
#   setsid nohup bash ~/Work/p0-rails/sim/acceptance/verify-twin.sh > /tmp/verify-twin.log 2>&1 &
set -uo pipefail
RUN=${1:-acc1}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
for d in "$HOME/.local/bin" "$HOME/.local/share/mise/installs/node/latest/bin" "$HOME/.local/share/mise/installs/claude/latest"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
T="$HOME/.cache/root-sim/$RUN"

echo "== build check $(date +%T)"
[ -f "$ROOT/branch/.next/BUILD_ID" ] || { echo "build the app first (npm run build in $ROOT/branch)"; echo "== VERIFY: RED"; exit 1; }
TWIN_TAP=${TWIN_TAP:-1}

echo "== twin up $(date +%T)"
bash "$HERE/twin-up.sh" "$RUN" || { echo "== VERIFY: RED (the twin did not come up)"; exit 1; }

cd "$ROOT/branch" || { echo "== VERIFY: RED"; exit 1; }
rc=0
echo "== twin suites (write, on the twin) $(date +%T)"
TMPDIR=$HOME/.cache/tmp PW_BASE_URL=http://127.0.0.1:8250 E2E_OC_URL=http://127.0.0.1:4250 TS_BRAIN=http://127.0.0.1:4250 \
  timeout 1200 npx playwright test e2e/list-order.spec.ts e2e/notify-per-session.spec.ts \
  --reporter=line --workers=1 || rc=1

echo "== live read-only suites (GET-only, on :8447) $(date +%T)"
LIVE_RC=0
TMPDIR=$HOME/.cache/tmp PW_BASE_URL=https://omarchy.tail5435b1.ts.net:8447 \
  timeout 900 npx playwright test e2e/who-wrote.spec.ts --grep @ro \
  --reporter=line --workers=1 2>/dev/null || LIVE_RC=$?
[ "$LIVE_RC" = 0 ] || echo "(no @ro suites on live, or they failed rc=$LIVE_RC — not fatal in phase 0)"

bash "$HERE/twin-up.sh" "$RUN" down
[ $rc = 0 ] && echo "== VERIFY: GREEN $(date +%T)" || echo "== VERIFY: RED (playwright exit $rc) $(date +%T)"
