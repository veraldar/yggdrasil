#!/usr/bin/env bash
# trunk-rtc-v1-e2e.sh — G3.2 v1 port of sim/trunk-rtc-e2e.sh: VOICE over the v1 trunk, end to end.
# The phone talks to a root with WebRTC whose media is DTLS-SRTP between the phone and the root,
# while the VPS only moves bytes — now through `bifrost-net trunk` (v1): a claimed trunk, a root
# enrolled by the real F3/F4 API, the phone paired by the real single-use QR (`/pair` →
# `POST /t/pair/redeem`), the bridge's `[trunk]` link (proto 2, root-key auth), the app in
# `BIFROST_AUTH=trunk`, real LiveKit + the real voice agent + real speech engines. No stubs.
# Private namespaces (unshare: user + net + mount + pid; then one network namespace per machine —
# nothing live is touched, every process dies with the run). The v0.9 rig (sim/trunk-rtc-e2e.sh)
# is unchanged and stays the `v09` baseline.
#
#        phone 198.51.100.50                 vps 198.51.100.7                     home 198.51.100.20
#   Chromium (Pixel 7, fake mic WAV)   :443 sni-443.py ─┬─ TLS "ap.tree.test" → vps-eye → trunk tls (PROXY v1)
#     https://ap.tree.test   ───tcp 443───▶             └─ ICE-TCP (RFC 4571 STUN) → tap → trunk listen_ice
#     ICE-TCP 198.51.100.7:443                                (routed by the REGISTERED ufrag, spec §5.7)
#   (vps-eye: the VPS's own view — it holds the trunk's TLS key: every decrypted byte, logged; with
#    $STATE/mitm present it swaps DTLS fingerprints — an active man in the middle)
#                                         trunk ◀═══ dial-OUT wss /t/root (pinned, proto 2) ═══ bridge (home)
#   home: bridge [trunk] → app (BIFROST_AUTH=trunk) · LiveKit (/rtc + ICE-TCP) · the voice agent
#         (branch/voice/agent.py) · speech (edge/voice_server.py) · the brain (YGG_ROOT_NAME = its root id)
#   lab 198.51.100.30 (s16, two-voice): a second root enrolled into the same trunk
#
# Firewalls (nftables, per namespace): phone, home and lab may send ONLY tcp to 198.51.100.7:443
# (every UDP packet dropped and counted); they accept no inbound connection; the vps only tcp 443.
#
#   sim/trunk-rtc-v1-e2e.sh                       the rtc spec (branch/e2e/trunk-rtc-v1.spec.ts):
#       R1 QR pairing · P1 pinned channel · R2 talk · R3 the reply spoken · R4 media path · R5 opaque
#       bytes · E1 the VPS's eyes · U1 LiveKit's ufrags registered on the pinned (tun) /rtc · U2 the
#       plain /rtc path (a phone with no directory pin) · R6 device revoke from /devices (≤ 1 s) ·
#       R7 `trunk-ctl devices revoke` (≤ 1 s) · M1 active MITM fingerprint swap → refused, no fallback ·
#       M2 the MITM also swaps the directory → D3 alarm · ∀
#   sim/trunk-rtc-v1-e2e.sh --scenario s16        S16 (sim/reach/s16.mjs): hands-free / hold on home
#       AND on lab — a light v1 root (the root build) reached from home's brain over WireGuard
#       relayed by the trunk (directory peers, per-root peer tokens)
#   sim/trunk-rtc-v1-e2e.sh --scenario two-voice  G3.6 step 15 (sim/reach/two-voice-v1.mjs): home
#       and lab each a door with ITS OWN LiveKit; phone A (door home) and phone B (door lab) talk at
#       the same time — both LiveKits reached through the trunk's ONE ICE-TCP port by dynamic ufrag
#       registration (§5.7)
#   APP_DIR=<a built app>  BIFROST_NET_BIN  ROOT_NET_BIN (the root build, lab in s16)  YGG_BIN
#
# Needs: trunk/target/release/bifrost-net (+ trunk/target/root/release/bifrost-net for s16),
# root/target/release/yggdrasil, branch built (npm run build), zbarimg, nft, tc, playwright's
# chromium, and from sim/trunk-rtc/setup.sh (TRUNK_RTC_CACHE, ~/.cache/trunk-rtc): livekit-server,
# the voice server (VOICE_DIR), the agent's venv (AGENT_VENV). Distances: PHONE_RTT_MS (60),
# HOME_RTT_MS (30). State + logs: TRUNK_RTC_STATE. Ports (inside the namespaces): 18900-18999.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCENARIO=${TRUNK_RTC_SCENARIO:-rtc}
while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) SCENARIO=${2:?--scenario rtc|s16|two-voice}; shift 2 ;;
    --scenario=*) SCENARIO=${1#*=}; shift ;;
    *) echo "usage: $0 [--scenario rtc|s16|two-voice]"; exit 2 ;;
  esac
done
case "$SCENARIO" in rtc | s16 | two-voice) ;; *) echo "unknown scenario $SCENARIO (rtc|s16|two-voice)"; exit 2 ;; esac
if [ -z "${TRUNK_RTC_V1_NS:-}" ]; then
  exec unshare --user --map-root-user --net --mount --pid --fork --mount-proc \
    env TRUNK_RTC_V1_NS=1 TRUNK_RTC_SCENARIO="$SCENARIO" "$0"
fi

for d in "$HOME/.local/bin" "$HOME/.local/share/mise/installs/node/latest/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
BIN=${BIFROST_NET_BIN:-$ROOT/trunk/target/release/bifrost-net}
ROOT_BIN=${ROOT_NET_BIN:-$ROOT/trunk/target/root/release/bifrost-net}
YGG_BIN=${YGG_BIN:-$ROOT/root/target/release/yggdrasil}
CACHE=${TRUNK_RTC_CACHE:-$HOME/.cache/trunk-rtc}
LK_BIN=${LIVEKIT_BIN:-$CACHE/livekit-server}
VOICE_DIR=${VOICE_DIR:-$CACHE/voice}
AGENT_VENV=${AGENT_VENV:-$CACHE/agent-venv}
B=${APP_DIR:-$ROOT/branch}
[ -x "$BIN" ] || { echo "build the trunk first: (cd trunk && cargo build --release)"; exit 2; }
[ "$SCENARIO" != s16 ] || [ -x "$ROOT_BIN" ] || { echo "build the root build first: (cd trunk && cargo build --release --no-default-features --target-dir target/root)"; exit 2; }
[ -x "$YGG_BIN" ] || { echo "build the brain first: (cd root && cargo build --release)"; exit 2; }
[ -f "$B/.next/BUILD_ID" ] || { echo "build the app first: (cd branch && npm run build)"; exit 2; }
[ -x "$LK_BIN" ] || { echo "no livekit-server at $LK_BIN — run sim/trunk-rtc/setup.sh (or set LIVEKIT_BIN)"; exit 2; }
[ -x "$VOICE_DIR/venv/bin/python" ] && [ -d "$VOICE_DIR/models" ] || { echo "no voice server in $VOICE_DIR — run sim/trunk-rtc/setup.sh"; exit 2; }
[ -x "$AGENT_VENV/bin/python" ] || { echo "no agent venv at $AGENT_VENV — run sim/trunk-rtc/setup.sh"; exit 2; }
for t in zbarimg nft nsenter jq; do command -v $t >/dev/null || { echo "$t missing"; exit 2; }; done

VPS=198.51.100.7 HOMEIP=198.51.100.20 LABIP=198.51.100.30 PHONE=198.51.100.50 AP_HOST=ap.tree.test
AP_URL="https://$AP_HOST"
BASE_TMP=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/wire}
mkdir -p "$BASE_TMP"
STATE=${TRUNK_RTC_STATE:-$(mktemp -d "$BASE_TMP/rtc-v1.XXXXXX")}
mkdir -p "$STATE"/{home/work,vps/tls,vps/cred,phone} && chmod 700 "$STATE"
rm -f "$STATE"/steps.tsv "$STATE"/tap.jsonl "$STATE"/eye.jsonl "$STATE"/mitm
# unix sockets (the trunk's console, the harness's hop to lab) live in a short dir: SUN_LEN is 108
SOCKS=$STATE
[ ${#STATE} -le 80 ] || SOCKS=$(mktemp -d "$HOME/.cache/trunk-v1/tmp/rs.XXXXXX")
{ cat /etc/hosts; echo "$VPS $AP_HOST"; } >"$STATE/hosts"
mount --bind "$STATE/hosts" /etc/hosts

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  [ "$SOCKS" = "$STATE" ] || rm -rf "$SOCKS"
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
LAB=0
[ "$SCENARIO" = rtc ] || LAB=1
machine vps $VPS
machine home $HOMEIP
machine phone $PHONE
[ "$LAB" = 1 ] && machine lab $LABIP
PHONE_RTT_MS=${PHONE_RTT_MS:-60} HOME_RTT_MS=${HOME_RTT_MS:-30}
delay() { # machine rtt-ms
  [ "$2" -gt 0 ] || return 0
  local d=$(($2 / 2))
  tc qdisc add dev "v-$1" root netem delay "${d}ms" && on "$1" tc qdisc add dev eth0 root netem delay "${d}ms"
}
{ delay phone "$PHONE_RTT_MS" && delay home "$HOME_RTT_MS" && { [ "$LAB" = 0 ] || delay lab "$HOME_RTT_MS"; }; } || echo "netem unavailable: no added delay"
only443() {
  printf '%s\n' 'table inet trunk {' \
    "  chain out { type filter hook output priority 0; policy drop; oif \"lo\" accept; ip daddr $VPS tcp dport 443 counter accept; meta l4proto udp counter drop; counter drop; }" \
    '  chain in { type filter hook input priority 0; policy drop; iif "lo" accept; ct state established,related accept; counter drop; }' '}'
}
only443 | on phone nft -f -
only443 | on home nft -f -
[ "$LAB" = 1 ] && only443 | on lab nft -f -
printf '%s\n' 'table inet trunk {' \
  '  chain in { type filter hook input priority 0; policy drop; iif "lo" accept; ct state established,related accept; tcp dport 443 counter accept; counter drop; }' '}' |
  on vps nft -f -

# ---- vps: 443 dispatcher → { the v1 trunk's TLS (by name, via the eye), the tap → the trunk's ICE listener } ----
TLSP=18943 EYEP=18944 WEBP=18945 TAPP=18978 ICEP=18979 THTTP=18980
CERT=$("$BIN" ap-cert "$STATE/vps/tls" "$AP_HOST" "$VPS")
PIN=$(sed -n 's/^pin = "\([^"]*\)".*/\1/p' <<<"$CERT")
"$BIN" trunk-kek "$STATE/vps/cred/trunk-kek" >/dev/null
cat >"$STATE/vps/trunk.toml" <<TOML
public_url = "$AP_URL"
listen_http = "127.0.0.1:$THTTP"
listen_tls = "127.0.0.1:$TLSP"
listen_ice = "127.0.0.1:$ICEP"
proxy_protocol = true
trusted_proxies = ["127.0.0.1/32"]
db = "$STATE/vps/trunk.db"
state_dir = "$STATE/vps"
cred_dir = "$STATE/vps/cred"
ctl_socket = "$SOCKS/ctl.sock"
acme_webroot = "$STATE/vps/acme"
rp_id = "$AP_HOST"
origins = ["$AP_URL"]
ice_owner_from = ["127.0.0.1/32"]
cert_path = "$STATE/vps/tls/cert.pem"
key_path = "$STATE/vps/tls/key.pem"
TOML
chmod 600 "$STATE/vps/trunk.toml"
cat >"$STATE/vps/sni-443.conf" <<CONF
listen  $VPS:443
route   $AP_HOST 127.0.0.1:$EYEP proxy
default 127.0.0.1:$WEBP
ice     127.0.0.1:$TAPP
CONF
# the trunk keeps no meter files on the VPS (its minute lines go to the obs sink root)
on vps env BIFROST_OBS_DIR= "$BIN" trunk -c "$STATE/vps/trunk.toml" >"$STATE/trunk.log" 2>&1 &
pids+=($!)
on vps env SNI443_STATS=off python3 -u "$ROOT/trunk/deploy/sni-443.py" -c "$STATE/vps/sni-443.conf" >"$STATE/sni-443.log" 2>&1 &
pids+=($!)
on vps python3 -u "$ROOT/sim/trunk-rtc/tap.py" 127.0.0.1:$TAPP 127.0.0.1:$ICEP "$STATE/tap.jsonl" >"$STATE/tap.log" 2>&1 &
pids+=($!)
on vps python3 -u "$ROOT/sim/trunk-rtc/vps-eye.py" 127.0.0.1:$EYEP 127.0.0.1:$TLSP "$STATE/vps/tls/cert.pem" \
  "$STATE/vps/tls/key.pem" "$STATE/eye.jsonl" "$STATE/mitm" >"$STATE/eye.log" 2>&1 &
pids+=($!)
mkdir -p "$STATE/website" && echo "a website" >"$STATE/website/index.html"
on vps python3 -m http.server --bind 127.0.0.1 $WEBP --directory "$STATE/website" >"$STATE/website.log" 2>&1 &
pids+=($!)
CTL="$BIN trunk-ctl --sock $SOCKS/ctl.sock"
for _ in $(seq 80); do
  on home curl -sf -o /dev/null --cacert "$STATE/vps/tls/cert.pem" "$AP_URL/t/state" && break
  sleep 0.25
done
on home curl -sf -o /dev/null --cacert "$STATE/vps/tls/cert.pem" "$AP_URL/t/state" ||
  { echo "the v1 trunk did not answer through vps:443"; tail -n 20 "$STATE"/{trunk,sni-443,eye}.log; exit 1; }

# ---- F1 claim (the agent's console code + the owner's TOTP), from home through vps:443 ----
export SSL_CERT_FILE="$STATE/vps/tls/cert.pem"
on home python3 "$ROOT/sim/trunk-v1/claim-admin.py" --url "$AP_URL" --origin "$AP_URL" --ctl "$CTL" \
  --email owner@rtc-v1.test >"$STATE/admin.json"
chmod 600 "$STATE/admin.json"

# ---- the roots: enroll (F4: by code, admin approves with step-up), then their pieces ----
MOCK=18901 BRAIN=18902 VOICEP=18903 AGENTP=18904 BR=18905 MEDIA=18906 APP=18907 WGU=18908 WGR=18909 WGH=18910
LKP=18960 LKTCP=18961 LKUDP=18962
enroll() { # name machine dir [flags…]
  local name=$1 m=$2 dir=$3; shift 3
  on "$m" python3 "$ROOT/sim/trunk-v1/enroll-root.py" --url "$AP_URL" --origin "$AP_URL" --admin "$STATE/admin.json" \
    --bin "$BIN" --dir "$dir" --name "$name" "$@" >"$dir/enroll.out" ||
    { echo "enroll $name failed"; cat "$dir/enroll.out"; exit 1; }
}
field() { jq -r "$2" "$1/enroll.json"; }

# brain: YGG_ROOT_NAME = the root id, its own peer token; with a wg node, peers from the directory
brain() { # machine dir id token [wg]
  local m=$1 d=$2 id=$3 tok=$4 wg=${5:-}
  local peers=()
  [ -n "$wg" ] && peers=(YGG_PEERS_FROM="http://127.0.0.1:$WGH/_wg/_roots" YGG_PEERS_VIA="http://127.0.0.1:$WGH/_wg/{id}")
  mkdir -p "$d/work" "$d/data"
  on "$m" python3 "$ROOT/root/mock/mock_upstream.py" "$MOCK" >"$d/mock.log" 2>&1 &
  pids+=($!)
  on "$m" env -i PATH="$PATH" HOME="$d" YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK" \
    YGG_UPSTREAM_STYLE=anthropic YGG_UPSTREAM_API_KEY=mock YGG_UPSTREAM_MODEL=mock YGG_WAKE_DEBOUNCE_MS=400 \
    YGG_PROVIDERS="$d/none.json" YGG_ARTIFACTS_DIR="$d/artifacts" YGG_DATA_DIR="$d/data" \
    YGG_PROFILES="$d/agents.json" YGG_PROJECT_DIR="$d/work" YGG_LISTEN="127.0.0.1:$BRAIN" \
    YGG_ROOT_NAME="$id" YGG_PEER_TOKEN="$tok" "${peers[@]}" \
    "$YGG_BIN" >"$d/brain.log" 2>&1 &
  pids+=($!)
}
wgnode() { # machine dir
  local m=$1 d=$2
  cat >"$d/wg.toml" <<TOML
[wg]
key_file = "$d/wg.key"
udp = "127.0.0.1:$WGU"
relay = "127.0.0.1:$WGR"
http = "127.0.0.1:$WGH"
brain = "http://127.0.0.1:$BRAIN"
trunk_state = "$d/trunk-state.json"
trunk_key = "$(field "$d" .trunk.trunk_key)"
TOML
  on "$m" "$BIN" wg -c "$d/wg.toml" >"$d/wg.log" 2>&1 &
  pids+=($!)
}
# bridge [trunk]: the full build (WebRTC, /rtc, ICE split) or the root build (light: link + WireGuard)
bridge() { # machine dir ip bin upstream [voice] [wg]
  local m=$1 d=$2 ip=$3 bin=$4 up=$5 voice=${6:-} wg=${7:-}
  local key
  key=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
  {
    printf '[node]\nname = "%s"\nprivate_key = "%s"\n\n' "$(basename "$d")" "$key"
    printf '[bridge]\nhttp = "127.0.0.1:%s"\nmedia = "%s:%s"\ntokens_file = "%s/devices.json"\n' "$BR" "$ip" "$MEDIA" "$d"
    printf 'opencode_url = "http://127.0.0.1:%s"\ncandidates = ["%s"]\ndtls_cert_file = "%s/bridge-dtls.json"\n\n' "$BRAIN" "$ip" "$d"
    printf '[trunk]\nurl = "%s"\npin = "%s"\ntrunk_key = "%s"\nroot_key_file = "%s/root.key"\n' "$AP_URL" "$PIN" "$(field "$d" .trunk.trunk_key)" "$d"
    printf 'root_id = "%s"\nstate_file = "%s/trunk-state.json"\nupstream = "%s"\n' "$(field "$d" .root_id)" "$d" "$up"
    # voice over the trunk: /rtc (LiveKit signaling, device-gated, its ufrags registered) and the
    # raw ICE-TCP forward to LiveKit's tcp port on the root's OWN address (LiveKit's TCP mux files a
    # connection under the interface address it arrived on; loopback is not one of its candidates)
    [ -n "$voice" ] && printf 'livekit = "127.0.0.1:%s"\ntcp = { livekit-ice = "%s:%s" }\n' "$LKP" "$ip" "$LKTCP"
    [ -n "$wg" ] && printf 'wg_relay = "127.0.0.1:%s"\nwg_local = "127.0.0.1:%s"\n' "$WGR" "$WGU"
  } >"$d/bridge.toml"
  chmod 600 "$d/bridge.toml"
  on "$m" "$bin" bridge -c "$d/bridge.toml" >"$d/bridge.log" 2>&1 &
  pids+=($!)
}
# a voice door: speech, LiveKit, the app (BIFROST_AUTH=trunk), the agent
voicedoor() { # machine dir ip
  local m=$1 d=$2 ip=$3
  local lk_key lk_secret
  lk_key=APIsim$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
  lk_secret=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  printf 'LK_KEY=%s\nLK_SECRET=%s\n' "$lk_key" "$lk_secret" >"$d/livekit.env"
  chmod 600 "$d/livekit.env"
  on "$m" env EDGE_MODELS="$VOICE_DIR/models" EDGE_PORT=$VOICEP EDGE_THREADS=4 \
    "$VOICE_DIR/venv/bin/python" -m uvicorn --app-dir "$VOICE_DIR" voice_server:app --host 127.0.0.1 --port $VOICEP \
    >"$d/voice.log" 2>&1 &
  pids+=($!)
  cat >"$d/livekit.yaml" <<YAML
port: $LKP
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: $LKTCP
  udp_port: $LKUDP
  use_external_ip: false
  node_ip: $ip
keys:
  $lk_key: $lk_secret
logging:
  level: info
YAML
  chmod 600 "$d/livekit.yaml"
  on "$m" "$LK_BIN" --config "$d/livekit.yaml" >"$d/livekit.log" 2>&1 &
  pids+=($!)
  mkdir -p "$d/artifacts-app"
  (
    cd "$B"
    exec nsenter --net=/proc/${NS[$m]}/ns/net -- env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
      BIFROST_AUTH=trunk BIFROST_TRUNK_STATE="$d/trunk-state.json" BIFROST_TRUNK_URL="$AP_URL" \
      BIFROST_PUBLIC_URL="$AP_URL" BIFROST_TRUST_PROXY=1 PORT="$APP" HOST=127.0.0.1 \
      BIFROST_BRIDGE_URL="http://127.0.0.1:$BR" BIFROST_MAIN_TITLE='[MAIN]' \
      OPENCODE_URL="http://127.0.0.1:$BRAIN" YGG_PEER_TOKEN="$(field "$d" .peer_token)" \
      ARTIFACTS_DIR="$d/artifacts-app" ARTIFACTS_MAIN_DIR= \
      LIVEKIT_URL="wss://$AP_HOST" LIVEKIT_API_URL="http://127.0.0.1:$LKP" \
      LIVEKIT_API_KEY="$lk_key" LIVEKIT_API_SECRET="$lk_secret" BIFROST_TRUNK_ICE=auto \
      SPEACHES_URL="http://127.0.0.1:$VOICEP/v1" TTS_MODEL_EN=local-vits-en-lessac TTS_VOICE_EN=en_lessac \
      NEXT_TELEMETRY_DISABLED=1 node server.mjs
  ) >"$d/app.log" 2>&1 &
  pids+=($!)
  # AGENT_LOAD_THRESHOLD=inf + AGENT_LOAD=off: the worker's availability must not follow this
  # MACHINE's cpu load (other work on it must not decide a deterministic run)
  (
    cd "$B/voice"
    exec nsenter --net=/proc/${NS[$m]}/ns/net -- env -i PATH="$PATH" HOME="$HOME" \
      HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 LIVEKIT_URL="ws://127.0.0.1:$LKP" \
      LIVEKIT_API_KEY="$lk_key" LIVEKIT_API_SECRET="$lk_secret" OPENCODE_URL="http://127.0.0.1:$BRAIN" \
      SPEACHES_URL="http://127.0.0.1:$VOICEP/v1" AGENT_HTTP_PORT=$AGENTP AGENT_TTS=off APP_URL="http://127.0.0.1:$APP" \
      AGENT_LOAD_THRESHOLD=inf AGENT_LOAD=off "$AGENT_VENV/bin/python" agent.py start
  ) >"$d/agent.log" 2>&1 &
  pids+=($!)
}

H="$STATE/home" L="$STATE/lab"
WG=
[ "$SCENARIO" = s16 ] && WG=1
enroll home home "$H" --hostname home-box --has-app --has-voice --dtls "$H/bridge-dtls.json"
HOME_ID=$(field "$H" .root_id)
case "$SCENARIO" in
  s16) mkdir -p "$L/work" && enroll lab lab "$L" --hostname lab-box ;;
  two-voice) mkdir -p "$L/work" && enroll lab lab "$L" --hostname lab-box --has-app --has-voice --dtls "$L/bridge-dtls.json" ;;
esac
LAB_ID=
[ "$LAB" = 1 ] && LAB_ID=$(field "$L" .root_id)

brain home "$H" "$HOME_ID" "$(field "$H" .peer_token)" "$WG"
[ -n "$WG" ] && wgnode home "$H"
bridge home "$H" $HOMEIP "$BIN" "127.0.0.1:$APP" voice "$WG"
voicedoor home "$H" $HOMEIP
if [ "$SCENARIO" = s16 ]; then
  brain lab "$L" "$LAB_ID" "$(field "$L" .peer_token)" 1
  wgnode lab "$L"
  bridge lab "$L" $LABIP "$ROOT_BIN" "127.0.0.1:$BRAIN" "" 1
elif [ "$SCENARIO" = two-voice ]; then
  brain lab "$L" "$LAB_ID" "$(field "$L" .peer_token)"
  bridge lab "$L" $LABIP "$BIN" "127.0.0.1:$APP" voice
  voicedoor lab "$L" $LABIP
fi

linkup() { [ "$(jq -r '.link.state' "$1/trunk-state.json" 2>/dev/null)" = up ]; }
doorup() { # machine dir
  on "$1" curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP/api/build" | grep -qE '^(200|401)$' &&
    on "$1" curl -sf -o /dev/null "http://127.0.0.1:$VOICEP/healthz" &&
    grep -qi "registered worker" "$2/agent.log"
}
up=0
for _ in $(seq 150); do
  if on home curl -sf -o /dev/null "http://127.0.0.1:$BRAIN/session" && linkup "$H" && doorup home "$H" &&
    { [ "$LAB" = 0 ] || { on lab curl -sf -o /dev/null "http://127.0.0.1:$BRAIN/session" && linkup "$L"; }; } &&
    { [ "$SCENARIO" != two-voice ] || doorup lab "$L"; } &&
    { [ "$SCENARIO" != s16 ] || on home curl -sf "http://127.0.0.1:$WGH/_wg/_roots" | grep -q "$LAB_ID"; } &&
    on phone curl -sf -o /dev/null --cacert "$STATE/vps/tls/cert.pem" "$AP_URL/t/state"; then
    up=1
    break
  fi
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "the world did not come up — logs in $STATE"
  tail -n 15 "$STATE"/trunk.log "$H"/{bridge,app,brain,agent,voice,livekit}.log
  [ "$LAB" = 1 ] && tail -n 15 "$L"/*.log
  exit 1
fi
# each door root has been in use: its [MAIN] exists (v0.9 made it at pairing, app/api/pair; in v1
# pairing is the trunk's — a fresh root makes it at the tree door's first contact, G3.6 step 5)
seedmain() { # machine
  on "$1" curl -sf -o /dev/null -X POST "http://127.0.0.1:$BRAIN/session" -H 'content-type: application/json' \
    -d '{"title":"[MAIN]"}' || { echo "could not make [MAIN] on $1"; exit 1; }
}
seedmain home
[ "$SCENARIO" = two-voice ] && seedmain lab
echo "world up: phone $PHONE → $AP_URL (vps $VPS:443) → v1 trunk → bridge [trunk] (dial-out) → app :$APP · LiveKit · agent · brain"
echo "roots: home $HOME_ID${LAB_ID:+ · lab $LAB_ID} · distance: phone ↔ vps RTT ${PHONE_RTT_MS} ms, roots ↔ vps RTT ${HOME_RTT_MS} ms (netem)"

# the phone's browser runs in the phone's namespace; the harness (and the admin's browser) at home
PHONE_CHROME="$STATE/phone/chrome"
REAL_CHROME=$(cd "$B" && node -e "const {chromium}=require('playwright');process.stdout.write(chromium.executablePath())" 2>/dev/null || true)
SHELL_CHROME=$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | tail -1)
printf '#!/bin/sh\nexec nsenter --net=/proc/%s/ns/net -- %s "$@"\n' "${NS[phone]}" "${SHELL_CHROME:-$REAL_CHROME}" >"$PHONE_CHROME"
chmod 755 "$PHONE_CHROME"

# shellcheck disable=SC1091
. "$H/livekit.env"
COMMON=(PW_AP_URL="$AP_URL" PW_AP_IP="$VPS" PW_STATE="$STATE" PW_PHONE_CHROME="$PHONE_CHROME" APP_DIR="$B"
  PW_TRUNK_V1=1 PW_ADMIN="$STATE/admin.json" PW_CTL="$CTL" PW_VPS_NETNS="$STATE/vps.netns"
  PW_TRUNK_HTTP="http://127.0.0.1:$THTTP" PW_HOME="http://127.0.0.1:$BRAIN" PW_HOME_ID="$HOME_ID"
  PW_VOICE="http://127.0.0.1:$VOICEP/v1" PW_EYE="$STATE/eye.jsonl" PW_MITM="$STATE/mitm" PW_TAP="$STATE/tap.jsonl")
# the harness runs at home; lab's brain lives on lab's loopback: two hops through a unix socket
# (a filesystem socket crosses namespaces) — no firewall rule is opened for the harness
labhop() {
  on lab python3 -u "$ROOT/sim/trunk-rtc/hop.py" "unix:$SOCKS/lab-brain.sock" "127.0.0.1:$BRAIN" >"$L/hop.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 40); do [ -S "$SOCKS/lab-brain.sock" ] && break; sleep 0.1; done
  on home python3 -u "$ROOT/sim/trunk-rtc/hop.py" "127.0.0.1:18991" "unix:$SOCKS/lab-brain.sock" >"$H/hop.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 40); do on home curl -sf -o /dev/null "http://127.0.0.1:18991/session" && break; sleep 0.1; done
}
cd "$B"
set +e
if [ "$SCENARIO" = s16 ]; then
  labhop
  on home env "${COMMON[@]}" PW_BASE_URL="$AP_URL" PW_LAB="http://127.0.0.1:18991" PW_LAB_ROOT="$LAB_ID" \
    node "$ROOT/sim/reach/s16.mjs" 2>&1 | tee "$STATE/e2e.log"
  rc=${PIPESTATUS[0]}
elif [ "$SCENARIO" = two-voice ]; then
  labhop
  on home env "${COMMON[@]}" PW_LAB="http://127.0.0.1:18991" PW_LAB_ID="$LAB_ID" \
    PW_HOME_LK="$H/livekit.log" PW_LAB_LK="$L/livekit.log" PW_HOME_BRIDGE="$H/bridge.log" PW_LAB_BRIDGE="$L/bridge.log" \
    node "$ROOT/sim/reach/two-voice-v1.mjs" 2>&1 | tee "$STATE/e2e.log"
  rc=${PIPESTATUS[0]}
else
  on home env "${COMMON[@]}" PW_LK_API="http://127.0.0.1:$LKP" PW_LK_KEY="$LK_KEY" PW_LK_SECRET="$LK_SECRET" \
    PW_PHONE_IP="$PHONE" PW_VPS_DIR="$STATE/vps" PW_HOME_DIR="$H" \
    npx playwright test e2e/trunk-rtc-v1.spec.ts --reporter=list 2>&1 | tee "$STATE/e2e.log"
  rc=${PIPESTATUS[0]}
fi
set -e

echo
echo "firewall counters (packets):"
for m in phone home vps $([ "$LAB" = 1 ] && echo lab); do
  printf '  %-6s %s\n' "$m" "$(on $m nft list ruleset | grep -o '.*counter packets [0-9]*' | sed 's/^[[:space:]]*//; s/ counter packets / = /' | tr '\n' ';' | sed 's/;$//')"
done
echo
printf '%-7s %-4s %s\n' STEP "" "WHAT"
fails=0
if [ -s "$STATE/steps.tsv" ]; then
  while IFS=$'\t' read -r n res what detail; do
    printf '%-7s %-4s %s\n' "$n" "$res" "$what"
    if [ "$res" = PASS ]; then [ -n "$detail" ] && printf '           · %s\n' "$detail"
    else fails=$((fails + 1)); [ -n "$detail" ] && printf '           ↳ %s\n' "$detail"; fi
  done <"$STATE/steps.tsv"
else
  echo "(no steps recorded)"
  fails=1
fi
echo "state + logs: $STATE"
if [ "$rc" != 0 ] || [ "$fails" != 0 ]; then
  echo "TRUNK-RTC-V1[$SCENARIO]: RED ($fails failed step(s), driver exit $rc)"
  exit 1
fi
echo "TRUNK-RTC-V1[$SCENARIO]: GREEN"
