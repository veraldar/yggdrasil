#!/usr/bin/env bash
# trunk-deploy.sh — go-chain Lane A: the trunk (public face) auto-deploys to a VPS.
#
#   bash scripts/go-chain/trunk-deploy.sh --host user@vps-ip --domain trunk.example.com \
#        --root-url http://100.x.y.z:4100 [--port 22] [--key ~/.ssh/id_ed25519] \
#        [--speech-url http://mac:8000] [--sim-dns] [--rollback <ts>|last]
#
# What it does (each step idempotent, every gate BEFORE the switch):
#   0 preflight   ssh reachable · systemd · ram/disk floors · ports free
#   1 deps        docker + compose plugin (apt) on the VPS
#   2 release     `git archive` THIS tree → /opt/bifrost/versions/<ts>/
#   3 secrets     minted ON the VPS (openssl rand), /opt/bifrost/secrets 0600,
#                 never printed; the admin token is shown ONCE in the receipt
#                 (pairing-URL fragment), never again anywhere
#   4 containers  livekit (+ speaches unless --speech-url) · pwa image build ·
#                 caddy TLS (or plain HTTP with --sim-dns — SIM ONLY)
#   5 gates       livekit up · pwa serving · pair mints over the public origin
#                 · https reachable (real mode)
#   6 receipt     the pairing URL (#admin= consumed once by the pair page),
#                 what runs where, the rollback command
#
# Release discipline (promote.sh contract, remote): versions/<ts>/ + a
# `current` symlink — the symlink never moves unless every gate passed; a red
# gate leaves the old version untouched. One-command undo: --rollback last.
# Spec: docs/reviews/layman-deploy-spec.md §2 Phase B, §4 rollback contract.
set -uo pipefail

HOST=; PORT=22; KEY=""; DOMAIN=""; ROOT_URL=""; REF="HEAD"; SPEECH_URL=""
SIM_DNS=0; ROLLBACK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;; --port) PORT="$2"; shift ;; --key) KEY="-i $2"; shift ;;
    --domain) DOMAIN="$2"; shift ;; --root-url) ROOT_URL="$2"; shift ;;
    --ref) REF="$2"; shift ;; --speech-url) SPEECH_URL="$2"; shift ;;
    --sim-dns) SIM_DNS=1 ;; --rollback) ROLLBACK="$2"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "trunk-deploy: unknown arg: $1" >&2; exit 64 ;;
  esac; shift
done

SSHOPTS="-p $PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ${KEY}"
vps() { ssh $SSHOPTS "$HOST" "$@"; }
say() { printf '\033[1m[trunk]\033[0m %s\n' "$*"; }
die() { say "GATE RED: $*"; say "the old version is untouched. undo anyway: $0 --host $HOST --rollback last"; exit 1; }
TS=$(date +%Y%m%d-%H%M%S)
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)

# ---------- rollback ----------
if [ -n "$ROLLBACK" ]; then
  [[ "$ROLLBACK" =~ ^[a-z0-9-]+$ ]] || { echo "rollback target must be <ts> or last" >&2; exit 64; }
  say "rollback → $ROLLBACK"
  vps "cd /opt/bifrost && t=$ROLLBACK; [ \"\$t\" = last ] && t=\$(ls -1t versions | sed -n 2p); [ -d \"versions/\$t\" ] || { echo \"no such version: \$t\"; exit 1; }; ln -sfn \"versions/\$t\" current && docker compose --project-directory current up -d 2>&1 | tail -2; echo NOW=\$(readlink current)" || die "rollback failed"
  say "rollback done"
  exit 0
fi

[ -n "$HOST" ] && [ -n "$DOMAIN" ] && [ -n "$ROOT_URL" ] || { echo "need --host, --domain, --root-url (see --help)" >&2; exit 64; }
[[ "$ROOT_URL" =~ ^https?://[0-9a-zA-Z.:_-]+$ ]] || die "--root-url must be http(s)://host:port"
[ -f "$REPO/pwa/package-lock.json" ] || die "pwa/package-lock.json missing — run from a full clone"

# ---------- 0 preflight ----------
say "preflight $HOST …"
vps 'echo ok' >/dev/null || die "ssh to $HOST failed"
vps 'command -v systemctl >/dev/null' || die "no systemd"
vps '[ $(awk "/MemTotal/{print \$2}" /proc/meminfo) -gt 1800000 ]' || die "VPS has < 2 GB RAM"
vps 'df / | awk "NR==2{exit !(\$2>8000000)}"' || die "VPS has < 10 GB disk"
vps 'command -v ss >/dev/null && ! ss -ltn | awk "{print \$4}" | grep -E ":(80|443|7880|3000)$"' \
  || say "NOTE: port check skipped or ports busy — if 80/443/7880/3000 are held, gates WILL fail"
if [ "$SIM_DNS" = 0 ]; then
  vps "getent hosts $DOMAIN >/dev/null" || die "$DOMAIN does not resolve from the VPS — point the A record first"
fi
say "preflight ok"

# ---------- 1 deps ----------
vps 'command -v docker >/dev/null && docker compose version >/dev/null 2>&1' || {
  say "installing docker + compose (apt) …"
  vps 'sudo apt-get update -qq && sudo apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1 && sudo systemctl enable --now docker' || die "docker install failed"
}

# ---------- 2 release ----------
say "shipping release $TS (git archive $REF) …"
vps "mkdir -p /opt/bifrost/versions/$TS" || die "cannot create version dir"
git -C "$REPO" archive "$REF" pwa | vps "tar -x -C /opt/bifrost/versions/$TS" || die "git archive failed"
vps "cd /opt/bifrost/versions/$TS && mkdir -p pwa-docker && tar -C pwa --exclude node_modules --exclude .next -cf - . | tar -C pwa-docker -xf -" || die "staging build context failed"
vps "ln -sfn versions/$TS /opt/bifrost/current" || die "cannot point current"

# ---------- 3 secrets (on the VPS, 0600, never printed) ----------
say "secrets: mint on VPS …"
vps 'mkdir -p /opt/bifrost/secrets
if [ ! -s /opt/bifrost/secrets/livekit.env ]; then umask 077; { echo "LIVEKIT_API_KEY=$(openssl rand -hex 16)"; echo "LIVEKIT_API_SECRET=$(openssl rand -hex 32)"; } > /opt/bifrost/secrets/livekit.env; fi
if [ ! -s /opt/bifrost/secrets/pwa.env ]; then umask 077; { echo "BIFROST_AUTH=devices"; echo "BIFROST_ADMIN_TOKEN=$(openssl rand -hex 32)"; } > /opt/bifrost/secrets/pwa.env; fi
chmod 600 /opt/bifrost/secrets/*.env' || die "secret mint failed"

# ---------- 4 config + containers ----------
say "writing livekit + caddy + compose …"
vps "cat > /opt/bifrost/current/livekit.yaml <<'LK'
port: 7880
bind_addresses: [\"0.0.0.0\"]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
logging:
  level: info
LK" || die "livekit.yaml failed"
if [ "$SIM_DNS" = 1 ]; then
  CADDY_BODY=":80
$(cat <<'CDx'
  auto_https off
CDx
)
$DOMAIN:80 {
  handle_path /livekit/* { reverse_proxy 127.0.0.1:7880 }
  handle { reverse_proxy 127.0.0.1:3000 }
}"
  PROTO=http
else
  CADDY_BODY="$DOMAIN {
  handle_path /livekit/* { reverse_proxy 127.0.0.1:7880 }
  handle { reverse_proxy 127.0.0.1:3000 }
}"
  PROTO=https
fi
printf '%s\n' "$CADDY_BODY" | vps "cat > /opt/bifrost/current/Caddyfile" || die "Caddyfile failed"

SPEACH_BLOCK=""
[ -z "$SPEECH_URL" ] && SPEACH_BLOCK='  speaches:
    image: ghcr.io/speaches-ai/speaches:latest-cpu
    restart: unless-stopped
    environment:
      WHISPER__COMPUTE_TYPE: int8
      STT_MODEL_TTL: -1
      TTS_MODEL_TTL: -1
    ports: ["127.0.0.1:8000:8000"]'

vps "cat > /opt/bifrost/current/compose.yml <<CP
name: bifrost
services:
$SPEACH_BLOCK
  livekit:
    image: livekit/livekit-server:latest
    command: --config /etc/livekit.yaml
    restart: unless-stopped
    network_mode: host
    volumes: [\"/opt/bifrost/current/livekit.yaml:/etc/livekit.yaml:ro\"]
    env_file: /opt/bifrost/secrets/livekit.env
  pwa:
    build: /opt/bifrost/current/pwa-docker
    image: bifrost-pwa:$TS
    restart: unless-stopped
    network_mode: host
    environment:
      PORT: \"3000\"
      HOST: \"127.0.0.1\"
      OPENCODE_URL: \"$ROOT_URL\"
      LIVEKIT_URL: \"$PROTO://$DOMAIN/livekit\"
      BIFROST_DEVICES_FILE: \"/data/.devices.json\"
    env_file: /opt/bifrost/secrets/pwa.env
    volumes:
      - bifrost-devices:/data
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    network_mode: host
    volumes:
      - /opt/bifrost/current/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
volumes:
  bifrost-devices:
  caddy_data:
  caddy_config:
CP" || die "compose.yml failed"
vps "cat > /opt/bifrost/current/pwa-docker/Dockerfile <<'DF'
FROM node:24
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build
CMD [\"node\", \"node_modules/next/dist/bin/next\", \"start\", \"-p\", \"3000\", \"-H\", \"127.0.0.1\"]
DF" || die "Dockerfile failed"

say "bringing the trunk up (first image build ~3-6 min) …"
if ! vps 'cd /opt/bifrost && docker compose --project-directory current up -d --build' >/tmp/gochain/compose-up.$$.log 2>&1; then
  tail -15 /tmp/gochain/compose-up.$$.log; die "compose up failed"
fi

# ---------- 5 gates (all before any receipt) ----------
say "gates:"
vps 'sleep 3; curl -sf -m 5 http://127.0.0.1:7880 >/dev/null' || { vps 'docker logs bifrost-livekit-1 2>&1 | tail -5'; die "g1 livekit not answering"; }
say "  g1 livekit up — PASS"
vps 'curl -sf -m 10 http://127.0.0.1:3000/api/build >/dev/null' || { vps 'docker logs bifrost-pwa-1 2>&1 | tail -5'; die "g2 pwa not serving"; }
say "  g2 pwa serves — PASS"
ADMIN=$(vps 'grep BIFROST_ADMIN_TOKEN /opt/bifrost/secrets/pwa.env | cut -d= -f2')
[ -n "$ADMIN" ] && [[ "$ADMIN" =~ ^[0-9a-f]{64}$ ]] || die "admin token missing/malformed on VPS"
MINT=$(vps "curl -s -m 10 -X POST http://127.0.0.1:3000/api/pair -H 'Content-Type: application/json' -H 'Authorization: Bearer $ADMIN' -d '{\"name\":\"gate-check\"}'")
echo "$MINT" | grep -q '"token":"bfnd-' || die "g3 pair mint failed over the origin: $MINT"
say "  g3 pair mints over the origin — PASS"
if [ "$SIM_DNS" = 0 ]; then
  vps "curl -sf -m 20 $PROTO://$DOMAIN/api/build >/dev/null" || die "g4 public $PROTO://$DOMAIN not serving (TLS/DNS)"
  say "  g4 $PROTO://$DOMAIN serves — PASS"
fi

# ---------- 6 receipt (the admin token appears ONCE, here) ----------
say "──────────────────────────────────────────────"
say "TRUNK RECEIPT $(date '+%F %T')"
say "  trunk     $PROTO://$DOMAIN (caddy · livekit$( [ -z "$SPEECH_URL" ] && echo ' · speaches') · pwa)"
say "  brain     $ROOT_URL (the root box, private line)"
say "  version   $TS  (current symlink; a red gate never moved it)"
say "  rollback  $0 --host $HOST --rollback last"
say "  devices   minted tokens live in the VPS volume bifrost-devices (0600 via registry)"
say ""
say "  ▌PAIRING URL — open THIS on the phone (the #admin part is used once):"
say "  ▌$PROTO://$DOMAIN/pair#admin=$ADMIN"
say "──────────────────────────────────────────────"
exit 0
