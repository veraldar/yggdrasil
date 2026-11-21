#!/usr/bin/env bash
# own-trunk-e2e.sh — YOUR OWN TRUNK, the lay procedure (docs/own-trunk.md) end to end in docker: fresh machines,
# the SIGNED release (scripts/release.sh), a simulated phone. No real Let's Encrypt (Pebble, its test server),
# nothing public.
#
#   "internet" 172.31.250.0/24 (docker network ot-net, OT_SUBNET; the phone = this machine at .1)
#     ot-files   .5   a fake GitHub: the release dist/VERSION (signed SHA256SUMS), tampered copies of it, a
#                     newer one for the weekly update — and an outside client (curl)
#     ot-pebble  .6   Let's Encrypt's test ACME server (HTTP-01 on port 80, like the real one)
#     ot-vps-a   .10  trunk.tree.test     Debian 12 + systemd: the release's trunk.sh --self-signed — refuses the
#                                         tampered releases, turns the firewall on, security updates + the weekly
#                                         signed update, :443 direct; at the end --update and --uninstall
#     ot-vps-b   .11  trunk-le.tree.test  Debian 12 + systemd + ufw: trunk.sh with Pebble, certbot standalone on :80
#     ot-vps-c   .12  trunk-px.tree.test  Debian 12 + systemd + an nginx website (www.tree.test) on :80 + :443:
#                     www.tree.test       trunk.sh --behind-proxy, Pebble through nginx's webroot, then :443 shared by
#                                         name with sni-443.py (option A) and nginx stream (option B)
#     ot-home    .20  the home computer: plain debian:12 (no node, no cargo, no git): the release's install.sh
#                     --trunk, the line pasted at its prompt in an interactive shell (never on a command line)
#     ot-mac     .30  another computer (Ubuntu 24.04): the release's join.sh --hub https://trunk.tree.test,
#                     approved on the phone
#     ot-jammy   .40  Ubuntu 22.04 (glibc 2.35): the release installs and runs there; ot-buster (Debian 10, glibc
#                     2.28) is refused plainly before anything is downloaded
#     ot-vps-v   .14  trunk-v.tree.test   a trunk for the voice box
#     ot-voice   .21  Debian 12 with systemd as PID 1 and a real login session: plain bash install.sh --trunk (no
#                     --skip, no --direct) — all seven units, voice /healthz, a paired phone's voice token,
#                     lingering, the disk it takes
#
# Every release in it is a TEST release: scripts/release.sh signs it with a throwaway key made for this run
# (YGG_RELEASE_KEY), its scripts are marked YGG_RELEASE_TEST=1 and trust that key through
# YGG_RELEASE_TEST_SIGNERS. The real release key never signs anything here.
#   the phone: Chromium (Playwright, Pixel 7) on this machine — branch/e2e/own-trunk.spec.ts
#
#   sim/own-trunk-e2e.sh                 every stage; exit 0 = all PASS (the table at the end)
#   OT_STAGES=a,b,c,j,v,u (subset) · OT_REAL_RELEASE=1 adds stage r: trunk.sh against the REAL GitHub release
#   OT_KEEP=1 leaves the containers up · OT_STATE=DIR keeps state + logs there
#   OT_JOINER=deb443: the third machine is a clean Debian 12 whose firewall lets ONLY tcp 443 out (iptables,
#   loopback aside); it fetches the release from the fake GitHub over https on 443 (a CA made for this run)
#   OT_JOIN_MODEL=home: the third machine is given no model — join.sh's default without a terminal, "Same as the
#   home root": after the approval it fetches the home root's model inside its tunnel (check m2). Needs a home
#   brain with GET /root/model (v0.9.1).
#   OT_DIST=DIR: a release made elsewhere (release.sh's dist/VERSION — a draft, a rehearsal), used exactly as it is:
#   nothing is built, its installers' own embedded key decides (a real-stamped one gets no YGG_RELEASE_TEST_SIGNERS).
#   OT_DIST_KEY=FILE: the key that signed it, for the forged/newer releases the tamper and update steps need — never
#   the real release key (refused); without it those steps are SKIP (listed, not counted as passes)
#   OT_VERSION (0.9.0) · OT_REUSE_BUILD=1: re-stage the last release build (release.sh --no-build) instead of
#   building the working tree again (--dirty)
#
# Needs: docker (privileged containers: systemd inside), the internet for apt in the fresh containers and the
# images, zbarimg, ssh-keygen, branch/node_modules (Playwright + its chromium) for the phone.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HERE=$ROOT/sim/own-trunk
STATE=${OT_STATE:-$(mktemp -d /tmp/own-trunk.XXXXXX)}
STAGES=,${OT_STAGES:-a,b,c,j,v,u},; [ "${OT_REAL_RELEASE:-0}" = 1 ] && STAGES="${STAGES}r,"
mkdir -p "$STATE"/{files,sim,log} && chmod 755 "$STATE" "$STATE/sim"
RESULTS=$STATE/results.tsv; : >"$RESULTS"; : >"$STATE/steps.tsv"
# a private /24 (docker's own DNS forwarder serves 172.16/12 networks; the sim needs it for apt)
NET=ot-net SUBNET=${OT_SUBNET:-172.31.250.0/24}; P=${SUBNET%.*}
PHONE_IP=$P.1 IP_FILES=$P.5 IP_PEBBLE=$P.6 IP_A=$P.10 IP_B=$P.11 IP_C=$P.12 IP_R=$P.13 IP_HOME=$P.20 IP_MAC=$P.30
IP_V=$P.14 IP_VOICE=$P.21 IP_JAMMY=$P.40
A=trunk.tree.test B=trunk-le.tree.test C=trunk-px.tree.test WWW=www.tree.test
ALL=(ot-files ot-pebble ot-vps-a ot-vps-b ot-vps-c ot-vps-r ot-vps-v ot-home ot-mac ot-jammy ot-buster ot-voice)
VER=${OT_VERSION:-0.9.0}
DIST=$STATE/dist/$VER                     # this run's TEST release (scripts/release.sh, a throwaway key)
KEY=$STATE/test-key/release_ed25519       # made for this run; never the real release key
GIVEN=${OT_DIST:-} REALSTAMP=0            # OT_DIST: a release made elsewhere, used as it is
if [ -n "$GIVEN" ]; then
  GIVEN=$(cd "$GIVEN" && pwd) || exit 2; VER=${OT_VERSION:-$(basename "$GIVEN")}; DIST=$GIVEN; KEY=${OT_DIST_KEY:-}
  grep -q "^YGG_RELEASE_TEST=''" "$DIST/install.sh" && REALSTAMP=1
fi
TS=/opt/test-signers                      # its allowed_signers line, in every container that runs a script
HU=ana HH=/home/ana                       # the home computer's user
FILES_URL=http://files.tree.test:8000
# trunk.sh / install.sh / join.sh: the fake GitHub's releases, signed by this run's key
TSENV="YGG_RELEASE_TEST_SIGNERS=$TS"; [ $REALSTAMP = 1 ] && TSENV=''   # a real-stamped release trusts its own key only
REL="TRUNK_RELEASES=$FILES_URL/releases $TSENV"
HREL="YGG_RELEASES=$FILES_URL/releases $TSENV"
JOINER=${OT_JOINER:-ubuntu}; JREL=$HREL   # what the third machine runs join.sh with
# the home root's model key in this run: made up, and unmistakable when "Same as the home root" must not leak it
HOME_KEY=mock; [ "${OT_JOIN_MODEL:-}" = home ] && HOME_KEY=mock-home-7c1f0e5a9b3d2468
[ "$JOINER" = deb443 ] && JREL="YGG_RELEASES=https://files.tree.test/releases $TSENV"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
pass() { printf 'PASS\t%s\t%s\n' "$1" "$2" >>"$RESULTS"; printf '\033[32mPASS\033[0m %-5s %s\n' "$1" "$2"; }
fail() { printf 'FAIL\t%s\t%s\t%s\n' "$1" "$2" "${3:-}" >>"$RESULTS"; printf '\033[31mFAIL\033[0m %-5s %s  %s\n' "$1" "$2" "${3:-}"; }
skip() { printf 'SKIP\t%s\t%s\t%s\n' "$1" "$2" "${3:-}" >>"$RESULTS"; printf '\033[33mSKIP\033[0m %-5s %s  %s\n' "$1" "$2" "${3:-}"; }
check() { # ID WHAT CMD… — PASS when CMD exits 0
  local id=$1 what=$2; shift 2
  if "$@" >>"$STATE/log/checks.log" 2>&1; then pass "$id" "$what"; else fail "$id" "$what" "(see log/checks.log)"; fi
}
stage() { case $STAGES in *,"$1",*) return 0 ;; esac; return 1; }
up() { [ -n "$(docker ps -q -f "name=^$1\$")" ]; }
dx() { docker exec "$@"; }
vps() { local c=$1; shift; docker exec "$c" bash -c "$*"; }          # as the VPS admin (sudo)
homesh() { docker exec -u "$HU" ot-home bash -c "$*"; }              # as the home computer's user
outside() { docker exec ot-files bash -c "$*"; }                      # somebody on the internet
export -f dx vps homesh outside
export HU

cleanup() {
  [ "${OT_KEEP:-0}" = 1 ] && { say "kept: containers ${ALL[*]} · network $NET"; return; }
  docker rm -f "${ALL[@]}" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ------------------------------------------------------------------------------------ prerequisites
command -v docker >/dev/null || { echo "docker is needed"; exit 2; }
command -v zbarimg >/dev/null || { echo "zbarimg is needed (zbar)"; exit 2; }
command -v ssh-keygen >/dev/null || { echo "ssh-keygen is needed (openssh)"; exit 2; }
[ -d "$ROOT/branch/node_modules/@playwright/test" ] || { echo "the phone needs Playwright: (cd branch && npm ci && npx playwright install chromium)"; exit 2; }
if [ -z "$GIVEN" ]; then
  # this run's release key: a throwaway, and its allowed_signers line (what YGG_RELEASE_TEST_SIGNERS points at)
  mkdir -p "$STATE/test-key" && rm -f "$KEY" "$KEY.pub"
  ssh-keygen -q -t ed25519 -N '' -C release@yggdrasil -f "$KEY" </dev/null
  printf 'release@yggdrasil namespaces="yggdrasil-release" %s\n' "$(cut -d' ' -f1-2 "$KEY.pub")" >"$STATE/test-signers"
  chmod 644 "$STATE/test-signers"
  say "a TEST release of the working tree, signed by this run's throwaway key: scripts/release.sh $VER"
  BUILD_FLAG=--dirty; [ "${OT_REUSE_BUILD:-0}" = 1 ] && BUILD_FLAG=--no-build
  YGG_RELEASE_KEY=$KEY DIST=$STATE/dist "$ROOT/scripts/release.sh" "$VER" "$BUILD_FLAG" >"$STATE/log/release.log" 2>&1 ||
    { tail -20 "$STATE/log/release.log"; exit 2; }
  ssh-keygen -Y verify -f "$STATE/test-signers" -I release@yggdrasil -n yggdrasil-release -s "$DIST/SHA256SUMS.sig" \
    <"$DIST/SHA256SUMS" >/dev/null 2>&1 || { echo "$DIST/SHA256SUMS is not signed by this run's key"; exit 2; }
  ! ssh-keygen -Y verify -f "$ROOT/allowed_signers" -I release@yggdrasil -n yggdrasil-release -s "$DIST/SHA256SUMS.sig" \
    <"$DIST/SHA256SUMS" >/dev/null 2>&1 || { echo "the test release verifies against the REAL key — refusing to go on"; exit 2; }
  grep -q "^YGG_RELEASE_TEST='1'" "$DIST/install.sh" || { echo "the test release's scripts are not marked YGG_RELEASE_TEST=1"; exit 2; }
else
  say "the release in $DIST (v$VER), used as it is$( [ $REALSTAMP = 1 ] && echo ': real-stamped, its own embedded key decides')"
  # whom it trusts: the allowed_signers line its installers embed (a test release: the key given)
  if [ $REALSTAMP = 1 ]; then sed -n "s/^YGG_SIGNER='\(.*\)'\$/\1/p" "$DIST/install.sh" | head -1 >"$STATE/test-signers"
  else printf 'release@yggdrasil namespaces="yggdrasil-release" %s\n' "$(ssh-keygen -y -f "$KEY" | cut -d' ' -f1-2)" >"$STATE/test-signers"; fi
  chmod 644 "$STATE/test-signers"
  ssh-keygen -Y verify -f "$STATE/test-signers" -I release@yggdrasil -n yggdrasil-release -s "$DIST/SHA256SUMS.sig" \
    <"$DIST/SHA256SUMS" >/dev/null 2>&1 || { echo "$DIST/SHA256SUMS is not signed by the key its installers trust"; exit 2; }
  (cd "$DIST" && sha256sum -c --quiet SHA256SUMS) || { echo "$DIST does not match its SHA256SUMS"; exit 2; }
  if [ -n "$KEY" ]; then
    kp=$(ssh-keygen -y -f "$KEY" | cut -d' ' -f1-2)
    [ "$kp" != "$(cut -d' ' -f1-2 "$ROOT/RELEASE-KEY.pub")" ] || { echo "OT_DIST_KEY is the REAL release key: it never signs a test release — refusing"; exit 2; }
    grep -qF "$kp" "$STATE/test-signers" || { echo "OT_DIST_KEY did not sign $DIST"; exit 2; }
  fi
fi
to_box() { # CONTAINER — this run's signers file at $TS (readable by everyone there)
  docker cp "$STATE/test-signers" "$1:$TS" >/dev/null && docker exec "$1" chmod 644 "$TS"
}
TGZ=yggdrasil-$VER-linux-x86_64.tar.gz
docker rm -f "${ALL[@]}" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
say "images"
docker build -q -t ot-vps:12 -f "$HERE/vps.Dockerfile" "$HERE" >/dev/null || exit 2
for i in node:24 debian:12 debian:10 ubuntu:22.04 ubuntu:24.04 ghcr.io/letsencrypt/pebble:latest; do
  docker image inspect "$i" >/dev/null 2>&1 || docker pull -q "$i" >/dev/null
done
# the binaries the release built (stage b/c pass the trunk's own file with --binary)
mkdir -p "$STATE/bin"
tar -xzf "$DIST/$TGZ" -C "$STATE/bin" --strip-components=2 "yggdrasil-$VER/bin/bifrost-net" "yggdrasil-$VER/bin/yggdrasil"

# ---- the fake GitHub: the release as published, plus the releases an attacker (or a newer version) would serve
R=$STATE/files/releases
mkrel() { # VERSION MODE — releases/download/vVERSION from dist (assets renamed to VERSION, trunk.sh stamped
  #         with it), SHA256SUMS signed with the release key; MODE: good | sums (SHA256SUMS changed after
  #         signing) | asset (the binary + archive changed after) | nosig | otherkey (signed by another key) |
  #         broken (signed, but its bifrost-net never serves: the update must roll back)
  local v=$1 mode=$2 d=$R/download/v$1 f
  mkdir -p "$d"
  for f in "$DIST"/*; do
    case $(basename "$f") in SHA256SUMS|SHA256SUMS.sig) continue ;; esac
    cp "$f" "$d/$(basename "$f" | sed "s/$VER/$v/g")"
  done
  sed -i "s/^YGG_RELEASE='[^']*'/YGG_RELEASE='$v'/" "$d/trunk.sh" "$d/install.sh" "$d/join.sh"
  if [ "$mode" = broken ]; then
    printf '#!/bin/sh\n# a signed release whose access point dies at once\n[ "$1" = ap-token ] && exit 0\necho "broken release: $*" >&2\nexit 1\n' \
      >"$d/bifrost-net-$v-linux-x86_64"
  fi
  (cd "$d" && sha256sum -- * | LC_ALL=C sort -k2 >SHA256SUMS)
  if [ "$mode" = otherkey ]; then
    ssh-keygen -q -t ed25519 -N '' -C release@yggdrasil -f "$STATE/otherkey" <<<y >/dev/null 2>&1 || true
    ssh-keygen -q -Y sign -f "$STATE/otherkey" -n yggdrasil-release "$d/SHA256SUMS" </dev/null
  elif [ "$mode" != nosig ]; then
    ssh-keygen -q -Y sign -f "$KEY" -n yggdrasil-release "$d/SHA256SUMS" </dev/null
  fi
  case $mode in
    sums) sed -i -E '1s/^0/X/; 1s/^[1-9a-f]/0/; 1s/^X/1/' "$d/SHA256SUMS" ;;   # one hash, one digit off
    asset) printf 'x' >>"$d/bifrost-net-$v-linux-x86_64"; printf 'x' >>"$d/yggdrasil-$v-linux-x86_64.tar.gz" ;;
  esac
}
latest() { rm -rf "$R/latest"; mkdir -p "$R/latest"; cp -r "$R/download/v$1" "$R/latest/download"; chmod -R a+rX "$STATE/files"; }
mkdir -p "$R/download/v$VER" && cp "$DIST"/* "$R/download/v$VER/"   # the release exactly as release.sh made it
if [ -n "$KEY" ]; then   # (OT_DIST without OT_DIST_KEY: no forged/newer releases — their steps are SKIP)
  mkrel 9.9.1 sums; mkrel 9.9.2 asset; mkrel 9.9.3 nosig; mkrel 9.9.4 otherkey
  mkrel 0.9.1-test good; mkrel 0.9.2-test sums; mkrel 0.9.3-test broken   # the weekly update: newer, forged, broken
fi
latest "$VER"

# ---- Pebble: HTTP-01 on port 80 like Let's Encrypt; no random nonce rejects, no sleeps (deterministic)
cat >"$STATE/pebble.json" <<'JSON'
{"pebble": {"listenAddress": "0.0.0.0:14000", "managementListenAddress": "0.0.0.0:15000",
  "certificate": "test/certs/localhost/cert.pem", "privateKey": "test/certs/localhost/key.pem",
  "httpPort": 80, "tlsPort": 443, "ocspResponderURL": "", "externalAccountBindingRequired": false,
  "keyAlgorithm": "ecdsa", "profiles": {"default": {"description": "90 days", "validityPeriod": 7776000}}}}
JSON
chmod 644 "$STATE/pebble.json"

say "network $NET ($SUBNET) — state + logs: $STATE"
docker network create --subnet "$SUBNET" "$NET" >/dev/null || exit 2
docker run -d --name ot-files --hostname files --network "$NET" --ip "$IP_FILES" --network-alias files.tree.test \
  -v "$STATE/files:/files:ro" -v "$STATE/sim:/sim" node:24 python3 -m http.server 8000 -d /files >/dev/null
if [ "$JOINER" = deb443 ]; then # the fake GitHub on https :443 too, with a certificate from a CA made for this run
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj /CN=rig-ca \
    -keyout "$STATE/sim/rig-ca.key" -out "$STATE/sim/rig-ca.pem" 2>/dev/null &&
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=files.tree.test \
    -keyout "$STATE/sim/files.key" -out "$STATE/sim/files.csr" 2>/dev/null &&
  openssl x509 -req -in "$STATE/sim/files.csr" -CA "$STATE/sim/rig-ca.pem" -CAkey "$STATE/sim/rig-ca.key" -CAcreateserial \
    -days 2 -extfile <(printf 'subjectAltName=DNS:files.tree.test\n') -out "$STATE/sim/files.pem" 2>/dev/null || exit 2
  chmod 644 "$STATE/sim/files.key" "$STATE/sim/files.pem" "$STATE/sim/rig-ca.pem"
  docker exec -d ot-files python3 -c 'import http.server, ssl, functools
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory="/files")
s = http.server.ThreadingHTTPServer(("0.0.0.0", 443), h)
c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain("/sim/files.pem", "/sim/files.key")
s.socket = c.wrap_socket(s.socket, server_side=True); s.serve_forever()'
fi
docker run -d --name ot-pebble --network "$NET" --ip "$IP_PEBBLE" --network-alias pebble \
  -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 -e PEBBLE_AUTHZREUSE=0 \
  -v "$STATE/pebble.json:/pebble.json:ro" ghcr.io/letsencrypt/pebble:latest -config /pebble.json >/dev/null
docker cp ot-pebble:/test/certs/pebble.minica.pem "$STATE/sim/pebble-acme-ca.pem" >/dev/null
for _ in $(seq 30); do outside "curl -sk -o /sim/pebble-root.pem https://pebble:15000/roots/0" && [ -s "$STATE/sim/pebble-root.pem" ] && break; sleep 1; done

new_vps() { # NAME IP ALIAS… — a fresh Debian 12 server with systemd as PID 1
  local n=$1 ip=$2; shift 2
  local al=(); for a in "$@"; do al+=(--network-alias "$a"); done
  docker run -d --name "$n" --hostname "${n#ot-}" --network "$NET" --ip "$ip" "${al[@]}" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock ot-vps:12 >/dev/null
  for _ in $(seq 30); do s=$(dx "$n" systemctl is-system-running 2>/dev/null || true); case $s in running|degraded) break ;; esac; sleep 1; done
}
# the connect line trunk.sh prints on a line of its own (and its pin)
line_of() { grep -o 'wss://[^ ]*#pin=[0-9A-F:]*,token=[0-9a-f]*' "$1" | tail -1; }
pin_of() { line_of "$1" | sed -n 's/.*#pin=\([0-9A-F:]*\),token=.*/\1/p'; }
reg_sum() { homesh 'sha256sum < ~/.local/state/bifrost/devices.json' | cut -c1-16; }
run_phone() { # SCOPE AP_URL AP_IP STEPS_FILE
  ( cd "$ROOT/branch" && OT_SCOPE=$1 OT_AP_URL=$2 OT_AP_IP=$3 OT_STATE="$STATE/sim" OT_STEPS=$4 OT_PHONE_IP=$PHONE_IP \
      OT_HUB_NAME=home-pc OT_HOME_USER=$HU OT_INSTALL_CMD="bash $HH/install.sh" \
      OT_JOIN_CMD="$JREL bash /home/ubuntu/join.sh" \
      PW_BASE_URL=$2 npx playwright test e2e/own-trunk.spec.ts --reporter=list ) >>"$STATE/log/phone.log" 2>&1
}
INSTALL_ARGS="--direct --skip voice,livekit,agent --upstream-env ~/model.env"
install_home() { # LOGNAME LINE — again: the line on stdin (a script, not a terminal), never in an argument
  local log=$1 line=$2
  printf '%s\n' "$line" | docker exec -i -u "$HU" ot-home bash -c "cd ~ && $HREL bash install.sh $INSTALL_ARGS --trunk" >"$STATE/log/$log" 2>&1
}
lay_install() { # LOGNAME LINE — the lay user at the home computer's terminal: an interactive shell on a tty;
  #               types the command, waits for the prompt, pastes the line. The shell keeps its history.
  local log=$STATE/log/$1 line=$2
  : >"$log"; rm -f "$STATE/sim/lay.done"
  ( while [ ! -e "$STATE/sim/lay.done" ]; do docker exec ot-home ps -eo args 2>/dev/null | grep -c 'token=' >>"$STATE/log/home-ps-samples.txt"; sleep 0.3; done ) &
  local sampler=$!
  {
    printf '%s\n' "cd ~ && $HREL bash install.sh $INSTALL_ARGS --trunk; echo \"INSTALL-EXIT=\$?\""
    for _ in $(seq 600); do grep -q 'connect line (not shown)' "$log" 2>/dev/null && break; sleep 0.5; done
    sleep 0.5; printf '%s\n' "$line"
    for _ in $(seq 900); do grep -q 'INSTALL-EXIT=[0-9]' "$log" 2>/dev/null && break; sleep 1; done
    printf 'exit\n'; sleep 3
  } | docker exec -i -u "$HU" -e HOME="$HH" ot-home script -qefc 'bash -i' /dev/null >"$log" 2>&1
  : >"$STATE/sim/lay.done"; wait "$sampler" 2>/dev/null
  sed -n 's/.*INSTALL-EXIT=\([0-9]*\).*/\1/p' "$log" | tail -1 | grep -qx 0
}

# ---- n0: the version order (a pre-release is OLDER than its release) — the same function in all three scripts
newer_ok() {
  local f
  for f in trunk/install/trunk.sh root/install/install.sh root/install/join.sh; do
    bash -c 'set -euo pipefail; eval "$(sed -n "/^newer() {/,/^}/p" "$1")"
      t() { if newer "$1" "$2"; then r=true; else r=false; fi; [ "$r" = "$3" ] || { echo "$0: newer $1 $2 → $r, not $3"; exit 1; }; }
      t 0.9.1-test 0.9.1 false; t 0.9.1 0.9.1-test true; t 0.9.1-test 0.9.0 true; t 0.9.0 0.9.0 false
      t 0.10.0 0.9.9 true; t 0.9.1-rc.2 0.9.1-rc.1 true; t 0.9.2-test 0.9.1-test true' "$f" "$ROOT/$f" || return 1
  done
}
check n0 "newer(): 0.9.1-test < 0.9.1 < 0.10.0, rc.1 < rc.2 — in trunk.sh, install.sh and join.sh" newer_ok

# =========================================================================================== stage a
LINE_A=''
if stage a; then
  say "stage a: a fresh VPS, the release's trunk.sh --self-signed (signed, checked), firewall + updates on"
  new_vps ot-vps-a "$IP_A" "$A"; to_box ot-vps-a
  docker cp "$DIST/trunk.sh" ot-vps-a:/root/trunk.sh >/dev/null   # the one file a user downloads
  # a real release's trunk.sh (YGG_RELEASE_TEST unset) never trusts other signers; a changed trunk.sh stops itself
  vps ot-vps-a "sed \"s/^YGG_RELEASE_TEST='1'/YGG_RELEASE_TEST=''/\" /root/trunk.sh >/root/trunk-real.sh &&
    cp /root/trunk.sh /root/trunk-changed.sh && echo '# one line more' >>/root/trunk-changed.sh"
  vps ot-vps-a "cd /root && $REL YGG_RELEASE_TEST_SIGNERS=$TS bash trunk-real.sh --name $A --self-signed -y" >"$STATE/log/a0p-real.log" 2>&1; rc=$?
  check a0p "a real release's trunk.sh with YGG_RELEASE_TEST_SIGNERS set refuses (64) before anything — it trusts only the release key" \
    bash -c "[ $rc = 64 ] && grep -q 'it trusts only the yggdrasil release key' '$STATE/log/a0p-real.log' && ! grep -q 'release:' '$STATE/log/a0p-real.log'"
  vps ot-vps-a "cd /root && $REL bash trunk-changed.sh --name $A --self-signed -y" >"$STATE/log/a0s-changed.log" 2>&1; rc=$?
  check a0s "a trunk.sh that is not the one the release signed (one line more) stops before it installs anything" \
    bash -c "[ $rc = 1 ] && grep -q 'is not the one release v$VER signed' '$STATE/log/a0s-changed.log' && \
      ! docker exec ot-vps-a test -e /usr/local/lib/yggdrasil-trunk/bifrost-net"
  if [ -n "$KEY" ]; then
  for v in 9.9.1 9.9.3 9.9.4; do
    vps ot-vps-a "cd /root && $REL bash trunk.sh --name $A --self-signed --version v$v -y" >"$STATE/log/a0-$v.log" 2>&1; echo "rc=$?" >>"$STATE/log/a0-$v.log"
  done
  check a0 "a forged release is refused before anything runs: SHA256SUMS changed / unsigned / another key, nothing installed" \
    bash -c "grep -q 'NOT signed by the yggdrasil release key' '$STATE/log/a0-9.9.1.log' && grep -q 'rc=1' '$STATE/log/a0-9.9.1.log' && \
      grep -q 'has no signature (SHA256SUMS.sig)' '$STATE/log/a0-9.9.3.log' && grep -q 'rc=1' '$STATE/log/a0-9.9.3.log' && \
      grep -q 'NOT signed by the yggdrasil release key' '$STATE/log/a0-9.9.4.log' && grep -q 'rc=1' '$STATE/log/a0-9.9.4.log' && \
      ! docker exec ot-vps-a test -e /usr/local/lib/yggdrasil-trunk/bifrost-net && ! docker exec ot-vps-a test -e /etc/yggdrasil-trunk"
  vps ot-vps-a "cd /root && $REL bash trunk.sh --name $A --self-signed --version v9.9.2 -y" >"$STATE/log/a0-9.9.2.log" 2>&1; rc=$?
  check a0b "a release whose binary was changed after signing: signature OK, sha256 refused, nothing installed" \
    bash -c "[ $rc != 0 ] && grep -q 'signature OK' '$STATE/log/a0-9.9.2.log' && grep -q 'does not match SHA256SUMS' '$STATE/log/a0-9.9.2.log' && \
      ! docker exec ot-vps-a test -e /usr/local/lib/yggdrasil-trunk/bifrost-net"
  else
    skip a0 "a forged release is refused before anything runs" "needs a re-signed release (OT_DIST_KEY)"
    skip a0b "a release changed after signing: sha256 refused" "needs a re-signed release (OT_DIST_KEY)"
  fi
  vps ot-vps-a "cd /root && $REL bash trunk.sh --name $A --self-signed" >"$STATE/log/a1-trunk.log" 2>&1; rc=$?
  LINE_A=$(line_of "$STATE/log/a1-trunk.log"); PIN_A=$(pin_of "$STATE/log/a1-trunk.log")
  check a1 "trunk.sh --name $A --self-signed (pinned to v$VER) → exit 0, ONE connect line, no command holding it" \
    bash -c "[ $rc = 0 ] && [ -n '$LINE_A' ] && [ \$(grep -c 'token=' '$STATE/log/a1-trunk.log') = 1 ] && \
      ! grep -q -- \"--trunk '\" '$STATE/log/a1-trunk.log' && grep -q 'bash install.sh --trunk\$' '$STATE/log/a1-trunk.log' && \
      grep -q 'binary: .*bifrost-net-$VER-linux-x86_64' '$STATE/log/a1-trunk.log'"
  check a2 "the service runs as a dynamic user (not root), key 600 root, ap.toml holds only the token's sha256" \
    vps ot-vps-a "systemctl is-active -q yggdrasil-trunk && [ \"\$(ps -o user= -C bifrost-net)\" != root ] && \
      [ \"\$(stat -c '%a %U' /etc/yggdrasil-trunk/key.pem)\" = '600 root' ] && \
      ! grep -rq '${LINE_A##*token=}' /etc/yggdrasil-trunk/ && grep -q \"\$(printf %s '${LINE_A##*token=}' | sha256sum | cut -c1-64)\" /etc/yggdrasil-trunk/ap.toml"
  check a3 "ufw was off: trunk.sh turned it on — 22 + 443 open, 80 not (self-signed); the outside reaches the trunk (503)" \
    bash -c "docker exec ot-vps-a ufw status | grep -q '^Status: active' && docker exec ot-vps-a ufw status | grep -q '^22/tcp.*ALLOW' && \
      docker exec ot-vps-a ufw status | grep -q '^443/tcp.*ALLOW' && ! docker exec ot-vps-a ufw status | grep -q '^80/tcp' && \
      [ \"\$(outside \"curl -sk -o /dev/null -w '%{http_code}' https://$A/\")\" = 503 ]"
  check a3u "updates on: unattended-upgrades (apt's daily timers) + the weekly signed trunk update timer" \
    vps ot-vps-a "grep -q '^APT::Periodic::Unattended-Upgrade \"1\";' /etc/apt/apt.conf.d/20auto-upgrades && \
      dpkg-query -W -f '\${Status}' unattended-upgrades | grep -q 'ok installed' && systemctl is-enabled -q apt-daily-upgrade.timer && \
      systemctl is-enabled -q yggdrasil-trunk-update.timer && systemctl is-active -q yggdrasil-trunk-update.timer && \
      grep -q 'ExecStart=/usr/local/sbin/yggdrasil-trunk --update' /etc/systemd/system/yggdrasil-trunk-update.service"
  check a4 "the pin is the SPKI of the key (bifrost-net ap-pin of the served cert = the line's pin)" \
    vps ot-vps-a "[ \"\$(/usr/local/lib/yggdrasil-trunk/bifrost-net ap-pin /etc/yggdrasil-trunk/cert.pem)\" = 'pin = \"sha-256 $PIN_A\"' ]"
  KEYSUM=$(vps ot-vps-a 'sha256sum </etc/yggdrasil-trunk/key.pem')
  vps ot-vps-a "cd /root && $REL bash trunk.sh" >"$STATE/log/a5-rerun.log" 2>&1; rc=$?
  check a5 "re-run (no options): exit 0, same key + pin + token, no new connect line, binary unchanged" \
    bash -c "[ $rc = 0 ] && [ \"\$(docker exec ot-vps-a bash -c 'sha256sum </etc/yggdrasil-trunk/key.pem')\" = '$KEYSUM' ] && \
      grep -q 'token kept' '$STATE/log/a5-rerun.log' && ! grep -q 'token=' '$STATE/log/a5-rerun.log' && \
      grep -q 'pin: sha-256 $PIN_A' '$STATE/log/a5-rerun.log' && grep -q 'binary: .*unchanged' '$STATE/log/a5-rerun.log'"
  docker cp ot-vps-a:/etc/yggdrasil-trunk/cert.pem "$STATE/sim/trunk-ca.pem" >/dev/null; chmod 644 "$STATE/sim/trunk-ca.pem"
  # deb443: the third machine's --cacert also has to trust the fake GitHub's https (the real one is a public CA)
  [ "$JOINER" = deb443 ] && cat "$STATE/sim/rig-ca.pem" >>"$STATE/sim/trunk-ca.pem"
  # the weekly update trusts this run's throwaway key too (a drop-in: test plumbing, not trunk.sh's) — a test release
  # only: a real-stamped one (OT_DIST) trusts the key it embeds, and refuses the override
  if [ $REALSTAMP = 0 ]; then
    vps ot-vps-a "mkdir -p /etc/systemd/system/yggdrasil-trunk-update.service.d && printf '[Service]\nEnvironment=YGG_RELEASE_TEST_SIGNERS=$TS\n' \
      >/etc/systemd/system/yggdrasil-trunk-update.service.d/test-signers.conf && systemctl daemon-reload"
  fi

  # ------------------------------------------------------------------------------- the home computer
  say "stage a: a plain Debian 12 home computer — the release's install.sh, the line pasted at its prompt"
  docker run -d --name ot-home --hostname home-pc --network "$NET" --ip "$IP_HOME" \
    -v "$ROOT/root/mock:/mock:ro" -v "$STATE/sim:/sim" debian:12 sleep infinity >/dev/null
  # what root/install/README.md says to install first (+ the test's own eyes: iproute2 for ss, procps for ps)
  dx ot-home bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      curl ca-certificates openssh-client libopus0 python3 iproute2 procps >/dev/null && useradd -m -s /bin/bash '"$HU" >"$STATE/log/home-apt.log" 2>&1
  docker cp "$DIST/install.sh" ot-home:"$HH/install.sh" >/dev/null && dx ot-home chown "$HU:$HU" "$HH/install.sh"   # the one file downloaded
  to_box ot-home
  homesh 'mkdir -p ~/mock && cd ~/mock && (setsid nohup python3 /mock/mock_upstream.py 18397 >mock.log 2>&1 &) &&
    printf "YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18397\nYGG_UPSTREAM_STYLE=anthropic\nYGG_UPSTREAM_API_KEY='"$HOME_KEY"'\nYGG_UPSTREAM_MODEL=mock\n" >~/model.env'
  check h0 "the home computer has no node, npm, cargo, rustc or git (the release brings what it needs)" \
    homesh '! command -v node && ! command -v npm && ! command -v cargo && ! command -v rustc && ! command -v git'
  if [ -n "$KEY" ]; then
  for v in 9.9.1 9.9.2; do
    printf '%s\n' "$LINE_A" | docker exec -i -u "$HU" ot-home bash -c "cd ~ && $HREL bash install.sh --version $v $INSTALL_ARGS --trunk" >"$STATE/log/h0-$v.log" 2>&1
    echo "rc=$?" >>"$STATE/log/h0-$v.log"
  done
  check h0t "install.sh refuses a forged release: SHA256SUMS changed (signature) / the archive changed (sha256); nothing unpacked" \
    bash -c "grep -q 'NOT signed by the yggdrasil release key' '$STATE/log/h0-9.9.1.log' && grep -q 'rc=1' '$STATE/log/h0-9.9.1.log' && \
      grep -q 'does not match SHA256SUMS' '$STATE/log/h0-9.9.2.log' && grep -q 'rc=1' '$STATE/log/h0-9.9.2.log' && \
      ! docker exec ot-home test -e $HH/.local/share/yggdrasil/release/9.9.2 && ! docker exec ot-home test -e $HH/.config/bifrost"
  else
    skip h0t "install.sh refuses a forged release" "needs a re-signed release (OT_DIST_KEY)"
  fi
  homesh "sed \"s/^YGG_RELEASE_TEST='1'/YGG_RELEASE_TEST=''/\" ~/install.sh >~/install-real.sh && cp ~/install.sh ~/install-changed.sh && echo '# one line more' >>~/install-changed.sh"
  homesh "cd ~ && $HREL YGG_RELEASE_TEST_SIGNERS=$TS bash install-real.sh $INSTALL_ARGS" >"$STATE/log/h0p-real.log" 2>&1 </dev/null; rc=$?
  homesh "cd ~ && $HREL bash install-changed.sh $INSTALL_ARGS" >"$STATE/log/h0s-changed.log" 2>&1 </dev/null; rc2=$?
  check h0p "a real release's install.sh with YGG_RELEASE_TEST_SIGNERS set refuses (64) before downloading anything" \
    bash -c "[ $rc = 64 ] && grep -q 'it trusts only the yggdrasil release key' '$STATE/log/h0p-real.log' && ! grep -q 'release:' '$STATE/log/h0p-real.log'"
  check h0s "an install.sh that is not the one the release signed stops before it downloads the archive" \
    bash -c "[ $rc2 = 1 ] && grep -q 'is not the one release v$VER signed' '$STATE/log/h0s-changed.log' && \
      ! grep -q 'yggdrasil-$VER-linux-x86_64.tar.gz' '$STATE/log/h0s-changed.log' && ! docker exec ot-home test -e $HH/.local/share/yggdrasil/release/$VER"
  lay_install h1-install.log "$LINE_A"; rc=$?
  check h1 "bash install.sh --trunk (typed), the line pasted at the prompt: exit 0, health 'trunk https://$A/pair → 200'" \
    bash -c "[ $rc = 0 ] && grep -q 'trunk   https://$A/pair → 200' '$STATE/log/h1-install.log' && grep -q 'signature OK' '$STATE/log/h1-install.log'"
  TOK=${LINE_A##*token=}
  check h1s "no secret on a command line: not in ~/.bash_history, not in ps (sampled all along), not on the screen" \
    bash -c "docker exec -u $HU ot-home grep -q 'install.sh .*--trunk' $HH/.bash_history && ! docker exec -u $HU ot-home grep -q 'token=' $HH/.bash_history && \
      [ -s '$STATE/log/home-ps-samples.txt' ] && ! grep -q '^[1-9]' '$STATE/log/home-ps-samples.txt' && \
      ! docker exec ot-home ps -eo args | grep -q 'token=' && ! grep -q '$TOK' '$STATE/log/h1-install.log'"
  check h1r "installed from the release: unpacked + checked (.verified), the app on the release's own node 24" \
    bash -c "docker exec ot-home test -f $HH/.local/share/yggdrasil/release/$VER/.verified && \
      docker exec ot-home ps -eo args | grep -q '^$HH/.local/share/yggdrasil/release/$VER/bin/node server.mjs' && \
      docker exec -u $HU ot-home grep -q 'yggdrasil $VER' $HH/.config/bifrost/install-manifest.txt"
  check h2 "bridge.toml [ap] url+pin+token+upstream, root-link on; app: devices, https://$A, loopback only" \
    homesh "c=~/.config/bifrost; grep -q '^url = \"wss://$A/ap\"' \$c/bridge.toml && grep -q '^pin = \"sha-256 $PIN_A\"' \$c/bridge.toml && \
      grep -q '^upstream = \"127.0.0.1:8082\"' \$c/bridge.toml && grep -q '^enabled = true' \$c/bridge.toml && \
      grep -qx 'BIFROST_PUBLIC_URL=https://$A' \$c/app.env && grep -qx 'HOST=127.0.0.1' \$c/app.env && \
      grep -qx 'BIFROST_AUTH=devices' \$c/app.env && grep -qx 'BIFROST_TRUST_PROXY=1' \$c/app.env && \
      grep -qx 'BIFROST_ROOTLINK_URL=wss://$A/rootlink' \$c/app.env && grep -q '^YGG_PEER_TOKEN=peer-' \$c/app.env && \
      ss -Hltn 'sport = :8082' | awk '{print \$4}' | grep -qx '127.0.0.1:8082'"
  check h3 "the brain: YGG_ROOT_NAME=home-pc, YGG_PEERS_FROM = the hub's WireGuard node (up), the app's peer token" \
    homesh "e=~/.config/yggdrasil/yggdrasil.env; grep -qx 'YGG_ROOT_NAME=home-pc' \$e && grep -qx 'YGG_PEERS_FROM=http://127.0.0.1:7893/_wg/_roots' \$e && \
      grep -qx 'YGG_PEERS_VIA=http://127.0.0.1:7893/_wg/{id}' \$e && curl -sf -o /dev/null 127.0.0.1:7893/_wg && \
      grep -qx 'wg_relay = \"127.0.0.1:7895\"' ~/.config/bifrost/bridge.toml && grep -q '^BIFROST_WG_PUB_FILE=' ~/.config/bifrost/app.env && \
      [ \"\$(sed -n 's/^YGG_PEER_TOKEN=//p' \$e)\" = \"\$(sed -n 's/^YGG_PEER_TOKEN=//p' ~/.config/bifrost/app.env)\" ] && curl -s 127.0.0.1:4100/root | grep -q '\"name\":\"home-pc\"'"
  check h4 "from the internet: /pair 200, /api/* 401 at the edge, /_roots 404 (the trunk shows nothing private)" \
    outside "[ \"\$(curl -sk -o /dev/null -w '%{http_code}' https://$A/pair)\" = 200 ] && [ \"\$(curl -sk -o /dev/null -w '%{http_code}' https://$A/api/session)\" = 401 ] && \
      [ \"\$(curl -sk -o /dev/null -w '%{http_code}' https://$A/_roots)\" = 404 ]"

  # ------------------------------------------------------------------------------- the third machine
  JIMG=ubuntu:24.04 JCAP=(); [ "$JOINER" = deb443 ] && JIMG=debian:12 JCAP=(--cap-add NET_ADMIN)
  docker run -d --name ot-mac --hostname mac-studio --network "$NET" --ip "$IP_MAC" "${JCAP[@]}" \
    -v "$ROOT/root/mock:/mock:ro" -v "$STATE/sim:/sim" "$JIMG" sleep infinity >/dev/null
  dx ot-mac bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3 ca-certificates curl openssh-client procps >/dev/null && (id ubuntu >/dev/null 2>&1 || useradd -m ubuntu)' >"$STATE/log/mac-apt.log" 2>&1
  if [ "$JOINER" = deb443 ]; then # from here on ONLY tcp 443 leaves this machine (loopback aside: docker's DNS, the mock)
    dx ot-mac bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends iptables >/dev/null &&
      iptables -A OUTPUT -o lo -j ACCEPT && iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT &&
      iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT && iptables -P OUTPUT DROP &&
      ip6tables -A OUTPUT -o lo -j ACCEPT && ip6tables -P OUTPUT DROP' >>"$STATE/log/mac-apt.log" 2>&1
    check j0 "the third machine: Debian 12, only tcp 443 out (:8000 and udp are dropped, https :443 answers)" \
      bash -c "docker exec ot-mac grep -q 'VERSION_ID=\"12\"' /etc/os-release && \
        ! docker exec ot-mac curl -s -m 5 -o /dev/null http://files.tree.test:8000/ && \
        docker exec ot-mac curl -sf -m 5 --cacert /sim/rig-ca.pem -o /dev/null https://files.tree.test/releases/download/v$VER/SHA256SUMS"
  fi
  docker cp "$DIST/join.sh" ot-mac:/home/ubuntu/join.sh >/dev/null && dx ot-mac chown ubuntu:ubuntu /home/ubuntu/join.sh
  to_box ot-mac
  dx -u ubuntu ot-mac bash -c 'mkdir -p ~/mock && cd ~/mock && (setsid nohup python3 /mock/mock_upstream.py 18397 >mock.log 2>&1 &) &&
    printf "YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18397\nYGG_UPSTREAM_STYLE=anthropic\nYGG_UPSTREAM_API_KEY=mock\nYGG_UPSTREAM_MODEL=mock\n" >~/model.env'

  # ------------------------------------------------------------------------------------------ phone
  say "stage a: the phone (Chromium) — pair, MAIN, join + approve, delegate, report home, revoke"
  run_phone full "https://$A" "$IP_A" "$STATE/sim/steps.tsv"; rc=$?
  check p "the phone walk through https://$A (table below; playwright exit $rc)" bash -c "[ $rc = 0 ]"
  if [ "${OT_JOIN_MODEL:-}" = home ]; then
    check m2 "Same as the home root: given no model, the third machine holds the home root's (address, kind, model, key) after the approval — fetched inside its tunnel; the key is in none of its logs" \
      bash -c "h=\$(docker exec -u $HU ot-home grep -E '^YGG_UPSTREAM_(BASE_URL|STYLE|MODEL|API_KEY)=' $HH/.config/yggdrasil/yggdrasil.env | sort) &&
        m=\$(docker exec ot-mac grep -E '^YGG_UPSTREAM_(BASE_URL|STYLE|MODEL|API_KEY)=' /home/ubuntu/.local/share/yggdrasil-root/brain.env | sort) &&
        [ -n \"\$h\" ] && [ \"\$h\" = \"\$m\" ] && echo \"\$m\" | grep -q 'API_KEY=$HOME_KEY' &&
        grep -q 'asking the home root for its own' '$STATE/sim/join.log' && grep -q \"the home root's\" '$STATE/sim/join.log' &&
        ! grep -q '$HOME_KEY' '$STATE/sim/join.log' &&
        ! docker exec ot-mac sh -c 'grep -rl $HOME_KEY /home/ubuntu/.local/share/yggdrasil-root/log /home/ubuntu/.local/share/yggdrasil-root/run /tmp 2>/dev/null | grep .' &&
        ! docker exec ot-mac sh -c 'ls /home/ubuntu/.local/share/yggdrasil-root/.upstream.* 2>/dev/null | grep .'"
  fi
  check m1 "the third machine joined from the release alone: its brain + root build unpacked and checked, no compiler" \
    bash -c "grep -q 'signature OK' '$STATE/sim/join.log' && docker exec ot-mac test -f /home/ubuntu/.local/share/yggdrasil/release/$VER/.verified && \
      docker exec ot-mac cmp -s /home/ubuntu/.local/share/yggdrasil-root/bin/bifrost-net /home/ubuntu/.local/share/yggdrasil/release/$VER/bin/bifrost-net-root && \
      ! docker exec ot-mac sh -c 'command -v cargo || command -v cc || command -v git'"

  # ------------------------------------------------------------------------- idempotency + rotation
  say "stage a: re-runs — install.sh --trunk twice, trunk.sh --rotate-token"
  SUM=$(reg_sum); BPID=$(homesh 'cat ~/.local/state/bifrost/run/yggdrasil.service.pid')
  install_home h5-again.log "$LINE_A"; rc=$?
  check h5 "install.sh --trunk (the same line on stdin) again: exit 0, device registry unchanged, brain not restarted" \
    bash -c "[ $rc = 0 ] && [ '$(reg_sum)' = '$SUM' ] && [ \"\$(docker exec -u $HU ot-home cat $HH/.local/state/bifrost/run/yggdrasil.service.pid)\" = '$BPID' ] && \
      grep -q 'trunk   https://$A/pair → 200' '$STATE/log/h5-again.log'"
  vps ot-vps-a "cd /root && $REL bash trunk.sh --rotate-token" >"$STATE/log/a6-rotate.log" 2>&1; rc=$?
  LINE_A2=$(line_of "$STATE/log/a6-rotate.log")
  sleep 4
  check a6 "trunk.sh --rotate-token: a new line, the same pin; the hub's old token is refused (503 from outside)" \
    bash -c "[ $rc = 0 ] && [ -n '$LINE_A2' ] && [ '$LINE_A2' != '$LINE_A' ] && [ '$(pin_of "$STATE/log/a6-rotate.log")' = '$PIN_A' ] && \
      [ \"\$(outside \"curl -sk -o /dev/null -w '%{http_code}' https://$A/pair\")\" = 503 ]"
  install_home h6-rotated.log "$LINE_A2"; rc=$?
  check h6 "install.sh --trunk (the new line): connected again (200), device registry unchanged" \
    bash -c "[ $rc = 0 ] && grep -q 'trunk   https://$A/pair → 200' '$STATE/log/h6-rotated.log' && [ '$(reg_sum)' = '$SUM' ]"

  homesh "cd ~ && $HREL bash install.sh --update $INSTALL_ARGS" >"$STATE/log/h9-update.log" 2>&1 </dev/null; rc=$?
  check h9 "home: install.sh --update — the newest signed release is this one: says so, re-runs, still connected (200)" \
    bash -c "[ $rc = 0 ] && grep -q 'signature OK' '$STATE/log/h9-update.log' && grep -q 'update: $VER is the newest release' '$STATE/log/h9-update.log' && \
      grep -q 'trunk   https://$A/pair → 200' '$STATE/log/h9-update.log'"

  # ---------------------------------------------------------------------- the weekly signed update
  say "stage a: the weekly update — nothing newer; a newer signed release; a forged one"
  vps ot-vps-a 'systemctl start yggdrasil-trunk-update.service; journalctl -u yggdrasil-trunk-update -o cat --no-pager' >"$STATE/log/a7-update-none.log" 2>&1
  check a7 "the update timer's unit, nothing newer: 'the newest release — nothing to do'" \
    bash -c "grep -q 'signature OK' '$STATE/log/a7-update-none.log' && grep -q '$VER is the newest release' '$STATE/log/a7-update-none.log'"
  if [ -n "$KEY" ]; then
  latest 0.9.1-test
  vps ot-vps-a 'systemctl start yggdrasil-trunk-update.service; journalctl -u yggdrasil-trunk-update -o cat --no-pager' >"$STATE/log/a8-update.log" 2>&1
  sleep 2
  check a8 "a newer SIGNED release: updated by itself to 0.9.1-test (its own trunk.sh, checked), same pin, the hub still connected" \
    bash -c "grep -q 'update: $VER → 0.9.1-test' '$STATE/log/a8-update.log' && \
      docker exec ot-vps-a grep -qx 'BINARY=bifrost-net-0.9.1-test-linux-x86_64' /etc/yggdrasil-trunk/trunk.conf && \
      docker exec ot-vps-a grep -qx \"YGG_RELEASE='0.9.1-test'\" /usr/local/sbin/yggdrasil-trunk && \
      docker exec ot-vps-a systemctl is-active -q yggdrasil-trunk && grep -q 'pin: sha-256 $PIN_A' '$STATE/log/a8-update.log' && \
      [ \"\$(outside \"curl -sk -o /dev/null -w '%{http_code}' https://$A/pair\")\" = 200 ]"
  latest 0.9.2-test
  vps ot-vps-a 'systemctl start yggdrasil-trunk-update.service; journalctl -u yggdrasil-trunk-update -o cat --no-pager -n 30' >"$STATE/log/a9-update-forged.log" 2>&1
  check a9 "a forged 'newer' release: the update refuses it (not signed), 0.9.1-test stays, the hub still connected" \
    bash -c "grep -q 'NOT signed by the yggdrasil release key' '$STATE/log/a9-update-forged.log' && \
      docker exec ot-vps-a grep -qx 'BINARY=bifrost-net-0.9.1-test-linux-x86_64' /etc/yggdrasil-trunk/trunk.conf && \
      [ \"\$(outside \"curl -sk -o /dev/null -w '%{http_code}' https://$A/pair\")\" = 200 ]"
  GOODBIN=$(vps ot-vps-a 'sha256sum </usr/local/lib/yggdrasil-trunk/bifrost-net')
  latest 0.9.3-test
  vps ot-vps-a 'systemctl start yggdrasil-trunk-update.service; journalctl -u yggdrasil-trunk-update -o cat --no-pager -n 60' >"$STATE/log/a10-update-broken.log" 2>&1
  sleep 4
  check a10 "a signed but BROKEN newer release: installed, does not answer → the previous trunk put back by itself, the hub reconnects" \
    bash -c "grep -q 'update: 0.9.1-test → 0.9.3-test' '$STATE/log/a10-update-broken.log' && \
      grep -q 'the previous trunk is back and answering' '$STATE/log/a10-update-broken.log' && \
      [ \"\$(docker exec ot-vps-a bash -c 'sha256sum </usr/local/lib/yggdrasil-trunk/bifrost-net')\" = '$GOODBIN' ] && \
      docker exec ot-vps-a grep -qx 'BINARY=bifrost-net-0.9.1-test-linux-x86_64' /etc/yggdrasil-trunk/trunk.conf && \
      docker exec ot-vps-a grep -qx \"YGG_RELEASE='0.9.1-test'\" /usr/local/sbin/yggdrasil-trunk && \
      docker exec ot-vps-a systemctl is-active -q yggdrasil-trunk && \
      [ \"\$(outside \"curl -sk -o /dev/null -w '%{http_code}' https://$A/pair\")\" = 200 ]"
  latest "$VER"
  else
    skip a8 "a newer signed release: updated by itself" "needs a re-signed release (OT_DIST_KEY)"
    skip a9 "a forged newer release refused" "needs a re-signed release (OT_DIST_KEY)"
    skip a10 "a broken newer release: rolled back" "needs a re-signed release (OT_DIST_KEY)"
  fi
fi

# =========================================================================================== stage b
if stage b; then
  say "stage b: Let's Encrypt (Pebble) — certbot standalone on :80, from the trunk's own key"
  new_vps ot-vps-b "$IP_B" "$B"
  vps ot-vps-b 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq ufw >/dev/null && ufw allow 22/tcp >/dev/null && ufw --force enable >/dev/null' >"$STATE/log/b-ufw.log" 2>&1
  docker cp "$DIST/trunk.sh" ot-vps-b:/root/trunk.sh >/dev/null
  docker cp "$STATE/bin/bifrost-net" ot-vps-b:/root/bifrost-net >/dev/null
  docker cp "$STATE/sim/pebble-acme-ca.pem" ot-vps-b:/root/pebble-acme-ca.pem >/dev/null
  PEB="REQUESTS_CA_BUNDLE=/root/pebble-acme-ca.pem"
  vps ot-vps-b "cd /root && $PEB bash trunk.sh --name $B --acme-server https://pebble:14000/dir --binary /root/bifrost-net" >"$STATE/log/b1-trunk.log" 2>&1; rc=$?
  LINE_B=$(line_of "$STATE/log/b1-trunk.log"); PIN_B=$(pin_of "$STATE/log/b1-trunk.log")
  check b1 "trunk.sh --acme-server <Pebble>: exit 0, a certificate from the ACME server, ufw (already on) 80 + 443 opened" \
    bash -c "[ $rc = 0 ] && [ -n '$LINE_B' ] && docker exec ot-vps-b openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -issuer | grep -qi pebble && \
      docker exec ot-vps-b ufw status | grep -q '^80/tcp.*ALLOW' && docker exec ot-vps-b ufw status | grep -q '^443/tcp.*ALLOW' && \
      docker exec ot-vps-b systemctl is-enabled -q yggdrasil-trunk-cert.timer"
  check b2 "an outsider verifies the chain against the ACME root (no -k): https://$B answers 503 (no hub yet)" \
    bash -c "[ \"\$(outside \"curl -s -o /dev/null -w '%{http_code}' --cacert /sim/pebble-root.pem https://$B/\")\" = 503 ]"
  SERIAL=$(vps ot-vps-b 'openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -serial')
  vps ot-vps-b "cd /root && /usr/local/sbin/yggdrasil-trunk --renew --force" >"$STATE/log/b3-renew.log" 2>&1; rc=$?
  check b3 "renewal (--renew --force, as the timer runs it): a new certificate, the SAME pin" \
    bash -c "[ $rc = 0 ] && [ \"\$(docker exec ot-vps-b openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -serial)\" != '$SERIAL' ] && \
      [ \"\$(docker exec ot-vps-b /usr/local/lib/yggdrasil-trunk/bifrost-net ap-pin /etc/yggdrasil-trunk/cert.pem)\" = 'pin = \"sha-256 $PIN_B\"' ] && \
      [ \"\$(outside \"curl -s -o /dev/null -w '%{http_code}' --cacert /sim/pebble-root.pem https://$B/\")\" = 503 ]"
  vps ot-vps-b 'systemctl start yggdrasil-trunk-cert.service' >"$STATE/log/b4-timer.log" 2>&1; rc=$?
  check b4 "the timer's unit runs clean: not due yet, nothing to do" \
    bash -c "[ $rc = 0 ] && docker exec ot-vps-b journalctl -u yggdrasil-trunk-cert -o cat --no-pager | grep -q 'nothing to do'"
  if up ot-home; then
    SUM=$(reg_sum)
    install_home h7-le.log "$LINE_B"; rc=$?
    check h7 "the hub moves to the Pebble trunk: health 200; an outsider gets /pair 200 with full chain validation" \
      bash -c "[ $rc = 0 ] && grep -q 'trunk   https://$B/pair → 200' '$STATE/log/h7-le.log' && [ \"\$(outside \"curl -s -o /dev/null -w '%{http_code}' --cacert /sim/pebble-root.pem https://$B/pair\")\" = 200 ] && \
        [ '$(reg_sum)' = '$SUM' ]"
  fi
fi

# =========================================================================================== stage c
if stage c; then
  say "stage c: a VPS whose :80 and :443 are a website (nginx) — trunk.sh --behind-proxy, Pebble through nginx"
  new_vps ot-vps-c "$IP_C" "$C" "$WWW"
  # shellcheck disable=SC2016  # $remote_addr is nginx's
  vps ot-vps-c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq nginx libnginx-mod-stream openssl curl >/dev/null &&
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /etc/nginx/www.key -out /etc/nginx/www.crt -days 30 \
      -subj /CN=www.tree.test -addext subjectAltName=DNS:www.tree.test 2>/dev/null &&
    cat >/etc/nginx/sites-enabled/default <<NGX
server { listen 80 default_server; server_name www.tree.test; location / { return 200 "WEBSITE OK (http)\n"; } }
server { listen 443 ssl default_server; server_name www.tree.test; ssl_certificate /etc/nginx/www.crt; ssl_certificate_key /etc/nginx/www.key;
         location / { return 200 "WEBSITE OK \$remote_addr\n"; } }
NGX
    nginx -t 2>/dev/null && systemctl restart nginx' >"$STATE/log/c-website.log" 2>&1
  docker cp ot-vps-c:/etc/nginx/www.crt "$STATE/sim/www.crt" >/dev/null; chmod 644 "$STATE/sim/www.crt"
  check c0 "the website answers on :443 and :80 before anything" \
    outside "curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | grep -q '^WEBSITE OK' && curl -s -m 5 http://$WWW/ | grep -q '^WEBSITE OK (http)'"
  docker cp "$DIST/trunk.sh" ot-vps-c:/root/trunk.sh >/dev/null       # the single file again
  to_box ot-vps-c
  docker cp "$STATE/bin/bifrost-net" ot-vps-c:/root/bifrost-net >/dev/null
  docker cp "$STATE/sim/pebble-acme-ca.pem" ot-vps-c:/root/pebble-acme-ca.pem >/dev/null
  ENVC="REQUESTS_CA_BUNDLE=/root/pebble-acme-ca.pem $REL"   # sni-443.py comes from the signed release
  vps ot-vps-c "cd /root && $ENVC bash trunk.sh --name $C --acme-server https://pebble:14000/dir --binary /root/bifrost-net" >"$STATE/log/c1-busy.log" 2>&1; rc=$?
  check c1 "without --behind-proxy: refused (443 is nginx's), says --behind-proxy, nothing installed (not even a package), website up" \
    bash -c "[ $rc != 0 ] && grep -q 'taken by .nginx' '$STATE/log/c1-busy.log' && grep -q -- '--behind-proxy' '$STATE/log/c1-busy.log' && \
      ! grep -q 'apt-get install' '$STATE/log/c1-busy.log' && \
      ! docker exec ot-vps-c test -e /etc/systemd/system/yggdrasil-trunk.service && \
      [ \"\$(docker exec ot-files curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | cut -c1-10)\" = 'WEBSITE OK' ]"
  vps ot-vps-c "cd /root && $ENVC bash trunk.sh --name $C --behind-proxy --acme-server https://pebble:14000/dir --binary /root/bifrost-net" >"$STATE/log/c2-behind.log" 2>&1; rc=$?
  LINE_C=$(line_of "$STATE/log/c2-behind.log"); PIN_C=$(pin_of "$STATE/log/c2-behind.log")
  check c2 "--behind-proxy: ap on 127.0.0.1:4443 with proxy_protocol; nginx holds :80 → CERTIFICATE PENDING + the nginx snippet" \
    bash -c "[ $rc = 0 ] && [ -n '$LINE_C' ] && grep -q 'CERTIFICATE PENDING' '$STATE/log/c2-behind.log' && grep -q 'nginx holds port 80' '$STATE/log/c2-behind.log' && \
      docker exec ot-vps-c grep -qx 'listen = \"127.0.0.1:4443\"' /etc/yggdrasil-trunk/ap.toml && docker exec ot-vps-c grep -qx 'proxy_protocol = true' /etc/yggdrasil-trunk/ap.toml && \
      docker exec ot-vps-c test -x /usr/local/lib/yggdrasil-trunk/sni-443.py && \
      [ \"\$(docker exec ot-vps-c sha256sum /usr/local/lib/yggdrasil-trunk/sni-443.py | cut -c1-64)\" = \"\$(sha256sum <'$DIST/sni-443.py' | cut -c1-64)\" ] && \
      [ \"\$(docker exec ot-files curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | cut -c1-10)\" = 'WEBSITE OK' ]"
  check c2f "a server with a website: ufw on with ssh, 80 + 443 open — the website still reachable from outside" \
    bash -c "docker exec ot-vps-c ufw status | grep -q '^Status: active' && docker exec ot-vps-c ufw status | grep -q '^22/tcp.*ALLOW' && \
      docker exec ot-vps-c ufw status | grep -q '^80/tcp.*ALLOW' && docker exec ot-vps-c ufw status | grep -q '^443/tcp.*ALLOW' && \
      [ \"\$(docker exec ot-files curl -s -m 5 http://$WWW/ | cut -c1-10)\" = 'WEBSITE OK' ]"
  # the user does what it printed: the server block into nginx, reload, re-run with --webroot
  awk '/nginx holds port 80/{f=1} f&&/^ *server \{/{p=1} p{print} p&&/^ *\}$/{exit}' "$STATE/log/c2-behind.log" | sed 's/^ *//' >"$STATE/sim/acme-snippet.conf"
  docker cp "$STATE/sim/acme-snippet.conf" ot-vps-c:/etc/nginx/conf.d/yggdrasil-trunk-acme.conf >/dev/null
  WR=$(sed -n 's/.*sudo bash trunk\.sh --webroot \([^ ]*\).*/\1/p' "$STATE/log/c2-behind.log" | head -1)
  vps ot-vps-c "nginx -t && systemctl reload nginx && cd /root && $ENVC bash trunk.sh --webroot $WR" >"$STATE/log/c3-webroot.log" 2>&1; rc=$?
  check c3 "the printed nginx snippet + trunk.sh --webroot: a certificate through nginx's :80, the same pin" \
    bash -c "[ $rc = 0 ] && ! grep -q 'CERTIFICATE PENDING' '$STATE/log/c3-webroot.log' && docker exec ot-vps-c openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -issuer | grep -qi pebble && \
      grep -q 'pin: sha-256 $PIN_C' '$STATE/log/c3-webroot.log' && [ \"\$(docker exec ot-files curl -s -m 5 http://$WWW/ | cut -c1-10)\" = 'WEBSITE OK' ]"
  # option A: the website moves to 127.0.0.1:8443, our router takes :443
  vps ot-vps-c "sed -i 's/listen 443 ssl default_server;/listen 127.0.0.1:8443 ssl default_server;/' /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx && sleep 1 && systemctl enable --now yggdrasil-sni-443" >"$STATE/log/c4-sni.log" 2>&1; rc=$?
  sleep 2
  check c4 "option A (sni-443.py on :443): the website still answers (its own cert), the trunk answers by name" \
    bash -c "[ $rc = 0 ] && [ \"\$(docker exec ot-files curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | cut -c1-10)\" = 'WEBSITE OK' ] && \
      [ \"\$(docker exec ot-files curl -s -o /dev/null -w '%{http_code}' --cacert /sim/pebble-root.pem https://$C/)\" = 503 ]"
  if up ot-home; then
    SUM=$(reg_sum)
    install_home h8-px.log "$LINE_C"; rc=$?
    check h8 "the hub on the trunk behind the router: health 200, registry unchanged" \
      bash -c "[ $rc = 0 ] && grep -q 'trunk   https://$C/pair → 200' '$STATE/log/h8-px.log' && [ '$(reg_sum)' = '$SUM' ]"
    say "stage c: the phone through the :443 router (pair, MAIN, revoke) — its region is its real address (PROXY v1)"
    run_phone short "https://$C" "$IP_C" "$STATE/sim/steps-c.tsv"; rc=$?
    check pc "the phone walk through https://$C behind sni-443.py (playwright exit $rc)" bash -c "[ $rc = 0 ]"
    # option B: nginx itself routes :443 by name (the printed stream block), PROXY v1 to both
    awk '/^ *stream \{/{p=1} p{print} p&&/^    \}$/{exit}' "$STATE/log/c2-behind.log" | sed 's/^    //' >"$STATE/sim/stream.conf"
    docker cp "$STATE/sim/stream.conf" ot-vps-c:/root/stream.conf >/dev/null
    vps ot-vps-c "systemctl disable --now yggdrasil-sni-443 && cat /root/stream.conf >>/etc/nginx/nginx.conf &&
      sed -i 's/listen 127.0.0.1:8443 ssl default_server;/listen 127.0.0.1:8443 ssl default_server proxy_protocol; set_real_ip_from 127.0.0.1; real_ip_header proxy_protocol;/' /etc/nginx/sites-enabled/default &&
      nginx -t && systemctl reload nginx" >"$STATE/log/c5-stream.log" 2>&1; rc=$?
    sleep 2
    # shellcheck disable=SC2016  # expanded on the home computer
    CODE=$(homesh 'curl -s -m 10 -X POST http://127.0.0.1:8082/api/pair/code -H "authorization: Bearer $(sed -n "s/^BIFROST_ADMIN_TOKEN=//p" ~/.config/bifrost/app.env)" -H "content-type: application/json" -d "{\"name\":\"curl\"}"' | python3 -c 'import json,sys,urllib.parse; u=json.load(sys.stdin)["url"]; print(urllib.parse.parse_qs(u.split("#")[1])["code"][0])' 2>/dev/null)
    CLAIM=$(outside "curl -s -m 10 --cacert /sim/pebble-root.pem -X POST https://$C/api/pair/claim -H 'content-type: application/json' -d '{\"code\":\"$CODE\",\"name\":\"via-nginx\"}'")
    check c5 "option B (nginx stream, the printed block): website answers with the client's real address; the trunk too (PROXY v1)" \
      bash -c "[ $rc = 0 ] && docker exec ot-files curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | grep -qx 'WEBSITE OK $IP_FILES' && \
        printf '%s' '$CLAIM' | grep -q '\"accessToken\":\"bfnd-' && \
        docker exec -u $HU ot-home cat $HH/.local/state/bifrost/devices.json | python3 -c 'import json,sys; d=[x for x in json.load(sys.stdin)[\"devices\"] if x[\"name\"]==\"via-nginx\"]; sys.exit(0 if d and d[-1][\"region\"]==\"lan:$P.0/24\" else 1)'"
  fi
fi

# =========================================================================================== stage j
if stage j; then
  say "stage j: Ubuntu 22.04 (glibc 2.35) — the release installs and runs; Debian 10 (glibc 2.28) is refused plainly"
  docker run -d --name ot-jammy --hostname jammy --network "$NET" --ip "$IP_JAMMY" -v "$ROOT/root/mock:/mock:ro" ubuntu:22.04 sleep infinity >/dev/null
  dx ot-jammy bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      curl ca-certificates openssh-client libopus0 python3 iproute2 procps >/dev/null && useradd -m -s /bin/bash '"$HU" >"$STATE/log/jammy-apt.log" 2>&1
  to_box ot-jammy
  docker cp "$DIST/install.sh" ot-jammy:"$HH/install.sh" >/dev/null && dx ot-jammy chown "$HU:$HU" "$HH/install.sh"
  docker exec -u "$HU" ot-jammy bash -c 'mkdir -p ~/mock && cd ~/mock && (setsid nohup python3 /mock/mock_upstream.py 18397 >mock.log 2>&1 &) &&
    printf "YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18397\nYGG_UPSTREAM_STYLE=anthropic\nYGG_UPSTREAM_API_KEY=mock\nYGG_UPSTREAM_MODEL=mock\n" >~/model.env'
  JG=$(dx ot-jammy bash -c 'ldd --version | head -1 | grep -o "[0-9.]*$"')
  docker exec -u "$HU" ot-jammy bash -c "cd ~ && $HREL bash install.sh --direct --skip voice,livekit,agent --upstream-env ~/model.env" \
    >"$STATE/log/j1-jammy.log" 2>&1 </dev/null; rc=$?
  check j1 "Ubuntu 22.04 (glibc $JG): the release installs; brain, bridge and app answer 200 (no trunk: the LAN way)" \
    bash -c "[ $rc = 0 ] && grep -q 'brain   http://127.0.0.1:4100/session → 200' '$STATE/log/j1-jammy.log' && \
      grep -q 'bridge  http://127.0.0.1:7890/identity → 200' '$STATE/log/j1-jammy.log' && grep -q 'app     http://127.0.0.1:8082/pair → 200' '$STATE/log/j1-jammy.log'"
  docker run -d --name ot-buster --hostname buster debian:10 sleep infinity >/dev/null
  docker cp "$DIST/install.sh" ot-buster:/root/install.sh >/dev/null
  dx ot-buster bash -c "cd /root && $HREL bash install.sh" >"$STATE/log/j2-buster.log" 2>&1 </dev/null; rc=$?
  check j2 "Debian 10 (glibc 2.28): refused plainly — 'glibc 2.28 … needs 2.31' — before anything is downloaded" \
    bash -c "[ $rc = 1 ] && grep -q 'glibc 2.28; the release needs 2.31 or newer' '$STATE/log/j2-buster.log' && \
      grep -q 'Nothing was downloaded' '$STATE/log/j2-buster.log' && ! grep -q 'release:' '$STATE/log/j2-buster.log' && \
      ! docker exec ot-buster test -e /root/.local/share/yggdrasil"
fi

# =========================================================================================== stage v
if stage v; then
  say "stage v: the voice box — Debian 12, systemd, a login session: plain bash install.sh --trunk (no --skip, no --direct)"
  new_vps ot-vps-v "$IP_V" trunk-v.tree.test; to_box ot-vps-v
  docker cp "$DIST/trunk.sh" ot-vps-v:/root/trunk.sh >/dev/null
  vps ot-vps-v "cd /root && $REL bash trunk.sh --name trunk-v.tree.test --self-signed -y" >"$STATE/log/v0-trunk.log" 2>&1
  LINE_V=$(line_of "$STATE/log/v0-trunk.log")
  new_vps ot-voice "$IP_VOICE" voice-box
  docker run --rm -v "$ROOT/root/mock:/m:ro" -v "$STATE/sim:/s" debian:12 cp /m/mock_upstream.py /s/mock_upstream.py
  # a Debian 12 desktop's own pieces (logind sessions, the user bus, polkit) + what the README asks for
  dx ot-voice bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      libpam-systemd dbus-user-session polkitd curl ca-certificates openssh-client libopus0 python3-venv bzip2 iproute2 procps >/dev/null &&
      systemctl reload dbus && systemctl restart polkit &&   # as on a booted Debian: the system bus knows polkit
      useradd -m -s /bin/bash '"$HU" >"$STATE/log/voice-apt.log" 2>&1
  to_box ot-voice
  docker cp "$DIST/install.sh" ot-voice:"$HH/install.sh" >/dev/null
  docker cp "$STATE/sim/mock_upstream.py" ot-voice:/opt/mock_upstream.py >/dev/null
  printf '%s\n' "$LINE_V" >"$STATE/line-v.txt"; chmod 600 "$STATE/line-v.txt"
  docker cp "$STATE/line-v.txt" ot-voice:"$HH/line.txt" >/dev/null; rm -f "$STATE/line-v.txt"
  dx ot-voice bash -c "chown $HU:$HU $HH/install.sh $HH/line.txt && chmod 600 $HH/line.txt &&
    printf 'YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18397\nYGG_UPSTREAM_STYLE=anthropic\nYGG_UPSTREAM_API_KEY=mock\nYGG_UPSTREAM_MODEL=mock\n' >$HH/model.env &&
    chown $HU:$HU $HH/model.env && (setsid nohup python3 /opt/mock_upstream.py 18397 >/var/log/mock.log 2>&1 &)"
  # ana logs in (su -: a logind session through pam_systemd, her user manager) and types the one command
  dx ot-voice su - "$HU" -c "$HREL bash install.sh --trunk --upstream-env ~/model.env <~/line.txt" >"$STATE/log/v1-install.log" 2>&1; rc=$?
  dx ot-voice shred -u "$HH/line.txt" 2>/dev/null
  UID_V=$(dx ot-voice id -u "$HU")
  ustate() { dx ot-voice runuser -u "$HU" -- env XDG_RUNTIME_DIR=/run/user/"$UID_V" systemctl --user is-active "$@" 2>/dev/null | tr '\n' ' '; }
  SEVEN="yggdrasil bifrost-app bifrost-bridge bifrost-wg bifrost-livekit bifrost-voice bifrost-agent"
  # the first start of bifrost-voice downloads its speech models (~200 MB): wait for it, up to 20 minutes
  for _ in $(seq 240); do [ "$(dx ot-voice curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:8000/healthz)" = 200 ] && break; sleep 5; done
  sleep 5
  ST=$(ustate $SEVEN)
  check v1 "plain bash install.sh --trunk (the session ended since): exit 0, all seven units active — $ST" \
    bash -c "[ $rc = 0 ] && [ '$ST' = 'active active active active active active active ' ]"
  check v2 "lingering on (install.sh asked logind itself): loginctl show-user -p Linger = yes; the units outlived the login" \
    bash -c "[ \"\$(docker exec ot-voice loginctl show-user $HU -p Linger)\" = Linger=yes ] && grep -q 'linger  on' '$STATE/log/v1-install.log'"
  check v3 "voice: the local speech server's /healthz → 200 (its models downloaded on the first start)" \
    bash -c "[ \"\$(docker exec ot-voice curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:8000/healthz)\" = 200 ]"
  # a phone pairs (the code from the box, claimed through the trunk) and asks for a voice token through the trunk
  # shellcheck disable=SC2016  # expanded on the voice box
  VCODE=$(dx -u "$HU" ot-voice bash -c 'curl -s -m 10 -X POST http://127.0.0.1:8082/api/pair/code -H "authorization: Bearer $(sed -n "s/^BIFROST_ADMIN_TOKEN=//p" ~/.config/bifrost/app.env)" -H "content-type: application/json" -d "{\"name\":\"voice-phone\"}"' |
    python3 -c 'import json,sys,urllib.parse; u=json.load(sys.stdin)["url"]; print(urllib.parse.parse_qs(u.split("#")[1])["code"][0])' 2>/dev/null)
  VACC=$(outside "curl -sk -m 10 -X POST https://trunk-v.tree.test/api/pair/claim -H 'content-type: application/json' -d '{\"code\":\"$VCODE\",\"name\":\"voice-phone\"}'" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("accessToken",""))' 2>/dev/null)
  outside "curl -sk -m 20 -X POST https://trunk-v.tree.test/api/token -H 'authorization: Bearer $VACC' -H 'content-type: application/json' -d '{\"room\":\"main\"}'" \
    >"$STATE/log/v4-token.json" 2>&1
  check v4 "a paired phone asks through the trunk: a LiveKit voice token for room main (wss://trunk-v…, ICE-TCP via :443)" \
    bash -c "[ -n '$VACC' ] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get(\"participantToken\") and d.get(\"serverUrl\",\"\").startswith(\"wss://trunk-v.tree.test\") else 1)' '$STATE/log/v4-token.json'"
  # what the install put in ana's home (all of it: she started with an empty one) — df is no measure in a container
  dx ot-voice bash -c "cd $HH && du -sxm .local/share/yggdrasil/release .local/share/bifrost/voice/venv .local/share/bifrost/voice/models \
    .local/share/bifrost/agent .cache .local/bin 2>/dev/null" >"$STATE/log/v5-disk.txt" 2>&1
  DISK_MB=$(dx ot-voice du -sxm "$HH" | cut -f1)
  printf '%s\tthe whole home (the install, everything included)\n' "$DISK_MB" >>"$STATE/log/v5-disk.txt"
  check v5 "the disk it took: $DISK_MB MB in the home (log/v5-disk.txt: release, voice venv + models, agent, pip cache)" \
    bash -c "[ $DISK_MB -gt 0 ] && [ $DISK_MB -lt 2500 ]"
fi

# =========================================================================================== stage u
if stage u; then
  say "stage u: --uninstall — the home computer, the third machine, the trunk: nothing left behind"
  if up ot-home; then
    homesh "bash ~/install.sh --uninstall" >"$STATE/log/u0-home-ask.log" 2>&1 </dev/null; rc0=$?
    homesh "bash ~/install.sh --uninstall -y" >"$STATE/log/u1-home.log" 2>&1; rc=$?
    sleep 1
    check u1 "home: install.sh --uninstall lists what goes and asks (no tty, no -y: refuses); -y removes it all — no unit, file, process" \
      bash -c "[ $rc0 = 64 ] && grep -q 'your chats' '$STATE/log/u0-home-ask.log' && [ $rc = 0 ] && grep -q 'removed' '$STATE/log/u1-home.log' && \
        docker exec -u $HU ot-home bash -c 'for p in ~/.config/bifrost ~/.config/yggdrasil ~/.config/systemd/user/bifrost-* ~/.config/systemd/user/yggdrasil.service \
          ~/.local/share/yggdrasil ~/.local/share/bifrost ~/.local/state/bifrost ~/.local/bin/yggdrasil ~/.local/bin/bifrost-net ~/.local/bin/livekit-server; do [ -e \$p ] && exit 1; done; exit 0' && \
        ! docker exec ot-home ps -eo stat=,args= | grep -v '^Z' | grep -E 'bifrost-net|yggdrasil|server\.mjs'"
  fi
  if up ot-mac; then
    dx -u ubuntu ot-mac bash -c "$JREL bash ~/join.sh --uninstall -y" >"$STATE/log/u2-mac.log" 2>&1; rc=$?
    sleep 1
    check u2 "the third machine: join.sh --uninstall -y — its root, units and the unpacked release gone, nothing running" \
      bash -c "[ $rc = 0 ] && ! docker exec ot-mac test -e /home/ubuntu/.local/share/yggdrasil-root && \
        ! docker exec ot-mac test -e /home/ubuntu/.local/share/yggdrasil && \
        ! docker exec ot-mac sh -c 'ls /home/ubuntu/.config/systemd/user/yggdrasil-root-* 2>/dev/null | grep -q .' && \
        ! docker exec ot-mac ps -eo stat=,args= | grep -v '^Z' | grep -E 'yggdrasil|bifrost-net|root-dial'"
  fi
  if up ot-vps-a; then
    vps ot-vps-a "/usr/local/sbin/yggdrasil-trunk --uninstall -y" >"$STATE/log/u3-trunk.log" 2>&1; rc=$?
    check u3 "the trunk: trunk.sh --uninstall -y — no unit, key, config, binary left; ufw still on, ssh open, 443 closed again" \
      bash -c "[ $rc = 0 ] && ! docker exec ot-vps-a sh -c 'ls /etc/systemd/system/yggdrasil-* 2>/dev/null | grep -q .' && \
        ! docker exec ot-vps-a test -e /etc/yggdrasil-trunk && ! docker exec ot-vps-a test -e /usr/local/lib/yggdrasil-trunk && \
        ! docker exec ot-vps-a test -e /usr/local/sbin/yggdrasil-trunk && ! docker exec ot-vps-a test -e /var/lib/yggdrasil-trunk && \
        ! docker exec ot-vps-a pgrep -x bifrost-net && docker exec ot-vps-a ufw status | grep -q '^Status: active' && \
        docker exec ot-vps-a ufw status | grep -q '^22/tcp.*ALLOW' && ! docker exec ot-vps-a ufw status | grep -q '^443/tcp'"
  fi
fi

# =========================================================================================== stage r
if stage r; then
  RV=${OT_REAL_VERSION:-0.8.0}
  say "stage r: the REAL release from github.com/veraldar/yggdrasil (v$RV) — signed: installed; unsigned: refused"
  new_vps ot-vps-r "$IP_R" trunk-gh.tree.test
  docker cp "$DIST/trunk.sh" ot-vps-r:/root/trunk.sh >/dev/null
  vps ot-vps-r "cd /root && bash trunk.sh --name trunk-gh.tree.test --self-signed --version v$RV -y" >"$STATE/log/r1-github.log" 2>&1; rc=$?
  if grep -q 'has no signature' "$STATE/log/r1-github.log"; then
    check r1 "trunk.sh --version v$RV: the real release has no SHA256SUMS.sig — refused, nothing installed" \
      bash -c "[ $rc = 1 ] && ! docker exec ot-vps-r test -e /usr/local/lib/yggdrasil-trunk/bifrost-net"
  else
    check r1 "trunk.sh --version v$RV downloads bifrost-net-$RV-linux-x86_64 from GitHub, signature + sha256 checked, runs it" \
      bash -c "[ $rc = 0 ] && grep -q 'signature OK' '$STATE/log/r1-github.log' && \
        grep -q 'binary: /usr/local/lib/yggdrasil-trunk/bifrost-net ← bifrost-net-$RV-linux-x86_64' '$STATE/log/r1-github.log' && \
        [ \"\$(docker exec ot-files curl -sk -o /dev/null -w '%{http_code}' https://trunk-gh.tree.test/)\" = 503 ]"
  fi
fi

# ====================================================================================== the table
echo
printf '%-5s %-4s %s\n' STEP "" WHAT
fails=0 skips=0
while IFS=$'\t' read -r res id what detail; do
  printf '%-5s %-4s %s\n' "$id" "$res" "$what"
  case $res in PASS) ;; SKIP) skips=$((skips + 1)) ;; *) fails=$((fails + 1)) ;; esac
done <"$RESULTS"
for f in "$STATE/sim/steps.tsv" "$STATE/sim/steps-c.tsv"; do
  [ -s "$f" ] || continue
  echo "  phone ($(basename "$f" .tsv)):"
  while IFS=$'\t' read -r n res what detail; do
    printf '    %-5s %-4s %s\n' "$n" "$res" "$what"
    [ "$res" = PASS ] || { fails=$((fails + 1)); [ -n "$detail" ] && printf '           ↳ %s\n' "$detail"; }
  done <"$f"
done
echo "state + logs: $STATE"
if [ "$fails" != 0 ]; then echo "OWN-TRUNK: RED ($fails failed)"; exit 1; fi
echo "OWN-TRUNK: GREEN$( [ "$skips" = 0 ] || echo " ($skips skipped — see SKIP above)")"
