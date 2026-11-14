#!/usr/bin/env bash
# trunk-e2e.sh — THE END DESIGN, all of it in one world: WebRTC between the phone and the box
# (the QR-pinned channel carries the app's data, LiveKit carries the voice) and WireGuard between
# the roots (the hub's node pins each key the phone approved), while the VPS only moves bytes on
# tcp 443. Deterministic, on this machine, in private namespaces (unshare: user + net + mount +
# pid; one network namespace per machine — nothing live is touched, every process dies with the run).
#
#        phone 198.51.100.50                 vps 198.51.100.7                  home 198.51.100.20
#   Chromium (Pixel 7, mic = a WAV:    :443 sni-443.py ─┬─ TLS "ap.tree.test" → vps-eye → ap :4443
#   "Start a session on mac and have                    └─ ICE-TCP (RFC 4571 STUN) → tap → ap raw
#    it start a session on lab to say                          forward "livekit-ice" 127.0.0.1:4479
#    lab done.")                             (vps-eye: the VPS's own view — it holds the ap's TLS
#                                             key: every decrypted byte, logged per connection)
#   mac 198.51.100.31 · lab 198.51.100.32         ap ◀═══ dial-OUT wss (pinned) ═══ bridge (home)
#     each: the joiner (join.sh's steps:    home: bridge (pinned channel + root-link + the WireGuard
#     key → POST /api/roots/join → poll),         relay) → app (devices mode, the join routes) ·
#     its brain on its own mock, its              LiveKit (/rtc + ICE-TCP) · the voice agent ·
#     WireGuard node (the ROOT build of           speech (edge/voice_server.py: whisper-tiny.en +
#     bifrost-net), root-dial.py → wss            piper) · the hub brain "home" (learns the roots
#     ap.tree.test/rootlink                       from its node) · the hub's WireGuard node
#
# Firewalls (nftables, per namespace): phone, home, mac and lab may send ONLY tcp to
# 198.51.100.7:443 (every UDP packet dropped and counted) and accept no inbound connection; the
# vps accepts only tcp 443.
#
# Steps (branch/e2e/trunk-e2e.spec.ts): W1 pair by QR · W2 the pinned channel is up · W3/W4 mac and
# lab join, approved on the phone (it shows each tunnel key's fingerprint) · W5 they learn each
# other from the hub's directory · W6 MAIN delegates by VOICE: the WAV's words → LiveKit → the
# agent's STT → MAIN → session_start on mac · W7 the reply is spoken back over the voice room ·
# W8 mac does it: its session starts one on lab, lab reports to mac's session, mac reports home ·
# W9 what the VPS read: no app data after pairing; between roots only WireGuard; the media opaque ·
# W10 revoke the phone on the box console → its channel, its voice and both roots' tunnels cut.
#
#   sim/trunk-e2e.sh            exit 0 = every step PASS; prints the PASS/FAIL table + latencies
#
# Needs what sim/trunk-rtc-e2e.sh needs (the builds, sim/trunk-rtc/setup.sh's cache, zbarimg, nft,
# tc) + qrencode and the root build: (cd trunk && cargo build --release --no-default-features
# --target-dir target/root) — or ROOT_NET_BIN. State + logs: TRUNK_E2E_STATE.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${TRUNK_E2E_NS:-}" ]; then
  exec unshare --user --map-root-user --net --mount --pid --fork --mount-proc \
    env TRUNK_E2E_NS=1 "$0" "$@"
fi

BIN=${BIFROST_NET_BIN:-$ROOT/trunk/target/release/bifrost-net}
ROOT_BIN=${ROOT_NET_BIN:-$ROOT/trunk/target/root/release/bifrost-net}
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
CACHE=${TRUNK_RTC_CACHE:-$HOME/.cache/trunk-rtc}
LK_BIN=${LIVEKIT_BIN:-$CACHE/livekit-server}
VOICE_DIR=${VOICE_DIR:-$CACHE/voice}
AGENT_VENV=${AGENT_VENV:-$CACHE/agent-venv}
B=$ROOT/branch
[ -x "$BIN" ] || { echo "build the trunk first: (cd trunk && cargo build --release)"; exit 2; }
[ -x "$ROOT_BIN" ] || { echo "build the root build first: (cd trunk && cargo build --release --no-default-features --target-dir target/root)"; exit 2; }
[ -x "$YGG_BIN" ] || { echo "build the brain first: (cd root && cargo build --release)"; exit 2; }
[ -f "$B/.next/BUILD_ID" ] || { echo "build the app first: (cd branch && npm run build)"; exit 2; }
[ -x "$LK_BIN" ] || { echo "no livekit-server at $LK_BIN — run sim/trunk-rtc/setup.sh (or set LIVEKIT_BIN)"; exit 2; }
[ -x "$VOICE_DIR/venv/bin/python" ] && [ -d "$VOICE_DIR/models" ] || { echo "no voice server in $VOICE_DIR — run sim/trunk-rtc/setup.sh"; exit 2; }
[ -x "$AGENT_VENV/bin/python" ] || { echo "no agent venv at $AGENT_VENV — run sim/trunk-rtc/setup.sh"; exit 2; }
for t in zbarimg qrencode nft nsenter; do command -v $t >/dev/null || { echo "$t missing"; exit 2; }; done

VPS=198.51.100.7 HOMEIP=198.51.100.20 PHONE=198.51.100.50 MACIP=198.51.100.31 LABIP=198.51.100.32
AP_HOST=ap.tree.test
AP_URL="https://$AP_HOST"
STATE=${TRUNK_E2E_STATE:-$(mktemp -d "${TMPDIR:-/tmp}/trunk-e2e.XXXXXX")}
mkdir -p "$STATE"/{home/work,vps/tls,phone,mac,lab} && chmod 700 "$STATE"
rm -f "$STATE"/devices.json* "$STATE"/roots.json* "$STATE"/steps.tsv "$STATE"/tap.jsonl "$STATE"/eye.jsonl "$STATE"/mitm
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
machine mac $MACIP
machine lab $LABIP
# distances (netem, both directions): the phone on mobile data, home and the roots on home lines
PHONE_RTT_MS=${PHONE_RTT_MS:-60} HOME_RTT_MS=${HOME_RTT_MS:-30} ROOT_RTT_MS=${ROOT_RTT_MS:-40}
delay() { # machine rtt-ms
  [ "$2" -gt 0 ] || return 0
  local d=$(($2 / 2))
  tc qdisc add dev "v-$1" root netem delay "${d}ms" && on "$1" tc qdisc add dev eth0 root netem delay "${d}ms"
}
{ delay phone "$PHONE_RTT_MS" && delay home "$HOME_RTT_MS" && delay mac "$ROOT_RTT_MS" && delay lab "$ROOT_RTT_MS"; } ||
  echo "netem unavailable: no added delay"
# everyone but the VPS: out ONLY to the VPS on tcp 443 (UDP counted, then dropped); in: replies only
only443() {
  printf '%s\n' 'table inet trunk {' \
    "  chain out { type filter hook output priority 0; policy drop; oif \"lo\" accept; ip daddr $VPS tcp dport 443 counter accept; meta l4proto udp counter drop; counter drop; }" \
    '  chain in { type filter hook input priority 0; policy drop; iif "lo" accept; ct state established,related accept; counter drop; }' '}'
}
for m in phone home mac lab; do only443 | on $m nft -f -; done
printf '%s\n' 'table inet trunk {' \
  '  chain in { type filter hook input priority 0; policy drop; iif "lo" accept; ct state established,related accept; tcp dport 443 counter accept; counter drop; }' '}' |
  on vps nft -f -

# ---- vps: 443 dispatcher → { the ap (TLS by name, through the eye), the tap → the ap's raw ICE forward } ----
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
route   $AP_HOST 127.0.0.1:4444 proxy
default 127.0.0.1:8443
ice     127.0.0.1:4478
CONF
on vps "$BIN" ap -c "$STATE/vps/ap.toml" >"$STATE/ap.log" 2>&1 &
pids+=($!)
on vps python3 -u "$ROOT/trunk/deploy/sni-443.py" -c "$STATE/vps/sni-443.conf" >"$STATE/sni-443.log" 2>&1 &
pids+=($!)
on vps python3 -u "$ROOT/sim/trunk-rtc/tap.py" 127.0.0.1:4478 127.0.0.1:4479 "$STATE/tap.jsonl" >"$STATE/tap.log" 2>&1 &
pids+=($!)
on vps python3 -u "$ROOT/sim/trunk-rtc/vps-eye.py" 127.0.0.1:4444 127.0.0.1:4443 "$STATE/vps/tls/cert.pem" \
  "$STATE/vps/tls/key.pem" "$STATE/eye.jsonl" "$STATE/mitm" >"$STATE/eye.log" 2>&1 &
pids+=($!)
on vps python3 -m http.server --bind 127.0.0.1 8443 --directory "$STATE/vps" >"$STATE/website.log" 2>&1 &
pids+=($!)

# ---- home: brain, speech, LiveKit, the agent, the bridge (dial-out), the hub's WireGuard node, the app ----
APP=18395 HOMEP=18396 MOCK=18397 BR=18398 MEDIA=18399 VOICEP=18300 AGENTP=18381 LKP=7880 LKTCP=7881 LKUDP=7882
RL=18400 HUBWG=18403 HUBUDP=18404 RELAYUDP=18405
# a joined root's own ports (each root has its own loopback): brain, old peer port, its node's door, udp, the dialer's udp
RBRAIN=18401 RPEER=18402 RWG=18406 RWGUDP=18407 RPIPE=18408
LK_KEY=APIsim$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
LK_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
RLSECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
PEER="peer-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
on home python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK" >"$STATE/mock.log" 2>&1 &
pids+=($!)
# the hub's three restartable parts (the spec restarts them mid-session: step H1) — hub.sh
# start|stop|restart [brain|bridge|wg …], run inside home's network namespace; pids in home/*.pid
cat >"$STATE/home/hub.sh" <<SH
#!/usr/bin/env bash
# GENERATED by sim/trunk-e2e.sh — the hub's brain, bridge and WireGuard node
S="$STATE"
cmd_brain() {
  # the hub brain "home": no static YGG_PEERS — it learns every root whose key the phone pinned
  # from the hub's WireGuard node, and calls it inside the tunnel
  exec env -i PATH="$PATH" HOME="$STATE/home" YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK" \\
    YGG_UPSTREAM_STYLE=anthropic YGG_UPSTREAM_API_KEY=mock YGG_UPSTREAM_MODEL=mock YGG_WAKE_DEBOUNCE_MS=400 \\
    YGG_PROVIDERS="$STATE/home/none.json" YGG_ARTIFACTS_DIR="$STATE/home/artifacts" \\
    YGG_DATA_DIR="$STATE/home/data" YGG_PROFILES="$STATE/home/agents.json" \\
    YGG_PROJECT_DIR="$STATE/home/work" YGG_LISTEN="127.0.0.1:$HOMEP" YGG_ROOT_NAME=home YGG_PEER_TOKEN="$PEER" \\
    YGG_PEERS_FROM="http://127.0.0.1:$HUBWG/_wg/_roots" YGG_PEERS_VIA="http://127.0.0.1:$HUBWG/_wg/{id}" \\
    "$YGG_BIN"
}
cmd_bridge() { exec "$BIN" bridge -c "$STATE/home/bridge.toml"; }
cmd_wg() { exec "$BIN" wg -c "$STATE/home/wg-hub.toml"; }
log_of() { case \$1 in brain) echo "\$S/home.log" ;; bridge) echo "\$S/bridge.log" ;; wg) echo "\$S/wg-hub.log" ;; esac; }
start() { ( cmd_\$1 ) >>"\$(log_of \$1)" 2>&1 & echo \$! >"\$S/home/\$1.pid"; }
stop() {
  local p; p=\$(cat "\$S/home/\$1.pid" 2>/dev/null) || return 0
  kill "\$p" 2>/dev/null || return 0
  for _ in \$(seq 100); do kill -0 "\$p" 2>/dev/null || return 0; sleep 0.05; done
  kill -9 "\$p" 2>/dev/null || true
}
what=\$1; shift
parts=("\$@"); [ \${#parts[@]} -gt 0 ] || parts=(brain bridge wg)
for x in "\${parts[@]}"; do
  case \$what in start) start \$x ;; stop) stop \$x ;; restart) stop \$x ;; esac
done
if [ "\$what" = restart ]; then for x in "\${parts[@]}"; do start \$x; done; fi
SH
chmod 700 "$STATE/home/hub.sh"
: >"$STATE/home.log"; : >"$STATE/bridge.log"; : >"$STATE/wg-hub.log"
on home bash "$STATE/home/hub.sh" start brain
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
root_link_secret = "$RLSECRET"

# the root <-> root leg: links dial in through the ap (/rootlink); the bridge relays WireGuard only
[bridge.root-link]
enabled = true
listen = "127.0.0.1:$RL"
ping_secs = 5
result_secs = 120
wg_relay = "127.0.0.1:$RELAYUDP"
wg_local = "127.0.0.1:$HUBUDP"

[ap]
url = "wss://$AP_HOST/ap"
pin = "$PIN"
token = "$APTOK"
upstream = "127.0.0.1:$APP"
# voice over the trunk: /rtc (LiveKit signaling, device-gated) and the raw ICE-TCP forward (the
# box's own address: LiveKit's TCP mux files a connection under the address it arrived on)
livekit = "127.0.0.1:$LKP"
tcp = { livekit-ice = "$HOMEIP:$LKTCP" }
TOML
chmod 600 "$STATE/home/bridge.toml"
on home bash "$STATE/home/hub.sh" start bridge

# the hub's WireGuard node: its key never leaves it; its peers are the keys the phone pinned
"$BIN" wg-key "$STATE/home/hub-wg.key" >"$STATE/home/hub-wg.txt"
cat >"$STATE/home/wg-hub.toml" <<TOML
[wg]
key_file = "$STATE/home/hub-wg.key"
udp = "127.0.0.1:$HUBUDP"
relay = "127.0.0.1:$RELAYUDP"
http = "127.0.0.1:$HUBWG"
brain = "http://127.0.0.1:$HOMEP"
roots_file = "$STATE/roots.json"
devices_file = "$STATE/devices.json"
TOML
on home bash "$STATE/home/hub.sh" start wg

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
    BIFROST_NET_BIN="$BIN" BIFROST_BRIDGE_CONFIG="$STATE/home/bridge.toml" \
    BIFROST_ROOTLINK_URL="wss://$AP_HOST/rootlink" YGG_PEER_TOKEN="$PEER" \
    BIFROST_WG_PUB_FILE="$STATE/home/hub-wg.key.pub" \
    node server.mjs
) >"$STATE/app.log" 2>&1 &
pids+=($!)

# AGENT_LOAD_THRESHOLD=inf + AGENT_LOAD=off: the worker's availability must not follow this
# machine's cpu load (sim/trunk-rtc-e2e.sh)
(
  cd "$B/voice"
  exec nsenter --net=/proc/${NS[home]}/ns/net -- env -i PATH="$PATH" HOME="$HOME" \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 LIVEKIT_URL="ws://127.0.0.1:$LKP" \
    LIVEKIT_API_KEY="$LK_KEY" LIVEKIT_API_SECRET="$LK_SECRET" OPENCODE_URL="http://127.0.0.1:$HOMEP" \
    SPEACHES_URL="http://127.0.0.1:$VOICEP/v1" AGENT_HTTP_PORT=$AGENTP AGENT_TTS=off APP_URL="http://127.0.0.1:$APP" \
    AGENT_LOAD_THRESHOLD=inf AGENT_LOAD=off "$AGENT_VENV/bin/python" agent.py start
) >"$STATE/agent.log" 2>&1 &
pids+=($!)

# ---- the two machines that will join: each its own model (a mock), nothing else until the join ----
for m in mac lab; do
  on $m python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK" >"$STATE/$m/mock.log" 2>&1 &
  pids+=($!)
done

up=0
for _ in $(seq 120); do
  if on home curl -sf -o /dev/null "http://127.0.0.1:$APP/pair" &&
    on home curl -sf -o /dev/null "http://127.0.0.1:$HOMEP/session" &&
    on home curl -sf -o /dev/null "http://127.0.0.1:$VOICEP/healthz" &&
    on home curl -sf -o /dev/null "http://127.0.0.1:$HUBWG/_wg" &&
    grep -q "channel up" "$STATE/bridge.log" &&
    grep -qi "registered worker" "$STATE/agent.log" &&
    on phone curl -sf -o /dev/null --cacert "$STATE/vps/tls/cert.pem" "$AP_URL/pair" &&
    on mac curl -sf -o /dev/null "http://127.0.0.1:$MOCK/calls" && on lab curl -sf -o /dev/null "http://127.0.0.1:$MOCK/calls"; then
    up=1
    break
  fi
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "the world did not come up — logs in $STATE"
  tail -n 15 "$STATE"/{bridge,ap,app,home,agent,voice,livekit,wg-hub}.log
  exit 1
fi
echo "world up: phone $PHONE → $AP_URL (vps $VPS:443) → bridge (dial-out) → app :$APP · LiveKit · agent · brain home · wg node"
echo "          mac $MACIP + lab $LABIP: tcp 443 to the vps only, waiting to join"
echo "distance: phone ↔ vps RTT ${PHONE_RTT_MS} ms, home ↔ vps ${HOME_RTT_MS} ms, each root ↔ vps ${ROOT_RTT_MS} ms (netem)"

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
  PW_PHONE_IP="$PHONE" PW_VPS_DIR="$STATE/vps" PW_EYE="$STATE/eye.jsonl" PW_BRIDGE="http://127.0.0.1:$BR" \
  PW_HUBWG="http://127.0.0.1:$HUBWG" PW_CAFILE="$STATE/vps/tls/cert.pem" PW_YGG_BIN="$YGG_BIN" \
  PW_ROOT_NET_BIN="$ROOT_BIN" PW_ROOT_MOCK="http://127.0.0.1:$MOCK" PW_MAC_IP="$MACIP" PW_LAB_IP="$LABIP" \
  PW_ROOT_PORTS="$RBRAIN,$RPEER,$RWG,$RWGUDP,$RPIPE" PW_PEER_TOKEN="$PEER" \
  PW_MITM="$STATE/mitm" PW_HUB_SH="$STATE/home/hub.sh" \
  npx playwright test e2e/trunk-e2e.spec.ts --reporter=list 2>&1 | tee "$STATE/e2e.log"
rc=${PIPESTATUS[0]}
set -e

echo
echo "firewall counters (packets):"
for m in phone home mac lab vps; do
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
  echo "TRUNK-E2E: RED ($fails failed step(s), playwright exit $rc)"
  exit 1
fi
echo "TRUNK-E2E: GREEN"
