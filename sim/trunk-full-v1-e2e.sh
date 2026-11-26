#!/usr/bin/env bash
# trunk-full-v1-e2e.sh — G3.1 v1 port of sim/trunk-full-e2e.sh (+ --scenario s17).
# Runs the whole tree through a real v1 trunk (`bifrost-net trunk`) in private namespaces
# (unshare --user --map-root-user --net --mount --pid --fork --mount-proc):
#   - default: claim admin → enroll home/mac/lab via /t/roots/enroll → bridges [trunk] + wg
#     (trunk_state) → real brains on mock_upstream.py (per-root YGG_PEER_TOKEN) → phone (Pixel 7)
#     signs in → MAIN delegates to mac → mac delegates to lab → phone opens /roots/mac →
#     revoke lab cuts WG tunnel <= 1.5 s.
#   - --scenario s17: same v1 trunk + WireGuard world, real `claude` binary on lab pointed at
#     sim/reach/cc_model.py, phone attaches 6.4 MB PDF in composer → lab stores blob → Claude Code
#     reads it, replies with marker word, writes marker.html → phone opens artifact link.
#
# v0.9 sim/trunk-full-e2e.sh stays untouched for baselines.
#   sim/trunk-full-v1-e2e.sh [--scenario full|s17]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCENARIO=${TRUNK_FULL_SCENARIO:-full}
while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) SCENARIO=${2:?--scenario full|s17}; shift 2 ;;
    --scenario=*) SCENARIO=${1#*=}; shift ;;
    *) echo "usage: $0 [--scenario full|s17]"; exit 2 ;;
  esac
done
case "$SCENARIO" in full | s17) ;; *) echo "unknown scenario $SCENARIO (full|s17)"; exit 2 ;; esac
if [ -z "${TRUNK_FULL_V1_NS:-}" ]; then
  exec unshare --user --map-root-user --net --mount --pid --fork --mount-proc \
    env TRUNK_FULL_V1_NS=1 TRUNK_FULL_SCENARIO="$SCENARIO" "$0"
fi

for d in "$HOME/.local/bin" "$HOME/.local/share/mise/installs/node/latest/bin" "$HOME/.local/share/mise/installs/claude/latest"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
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
TRUNK_HOST=ap.tree.test
TRUNK_PORT=18750
ICE_PORT=18751
MOCK_PORT=18752
CCM_PORT=18753
LIB_PORT=18754
TRUNK_URL="http://127.0.0.1:$TRUNK_PORT"

BASE_TMP=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ladder}
mkdir -p "$BASE_TMP"
STATE=${TRUNK_FULL_STATE:-$(mktemp -d "$BASE_TMP/trunk-full-v1.XXXXXX")}
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
if [ "$SCENARIO" = s17 ]; then
  rm -f "$STATE/cc-model.log"
  python3 "$ROOT/sim/reach/cc_model.py" --port "$CCM_PORT" --log "$STATE/cc-model.log" >"$STATE/cc-model.err" 2>&1 &
  pids+=($!)
fi

# ---- v1 trunk ----
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
rp_id = "127.0.0.1"
origins = ["$TRUNK_URL"]
ice_owner_from = ["127.0.0.1/32"]
TOML
chmod 600 "$STATE/trunk/trunk.toml"
"$BIN" trunk -c "$STATE/trunk/trunk.toml" >"$STATE/trunk.log" 2>&1 &
pids+=($!)
for _ in $(seq 60); do curl -sf "$TRUNK_URL/t/state" >/dev/null && break; sleep 0.25; done

# ---- claim admin ----
python3 "$ROOT/sim/trunk-v1/claim-admin.py" \
  --url "$TRUNK_URL" --origin "$TRUNK_URL" \
  --ctl "$BIN trunk-ctl --sock $STATE/trunk/ctl.sock" \
  --email "owner@full-v1.test" >"$STATE/admin.json"
chmod 600 "$STATE/admin.json"

cd "$B"
set +e
PW_BASE_URL="$TRUNK_URL" PW_STATE="$STATE" PW_TRUNK_BIN="$BIN" PW_YGG_BIN="$YGG_BIN" \
  PW_MOCK_PORT="$MOCK_PORT" PW_CCM_PORT="$CCM_PORT" PW_LIB_PORT="$LIB_PORT" \
  PW_APP_DIR="$B" PW_SCENARIO="$SCENARIO" PW_REPO="$ROOT" \
  npx playwright test e2e/trunk-full-v1.spec.ts --workers=1 --reporter=list >"$STATE/pw.log" 2>&1
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
  printf '%-6s %-6s %s\n' "S00" "FAIL" "no steps recorded (pw exit $rc)"
  tail -40 "$STATE/pw.log"
  fails=1
fi
echo "state + logs: $STATE"
if [ "$rc" != 0 ] || [ "$fails" != 0 ]; then
  echo "TRUNK-FULL-V1[$SCENARIO]: RED ($fails failed, exit $rc)"
  exit 1
fi
echo "TRUNK-FULL-V1[$SCENARIO]: GREEN"
