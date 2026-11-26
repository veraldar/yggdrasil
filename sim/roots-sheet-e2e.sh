#!/usr/bin/env bash
# The roots sheet (E2 · the whole tree) on its own rig — never a live brain:
#   mock upstream → two brains, "home" and "lab" (static peers of each other, one peer token;
#   lab runs its own MAIN: YGG_ROOT_MAIN=1, YGG_HOME_ROOT=home) → this tree's app (next start,
#   BIFROST_AUTH=devices, one seeded device; roots.json names lab as a joined root) →
#   Playwright on a Pixel 7: branch/e2e/roots-sheet.spec.ts.
# Needs: root/target/release/yggdrasil and branch/.next (npm run build) of this tree.
# First, without a phone: a pending join survives two app restarts (joins-pending.json).
# Ports 18510-18520 (P3_PORT_BASE moves them). State under ~/.cache/p3-app-tmp (STATE=…).
# Stops only what it started, by PID. SHOTS=<dir> keeps the screenshots.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
B="$ROOT/branch"
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
P=${P3_PORT_BASE:-18510}
RIG_AUTH=${RIG_AUTH:-devices}
MOCK=$P HOMEP=$((P + 1)) LABP=$((P + 2)) APP_IN=$((P + 9)) APP=$((P + 10))
STATE=${STATE:-$HOME/.cache/p3-app-tmp/roots-sheet}
SHOTS=${SHOTS:-$STATE/shots}
rm -rf "$STATE" && mkdir -p "$STATE"/{home,lab}/work "$STATE"/{stub,app} "$SHOTS"

pids=()
stop() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap stop EXIT

# the brains read each harness's model list at start (`opencode models`, `codex debug models`):
# stand-ins that answer nothing, so no harness process outlives the rig
for h in opencode codex claude; do printf '#!/bin/sh\nexit 1\n' >"$STATE/stub/$h"; chmod +x "$STATE/stub/$h"; done
RPATH="$STATE/stub:$PATH"

PEER=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK" >"$STATE/mock.log" 2>&1 &
pids+=($!)

brain() { # name port peers [extra env…]
  local n=$1 port=$2 peers=$3
  shift 3
  env -i PATH="$RPATH" HOME="$STATE/$n" YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK" \
    YGG_UPSTREAM_STYLE=anthropic YGG_UPSTREAM_API_KEY=mock YGG_UPSTREAM_MODEL=mock \
    YGG_PROVIDERS="$STATE/$n/none.json" YGG_PROFILES="$STATE/$n/agents.json" \
    YGG_ARTIFACTS_DIR="$STATE/$n/artifacts" YGG_DATA_DIR="$STATE/$n/data" YGG_PROJECT_DIR="$STATE/$n/work" \
    YGG_LISTEN="127.0.0.1:$port" YGG_ROOT_NAME="$n" YGG_PEER_TOKEN="$PEER" YGG_PEERS="$peers" "$@" \
    "$YGG_BIN" >"$STATE/$n.log" 2>&1 &
  pids+=($!)
}
brain home "$HOMEP" "lab=http://127.0.0.1:$LABP"
brain lab "$LABP" "home=http://127.0.0.1:$HOMEP" YGG_ROOT_MAIN=1 YGG_HOME_ROOT=home

if [ "$RIG_AUTH" = trunk ]; then
  # v1 trunk mode: seeded trunk-state.json + stand-in trunk front (sim/acceptance/trunk-seed.mjs)
  node "$ROOT/sim/acceptance/trunk-seed.mjs" init "$STATE" --root-name home --trunk-url "http://127.0.0.1:$APP" >/dev/null
  TOKEN=$(node "$ROOT/sim/acceptance/trunk-seed.mjs" mint "$STATE" --did dev_e2e0root --ip 203.0.113.7 --role admin)
  cat >"$STATE/me-roots.json" <<'JSON'
[
  {"id":"rt_home","name":"home","online":true,"has_app":true,"has_voice":false,"dtls_fp":"","door":true},
  {"id":"rt_lab","name":"lab","online":true,"has_app":false,"has_voice":false,"dtls_fp":"","door":false}
]
JSON
  APP_PORT=$APP_IN
else
  # one paired phone (devices.json: an access token for its region — server.mjs stamps the peer: loopback),
  # and lab as a root this hub joined (roots.json — the remove marks it revoked)
  TOKEN=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
  python3 - "$STATE" "$TOKEN" <<'PY'
import hashlib, json, os, sys, time
state, tok = sys.argv[1], sys.argv[2]
now = int(time.time() * 1000)
far = now + 7 * 86400_000
iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
h = lambda s: hashlib.sha256(s.encode()).hexdigest()
dev = {"id": "dev_e2e0root", "name": "pixel", "created": iso, "revoked": False, "region": "loopback",
       "lastRegion": "loopback", "regionChanges": 0, "lastSeen": iso, "refreshHash": h("refresh-" + tok),
       "refreshExp": far, "prevRefresh": [], "access": [{"hash": h(tok), "exp": far, "region": "loopback"}],
       "roots": ["lab"]}
for name, body in (("devices.json", {"version": 2, "killEpoch": 0, "devices": [dev], "codes": []}),
                   ("roots.json", {"version": 1, "roots": [{"id": "lab", "name": "lab", "os": "linux",
                    "host": "lab.local", "joined_at": iso, "dev": dev["id"], "secretHash": h("root-" + tok),
                    "delivered_at": iso}]})):
    p = os.path.join(state, name)
    with open(p, "w") as f:
        json.dump(body, f, indent=2)
    os.chmod(p, 0o600)
PY
  APP_PORT=$APP
fi

app_up() { # (re)start the app; its PID in $APP_PID
  if [ "$RIG_AUTH" = trunk ]; then
    (
      cd "$B"
      exec env -i PATH="$PATH" HOME="$STATE/app" NODE_ENV=production \
        BIFROST_AUTH=trunk BIFROST_TRUNK_STATE="$STATE/trunk-state.json" \
        BIFROST_TRUNK_URL="http://127.0.0.1:$APP" BIFROST_TRUST_PROXY=1 \
        BIFROST_MAIN_TITLE='[MAIN]' OPENCODE_URL="http://127.0.0.1:$HOMEP" \
        ARTIFACTS_DIR="$STATE/artifacts-app" ARTIFACTS_MAIN_DIR= YGG_PEER_TOKEN="$PEER" \
        PORT="$APP_PORT" HOST=127.0.0.1 node server.mjs
    ) >>"$STATE/app.log" 2>&1 &
  else
    (
      cd "$B"
      exec env -i PATH="$PATH" HOME="$STATE/app" NODE_ENV=production \
        BIFROST_AUTH=devices BIFROST_DEVICES_FILE="$STATE/devices.json" \
        BIFROST_MAIN_TITLE='[MAIN]' OPENCODE_URL="http://127.0.0.1:$HOMEP" \
        ARTIFACTS_DIR="$STATE/artifacts-app" ARTIFACTS_MAIN_DIR= YGG_PEER_TOKEN="$PEER" \
        PORT="$APP_PORT" HOST=127.0.0.1 node server.mjs
    ) >>"$STATE/app.log" 2>&1 &
  fi
  APP_PID=$!
  pids+=("$APP_PID")
  for _ in $(seq 60); do
    curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/" | grep -qE '^(200|302|307)$' && return 0
    sleep 0.5
  done
  echo "the app did not come up — $STATE/app.log" >&2
  return 1
}
app_up
if [ "$RIG_AUTH" = trunk ]; then
  node "$ROOT/sim/acceptance/trunk-seed.mjs" front "$STATE" --port "$APP" --app "http://127.0.0.1:$APP_PORT" \
    --client-ip 203.0.113.7 --sign-in cookie >>"$STATE/front.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 40); do
    curl -sf -o /dev/null "http://127.0.0.1:$APP/t/state" && break
    sleep 0.25
  done
fi

up=0
for _ in $(seq 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$HOMEP/root" && curl -sf -o /dev/null "http://127.0.0.1:$LABP/root"; then
    up=1
    break
  fi
  sleep 1
done
[ "$up" = 1 ] || { echo "rig not up — logs in $STATE" >&2; tail -3 "$STATE"/*.log >&2; exit 1; }

A="http://127.0.0.1:$APP"
CK="Cookie: bifrost_device=$TOKEN"
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got $2, want $3" >&2; exit 1; fi; }
if [ "$RIG_AUTH" = trunk ]; then
  check "trunk-state.json mode" "$(stat -c %a "$STATE/trunk-state.json")" 600
  check "v1 never writes devices.json" "$([ -e "$STATE/devices.json" ] && echo yes || echo no)" no
  check "v1 /api/roots/join moved to trunk (404)" "$(curl -s -o /dev/null -w '%{http_code}' -H "$CK" "$A/api/roots/join")" 404
  check "unauthenticated /api/roots gets 401" "$(curl -s -o /dev/null -w '%{http_code}' "$A/api/roots")" 401
  check "authenticated /api/roots gets 200" "$(curl -s -o /dev/null -w '%{http_code}' -H "$CK" "$A/api/roots")" 200
else
  # ---- pending joins outlive an app restart (joins-pending.json: mode 600, no raw secret) ----
  J=$(curl -sf -X POST -H 'Content-Type: application/json' -d '{"name":"mac","os":"macos","host":"mac.local"}' "$A/api/roots/join")
  REQ=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["req"])' <<<"$J")
  SEC=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["secret"])' <<<"$J")
  for _ in $(seq 20); do [ -f "$STATE/joins-pending.json" ] && break; sleep 0.2; done
  check "joins-pending.json mode" "$(stat -c %a "$STATE/joins-pending.json")" 600
  check "joins-pending.json holds no raw join secret" "$(grep -c "$SEC" "$STATE/joins-pending.json" || true)" 0
  kill "$APP_PID"; wait "$APP_PID" 2>/dev/null || true
  app_up
  check "after a restart the joiner still polls pending" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H "x-join-secret: $SEC" "$A/api/roots/join/$REQ")" 202
  check "after a restart the phone still sees it pending" \
    "$(curl -s -H "$CK" "$A/api/roots/join/$REQ/view" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" pending
  check "it can still be refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$CK" "$A/api/roots/join/$REQ/refuse")" 200
  kill "$APP_PID"; wait "$APP_PID" 2>/dev/null || true
  app_up
  check "a refusal outlives a restart too" \
    "$(curl -s -H "x-join-secret: $SEC" "$A/api/roots/join/$REQ" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" refused
  check "the console (no device) gets a plain 403 from /api/roots, not a pairing 401" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$A/api/roots")" 403
fi

# ---- the phone ----
cd "$B"
PW_BASE_URL="$A" PW_HOME_BRAIN="http://127.0.0.1:$HOMEP" PW_LAB_BRAIN="http://127.0.0.1:$LABP" \
  PW_DEVICE_TOKEN="$TOKEN" PW_RIG_STATE="$STATE" PW_SHOTS="$SHOTS" E2E_OC_URL="http://127.0.0.1:$HOMEP" \
  PW_TRUNK_AUTH="$( [ "$RIG_AUTH" = trunk ] && echo 1 || echo 0 )" \
  npx playwright test -c playwright.roots-sheet.config.ts "$@"
