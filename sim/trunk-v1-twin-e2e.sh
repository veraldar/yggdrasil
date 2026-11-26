#!/usr/bin/env bash
# trunk-v1-twin-e2e.sh — G5.1: the acceptance twin as a v1 root behind a loopback v1 trunk
# (ports 18600–18610, never the VPS). Runs under twin.lock (the ladder holds twin.lock; when
# invoked by hand, wrap with `flock ~/.cache/trunk-v1/twin.lock`).
#
#   G51_DRY_RUN=1  runs against mock_upstream.py with TWIN_HARNESS=0 (zero paid API quota)
#   G51_DRY_RUN=0  (default, paid run when lead decides): real upstream + SIM_HARNESS=1
#
# G53=1 (G5.3, voice personas through this trunk): same stack, no Playwright drive. Instead
#   G53_DRY_RUN=1 (default)  no model tokens: suite.py --dry-run (every scenario loads, v-all-agents excluded)
#                            + sim/voice/v1probe.py (a Pixel 7 pairs by console QR and opens MAIN through the trunk)
#   G53_DRY_RUN=0            the paid run: sim/voice/suite.py --target <trunk> --brain :4250 --pair-cmd <trunk-ctl pair-qr>
#                            The voice leg is real in this mode (WIRE-2's pieces, not forks): the twin's root is enrolled with
#                            --has-voice (sim/trunk-v1/enroll-root.py), its bridge carries [trunk] livekit/tcp/ice_tcp, and
#                            LiveKit (~/.cache/trunk-rtc/livekit-server), the speech server and the voice agent
#                            (~/.cache/trunk-rtc/{voice,agent-venv}) run on the twin's loopback (ports 18720-18724). The phone
#                            gets /rtc through the trunk and ICE-TCP at the trunk's listen_ice (127.0.0.1:$ICE_PORT).
#                            G53.3-smoke (default mode): a paired Pixel 7 speaks a question, MAIN's mock reply is spoken back.
#
# Spec §9 G5.1 8-step drive:
#   1. sign in (Pixel 7 on /login)
#   2. tree door / home screen
#   3. typed turn to MAIN
#   4. MAIN starts a build sub-session, which reports back to MAIN's inbox
#   5. an artifact opens with sandbox CSP
#   6. a session on a second (light) root through a per-root route
#   7. a spoken turn answered aloud (L16; real voice run only)
#   8. device revoked mid-stream
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN=${1:-v1g51}
DRY=${G51_DRY_RUN:-0}
BIN=${BIFROST_NET_BIN:-$ROOT/trunk/target/release/bifrost-net}
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
B=$ROOT/branch
[ -x "$BIN" ] || { echo "build the trunk first: (cd trunk && cargo build --release)"; exit 2; }
[ -x "$YGG_BIN" ] || { echo "build the brain first: (cd root && cargo build --release)"; exit 2; }
[ -f "$B/.next/BUILD_ID" ] || { echo "build the app first: (cd branch && npm run build)"; exit 2; }

# Loopback trunk ports 18600-18610 (CONTRACTS.md C7)
TRUNK_PORT=18600 ICE_PORT=18601 BR_HTTP=18602 BR_MEDIA=18603 WG_HTTP=18604 WG_UDP=18605 WG_RELAY=18606
MAC_BRAIN=18607 MAC_BR=18608 MAC_WG_HTTP=18609 MOCK_PORT=18610
MAC_MEDIA=18611 MAC_WG_UDP=18612 MAC_RELAY=18613
# G53 voice leg (LADDER's 18700-18799)
VOICEP=18720 AGENTP=18721 LKP=18722 LKTCP=18723 LKUDP=18724
CACHE=${TRUNK_RTC_CACHE:-$HOME/.cache/trunk-rtc}
LK_BIN=${LIVEKIT_BIN:-$CACHE/livekit-server}; VOICE_DIR=${VOICE_DIR:-$CACHE/voice}; AGENT_VENV=${AGENT_VENV:-$CACHE/agent-venv}
G53=${G53:-0}
if [ "$G53" = 1 ]; then
  [ -x "$LK_BIN" ] && [ -x "$VOICE_DIR/venv/bin/python" ] && [ -d "$VOICE_DIR/models" ] && [ -x "$AGENT_VENV/bin/python" ] ||
    { echo "G53 needs livekit-server, the voice server and the agent venv in $CACHE (sim/trunk-rtc/setup.sh)"; exit 2; }
fi

BASE_TMP=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ladder}
mkdir -p "$BASE_TMP"
STATE=${G51_STATE:-$(mktemp -d "$BASE_TMP/g51-twin.XXXXXX")}
mkdir -p "$STATE"/{trunk/cred,twin,mac/work,mac/data,mac/artifacts} && chmod 700 "$STATE"
rm -f "$STATE/steps.tsv"
TRUNK_URL="http://127.0.0.1:$TRUNK_PORT"

pids=()
MOCK_UNIT="acc-${RUN}-g51-mock"
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  bash "$ROOT/sim/acceptance/twin-up.sh" "$RUN" down >/dev/null 2>&1 || true
  systemctl --user stop "$MOCK_UNIT" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$MOCK_UNIT" >/dev/null 2>&1 || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

# ---- 1. loopback v1 trunk on 18600 ----
"$BIN" trunk-kek "$STATE/trunk/cred/trunk-kek" >/dev/null
cat >"$STATE/trunk/trunk.toml" <<TOML
public_url = "$TRUNK_URL"
listen_http = "127.0.0.1:$TRUNK_PORT"
listen_ice = "127.0.0.1:$ICE_PORT"
trusted_proxies = ["127.0.0.1/32"]
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

# ---- 2. claim admin + enroll twin (has_app) and mac (light) ----
python3 "$ROOT/sim/trunk-v1/claim-admin.py" \
  --url "$TRUNK_URL" --origin "$TRUNK_URL" \
  --ctl "$BIN trunk-ctl --sock $STATE/trunk/ctl.sock" \
  --email "owner@g51.test" >"$STATE/admin.json"
chmod 600 "$STATE/admin.json"

enroll_one() {
  local name=$1 has_app=$2 dir=$3
  local rk wk
  rk=$("$BIN" root-key "$dir/root.key" | sed -n 's/^public_key = "\(.*\)"/\1/p')
  wk=$("$BIN" wg-key "$dir/wg.key" | sed -n 's/^public_key = "\(.*\)"/\1/p')
  python3 - "$TRUNK_URL" "$STATE/admin.json" "$name" "$has_app" "$rk" "$wk" "$dir/enrolled.json" <<'PY'
import json, sys, urllib.request
url, ap, name, has_app, rk, wk, out = sys.argv[1:8]
admin = json.load(open(ap))
hdr = {"content-type": "application/json", "origin": url, "cookie": "bifrost_device=" + admin["cookies"]["bifrost_device"]}
def post(p, b, h=None):
    req = urllib.request.Request(url + p, data=json.dumps(b).encode(), method="POST", headers=h or {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())
st = post("/t/roots/enroll", {"hostname": name, "os": "linux", "arch": "x86_64", "root_pub": rk, "wg_pub": wk, "has_app": has_app == "true", "has_voice": False})
post(f"/t/roots/enroll/{st['id']}/approve", {"name": name}, hdr)
res = post(f"/t/roots/enroll/{st['id']}/poll", {"secret": st["poll_secret"]})
assert res.get("status") == "approved", res
json.dump(res, open(out, "w"), indent=2)
PY
}
if [ "$G53" = 1 ]; then
  mkdir -p "$STATE/twin"
  python3 "$ROOT/sim/trunk-v1/enroll-root.py" --url "$TRUNK_URL" --origin "$TRUNK_URL" --admin "$STATE/admin.json" \
    --bin "$BIN" --dir "$STATE/twin" --name twin --hostname twin --has-app --has-voice --dtls "$STATE/twin/bridge-dtls.json" >"$STATE/twin/enroll.out" ||
    { echo "enroll twin failed"; cat "$STATE/twin/enroll.out"; exit 1; }
  cp "$STATE/twin/enroll.json" "$STATE/twin/enrolled.json"
else
  enroll_one twin true "$STATE/twin"
fi
enroll_one mac false "$STATE/mac"

TWIN_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["root_id"])' "$STATE/twin/enrolled.json")
TWIN_TK=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["trunk"]["trunk_key"])' "$STATE/twin/enrolled.json")
TWIN_PT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["peer_token"])' "$STATE/twin/enrolled.json")
MAC_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["root_id"])' "$STATE/mac/enrolled.json")
MAC_TK=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["trunk"]["trunk_key"])' "$STATE/mac/enrolled.json")
MAC_PT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["peer_token"])' "$STATE/mac/enrolled.json")

# ---- 3. start bridges + wg for twin and mac ----
cat >"$STATE/twin/wg.toml" <<TOML
[wg]
key_file = "$STATE/twin/wg.key"
udp = "127.0.0.1:$WG_UDP"
relay = "127.0.0.1:$WG_RELAY"
http = "127.0.0.1:$WG_HTTP"
brain = "http://127.0.0.1:4250"
trunk_state = "$STATE/twin/trunk-state.json"
trunk_key = "$TWIN_TK"
TOML
"$BIN" wg -c "$STATE/twin/wg.toml" >"$STATE/wg-twin.log" 2>&1 &
pids+=($!)

PRIV1=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
TW_ICE='ice_tcp = []' TW_BR_EXTRA='' TW_TRUNK_EXTRA=''
if [ "$G53" = 1 ]; then
  TW_ICE="ice_tcp = [\"127.0.0.1:$ICE_PORT\"]"
  TW_BR_EXTRA=$(printf 'candidates = ["127.0.0.1"]\ndtls_cert_file = "%s/twin/bridge-dtls.json"' "$STATE")
  TW_TRUNK_EXTRA=$(printf 'livekit = "127.0.0.1:%s"\ntcp = { livekit-ice = "127.0.0.1:%s" }' "$LKP" "$LKTCP")
fi
cat >"$STATE/twin/bridge.toml" <<TOML
[node]
name = "twin"
private_key = "$PRIV1"
[bridge]
http = "127.0.0.1:$BR_HTTP"
media = "127.0.0.1:$BR_MEDIA"
tokens_file = "$STATE/twin/devices.json"
opencode_url = "http://127.0.0.1:4250"
$TW_BR_EXTRA
[trunk]
url = "$TRUNK_URL"
trunk_key = "$TWIN_TK"
root_key_file = "$STATE/twin/root.key"
root_id = "$TWIN_ID"
state_file = "$STATE/twin/trunk-state.json"
upstream = "127.0.0.1:8250"
$TW_ICE
wg_relay = "127.0.0.1:$WG_RELAY"
wg_local = "127.0.0.1:$WG_UDP"
$TW_TRUNK_EXTRA
TOML
"$BIN" bridge -c "$STATE/twin/bridge.toml" >"$STATE/bridge-twin.log" 2>&1 &
pids+=($!)

for _ in $(seq 60); do [ -f "$STATE/twin/trunk-state.json" ] && grep -q '"state": "up"' "$STATE/twin/trunk-state.json" 2>/dev/null && break; sleep 0.25; done

# ---- 4. start twin brain (:4250) + librarian (:4251) + app (:8250 in BIFROST_AUTH=trunk) ----
if [ "$DRY" = 1 ]; then
  python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK_PORT" >"$STATE/mock.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 40); do ss -ltn 2>/dev/null | grep -qE "[:.]${MOCK_PORT}[[:space:]]" && break; sleep 0.1; done
  export SIM_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK_PORT"
  export TWIN_HARNESS=0
fi

# Start twin brain + librarian via twin-up.sh, then point app at the REAL loopback trunk-state.json
rm -rf "$HOME/.cache/root-sim/acc-$RUN"
TWIN_AUTH=tailnet TWIN_SEED_MAIN=1 TWIN_TAP=0 bash "$ROOT/sim/acceptance/twin-up.sh" "$RUN" >"$STATE/twin-up.log" 2>&1
# Replace the tailnet next-start app with server.mjs in BIFROST_AUTH=trunk reading the real bridge's trunk-state.json
systemctl --user stop "acc-$RUN-app" >/dev/null 2>&1 || true
systemctl --user reset-failed "acc-$RUN-app" >/dev/null 2>&1 || true
APP_VOICE_ENV=()
if [ "$G53" = 1 ]; then
  LK_KEY=APIsim$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n'); LK_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  env EDGE_MODELS="$VOICE_DIR/models" EDGE_PORT=$VOICEP EDGE_THREADS=4 \
    "$VOICE_DIR/venv/bin/python" -m uvicorn --app-dir "$VOICE_DIR" voice_server:app --host 127.0.0.1 --port $VOICEP >"$STATE/voice.log" 2>&1 &
  pids+=($!)
  cat >"$STATE/livekit.yaml" <<YAML
port: $LKP
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: $LKTCP
  udp_port: $LKUDP
  use_external_ip: false
  node_ip: 127.0.0.1
keys:
  $LK_KEY: $LK_SECRET
logging:
  level: info
YAML
  chmod 600 "$STATE/livekit.yaml"
  "$LK_BIN" --config "$STATE/livekit.yaml" >"$STATE/livekit.log" 2>&1 &
  pids+=($!)
  APP_VOICE_ENV=(BIFROST_BRIDGE_URL="http://127.0.0.1:$BR_HTTP" BIFROST_PUBLIC_URL="$TRUNK_URL"
    LIVEKIT_URL="ws://127.0.0.1:$TRUNK_PORT" LIVEKIT_API_URL="http://127.0.0.1:$LKP" LIVEKIT_API_KEY="$LK_KEY" LIVEKIT_API_SECRET="$LK_SECRET"
    BIFROST_TRUNK_ICE="127.0.0.1:$ICE_PORT" SPEACHES_URL="http://127.0.0.1:$VOICEP/v1" TTS_MODEL_EN=local-vits-en-lessac TTS_VOICE_EN=en_lessac)
fi
mkdir -p "$STATE/twin/artifacts"
printf '<!doctype html><h1>G5.1 sandbox artifact</h1><script>window.__xss=1</script>\n' >"$STATE/twin/artifacts/g51-check.html"
(
  cd "$B"
  exec env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
    PORT=8250 HOST=127.0.0.1 BIFROST_AUTH=trunk BIFROST_TRUST_PROXY=1 \
    BIFROST_TRUNK_STATE="$STATE/twin/trunk-state.json" BIFROST_TRUNK_URL="$TRUNK_URL" \
    BIFROST_MAIN_TITLE='[MAIN]' OPENCODE_URL="http://127.0.0.1:4250" \
    ARTIFACTS_DIR="$STATE/twin/artifacts" YGG_PEER_TOKEN="$TWIN_PT" \
    "${APP_VOICE_ENV[@]}" NEXT_TELEMETRY_DISABLED=1 node server.mjs
) >"$STATE/app.log" 2>&1 &
pids+=($!)
if [ "$G53" = 1 ]; then
  # AGENT_LOAD_THRESHOLD=inf + AGENT_LOAD=off: the worker's availability must not follow this machine's cpu load
  (
    cd "$B/voice"
    exec env -i PATH="$PATH" HOME="$HOME" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 LIVEKIT_URL="ws://127.0.0.1:$LKP" \
      LIVEKIT_API_KEY="$LK_KEY" LIVEKIT_API_SECRET="$LK_SECRET" OPENCODE_URL="http://127.0.0.1:4250" \
      SPEACHES_URL="http://127.0.0.1:$VOICEP/v1" AGENT_HTTP_PORT=$AGENTP AGENT_TTS=off APP_URL="http://127.0.0.1:8250" \
      AGENT_LOAD_THRESHOLD=inf AGENT_LOAD=off "$AGENT_VENV/bin/python" agent.py start
  ) >"$STATE/agent.log" 2>&1 &
  pids+=($!)
fi
for _ in $(seq 60); do curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8250/api/build" | grep -qE '^(200|401)$' && break; sleep 0.5; done

# ---- 5. start second (light) root "mac" ----
cat >"$STATE/mac/wg.toml" <<TOML
[wg]
key_file = "$STATE/mac/wg.key"
udp = "127.0.0.1:$MAC_WG_UDP"
relay = "127.0.0.1:$MAC_RELAY"
http = "127.0.0.1:$MAC_WG_HTTP"
brain = "http://127.0.0.1:$MAC_BRAIN"
trunk_state = "$STATE/mac/trunk-state.json"
trunk_key = "$MAC_TK"
TOML
"$BIN" wg -c "$STATE/mac/wg.toml" >"$STATE/wg-mac.log" 2>&1 &
pids+=($!)
PRIV2=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
cat >"$STATE/mac/bridge.toml" <<TOML
[node]
name = "mac"
private_key = "$PRIV2"
[bridge]
http = "127.0.0.1:$MAC_BR"
media = "127.0.0.1:$MAC_MEDIA"
tokens_file = "$STATE/mac/devices.json"
opencode_url = "http://127.0.0.1:$MAC_BRAIN"
[trunk]
url = "$TRUNK_URL"
trunk_key = "$MAC_TK"
root_key_file = "$STATE/mac/root.key"
root_id = "$MAC_ID"
state_file = "$STATE/mac/trunk-state.json"
upstream = "127.0.0.1:$MAC_BRAIN"
ice_tcp = []
wg_relay = "127.0.0.1:$MAC_RELAY"
wg_local = "127.0.0.1:$MAC_WG_UDP"
TOML
"$BIN" bridge -c "$STATE/mac/bridge.toml" >"$STATE/bridge-mac.log" 2>&1 &
pids+=($!)
env -i PATH="$PATH" HOME="$STATE/mac" \
  YGG_UPSTREAM_BASE_URL="${SIM_UPSTREAM_BASE_URL:-http://127.0.0.1:$MOCK_PORT}" \
  YGG_UPSTREAM_STYLE=anthropic YGG_UPSTREAM_API_KEY=mock YGG_UPSTREAM_MODEL=mock \
  YGG_PROVIDERS="$STATE/mac/none.json" YGG_PROFILES="$STATE/mac/agents.json" \
  YGG_ARTIFACTS_DIR="$STATE/mac/artifacts" YGG_DATA_DIR="$STATE/mac/data" YGG_PROJECT_DIR="$STATE/mac/work" \
  YGG_LISTEN="127.0.0.1:$MAC_BRAIN" YGG_ROOT_NAME="$MAC_ID" YGG_PEER_TOKEN="$MAC_PT" \
  YGG_PEERS_FROM="http://127.0.0.1:$MAC_WG_HTTP/_wg/_roots" YGG_PEERS_VIA="http://127.0.0.1:$MAC_WG_HTTP/_wg/{id}" \
  "$YGG_BIN" >"$STATE/brain-mac.log" 2>&1 &
pids+=($!)

# ---- G5.3 (voice personas through the v1 trunk) replaces the G5.1 drive ----
if [ "${G53:-0}" = 1 ]; then
  G53_DRY=${G53_DRY_RUN:-1}
  PAIR_CMD="$BIN trunk-ctl --sock $STATE/trunk/ctl.sock pair-qr"
  VOUT="$STATE/voice-suite"; mkdir -p "$VOUT"
  : >"$STATE/steps.tsv"
  g53_step() { # name, command...
    local n=$1; shift
    if "$@" >"$STATE/$n.log" 2>&1; then printf '%s\tPASS\t%s\n' "$n" "$(tail -1 "$STATE/$n.log" | cut -c1-110)" >>"$STATE/steps.tsv"
    else printf '%s\tFAIL\t%s\n' "$n" "$(tail -3 "$STATE/$n.log" | tr '\n' ' ' | cut -c1-140)" >>"$STATE/steps.tsv"; fi
  }
  g53_step G53.1-plan python3 "$ROOT/sim/voice/suite.py" --dry-run --out "$VOUT" -- --target "$TRUNK_URL" --brain http://127.0.0.1:4250 --pair-cmd "$PAIR_CMD"
  g53_step G53.2-probe python3 "$ROOT/sim/voice/v1probe.py" --target "$TRUNK_URL" --brain http://127.0.0.1:4250 --pair-cmd "$PAIR_CMD" --out "$VOUT/probe"
  # G53.3: the voice leg, end to end (the persona's speech engines are the local speech server; no persona LLM / judge)
  g53_step G53.3-smoke python3 "$ROOT/sim/voice/v1smoke.py" --target "$TRUNK_URL" --brain http://127.0.0.1:4250 --pair-cmd "$PAIR_CMD" --out "$VOUT/smoke"
  # the voice path really used the trunk: the bridge registered LiveKit's ufrag over /t/root (the phone's /rtc went through the
  # trunk), and the trunk's ICE-TCP listener was up. (This single-host twin cannot forbid the direct loopback UDP path for the
  # media itself — the namespace rig sim/trunk-rtc-v1-e2e.sh G3.2 proves the ICE-TCP media path with its UDP firewall.)
  g53_step G53.3b-ufrag bash -c "grep 'LiveKit ufrag .* registered with the trunk' '$STATE/bridge-twin.log' | tail -1; grep -q 'LiveKit ufrag .* registered with the trunk' '$STATE/bridge-twin.log' && grep -q 'ICE-TCP Some(127.0.0.1:$ICE_PORT)' '$STATE/trunk.log'"
  if [ "$G53_DRY" = 0 ]; then
    g53_step G53.4-suite python3 "$ROOT/sim/voice/suite.py" --out "$VOUT" -- --target "$TRUNK_URL" --brain http://127.0.0.1:4250 --pair-cmd "$PAIR_CMD"
  fi
  echo ""; printf '%-22s %-8s %s\n' "STEP" "RES" "WHAT"
  fails=0
  while IFS=$'\t' read -r n res what; do printf '%-22s %-8s %s\n' "$n" "$res" "$what"; [ "$res" = PASS ] || fails=$((fails + 1)); done <"$STATE/steps.tsv"
  echo "TRUNK-V1-VOICE (G5.3 dry=$G53_DRY): fails=$fails (state: $STATE)"
  [ "$fails" -eq 0 ]
  exit $?
fi

# ---- 6. run the G5.1 Playwright drive ----
cd "$B"
set +e
PW_BASE_URL="$TRUNK_URL" PW_G51_STATE="$STATE" PW_G51_DRY="$DRY" PW_MAC_ID="$MAC_ID" \
  npx playwright test e2e/trunk-v1-twin.spec.ts --workers=1 --reporter=list >"$STATE/pw.log" 2>&1
rc=$?
set -e

echo ""
printf '%-6s %-8s %s\n' "STEP" "RES" "WHAT"
fails=0
if [ -s "$STATE/steps.tsv" ]; then
  while IFS=$'\t' read -r n res what; do
    printf '%-6s %-8s %s\n' "$n" "$res" "$what"
    [ "$res" = PASS ] || fails=$((fails + 1))
  done <"$STATE/steps.tsv"
else
  printf '%-6s %-8s %s\n' "G51.0" "FAIL" "no steps recorded (exit $rc)"
  tail -40 "$STATE/pw.log"
  fails=1
fi
echo "TRUNK-V1-TWIN (dry=$DRY): fails=$fails rc=$rc (state: $STATE)"
[ "$fails" -eq 0 ] && [ "$rc" -eq 0 ]
