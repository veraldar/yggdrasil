#!/usr/bin/env bash
# trunk-v1-e2e.sh — G3.6: the trunk v1 storyboard end to end (spec §9 G3.6, 15 steps),
# in private namespaces (unshare --user --map-root-user --net --mount --pid --fork --mount-proc).
# Phone = Playwright Chromium Pixel 7 (360 px). Uses the real pieces on trunk-v1:
#   bifrost-net trunk (TRUNK_TEST_FAST=1), trunk-ctl, bridges in [trunk] mode,
#   bifrost-net wg with trunk_state, real yggdrasil brains on mock_upstream.py,
#   real app (node server.mjs, BIFROST_AUTH=trunk).
#
# Steps whose feature is not merged yet report MISSING (never PASS, never SKIP) and exit 1
# so G3.6 stays RED until IDP M3 and WIRE M5 land.
#
#   sim/trunk-v1-e2e.sh        exit 0 = all 15 steps PASS; exit 1 = any FAIL or MISSING
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${TRUNK_V1_NS:-}" ]; then
  exec unshare --user --map-root-user --net --mount --pid --fork --mount-proc \
    env TRUNK_V1_NS=1 "$0" "$@"
fi

BIN=${BIFROST_NET_BIN:-$ROOT/trunk/target/release/bifrost-net}
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
B=${APP_DIR:-$ROOT/branch}
[ -x "$BIN" ] || { echo "build the trunk first: (cd trunk && cargo build --release)"; exit 2; }
[ -x "$YGG_BIN" ] || { echo "build the brain first: (cd root && cargo build --release)"; exit 2; }
[ -f "$B/.next/BUILD_ID" ] || { echo "build the app first: (cd branch && npm run build)"; exit 2; }

ip link set lo up
ip link add wan0 type dummy && ip addr add 198.51.100.7/24 dev wan0 && ip link set wan0 up
ip link add far0 type dummy && ip addr add 203.0.113.9/24 dev far0 && ip link set far0 up
TRUNK_IP=198.51.100.7
TRUNK_HOST=ljoolq.tree.test
TRUNK_PORT=18780
ICE_PORT=18781
MOCK_PORT=18782
TRUNK_URL="http://$TRUNK_HOST:$TRUNK_PORT"

BASE_TMP=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ladder}
mkdir -p "$BASE_TMP"
STATE=${TRUNK_V1_STATE:-$(mktemp -d "$BASE_TMP/trunk-v1-e2e.XXXXXX")}
mkdir -p "$STATE"/{trunk/cred,home/work,mac/work,lab/work} && chmod 700 "$STATE"
rm -f "$STATE/steps.tsv"
{ cat /etc/hosts; echo "$TRUNK_IP $TRUNK_HOST"; } >"$STATE/hosts"
mount --bind "$STATE/hosts" /etc/hosts

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  for pf in "$STATE"/*.pid; do [ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

# ---- mock upstream ----
python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK_PORT" >"$STATE/mock.log" 2>&1 &
pids+=($!)

# ---- v1 trunk (unclaimed at start — steps 1 & 2 claim it!) ----
"$BIN" trunk-kek "$STATE/trunk/cred/trunk-kek" >/dev/null
cat >"$STATE/trunk/trunk.toml" <<TOML
public_url = "$TRUNK_URL"
listen_http = "0.0.0.0:$TRUNK_PORT"
listen_ice = "0.0.0.0:$ICE_PORT"
trusted_proxies = ["127.0.0.1/32", "$TRUNK_IP/32"]
db = "$STATE/trunk/trunk.db"
state_dir = "$STATE/trunk"
cred_dir = "$STATE/trunk/cred"
ctl_socket = "$STATE/trunk/ctl.sock"
rp_id = "$TRUNK_HOST"
origins = ["$TRUNK_URL"]
ice_owner_from = ["127.0.0.1/32"]
TOML
chmod 600 "$STATE/trunk/trunk.toml"
TRUNK_TEST_FAST=1 "$BIN" trunk -c "$STATE/trunk/trunk.toml" >"$STATE/trunk.log" 2>&1 &
pids+=($!)

for _ in $(seq 60); do
  curl -sf "$TRUNK_URL/t/state" >/dev/null && break
  sleep 0.25
done
curl -sf "$TRUNK_URL/t/state" >/dev/null || { echo "v1 trunk did not start"; tail -20 "$STATE/trunk.log"; exit 1; }

# ---- run the storyboard spec ----
cd "$B"
set +e
PW_BASE_URL="$TRUNK_URL" PW_TRUNK_V1_STATE="$STATE" PW_TRUNK_BIN="$BIN" \
  PW_YGG_BIN="$YGG_BIN" PW_MOCK_PORT="$MOCK_PORT" PW_APP_DIR="$B" \
  npx playwright test e2e/trunk-v1.spec.ts --workers=1 --reporter=list >"$STATE/pw.log" 2>&1
pw_rc=$?
set -e

echo ""
printf '%-6s %-8s %s\n' "STEP" "RES" "WHAT"
fail=0
missing=0
if [ -f "$STATE/steps.tsv" ]; then
  while IFS=$'\t' read -r step res what; do
    printf '%-6s %-8s %s\n' "$step" "$res" "$what"
    case "$res" in
      PASS) ;;
      MISSING) missing=$((missing + 1)) ;;
      *) fail=$((fail + 1)) ;;
    esac
  done <"$STATE/steps.tsv"
else
  printf '%-6s %-8s %s\n' "S00" "FAIL" "no steps.tsv produced (pw_rc=$pw_rc)"
  tail -40 "$STATE/pw.log"
  fail=1
fi
echo ""
echo "TRUNK-V1 E2E: fail=$fail missing=$missing pw_rc=$pw_rc (state: $STATE)"
[ "$fail" -eq 0 ] && [ "$missing" -eq 0 ] && [ "$pw_rc" -eq 0 ]
