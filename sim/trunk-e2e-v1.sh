#!/usr/bin/env bash
# trunk-e2e-v1.sh — G3.3 v1 port of sim/trunk-e2e.sh: three roots (home, mac, lab) behind a real
# v1 trunk in private namespaces, using the root build (ROOT_NET_BIN) for mac & lab, WireGuard
# from trunk-state.json, and per-root peer tokens (curing M0 F3).
# v0.9 sim/trunk-e2e.sh stays untouched for baselines.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${TRUNK_E2E_V1_NS:-}" ]; then
  exec unshare --user --map-root-user --net --mount --pid --fork --mount-proc \
    env TRUNK_E2E_V1_NS=1 "$0" "$@"
fi

BIN=${BIFROST_NET_BIN:-$ROOT/trunk/target/release/bifrost-net}
ROOT_BIN=${ROOT_NET_BIN:-$ROOT/trunk/target/root/release/bifrost-net}
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
B=${APP_DIR:-$ROOT/branch}
[ -x "$BIN" ] || { echo "build the trunk first: (cd trunk && cargo build --release)"; exit 2; }
[ -x "$ROOT_BIN" ] || ROOT_BIN="$BIN"
[ -x "$YGG_BIN" ] || { echo "build the brain first: (cd root && cargo build --release)"; exit 2; }
[ -f "$B/.next/BUILD_ID" ] || { echo "build the app first: (cd branch && npm run build)"; exit 2; }

ip link set lo up
ip link add wan0 type dummy && ip addr add 198.51.100.7/24 dev wan0 && ip link set wan0 up
TRUNK_IP=198.51.100.7
TRUNK_HOST=ap.tree.test
TRUNK_PORT=18735
ICE_PORT=18736
MOCK_PORT=18737
TRUNK_URL="http://$TRUNK_HOST:$TRUNK_PORT"

BASE_TMP=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ladder}
mkdir -p "$BASE_TMP"
STATE=${TRUNK_E2E_STATE:-$(mktemp -d "$BASE_TMP/trunk-e2e-v1.XXXXXX")}
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

python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK_PORT" >"$STATE/mock.log" 2>&1 &
pids+=($!)

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
for _ in $(seq 60); do curl -sf "$TRUNK_URL/t/state" >/dev/null && break; sleep 0.25; done

python3 "$ROOT/sim/trunk-v1/claim-admin.py" \
  --url "$TRUNK_URL" --origin "$TRUNK_URL" \
  --ctl "$BIN trunk-ctl --sock $STATE/trunk/ctl.sock" \
  --email "owner@e2e-v1.test" >"$STATE/admin.json"
chmod 600 "$STATE/admin.json"

cd "$B"
set +e
PW_BASE_URL="$TRUNK_URL" PW_STATE="$STATE" PW_TRUNK_BIN="$BIN" PW_ROOT_BIN="$ROOT_BIN" \
  PW_YGG_BIN="$YGG_BIN" PW_MOCK_PORT="$MOCK_PORT" PW_APP_DIR="$B" \
  npx playwright test e2e/trunk-e2e-v1.spec.ts --workers=1 --reporter=list >"$STATE/pw.log" 2>&1
rc=$?
set -e

echo ""
printf '%-6s %-6s %s\n' "STEP" "RES" "WHAT"
fails=0
if [ -s "$STATE/steps.tsv" ]; then
  while IFS=$'\t' read -r n res what; do
    printf '%-6s %-6s %s\n' "$n" "$res" "$what"
    [ "$res" = PASS ] || fails=$((fails + 1))
  done <"$STATE/steps.tsv"
else
  printf '%-6s %-6s %s\n' "W0" "FAIL" "no steps recorded (exit $rc)"
  tail -40 "$STATE/pw.log"
  fails=1
fi
echo "state + logs: $STATE"
[ "$rc" -eq 0 ] && [ "$fails" -eq 0 ]
