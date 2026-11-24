#!/usr/bin/env bash
# A root's page is the home screen of that computer — on its own rig, never a live brain:
#   mock upstream → three brains: "home", "lab" (this tree's brain) and "old" (an OLDER brain:
#   one from before PUT /root/theme, OLD_BIN) — lab and old run their own MAIN
#   (YGG_ROOT_MAIN=1, YGG_HOME_ROOT=home), all static peers of home, one peer token →
#   this tree's app (next start, BIFROST_AUTH=devices, one seeded device; roots.json names lab
#   and old as joined roots) → Playwright at 360 px with touch: branch/e2e/root-home-layout.spec.ts.
# Needs: root/target/release/yggdrasil and branch/.next (npm run build) of this tree.
#   OLD_BIN=<an older yggdrasil>   default: the 20261123-2004-2044afb1 release's, when it is there;
#                                  without one the rig has no "old" and the spec skips its steps.
#   UP_ONLY=1                      bring the rig up, print its addresses, wait (Ctrl-C stops it).
# Ports 18550-18560 (P3_PORT_BASE moves them; a port already taken stops the run — the spec
# would drive somebody else's rig). State under ~/.cache/p3-app-tmp (STATE=…: it is wiped first
# — pass your own). Stops only what it started, by PID. SHOTS=<dir> keeps the shots.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
B="$ROOT/branch"
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
OLD_DEFAULT=$HOME/.local/share/yggdrasil/hub/releases/20261123-2004-2044afb1/bin/yggdrasil
OLD_BIN=${OLD_BIN-$([ -x "$OLD_DEFAULT" ] && echo "$OLD_DEFAULT" || true)}
P=${P3_PORT_BASE:-18550}
MOCK=$P HOMEP=$((P + 1)) LABP=$((P + 2)) OLDP=$((P + 3)) APP=$((P + 10))
for p in "$MOCK" "$HOMEP" "$LABP" "$OLDP" "$APP"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "port $p is taken — another rig runs there (P3_PORT_BASE=… moves this one)" >&2
    exit 1
  fi
done
STATE=${STATE:-$HOME/.cache/p3-app-tmp/root-home-layout}
SHOTS=${SHOTS:-$STATE/shots}
rm -rf "$STATE" && mkdir -p "$STATE"/{home,lab,old}/work "$STATE"/{stub,app} "$SHOTS"

pids=()
stop() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap stop EXIT

# the brains read each harness's model list at start: stand-ins that answer nothing
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
}
HOME_PEERS="lab=http://127.0.0.1:$LABP"
ROOTS_JSON='["lab"]'
if [ -n "$OLD_BIN" ]; then
  HOME_PEERS="$HOME_PEERS,old=http://127.0.0.1:$OLDP"
  ROOTS_JSON='["lab","old"]'
fi
brain "$YGG_BIN" home "$HOMEP" "$HOME_PEERS"
brain "$YGG_BIN" lab "$LABP" "home=http://127.0.0.1:$HOMEP" YGG_ROOT_MAIN=1 YGG_HOME_ROOT=home
[ -z "$OLD_BIN" ] || brain "$OLD_BIN" old "$OLDP" "home=http://127.0.0.1:$HOMEP" YGG_ROOT_MAIN=1 YGG_HOME_ROOT=home
# one artifact on lab, so its artifacts page has a row to show
mkdir -p "$STATE/lab/artifacts" && printf '# made on lab\n\nhello from lab\n' >"$STATE/lab/artifacts/lab-notes.md"

# one paired phone, and the joined roots (as sim/roots-sheet-e2e.sh)
TOKEN=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
python3 - "$STATE" "$TOKEN" "$ROOTS_JSON" <<'PY'
import hashlib, json, os, sys, time
state, tok, names = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
now = int(time.time() * 1000)
far = now + 7 * 86400_000
iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
h = lambda s: hashlib.sha256(s.encode()).hexdigest()
dev = {"id": "dev_e2e0root", "name": "pixel", "created": iso, "revoked": False, "region": "loopback",
       "lastRegion": "loopback", "regionChanges": 0, "lastSeen": iso, "refreshHash": h("refresh-" + tok),
       "refreshExp": far, "prevRefresh": [], "access": [{"hash": h(tok), "exp": far, "region": "loopback"}],
       "roots": names}
roots = [{"id": n, "name": n, "os": "linux", "host": n + ".local", "joined_at": iso, "dev": dev["id"],
          "secretHash": h("root-" + n + tok), "delivered_at": iso} for n in names]
for name, body in (("devices.json", {"version": 2, "killEpoch": 0, "devices": [dev], "codes": []}),
                   ("roots.json", {"version": 1, "roots": roots})):
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
    PORT="$APP" HOST=127.0.0.1 node server.mjs
) >>"$STATE/app.log" 2>&1 &
pids+=($!)

up=0
for _ in $(seq 90); do
  if curl -sf -o /dev/null "http://127.0.0.1:$APP/" && curl -sf -o /dev/null "http://127.0.0.1:$HOMEP/root" &&
    curl -sf -o /dev/null "http://127.0.0.1:$LABP/root" &&
    { [ -z "$OLD_BIN" ] || curl -sf -o /dev/null "http://127.0.0.1:$OLDP/root"; }; then
    up=1
    break
  fi
  sleep 1
done
[ "$up" = 1 ] || { echo "rig not up — logs in $STATE" >&2; tail -3 "$STATE"/*.log >&2; exit 1; }

A="http://127.0.0.1:$APP"
export PW_BASE_URL="$A" PW_HOME_BRAIN="http://127.0.0.1:$HOMEP" PW_LAB_BRAIN="http://127.0.0.1:$LABP" \
  PW_OLD_BRAIN="${OLD_BIN:+http://127.0.0.1:$OLDP}" PW_DEVICE_TOKEN="$TOKEN" PW_RIG_STATE="$STATE" \
  PW_SHOTS="$SHOTS" E2E_OC_URL="http://127.0.0.1:$HOMEP"
if [ "${UP_ONLY:-}" = 1 ]; then
  printf 'rig up\n  app   %s   (Cookie: bifrost_device=%s)\n  home  %s\n  lab   %s\n  old   %s\n  state %s\n' \
    "$A" "$TOKEN" "$PW_HOME_BRAIN" "$PW_LAB_BRAIN" "${PW_OLD_BRAIN:-none}" "$STATE"
  env | grep '^PW_\|^E2E_OC_URL' >"$STATE/rig.env"
  wait "${pids[0]}"
  exit 0
fi

cd "$B"
npx playwright test -c playwright.root-home-layout.config.ts "$@"
