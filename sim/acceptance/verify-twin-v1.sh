#!/usr/bin/env bash
# verify-twin-v1.sh — G2.4 runner for v1 (TWIN_AUTH=trunk, VERIFY_LIVE=0).
# Never touches the live :8447 brain or app. Does NOT take twin.lock itself (callers such as
# sim/v1-ladder.sh already hold ~/.cache/trunk-v1/twin.lock; wrap with flock when running by hand).
#
# Runs:
#   1. Fresh door pass (TWIN_SEED_MAIN=0, TWIN_LIVEKIT=1): e2e/tree-first.spec.ts
#   2. Main pass (TWIN_SEED_MAIN=1, TWIN_LIVEKIT=1): the §9 G2.4 session-page set +
#      the v1 specs (pin-state-place, trunk-auth, trunk-ui, trunk-pin, trunk-model).
set -uo pipefail

RUN=${1:-v1g24}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
for d in "$HOME/.local/bin" "$HOME/.local/share/mise/installs/node/latest/bin" "$HOME/.local/share/mise/installs/claude/latest"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export TMPDIR=${VERIFY_TMPDIR:-$HOME/.cache/trunk-v1/tmp/app}
mkdir -p "$TMPDIR"

[ -f "$ROOT/branch/.next/BUILD_ID" ] || { echo "build the app first (npm run build in $ROOT/branch)"; exit 1; }

AUTH=${TWIN_AUTH:-trunk}
FRONT=${TWIN_FRONT_PORT:-19050}
BASE=http://127.0.0.1:8250
[ "$AUTH" = trunk ] && BASE="http://127.0.0.1:$FRONT"

OUT="$TMPDIR/verify-twin-v1-$RUN"
rm -rf "$OUT"
mkdir -p "$OUT"

DOOR_RUN="${RUN}-door"
MAIN_RUN="${RUN}-main"
MOCK_UNIT="acc-${RUN}-mock"

cleanup() {
  bash "$HERE/twin-up.sh" "$DOOR_RUN" down >/dev/null 2>&1 || true
  bash "$HERE/twin-up.sh" "$MAIN_RUN" down >/dev/null 2>&1 || true
  systemctl --user stop "$MOCK_UNIT" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$MOCK_UNIT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Self-contained mock upstream unless caller supplied SIM_UPSTREAM_BASE_URL (no live API quota needed)
if [ -z "${SIM_UPSTREAM_BASE_URL:-}" ] && [ -f "$ROOT/root/mock/mock_upstream.py" ]; then
  MOCK_PORT=""
  for cand in $(seq 19051 19059); do
    if ! ss -ltn 2>/dev/null | grep -qE "[:.]${cand}[[:space:]]"; then
      MOCK_PORT=$cand
      break
    fi
  done
  [ -n "$MOCK_PORT" ] || { echo "no free port in 19051-19059 for mock_upstream"; exit 1; }
  systemctl --user stop "$MOCK_UNIT" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$MOCK_UNIT" >/dev/null 2>&1 || true
  PY="${HOME}/.cache/root-sim/_venv/bin/python3"
  [ -x "$PY" ] || PY="$(command -v python3)"
  systemd-run --user --unit "$MOCK_UNIT" --collect -q \
    -p StandardOutput="append:$OUT/mock-upstream.log" -p StandardError="append:$OUT/mock-upstream.log" \
    "$PY" "$ROOT/root/mock/mock_upstream.py" "$MOCK_PORT" >/dev/null
  for _ in $(seq 1 40); do
    ss -ltn 2>/dev/null | grep -qE "[:.]${MOCK_PORT}[[:space:]]" && break
    sleep 0.1
  done
  export SIM_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK_PORT"
fi

export TWIN_AUTH="$AUTH" TWIN_FRONT_PORT="$FRONT" TWIN_LIVEKIT=1 TWIN_TAP=0 TWIN_HARNESS="${TWIN_HARNESS:-0}"
export TWIN_ARTIFACTS_DIR="$ROOT/artifacts" VERIFY_LIVE=0
export PW_BASE_URL="$BASE" E2E_OC_URL="http://127.0.0.1:4250" TS_BRAIN="http://127.0.0.1:4250" E2E_ARTIFACTS_DIR="$ROOT/artifacts"

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
OVERALL_RC=0

run_pw() {
  local name=$1; shift
  local jf="$OUT/$name.json"
  local lf="$OUT/$name.log"
  PLAYWRIGHT_JSON_OUTPUT_NAME="$jf" timeout 1800 npx playwright test "$@" --workers=1 --reporter=list,json >"$lf" 2>&1
  local rc=$?
  local stats
  stats=$(python3 - "$jf" <<'PY' 2>/dev/null || echo "0 0 0"
import json, sys
s = json.load(open(sys.argv[1])).get("stats", {})
print(s.get("expected", 0), s.get("unexpected", 0), s.get("skipped", 0))
PY
)
  local p f sk
  read -r p f sk <<<"$stats"
  TOTAL_PASS=$((TOTAL_PASS + p))
  TOTAL_FAIL=$((TOTAL_FAIL + f))
  TOTAL_SKIP=$((TOTAL_SKIP + sk))
  printf "  %-28s rc=%-2d  passed=%-3d failed=%-3d skipped=%-3d\n" "$name" "$rc" "$p" "$f" "$sk"
  if [ "$rc" -ne 0 ]; then
    OVERALL_RC=1
  fi
}

cd "$ROOT/branch" || exit 1

echo "== $(date +%T) verify-twin-v1 ($AUTH, livekit=1) — pass 1: fresh door (tree-first)"
rm -rf "$HOME/.cache/root-sim/acc-$DOOR_RUN"
TWIN_SEED_MAIN=0 bash "$HERE/twin-up.sh" "$DOOR_RUN" >"$OUT/door-up.log" 2>&1 || {
  echo "door twin up failed:"; tail -20 "$OUT/door-up.log"; exit 1
}
run_pw tree-first -c playwright.tree-first.config.ts e2e/tree-first.spec.ts
bash "$HERE/twin-up.sh" "$DOOR_RUN" down >/dev/null 2>&1 || true

echo "== $(date +%T) verify-twin-v1 ($AUTH, livekit=1) — pass 2: G2.4 session-page set + v1 specs"
rm -rf "$HOME/.cache/root-sim/acc-$MAIN_RUN"
TWIN_SEED_MAIN=1 bash "$HERE/twin-up.sh" "$MAIN_RUN" >"$OUT/main-up.log" 2>&1 || {
  echo "main twin up failed:"; tail -20 "$OUT/main-up.log"; exit 1
}
curl -s -m 10 -X POST http://127.0.0.1:4250/session -H 'content-type: application/json' -d '{"title":"seed-row"}' >/dev/null || true

SET="base history states chat-files queue subs settings-truth roles-badges artifacts autoscroll-read-position list-order notify-per-session"
for s in $SET; do
  run_pw "$s" "e2e/$s.spec.ts"
done
run_pw engines-into-settings -c playwright.engines-into-settings.config.ts e2e/engines-into-settings.spec.ts
run_pw root-detail -c playwright.root-detail.config.ts e2e/root-detail.spec.ts
run_pw md-page -c playwright.md-page.config.ts e2e/md-page.spec.ts
run_pw artifact-preview-open-tab -c playwright.artifact-preview.config.ts e2e/artifact-preview-open-tab.spec.ts
run_pw held-reply -c playwright.held.config.ts e2e/held-reply.spec.ts

# v1 proofs (trunk-model runs last because it restarts the twin brain with a test model)
run_pw pin-state-place e2e/pin-state-place.spec.ts
[ "$AUTH" = trunk ] && run_pw trunk-auth e2e/trunk-auth.spec.ts
run_pw trunk-ui e2e/trunk-ui.spec.ts
run_pw trunk-pin e2e/trunk-pin.spec.ts
if [ "$AUTH" = trunk ]; then
  E2E_BRAIN_ENV_FILE="$HOME/.cache/root-sim/acc-$MAIN_RUN/yggdrasil.env" \
  E2E_BRAIN_LOG="$HOME/.cache/root-sim/acc-$MAIN_RUN/brain.log" \
    run_pw trunk-model e2e/trunk-model.spec.ts
fi

bash "$HERE/twin-up.sh" "$MAIN_RUN" down >/dev/null 2>&1 || true

echo "== $(date +%T) summary (logs: $OUT)"
echo "  ${TOTAL_PASS} passed, ${TOTAL_FAIL} failed, ${TOTAL_SKIP} skipped"
[ "$OVERALL_RC" -eq 0 ] && echo "== VERIFY-V1: GREEN $(date +%T)" || echo "== VERIFY-V1: RED $(date +%T)"
exit "$OVERALL_RC"
