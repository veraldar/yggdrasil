#!/usr/bin/env bash
# The roots sheet (E2 · the whole tree) on its own rig — never a live brain:
#   mock upstream → two brains, "home" and "lab" (static peers of each other, one peer token;
#   lab runs its own MAIN: YGG_ROOT_MAIN=1, YGG_HOME_ROOT=home) → this tree's app (next start,
#   BIFROST_AUTH=devices, one seeded device; roots.json names lab as a joined root) →
#   Playwright on a Pixel 7: branch/e2e/roots-sheet.spec.ts.
# Needs: root/target/release/yggdrasil and branch/.next (npm run build) of this tree.
# Ports 18510-18520 (P3_PORT_BASE moves them). State under ~/.cache/p3-app-tmp (STATE=…).
# Stops only what it started, by PID. SHOTS=<dir> keeps the screenshots.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
B="$ROOT/branch"
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
P=${P3_PORT_BASE:-18510}
MOCK=$P HOMEP=$((P + 1)) LABP=$((P + 2)) APP=$((P + 10))
STATE=${STATE:-$HOME/.cache/p3-app-tmp/roots-sheet}
SHOTS=${SHOTS:-$STATE/shots}
rm -rf "$STATE" && mkdir -p "$STATE"/{home,lab,stub,app} "$SHOTS"

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

# one paired phone (devices.json: an access token for the region `next start` sees, "unknown"),
# and lab as a root this hub joined (roots.json — the remove marks it revoked)
TOKEN=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
python3 - "$STATE" "$TOKEN" <<'PY'
import hashlib, json, os, sys, time
state, tok = sys.argv[1], sys.argv[2]
now = int(time.time() * 1000)
far = now + 7 * 86400_000
iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
h = lambda s: hashlib.sha256(s.encode()).hexdigest()
dev = {"id": "dev_e2e0root", "name": "pixel", "created": iso, "revoked": False, "region": "unknown",
       "lastRegion": "unknown", "regionChanges": 0, "lastSeen": iso, "refreshHash": h("refresh-" + tok),
       "refreshExp": far, "prevRefresh": [], "access": [{"hash": h(tok), "exp": far, "region": "unknown"}],
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

(
  cd "$B"
  exec env -i PATH="$PATH" HOME="$STATE/app" NODE_ENV=production \
    BIFROST_AUTH=devices BIFROST_DEVICES_FILE="$STATE/devices.json" \
    BIFROST_MAIN_TITLE='[MAIN]' OPENCODE_URL="http://127.0.0.1:$HOMEP" \
    ARTIFACTS_DIR="$STATE/artifacts-app" ARTIFACTS_MAIN_DIR= YGG_PEER_TOKEN="$PEER" \
    node node_modules/next/dist/bin/next start -p "$APP" -H 127.0.0.1
) >"$STATE/app.log" 2>&1 &
pids+=($!)

for _ in $(seq 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$HOMEP/root" && curl -sf -o /dev/null "http://127.0.0.1:$LABP/root" &&
    curl -s -o /dev/null "http://127.0.0.1:$APP/"; then
    break
  fi
  sleep 1
done

cd "$B"
PW_BASE_URL="http://127.0.0.1:$APP" PW_HOME_BRAIN="http://127.0.0.1:$HOMEP" PW_LAB_BRAIN="http://127.0.0.1:$LABP" \
  PW_DEVICE_TOKEN="$TOKEN" PW_RIG_STATE="$STATE" PW_SHOTS="$SHOTS" E2E_OC_URL="http://127.0.0.1:$HOMEP" \
  npx playwright test -c playwright.roots-sheet.config.ts "$@"
