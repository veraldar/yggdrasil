#!/usr/bin/env bash
# The "not up to date" marker (root updates, stage 1) on its own rig — never a live brain:
#   mock upstream → three brains: "home" and "lab" on this tree's brain, "old" on an OLDER brain
#   (OLD_BIN, default the 11-23 20:04 release: it reports no build) — static peers, one peer token →
#   this tree's app (next start, BIFROST_AUTH=devices, one seeded device; roots.json names lab and
#   old as joined roots) → Playwright at 360×780 Android touch: branch/e2e/root-behind.spec.ts.
#   It checks: home's GET /root reports its build; old is behind, lab is not; the row says
#   "not up to date" in --oz-active and the roots key has the mark (the home screen and a root's own
#   page: one header, HomeHead); old stops →
#   it is off and keeps the marker.
# Needs: root/target/release/yggdrasil and branch/.next (npm run build) of this tree.
# Ports 18530-18540 (P3_PORT_BASE moves them; a port already taken stops the run). State under ~/.cache/p3-app-tmp/root-behind (STATE=…).
# Stops only what it started, by PID. SHOTS=<dir> keeps the screenshots.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
B="$ROOT/branch"
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
OLD_BIN=${OLD_BIN:-$HOME/.local/share/yggdrasil/hub/releases/20261123-2004-2044afb1/bin/yggdrasil}
P=${P3_PORT_BASE:-18530}
MOCK=$P HOMEP=$((P + 1)) LABP=$((P + 2)) OLDP=$((P + 3)) APP=$((P + 10))
for p in "$MOCK" "$HOMEP" "$LABP" "$OLDP" "$APP"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "port $p is taken — another rig runs there (P3_PORT_BASE=… moves this one)" >&2
    exit 1
  fi
done
STATE=${STATE:-$HOME/.cache/p3-app-tmp/root-behind}
SHOTS=${SHOTS:-$STATE/shots}
rm -rf "$STATE" && mkdir -p "$STATE"/{home,lab,old}/work "$STATE"/{stub,app,bin} "$SHOTS"
# the older brain runs from a copy (a release folder may be pruned while the rig runs)
install -m755 "$OLD_BIN" "$STATE/bin/yggdrasil-old"

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

brain() { # bin name port peers [extra env…]
  local bin=$1 n=$2 port=$3 peers=$4
  shift 4
  env -i PATH="$RPATH" HOME="$STATE/$n" YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK" \
    YGG_UPSTREAM_STYLE=anthropic YGG_UPSTREAM_API_KEY=mock YGG_UPSTREAM_MODEL=mock \
    YGG_PROVIDERS="$STATE/$n/none.json" YGG_PROFILES="$STATE/$n/agents.json" \
    YGG_ARTIFACTS_DIR="$STATE/$n/artifacts" YGG_DATA_DIR="$STATE/$n/data" YGG_PROJECT_DIR="$STATE/$n/work" \
    YGG_LISTEN="127.0.0.1:$port" YGG_ROOT_NAME="$n" YGG_PEER_TOKEN="$PEER" YGG_PEERS="$peers" "$@" \
    "$bin" >"$STATE/$n.log" 2>&1 &
  pids+=($!)
  LAST_PID=$!
}
brain "$YGG_BIN" home "$HOMEP" "lab=http://127.0.0.1:$LABP,old=http://127.0.0.1:$OLDP"
brain "$YGG_BIN" lab "$LABP" "home=http://127.0.0.1:$HOMEP" YGG_ROOT_MAIN=1 YGG_HOME_ROOT=home
brain "$STATE/bin/yggdrasil-old" old "$OLDP" "home=http://127.0.0.1:$HOMEP" YGG_ROOT_MAIN=1 YGG_HOME_ROOT=home
OLD_PID=$LAST_PID

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
       "roots": ["lab", "old"]}
for name, body in (("devices.json", {"version": 2, "killEpoch": 0, "devices": [dev], "codes": []}),
                   ("roots.json", {"version": 1, "roots": [{"id": n, "name": n, "os": "linux",
                    "host": n + ".local", "joined_at": iso, "dev": dev["id"], "secretHash": h(n + "-root-" + tok),
                    "delivered_at": iso} for n in ("lab", "old")]})):
    p = os.path.join(state, name)
    with open(p, "w") as f:
        json.dump(body, f, indent=2)
    os.chmod(p, 0o600)
PY

app_up() { # (re)start the app; its PID in $APP_PID
  (
    cd "$B"
    exec env -i PATH="$PATH" HOME="$STATE/app" NODE_ENV=production \
      BIFROST_AUTH=devices BIFROST_DEVICES_FILE="$STATE/devices.json" \
      BIFROST_MAIN_TITLE='[MAIN]' OPENCODE_URL="http://127.0.0.1:$HOMEP" \
      ARTIFACTS_DIR="$STATE/artifacts-app" ARTIFACTS_MAIN_DIR= YGG_PEER_TOKEN="$PEER" \
      PORT="$APP" HOST=127.0.0.1 node server.mjs
  ) >>"$STATE/app.log" 2>&1 &
  APP_PID=$!
  pids+=("$APP_PID")
  for _ in $(seq 60); do
    curl -sf -o /dev/null "http://127.0.0.1:$APP/" && return 0
    sleep 0.5
  done
  echo "the app did not come up — $STATE/app.log" >&2
  return 1
}
app_up

up=0
for _ in $(seq 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$HOMEP/root" && curl -sf -o /dev/null "http://127.0.0.1:$LABP/root" &&
    curl -sf -o /dev/null "http://127.0.0.1:$OLDP/root"; then
    up=1
    break
  fi
  sleep 1
done
[ "$up" = 1 ] || { echo "rig not up — logs in $STATE" >&2; tail -3 "$STATE"/*.log >&2; exit 1; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got $2, want $3" >&2; exit 1; fi; }
check "the older brain reports no build" "$(curl -s "http://127.0.0.1:$OLDP/root" | python3 -c 'import json,sys; print("build" in json.load(sys.stdin))')" False

# ---- the phone ----
cd "$B"
PW_BASE_URL="http://127.0.0.1:$APP" PW_HOME_BRAIN="http://127.0.0.1:$HOMEP" PW_LAB_BRAIN="http://127.0.0.1:$LABP" \
  PW_OLD_BRAIN="http://127.0.0.1:$OLDP" PW_OLD_PID="$OLD_PID" PW_YGG_BIN="$YGG_BIN" \
  PW_DEVICE_TOKEN="$TOKEN" PW_RIG_STATE="$STATE" PW_SHOTS="$SHOTS" \
  npx playwright test -c playwright.root-behind.config.ts "$@"
