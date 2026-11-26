#!/usr/bin/env bash
# v1 LADDER (G2.1) — the whole v1 box in a PRIVATE network namespace (unshare -rn):
# loopback + a dummy "LAN" 192.168.77.2/24, so nothing here can touch a host port or a live service.
#
#   mock upstream → yggdrasil (root/) → app (`node server.mjs`, BIFROST_AUTH=trunk)
#   → v1 bridge (`[trunk]`, trunk-state.json) → v1 trunk (`bifrost-net trunk`, TRUNK_TEST_FAST=1)
#   → playwright: e2e/v1-auth.spec.ts, e2e/signin-ladder.spec.ts, e2e/v1-bridge.spec.ts, e2e/enroll.spec.ts
#
#   scripts/v1-ladder.sh [spec...]          (BIFROST_NET_BIN overrides the trunk/bridge binary)
#
# Needs: branch built (npm run build), trunk/target/release/bifrost-net, root/target/release/yggdrasil,
# playwright's chromium. State + logs: V1_STATE (default: mktemp under $TMPDIR or ~/.cache/trunk-v1/tmp/ladder).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${V1_NETNS:-}" ]; then
  exec unshare -rn env V1_NETNS=1 "$0" "$@"
fi

BIN=${BIFROST_NET_BIN:-$ROOT/trunk/target/release/bifrost-net}
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
B=$ROOT/branch
[ -x "$BIN" ] || { echo "build the trunk first: (cd trunk && cargo build --release), or set BIFROST_NET_BIN"; exit 2; }
[ -x "$YGG_BIN" ] || { echo "build the brain first: (cd root && cargo build --release)"; exit 2; }
[ -f "$B/.next/BUILD_ID" ] || { echo "build the app first: (cd branch && npm run build)"; exit 2; }

ip link set lo up
ip link add d0 type dummy
ip addr add 192.168.77.2/24 dev d0
ip link set d0 up
LAN=192.168.77.2
TRUNK_PORT=18194 ICE_PORT=18193 APP=18195 YGG=18196 MOCK=18197 BR=18198 MEDIA=18199
BASE_TMP=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ladder}
mkdir -p "$BASE_TMP"
STATE=${V1_STATE:-$(mktemp -d "$BASE_TMP/v1-ladder.XXXXXX")}
mkdir -p "$STATE"/{trunk/cred,home/ygg,home/proj} && chmod 700 "$STATE"

TRUNK_URL="http://$LAN:$TRUNK_PORT"
TRUNK_LOCAL="http://127.0.0.1:$TRUNK_PORT"

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT

# ---- 1. mock upstream + v1 trunk ----
python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK" >"$STATE/mock.log" 2>&1 &
pids+=($!)

"$BIN" trunk-kek "$STATE/trunk/cred/trunk-kek" >/dev/null
cat >"$STATE/trunk/trunk.toml" <<TOML
public_url = "$TRUNK_URL"
listen_http = "0.0.0.0:$TRUNK_PORT"
listen_ice = "0.0.0.0:$ICE_PORT"
trusted_proxies = ["127.0.0.1/32", "$LAN/32"]
db = "$STATE/trunk/trunk.db"
state_dir = "$STATE/trunk"
cred_dir = "$STATE/trunk/cred"
ctl_socket = "$STATE/trunk/ctl.sock"
rp_id = "$LAN"
origins = ["$TRUNK_URL", "$TRUNK_LOCAL"]
ice_owner_from = ["127.0.0.1/32"]
TOML
chmod 600 "$STATE/trunk/trunk.toml"
TRUNK_TEST_FAST=1 "$BIN" trunk -c "$STATE/trunk/trunk.toml" >"$STATE/trunk.log" 2>&1 &
pids+=($!)

for _ in $(seq 60); do
  curl -sf "$TRUNK_LOCAL/t/state" >/dev/null && break
  sleep 0.25
done
curl -sf "$TRUNK_LOCAL/t/state" >/dev/null || { echo "v1 trunk did not start"; tail -20 "$STATE/trunk.log"; exit 1; }

# ---- 2. claim admin + enroll the box's home root ----
python3 "$ROOT/sim/trunk-v1/claim-admin.py" \
  --url "$TRUNK_URL" --origin "$TRUNK_URL" \
  --ctl "$BIN trunk-ctl --sock $STATE/trunk/ctl.sock" \
  --email "owner@ladder.test" >"$STATE/admin.json"
chmod 600 "$STATE/admin.json"

HOME_RK=$("$BIN" root-key "$STATE/home/root.key" | sed -n 's/^public_key = "\(.*\)"/\1/p')
HOME_WK=$("$BIN" wg-key "$STATE/home/wg.key" | sed -n 's/^public_key = "\(.*\)"/\1/p')
python3 - "$TRUNK_URL" "$STATE/admin.json" "$HOME_RK" "$HOME_WK" "$STATE/home/enrolled.json" <<'PY'
import json, sys, urllib.request
url, admin_path, rk, wk, out_path = sys.argv[1:6]
admin = json.load(open(admin_path))
hdr = {"content-type": "application/json", "origin": url, "cookie": "bifrost_device=" + admin["cookies"]["bifrost_device"]}
def post(path, body, h=None):
    req = urllib.request.Request(url + path, data=json.dumps(body).encode(), method="POST", headers=h or {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())
st = post("/t/roots/enroll", {"hostname": "ladder-box", "os": "linux", "arch": "x86_64", "root_pub": rk, "wg_pub": wk, "has_app": True, "has_voice": False})
post(f"/t/roots/enroll/{st['id']}/approve", {"name": "home"}, hdr)
res = post(f"/t/roots/enroll/{st['id']}/poll", {"secret": st["poll_secret"]})
assert res.get("status") == "approved", res
with open(out_path, "w") as f:
    json.dump(res, f, indent=2)
PY
HOME_ROOT_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["root_id"])' "$STATE/home/enrolled.json")
TRUNK_KEY=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["trunk"]["trunk_key"])' "$STATE/home/enrolled.json")
PEER_TOKEN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["peer_token"])' "$STATE/home/enrolled.json")

# ---- 3. brain + bridge [trunk] + app (BIFROST_AUTH=trunk) ----
env -i PATH="$PATH" HOME="$STATE/home" YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK/v1" \
  YGG_UPSTREAM_MODEL=mock YGG_UPSTREAM_API_KEY=mock-key YGG_CATALOG="$ROOT/root/fixtures/catalog.json" \
  YGG_PROVIDERS="$STATE/home/none.json" YGG_DATA_DIR="$STATE/home/ygg" YGG_PROJECT_DIR="$STATE/home/proj" \
  YGG_ARTIFACTS_DIR="$STATE/home/artifacts" YGG_LISTEN="127.0.0.1:$YGG" YGG_PEER_TOKEN="$PEER_TOKEN" \
  YGG_ROOT_NAME="$HOME_ROOT_ID" "$YGG_BIN" >"$STATE/ygg.log" 2>&1 &
pids+=($!)

PRIV=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
cat >"$STATE/home/bridge.toml" <<TOML
[node]
name = "ladder-box"
private_key = "$PRIV"

[bridge]
http = "0.0.0.0:$BR"
media = "$LAN:$MEDIA"
tokens_file = "$STATE/home/devices.json"
opencode_url = "http://127.0.0.1:$YGG"
candidates = ["$LAN"]
dtls_cert_file = "$STATE/home/bridge-dtls.json"

[trunk]
url = "$TRUNK_LOCAL"
trunk_key = "$TRUNK_KEY"
root_key_file = "$STATE/home/root.key"
root_id = "$HOME_ROOT_ID"
state_file = "$STATE/home/trunk-state.json"
upstream = "127.0.0.1:$APP"
ice_tcp = []
TOML
chmod 600 "$STATE/home/bridge.toml"
"$BIN" bridge -c "$STATE/home/bridge.toml" >"$STATE/bridge.log" 2>&1 &
pids+=($!)

for _ in $(seq 60); do
  [ -f "$STATE/home/trunk-state.json" ] && grep -q '"state": "up"' "$STATE/home/trunk-state.json" 2>/dev/null && break
  sleep 0.25
done

(
  cd "$B"
  exec env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
    BIFROST_AUTH=trunk BIFROST_TRUNK_STATE="$STATE/home/trunk-state.json" \
    BIFROST_TRUNK_URL="$TRUNK_URL" BIFROST_TRUST_PROXY=1 \
    BIFROST_MAIN_TITLE=e2e-ladder-main OPENCODE_URL="http://127.0.0.1:$YGG" \
    ARTIFACTS_DIR="$STATE/artifacts-app" ARTIFACTS_MAIN_DIR= \
    YGG_PEER_TOKEN="$PEER_TOKEN" PORT="$APP" HOST=127.0.0.1 \
    node server.mjs
) >"$STATE/app.log" 2>&1 &
pids+=($!)

for _ in $(seq 90); do
  curl -sf "http://127.0.0.1:$BR/identity" >/dev/null &&
    curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP/api/build" | grep -qE '^(200|401)$' &&
    curl -sf -o /dev/null "http://127.0.0.1:$YGG/session" && break
  sleep 0.5
done
echo "v1 box up: trunk $TRUNK_URL · app :$APP · brain :$YGG · root $HOME_ROOT_ID"

cd "$B"
SPECS=("$@")
[ ${#SPECS[@]} -gt 0 ] || SPECS=(e2e/v1-auth.spec.ts e2e/signin-ladder.spec.ts e2e/v1-bridge.spec.ts e2e/enroll.spec.ts)
set +e
PW_BASE_URL="$TRUNK_URL" PW_LOCAL_TRUNK="$TRUNK_LOCAL" PW_LAN_URL="$TRUNK_URL" \
  PW_V1_STATE="$STATE" PW_TRUNK_BIN="$BIN" PW_MAIN_SLUG=e2e-ladder-main \
  PW_BRIDGE_URL="http://$LAN:$BR" PW_HOME_ROOT_ID="$HOME_ROOT_ID" \
  npx playwright test "${SPECS[@]}" --workers=1 2>&1 | tee "$STATE/e2e.log"
rc=${PIPESTATUS[0]}
echo "trunk-state.json mode: $(stat -c %a "$STATE/home/trunk-state.json") · v0.9 devices.json present: $([ -e "$STATE/home/devices.json" ] && echo yes || echo no)"
echo "state + logs: $STATE"
exit "$rc"
