#!/usr/bin/env bash
# trunk-rtc-e2e.sh — VOICE over your own trunk, end to end: the phone talks to the box at home with
# WebRTC whose media is DTLS-SRTP between the phone and the box, while the VPS only moves bytes.
# Deterministic, on this machine, in private namespaces (unshare: user + net + mount + pid; then one
# network namespace per machine — nothing live is touched, every process dies with the run).
#
#        phone 198.51.100.50                 vps 198.51.100.7                  home 198.51.100.20
#   Chromium (Pixel 7, fake mic WAV)   :443 sni-443.py ─┬─ TLS "ap.tree.test" → ap 127.0.0.1:4443
#     https://ap.tree.test   ───tcp 443───▶             └─ ICE-TCP (RFC 4571 STUN) → tap → ap raw
#     ICE-TCP 198.51.100.7:443                                 forward "livekit-ice" 127.0.0.1:4479
#                                                 ap ◀═══ dial-OUT wss (pinned) ═══ bridge (home)
#   home: bridge → app (devices mode) · LiveKit (/rtc + ICE-TCP 198.51.100.20:7881) · the voice
#         agent (branch/voice/agent.py, livekit-agents) · speech: edge/voice_server.py (sherpa-onnx
#         whisper-tiny.en STT + piper TTS — what install.sh installs as bifrost-voice) · the brain
#         (yggdrasil on root/mock/mock_upstream.py)
#
# Firewalls (nftables, per namespace): phone and home may send ONLY tcp to 198.51.100.7:443 (every
# UDP packet dropped and counted); home accepts no inbound connection; the vps accepts only tcp 443.
# The "tap" between sni-443's ice route and the ap records every byte the VPS forwards for the media
# (sim/trunk-rtc/tap.py) — the spec classifies it: STUN, DTLS, SRTP/SRTCP only.
#
# Steps (branch/e2e/trunk-rtc.spec.ts): R1 pair by QR through the ap · R2 hold the roots and talk:
# the WAV's words reach the agent's STT and MAIN · R3 the reply is spoken back: TTS audio bytes at
# the phone, and STT of that audio matches the reply · R4 the media path: the selected candidate
# pair is tcp 198.51.100.7:443, UDP was blocked, LiveKit saw tcp · R5 the VPS held no keys: every
# forwarded frame is STUN/DTLS/SRTP · R6 revoke the device on the box console → voice is cut.
#
#   sim/trunk-rtc-e2e.sh            exit 0 = every step PASS; prints the PASS/FAIL table + latency
#
# Needs: root/target/release/yggdrasil + trunk/target/release/bifrost-net (cargo build --release),
# branch built (npm run build), zbarimg, nft, tc, playwright's chromium — and, made once by
# sim/trunk-rtc/setup.sh into TRUNK_RTC_CACHE (~/.cache/trunk-rtc): livekit-server (LIVEKIT_BIN),
# the edge voice server with its venv + models (VOICE_DIR), the agent's venv (AGENT_VENV).
# Distances: PHONE_RTT_MS (60) and HOME_RTT_MS (30), netem. State + logs: TRUNK_RTC_STATE.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${TRUNK_RTC_NS:-}" ]; then
  exec unshare --user --map-root-user --net --mount --pid --fork --mount-proc \
    env TRUNK_RTC_NS=1 "$0" "$@"
fi

BIN=${BIFROST_NET_BIN:-$ROOT/trunk/target/release/bifrost-net}
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
CACHE=${TRUNK_RTC_CACHE:-$HOME/.cache/trunk-rtc}
LK_BIN=${LIVEKIT_BIN:-$CACHE/livekit-server}
VOICE_DIR=${VOICE_DIR:-$CACHE/voice}
AGENT_VENV=${AGENT_VENV:-$CACHE/agent-venv}
B=$ROOT/branch
[ -x "$BIN" ] || { echo "build the trunk first: (cd trunk && cargo build --release)"; exit 2; }
[ -x "$YGG_BIN" ] || { echo "build the brain first: (cd root && cargo build --release)"; exit 2; }
[ -f "$B/.next/BUILD_ID" ] || { echo "build the app first: (cd branch && npm run build)"; exit 2; }
[ -x "$LK_BIN" ] || { echo "no livekit-server at $LK_BIN — run sim/trunk-rtc/setup.sh (or set LIVEKIT_BIN)"; exit 2; }
[ -x "$VOICE_DIR/venv/bin/python" ] && [ -d "$VOICE_DIR/models" ] || { echo "no voice server in $VOICE_DIR — run sim/trunk-rtc/setup.sh"; exit 2; }
[ -x "$AGENT_VENV/bin/python" ] || { echo "no agent venv at $AGENT_VENV — run sim/trunk-rtc/setup.sh"; exit 2; }
for t in zbarimg nft nsenter; do command -v $t >/dev/null || { echo "$t missing"; exit 2; }; done

VPS=198.51.100.7 HOMEIP=198.51.100.20 PHONE=198.51.100.50 AP_HOST=ap.tree.test
AP_URL="https://$AP_HOST"
STATE=${TRUNK_RTC_STATE:-$(mktemp -d "${TMPDIR:-/tmp}/trunk-rtc.XXXXXX")}
mkdir -p "$STATE"/{home/work,vps/tls,phone} && chmod 700 "$STATE"
rm -f "$STATE"/devices.json* "$STATE"/steps.tsv "$STATE"/tap.jsonl
{ cat /etc/hosts; echo "$VPS $AP_HOST"; } >"$STATE/hosts"
mount --bind "$STATE/hosts" /etc/hosts

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

# ---- the machines: one network namespace each, on one "internet" segment ----
ip link set lo up
ip link add inet0 type bridge && ip addr add 198.51.100.1/24 dev inet0 && ip link set inet0 up
declare -A NS
machine() { # name ip
  unshare --net sleep infinity &
  local pid=$!
  pids+=("$pid")
  for _ in $(seq 50); do [ "$(readlink /proc/$pid/ns/net)" != "$(readlink /proc/$$/ns/net)" ] && break; sleep 0.05; done
  ip link add "v-$1" type veth peer name eth0 netns "$pid"
  ip link set "v-$1" master inet0 up
  nsenter --net=/proc/$pid/ns/net sh -c "ip link set lo up && ip addr add $2/24 dev eth0 && ip link set eth0 up"
  NS[$1]=$pid
  echo "/proc/$pid/ns/net" >"$STATE/$1.netns"
}
on() { local n=$1; shift; nsenter --net=/proc/${NS[$n]}/ns/net -- "$@"; }
machine vps $VPS
machine home $HOMEIP
machine phone $PHONE
# a real distance (netem, both directions): phone ↔ VPS a mobile network, home ↔ VPS a home line
PHONE_RTT_MS=${PHONE_RTT_MS:-60} HOME_RTT_MS=${HOME_RTT_MS:-30}
delay() { # machine rtt-ms
  [ "$2" -gt 0 ] || return 0
  local d=$(($2 / 2))
  tc qdisc add dev "v-$1" root netem delay "${d}ms" && on "$1" tc qdisc add dev eth0 root netem delay "${d}ms"
}
delay phone "$PHONE_RTT_MS" && delay home "$HOME_RTT_MS" || echo "netem unavailable: no added delay"
# phone + home: out ONLY to the VPS on tcp 443 (UDP counted, then dropped); in: replies only
only443() {
  printf '%s\n' 'table inet trunk {' \
    "  chain out { type filter hook output priority 0; policy drop; oif \"lo\" accept; ip daddr $VPS tcp dport 443 counter accept; meta l4proto udp counter drop; counter drop; }" \
    '  chain in { type filter hook input priority 0; policy drop; iif "lo" accept; ct state established,related accept; counter drop; }' '}'
}
only443 | on phone nft -f -
only443 | on home nft -f -
# the VPS: the provider firewall in front of it admits tcp 443 (22/80 are not part of this)
printf '%s\n' 'table inet trunk {' \
  '  chain in { type filter hook input priority 0; policy drop; iif "lo" accept; ct state established,related accept; tcp dport 443 counter accept; counter drop; }' '}' |
  on vps nft -f -

# ---- vps: 443 dispatcher → { the ap (TLS by name), the tap → the ap's raw ICE forward } ----
CERT=$("$BIN" ap-cert "$STATE/vps/tls" "$AP_HOST" "$VPS")
PIN=$(sed -n 's/^pin = "\([^"]*\)".*/\1/p' <<<"$CERT")
TOK=$("$BIN" ap-token)
APTOK=$(sed -n 's/^token = "\([^"]*\)".*/\1/p' <<<"$TOK")
APHASH=$(sed -n 's/^bridge_token_sha256 = "\([^"]*\)".*/\1/p' <<<"$TOK")
cat >"$STATE/vps/ap.toml" <<TOML
[ap]
listen = "127.0.0.1:4443"
cert_path = "$STATE/vps/tls/cert.pem"
key_path = "$STATE/vps/tls/key.pem"
bridge_token_sha256 = "$APHASH"
proxy_protocol = true

[[ap.tcp]]
name = "livekit-ice"
listen = "127.0.0.1:4479"
TOML
cat >"$STATE/vps/sni-443.conf" <<CONF
listen  $VPS:443
route   $AP_HOST 127.0.0.1:4443 proxy
default 127.0.0.1:8443
ice     127.0.0.1:4478
CONF
on vps "$BIN" ap -c "$STATE/vps/ap.toml" >"$STATE/ap.log" 2>&1 &
pids+=($!)
on vps python3 -u "$ROOT/trunk/deploy/sni-443.py" -c "$STATE/vps/sni-443.conf" >"$STATE/sni-443.log" 2>&1 &
pids+=($!)
on vps python3 -u "$ROOT/sim/trunk-rtc/tap.py" 127.0.0.1:4478 127.0.0.1:4479 "$STATE/tap.jsonl" >"$STATE/tap.log" 2>&1 &
pids+=($!)
on vps python3 -m http.server --bind 127.0.0.1 8443 --directory "$STATE/vps" >"$STATE/website.log" 2>&1 &
pids+=($!)

# ---- home: brain, speech, LiveKit, the agent, the bridge (dial-out), the app ----
APP=18395 HOMEP=18396 MOCK=18397 BR=18398 MEDIA=18399 VOICEP=18300 AGENTP=18381 LKP=7880 LKTCP=7881 LKUDP=7882
LK_KEY=APIsim$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
LK_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
on home python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK" >"$STATE/mock.log" 2>&1 &
pids+=($!)
on home env -i PATH="$PATH" HOME="$STATE/home" YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK" \
  YGG_UPSTREAM_STYLE=anthropic YGG_UPSTREAM_API_KEY=mock YGG_UPSTREAM_MODEL=mock \
  YGG_PROVIDERS="$STATE/home/none.json" YGG_ARTIFACTS_DIR="$STATE/home/artifacts" \
  YGG_DATA_DIR="$STATE/home/data" YGG_PROFILES="$STATE/home/agents.json" \
  YGG_PROJECT_DIR="$STATE/home/work" YGG_LISTEN="127.0.0.1:$HOMEP" YGG_ROOT_NAME=home \
  "$YGG_BIN" >"$STATE/home.log" 2>&1 &
pids+=($!)
on home env EDGE_MODELS="$VOICE_DIR/models" EDGE_PORT=$VOICEP EDGE_THREADS=4 \
  "$VOICE_DIR/venv/bin/python" -m uvicorn --app-dir "$VOICE_DIR" voice_server:app --host 127.0.0.1 --port $VOICEP \
  >"$STATE/voice.log" 2>&1 &
pids+=($!)
cat >"$STATE/home/livekit.yaml" <<YAML
port: $LKP
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: $LKTCP
  udp_port: $LKUDP
  use_external_ip: false
  node_ip: $HOMEIP
keys:
  $LK_KEY: $LK_SECRET
logging:
  level: info
YAML
chmod 600 "$STATE/home/livekit.yaml"
on home "$LK_BIN" --config "$STATE/home/livekit.yaml" >"$STATE/livekit.log" 2>&1 &
pids+=($!)

KEY=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
cat >"$STATE/home/bridge.toml" <<TOML
[node]
name = "hub-box"
private_key = "$KEY"

[bridge]
http = "127.0.0.1:$BR"
media = "$HOMEIP:$MEDIA"
tokens_file = "$STATE/devices.json"
opencode_url = "http://127.0.0.1:$HOMEP"
candidates = ["$HOMEIP"]
dtls_cert_file = "$STATE/home/bridge-dtls.json"
public_url = "http://$HOMEIP:$BR"

[ap]
url = "wss://$AP_HOST/ap"
pin = "$PIN"
token = "$APTOK"
upstream = "127.0.0.1:$APP"
# voice over the trunk: /rtc (LiveKit signaling, device-gated) and the raw ICE-TCP forward. The
# target is LiveKit's tcp port on the box's OWN address: LiveKit's TCP mux files a connection under
# the interface address it arrived on, and loopback is not one of its candidates.
livekit = "127.0.0.1:$LKP"
tcp = { livekit-ice = "$HOMEIP:$LKTCP" }
TOML
chmod 600 "$STATE/home/bridge.toml"
on home "$BIN" bridge -c "$STATE/home/bridge.toml" >"$STATE/bridge.log" 2>&1 &
pids+=($!)

(
  cd "$B"
  exec nsenter --net=/proc/${NS[home]}/ns/net -- env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
    BIFROST_AUTH=devices BIFROST_DEVICES_FILE="$STATE/devices.json" \
    BIFROST_PUBLIC_URL="$AP_URL" BIFROST_TRUST_PROXY=1 PORT="$APP" HOST=127.0.0.1 \
    BIFROST_BRIDGE_URL="http://127.0.0.1:$BR" BIFROST_MAIN_TITLE='[MAIN]' \
    OPENCODE_URL="http://127.0.0.1:$HOMEP" ARTIFACTS_DIR="$STATE/artifacts-app" ARTIFACTS_MAIN_DIR= \
    LIVEKIT_URL="wss://$AP_HOST" LIVEKIT_API_URL="http://127.0.0.1:$LKP" \
    LIVEKIT_API_KEY="$LK_KEY" LIVEKIT_API_SECRET="$LK_SECRET" BIFROST_TRUNK_ICE=auto \
    SPEACHES_URL="http://127.0.0.1:$VOICEP/v1" TTS_MODEL_EN=local-vits-en-lessac TTS_VOICE_EN=en_lessac \
    node server.mjs
) >"$STATE/app.log" 2>&1 &
pids+=($!)

# AGENT_LOAD_THRESHOLD=inf: the worker's availability follows this MACHINE's cpu load (other work
# on it must not decide a deterministic run: "no servers available" = an agent-less room)
(
  cd "$B/voice"
  exec nsenter --net=/proc/${NS[home]}/ns/net -- env -i PATH="$PATH" HOME="$HOME" \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 LIVEKIT_URL="ws://127.0.0.1:$LKP" \
    LIVEKIT_API_KEY="$LK_KEY" LIVEKIT_API_SECRET="$LK_SECRET" OPENCODE_URL="http://127.0.0.1:$HOMEP" \
    SPEACHES_URL="http://127.0.0.1:$VOICEP/v1" AGENT_HTTP_PORT=$AGENTP AGENT_TTS=off APP_URL="http://127.0.0.1:$APP" \
    AGENT_LOAD_THRESHOLD=inf "$AGENT_VENV/bin/python" agent.py start
) >"$STATE/agent.log" 2>&1 &
pids+=($!)

up=0
for _ in $(seq 120); do
  if on home curl -sf -o /dev/null "http://127.0.0.1:$APP/pair" &&
    on home curl -sf -o /dev/null "http://127.0.0.1:$HOMEP/session" &&
    on home curl -sf -o /dev/null "http://127.0.0.1:$VOICEP/healthz" &&
    grep -q "channel up" "$STATE/bridge.log" &&
    grep -qi "registered worker" "$STATE/agent.log" &&
    on phone curl -sf -o /dev/null --cacert "$STATE/vps/tls/cert.pem" "$AP_URL/pair"; then
    up=1
    break
  fi
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "the world did not come up — logs in $STATE"
  tail -n 15 "$STATE"/{bridge,ap,app,home,agent,voice,livekit}.log
  exit 1
fi
echo "world up: phone $PHONE → $AP_URL (vps $VPS:443) → bridge (dial-out) → app :$APP · LiveKit · agent · brain"
echo "distance: phone ↔ vps RTT ${PHONE_RTT_MS} ms, home ↔ vps RTT ${HOME_RTT_MS} ms (netem)"

# the phone's browser runs in the phone's namespace; the harness (and the box console's browser)
# runs at home — the box's own console is loopback there
PHONE_CHROME="$STATE/phone/chrome"
REAL_CHROME=$(cd "$B" && node -e "const {chromium}=require('playwright');process.stdout.write(chromium.executablePath())" 2>/dev/null || true)
SHELL_CHROME=$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | tail -1)
printf '#!/bin/sh\nexec nsenter --net=/proc/%s/ns/net -- %s "$@"\n' "${NS[phone]}" "${SHELL_CHROME:-$REAL_CHROME}" >"$PHONE_CHROME"
chmod 755 "$PHONE_CHROME"

cd "$B"
set +e
on home env PW_AP_URL="$AP_URL" PW_AP_IP="$VPS" PW_BASE_URL="http://127.0.0.1:$APP" PW_STATE="$STATE" \
  PW_HOME="http://127.0.0.1:$HOMEP" PW_VOICE="http://127.0.0.1:$VOICEP/v1" PW_PHONE_CHROME="$PHONE_CHROME" \
  PW_LK_API="http://127.0.0.1:$LKP" PW_LK_KEY="$LK_KEY" PW_LK_SECRET="$LK_SECRET" PW_TAP="$STATE/tap.jsonl" \
  PW_PHONE_IP="$PHONE" PW_VPS_DIR="$STATE/vps" \
  npx playwright test e2e/trunk-rtc.spec.ts --reporter=list 2>&1 | tee "$STATE/e2e.log"
rc=${PIPESTATUS[0]}
set -e

echo
echo "firewall counters (packets):"
for m in phone home vps; do
  printf '  %-6s %s\n' "$m" "$(on $m nft list ruleset | grep -o '.*counter packets [0-9]*' | sed 's/^[[:space:]]*//; s/ counter packets / = /' | tr '\n' ';' | sed 's/;$//')"
done
echo
printf '%-5s %-4s %s\n' STEP "" "WHAT"
fails=0
if [ -s "$STATE/steps.tsv" ]; then
  while IFS=$'\t' read -r n res what detail; do
    printf '%-5s %-4s %s\n' "$n" "$res" "$what"
    if [ "$res" = PASS ]; then [ -n "$detail" ] && printf '           · %s\n' "$detail"
    else fails=$((fails + 1)); [ -n "$detail" ] && printf '           ↳ %s\n' "$detail"; fi
  done <"$STATE/steps.tsv"
else
  echo "(no steps recorded)"
  fails=1
fi
echo "state + logs: $STATE"
if [ "$rc" != 0 ] || [ "$fails" != 0 ]; then
  echo "TRUNK-RTC: RED ($fails failed step(s), playwright exit $rc)"
  exit 1
fi
echo "TRUNK-RTC: GREEN"
