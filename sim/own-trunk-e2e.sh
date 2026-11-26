#!/usr/bin/env bash
# own-trunk-e2e.sh — G4.1: YOUR OWN TRUNK (v1) end to end in docker: fresh machines, the SIGNED release
# (scripts/release.sh), Pebble ACME, scripted claim + root approval. Nothing public.
#
#   "internet" 172.31.250.0/24 (docker network ot-net, OT_SUBNET)
#     ot-files   .5   fake GitHub: dist/VERSION (signed SHA256SUMS), tampered copies, newer 1.0.x & 2.0.0
#                     releases for --update and --major gate — and an outside client (curl + v1-agent.py)
#     ot-pebble  .6   Let's Encrypt's test ACME server (HTTP-01 on port 80)
#     ot-vps-a   .10  trunk.tree.test     Debian 12 + systemd: trunk.sh --self-signed — tampered releases
#                                         refused, static trunk user, ufw, unattended-upgrades, claim via
#                                         trunk-ctl claim-code --json, /install/root.sh + /install/root.exe,
#                                         --add-name, weekly update + rollback + --major gate, --uninstall
#     ot-vps-b   .11  trunk-le.tree.test  Debian 12 + systemd + ufw: trunk.sh with Pebble standalone :80,
#                                         --renew --force (same SPKI pin), claim
#     ot-vps-c   .12  trunk-px.tree.test  Debian 12 + systemd + nginx website (www.tree.test) on :80/:443:
#                     www.tree.test       trunk.sh --behind-proxy --acme --webroot through nginx :80, then
#                                         nginx HTTPS reverse proxy -> http://127.0.0.1:8080 (XFF)
#     ot-home    .20  home computer: plain debian:12 (no node, cargo, git): curl /install/root.sh | bash,
#                     tampered releases refused, POST /t/roots/enroll approved by rig, bridge/wg/brain/
#                     app/librarian/cc-live running, trunk-state.json up, --update --major gate, --uninstall
#     ot-buster  .41  Debian 10 (glibc 2.28): refused plainly by root.sh before downloading anything
#
#   sim/own-trunk-e2e.sh                 every stage (a,b,c,j,u); exit 0 = all PASS
#   OT_STAGES=a,b,c,j,u (subset) · OT_KEEP=1 leaves containers up · OT_STATE=DIR keeps state + logs
#   OT_VERSION (1.0.0-alpha.1) · OT_REUSE_BUILD=1 re-stages last release build (--no-build)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HERE=$ROOT/sim/own-trunk
TMP_BASE=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/install}
mkdir -p "$TMP_BASE"
STATE=${OT_STATE:-$(mktemp -d "$TMP_BASE/own-trunk.XXXXXX")}
STAGES=,${OT_STAGES:-a,b,c,j,u},
mkdir -p "$STATE"/{files,sim,log} && chmod 755 "$STATE" "$STATE/sim"
RESULTS=$STATE/results.tsv; : >"$RESULTS"
NET=ot-net SUBNET=${OT_SUBNET:-172.31.250.0/24}; P=${SUBNET%.*}
IP_FILES=$P.5 IP_PEBBLE=$P.6 IP_A=$P.10 IP_B=$P.11 IP_C=$P.12 IP_HOME=$P.20
A=trunk.tree.test B=trunk-le.tree.test C=trunk-px.tree.test WWW=www.tree.test
ALL=(ot-files ot-pebble ot-vps-a ot-vps-b ot-vps-c ot-home ot-buster)
VER=${OT_VERSION:-1.0.0-alpha.1}
DIST=$STATE/dist/$VER
KEY=$STATE/test-key/release_ed25519
GIVEN=${OT_DIST:-} REALSTAMP=0
if [ -n "$GIVEN" ]; then
  GIVEN=$(cd "$GIVEN" && pwd) || exit 2; VER=${OT_VERSION:-$(basename "$GIVEN")}; DIST=$GIVEN; KEY=${OT_DIST_KEY:-}
  grep -q "^YGG_RELEASE_TEST=''" "$DIST/root.sh" && REALSTAMP=1
fi
TS=/opt/test-signers
HU=ana HH=/home/ana
FILES_URL=http://files.tree.test:8000
TSENV="YGG_RELEASE_TEST_SIGNERS=$TS"; [ $REALSTAMP = 1 ] && TSENV=''
REL="TRUNK_RELEASES=$FILES_URL/releases $TSENV"
HREL="YGG_RELEASES=$FILES_URL/releases $TSENV"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
pass() { printf 'PASS\t%s\t%s\n' "$1" "$2" >>"$RESULTS"; printf '\033[32mPASS\033[0m %-5s %s\n' "$1" "$2"; }
fail() { printf 'FAIL\t%s\t%s\t%s\n' "$1" "$2" "${3:-}" >>"$RESULTS"; printf '\033[31mFAIL\033[0m %-5s %s  %s\n' "$1" "$2" "${3:-}"; }
skip() { printf 'SKIP\t%s\t%s\t%s\n' "$1" "$2" "${3:-}" >>"$RESULTS"; printf '\033[33mSKIP\033[0m %-5s %s  %s\n' "$1" "$2" "${3:-}"; }
check() { # ID WHAT CMD…
  local id=$1 what=$2; shift 2
  if "$@" >>"$STATE/log/checks.log" 2>&1; then pass "$id" "$what"; else fail "$id" "$what" "(see log/checks.log)"; fi
}
stage() { case $STAGES in *,"$1",*) return 0 ;; esac; return 1; }
up() { [ -n "$(docker ps -q -f "name=^$1\$")" ]; }
dx() { docker exec "$@"; }
vps() { local c=$1; shift; docker exec "$c" bash -c "$*"; }
homesh() { docker exec -u "$HU" ot-home bash -c "$*"; }
outside() { docker exec ot-files bash -c "$*"; }
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
command -v ssh-keygen >/dev/null || { echo "ssh-keygen is needed (openssh)"; exit 2; }
cp "$HERE/v1-agent.py" "$STATE/sim/v1-agent.py" && chmod 755 "$STATE/sim/v1-agent.py"

if [ -z "$GIVEN" ]; then
  mkdir -p "$STATE/test-key" && rm -f "$KEY" "$KEY.pub"
  ssh-keygen -q -t ed25519 -N '' -C release@yggdrasil -f "$KEY" </dev/null
  printf 'release@yggdrasil namespaces="yggdrasil-release" %s\n' "$(cut -d' ' -f1-2 "$KEY.pub")" >"$STATE/test-signers"
  chmod 644 "$STATE/test-signers"
  say "a TEST release of the working tree, signed by this run's throwaway key: scripts/release.sh $VER"
  BUILD_FLAG=--dirty; [ "${OT_REUSE_BUILD:-0}" = 1 ] && BUILD_FLAG=--no-build
  TMPDIR="$TMP_BASE" YGG_RELEASE_KEY=$KEY DIST=$STATE/dist "$ROOT/scripts/release.sh" "$VER" "$BUILD_FLAG" >"$STATE/log/release.log" 2>&1 ||
    { tail -30 "$STATE/log/release.log"; exit 2; }
  ssh-keygen -Y verify -f "$STATE/test-signers" -I release@yggdrasil -n yggdrasil-release -s "$DIST/SHA256SUMS.sig" \
    <"$DIST/SHA256SUMS" >/dev/null 2>&1 || { echo "$DIST/SHA256SUMS is not signed by this run's key"; exit 2; }
  ! ssh-keygen -Y verify -f "$ROOT/allowed_signers" -I release@yggdrasil -n yggdrasil-release -s "$DIST/SHA256SUMS.sig" \
    <"$DIST/SHA256SUMS" >/dev/null 2>&1 || { echo "the test release verifies against the REAL key — refusing"; exit 2; }
  grep -q "^YGG_RELEASE_TEST='1'" "$DIST/root.sh" || { echo "the test release's root.sh is not marked YGG_RELEASE_TEST=1"; exit 2; }
else
  say "the release in $DIST (v$VER), used as it is"
  if [ $REALSTAMP = 1 ]; then sed -n "s/^YGG_SIGNER='\(.*\)'\$/\1/p" "$DIST/root.sh" | head -1 >"$STATE/test-signers"
  else printf 'release@yggdrasil namespaces="yggdrasil-release" %s\n' "$(ssh-keygen -y -f "$KEY" | cut -d' ' -f1-2)" >"$STATE/test-signers"; fi
  chmod 644 "$STATE/test-signers"
  ssh-keygen -Y verify -f "$STATE/test-signers" -I release@yggdrasil -n yggdrasil-release -s "$DIST/SHA256SUMS.sig" \
    <"$DIST/SHA256SUMS" >/dev/null 2>&1 || { echo "$DIST/SHA256SUMS is not signed by the key its installers trust"; exit 2; }
  (cd "$DIST" && sha256sum -c --quiet SHA256SUMS) || { echo "$DIST does not match its SHA256SUMS"; exit 2; }
fi
to_box() { docker cp "$STATE/test-signers" "$1:$TS" >/dev/null && docker exec "$1" chmod 644 "$TS"; }

TGZ=yggdrasil-$VER-linux-x86_64.tar.gz
docker rm -f "${ALL[@]}" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
say "images"
docker build -q -t ot-vps:12 -f "$HERE/vps.Dockerfile" "$HERE" >/dev/null || exit 2
for i in node:24 debian:12 debian:10 ghcr.io/letsencrypt/pebble:latest; do
  docker image inspect "$i" >/dev/null 2>&1 || docker pull -q "$i" >/dev/null
done
mkdir -p "$STATE/bin"
tar -xzf "$DIST/$TGZ" -C "$STATE/bin" --strip-components=2 "yggdrasil-$VER/bin/bifrost-net" "yggdrasil-$VER/bin/yggdrasil"

# ---- fake GitHub: good, tampered, minor update, forged update, broken update, and v2.0.0 major
R=$STATE/files/releases
mkrel() { # VERSION MODE (good | sums | asset | nosig | otherkey | broken)
  local v=$1 mode=$2 d=$R/download/v$1 f
  mkdir -p "$d"
  for f in "$DIST"/*; do
    case $(basename "$f") in SHA256SUMS|SHA256SUMS.sig) continue ;; esac
    cp "$f" "$d/$(basename "$f" | sed "s/$VER/$v/g")"
  done
  sed -i "s/^YGG_RELEASE='[^']*'/YGG_RELEASE='$v'/" "$d/trunk.sh" "$d/root.sh"
  if [ "$mode" = broken ]; then
    printf '#!/bin/sh\n# a signed release whose trunk dies at once\n[ "$1" = trunk-kek ] && exit 0\necho "broken release: $*" >&2\nexit 1\n' \
      >"$d/bifrost-net-$v-linux-x86_64"
    chmod 755 "$d/bifrost-net-$v-linux-x86_64"
  fi
  (cd "$d" && sha256sum -- * | LC_ALL=C sort -k2 >SHA256SUMS)
  if [ "$mode" = otherkey ]; then
    ssh-keygen -q -t ed25519 -N '' -C release@yggdrasil -f "$STATE/otherkey" <<<y >/dev/null 2>&1 || true
    ssh-keygen -q -Y sign -f "$STATE/otherkey" -n yggdrasil-release "$d/SHA256SUMS" </dev/null
  elif [ "$mode" != nosig ]; then
    ssh-keygen -q -Y sign -f "$KEY" -n yggdrasil-release "$d/SHA256SUMS" </dev/null
  fi
  case $mode in
    sums) sed -i -E '1s/^0/X/; 1s/^[1-9a-f]/0/; 1s/^X/1/' "$d/SHA256SUMS" ;;
    asset) printf 'x' >>"$d/bifrost-net-$v-linux-x86_64"; printf 'x' >>"$d/yggdrasil-$v-linux-x86_64.tar.gz" ;;
  esac
}
latest() { rm -rf "$R/latest"; mkdir -p "$R/latest"; cp -r "$R/download/v$1" "$R/latest/download"; chmod -R a+rX "$STATE/files"; }
mkdir -p "$R/download/v$VER" && cp "$DIST"/* "$R/download/v$VER/"
if [ -n "$KEY" ]; then
  mkrel 9.9.1 sums; mkrel 9.9.2 asset; mkrel 9.9.3 nosig; mkrel 9.9.4 otherkey
  mkrel 1.0.1-test good; mkrel 1.0.2-test sums; mkrel 1.0.3-test broken
  mkrel 2.0.0-test good
fi
latest "$VER"

# ---- Pebble: HTTP-01 on port 80
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
docker run -d --name ot-pebble --network "$NET" --ip "$IP_PEBBLE" --network-alias pebble \
  -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 -e PEBBLE_AUTHZREUSE=0 \
  -v "$STATE/pebble.json:/pebble.json:ro" ghcr.io/letsencrypt/pebble:latest -config /pebble.json >/dev/null
docker cp ot-pebble:/test/certs/pebble.minica.pem "$STATE/sim/pebble-acme-ca.pem" >/dev/null
for _ in $(seq 30); do outside "curl -sk -o /sim/pebble-root.pem https://pebble:15000/roots/0" && [ -s "$STATE/sim/pebble-root.pem" ] && break; sleep 1; done

new_vps() { # NAME IP ALIAS…
  local n=$1 ip=$2; shift 2
  local al=(); for a in "$@"; do al+=(--network-alias "$a"); done
  docker run -d --name "$n" --hostname "${n#ot-}" --network "$NET" --ip "$ip" "${al[@]}" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock ot-vps:12 >/dev/null
  for _ in $(seq 30); do s=$(dx "$n" systemctl is-system-running 2>/dev/null || true); case $s in running|degraded) break ;; esac; sleep 1; done
}
pin_of() { sed -n 's/.*pin: *sha-256 \([0-9A-F:]*\).*/\1/p' "$1" | tail -1; }

# ---- n0: newer() and major_of() in trunk.sh and root.sh
newer_ok() {
  local f
  for f in trunk/install/trunk.sh root/install/root.sh; do
    bash -c 'set -euo pipefail; eval "$(sed -n "/^newer() {/,/^}/p" "$1")"; eval "$(sed -n "/^major_of() {/p" "$1")"
      t() { if newer "$1" "$2"; then r=true; else r=false; fi; [ "$r" = "$3" ] || { echo "$0: newer $1 $2 → $r, not $3"; exit 1; }; }
      t 1.0.0-alpha.1 1.0.0 false; t 1.0.0 1.0.0-alpha.1 true; t 1.0.1-test 1.0.0 true; t 1.0.0 1.0.0 false
      t 1.10.0 1.9.9 true; t 2.0.0-test 1.0.1-test true
      [ "$(major_of 1.0.0-alpha.1)" = 1 ] && [ "$(major_of 2.0.0-test)" = 2 ]' "$f" "$ROOT/$f" || return 1
  done
}
check n0 "newer() & major_of(): pre-release < release, 1.x vs 2.x — in trunk.sh and root.sh" newer_ok

# =========================================================================================== stage a
if stage a; then
  say "stage a: fresh VPS, trunk.sh v1 --self-signed (signed, static user, claim, /install/root.sh, update + --major)"
  new_vps ot-vps-a "$IP_A" "$A" "extra.tree.test"; to_box ot-vps-a
  docker cp "$DIST/trunk.sh" ot-vps-a:/root/trunk.sh >/dev/null
  vps ot-vps-a "sed \"s/^YGG_RELEASE_TEST='1'/YGG_RELEASE_TEST=''/\" /root/trunk.sh >/root/trunk-real.sh &&
    cp /root/trunk.sh /root/trunk-changed.sh && echo '# one line more' >>/root/trunk-changed.sh"
  vps ot-vps-a "cd /root && $REL YGG_RELEASE_TEST_SIGNERS=$TS bash trunk-real.sh --name $A --self-signed -y" >"$STATE/log/a0p-real.log" 2>&1; rc=$?
  check a0p "a real release's trunk.sh with YGG_RELEASE_TEST_SIGNERS refuses (64) before anything" \
    bash -c "[ $rc = 64 ] && grep -q 'it trusts only the yggdrasil release key' '$STATE/log/a0p-real.log'"
  vps ot-vps-a "cd /root && $REL bash trunk-changed.sh --name $A --self-signed -y" >"$STATE/log/a0s-changed.log" 2>&1; rc=$?
  check a0s "a tampered trunk.sh stops before installing anything" \
    bash -c "[ $rc = 1 ] && grep -q 'is not the one release v$VER signed' '$STATE/log/a0s-changed.log' && \
      ! docker exec ot-vps-a test -e /usr/local/lib/yggdrasil-trunk/bifrost-net"

  if [ -n "$KEY" ]; then
    for v in 9.9.1 9.9.3 9.9.4; do
      vps ot-vps-a "cd /root && $REL bash trunk.sh --name $A --self-signed --version v$v -y" >"$STATE/log/a0-$v.log" 2>&1; echo "rc=$?" >>"$STATE/log/a0-$v.log"
    done
    check a0 "forged releases refused (SHA256SUMS changed / unsigned / other key), nothing installed" \
      bash -c "grep -q 'NOT signed by the yggdrasil release key' '$STATE/log/a0-9.9.1.log' && grep -q 'rc=1' '$STATE/log/a0-9.9.1.log' && \
        grep -q 'has no signature (SHA256SUMS.sig)' '$STATE/log/a0-9.9.3.log' && grep -q 'rc=1' '$STATE/log/a0-9.9.3.log' && \
        grep -q 'NOT signed by the yggdrasil release key' '$STATE/log/a0-9.9.4.log' && grep -q 'rc=1' '$STATE/log/a0-9.9.4.log' && \
        ! docker exec ot-vps-a test -e /usr/local/lib/yggdrasil-trunk/bifrost-net && ! docker exec ot-vps-a test -e /etc/yggdrasil-trunk"
    vps ot-vps-a "cd /root && $REL bash trunk.sh --name $A --self-signed --version v9.9.2 -y" >"$STATE/log/a0-9.9.2.log" 2>&1; rc=$?
    check a0b "changed binary after signing: signature OK, sha256 refused, nothing installed" \
      bash -c "[ $rc != 0 ] && grep -q 'signature OK' '$STATE/log/a0-9.9.2.log' && grep -q 'does not match SHA256SUMS' '$STATE/log/a0-9.9.2.log' && \
        ! docker exec ot-vps-a test -e /usr/local/lib/yggdrasil-trunk/bifrost-net"
  else
    skip a0 "forged releases refused" "needs OT_DIST_KEY"
    skip a0b "changed binary refused" "needs OT_DIST_KEY"
  fi

  vps ot-vps-a "cd /root && $REL bash trunk.sh --name $A --self-signed -y" >"$STATE/log/a1-trunk.log" 2>&1; rc=$?
  PIN_A=$(pin_of "$STATE/log/a1-trunk.log")
  check a1 "trunk.sh v1 --name $A --self-signed → exit 0, unclaimed /t/state, prints claim instructions, serves /install/root.sh + 404 root.exe" \
    bash -c "[ $rc = 0 ] && grep -q 'sudo trunk-ctl claim-code' '$STATE/log/a1-trunk.log' && \
      outside \"curl -sk https://$A/t/state\" | grep -q '\"claimed\":false' && \
      outside \"curl -sk https://$A/install/root.sh\" | grep -q \"TRUNK_URL_BAKED='https://$A'\" && \
      [ \"\$(outside \"curl -sk -o /dev/null -w '%{http_code}' https://$A/install/root.exe\")\" = 404 ]"

  check a2 "static trunk user (not root), ProtectSystem=strict, key+kek 600 root, /run/trunk/claim 600 trunk" \
    vps ot-vps-a "systemctl is-active -q yggdrasil-trunk && [ \"\$(ps -o user= -C bifrost-net | tr -d ' ')\" = trunk ] && \
      grep -q '^User=trunk$' /etc/systemd/system/yggdrasil-trunk.service && \
      grep -q '^ProtectSystem=strict$' /etc/systemd/system/yggdrasil-trunk.service && \
      grep -q '^ReadWritePaths=/var/lib/yggdrasil-trunk$' /etc/systemd/system/yggdrasil-trunk.service && \
      [ \"\$(stat -c '%a %U' /etc/yggdrasil-trunk/key.pem)\" = '600 root' ] && \
      [ \"\$(stat -c '%a %U' /etc/yggdrasil-trunk/trunk-kek)\" = '600 root' ] && \
      [ \"\$(stat -c '%a %U' /run/trunk/claim)\" = '600 trunk' ]"

  check a3 "ufw on (22 + 443 open, 80 not), unattended-upgrades + weekly signed update timer enabled" \
    vps ot-vps-a "ufw status | grep -q '^Status: active' && ufw status | grep -q '^22/tcp.*ALLOW' && \
      ufw status | grep -q '^443/tcp.*ALLOW' && ! ufw status | grep -q '^80/tcp' && \
      dpkg-query -W -f '\${Status}' unattended-upgrades | grep -q 'ok installed' && \
      systemctl is-enabled -q yggdrasil-trunk-update.timer && systemctl is-active -q yggdrasil-trunk-update.timer"

  KEYSUM=$(vps ot-vps-a 'sha256sum </etc/yggdrasil-trunk/key.pem')
  KEKSUM=$(vps ot-vps-a 'sha256sum </etc/yggdrasil-trunk/trunk-kek')
  vps ot-vps-a "cd /root && $REL bash trunk.sh --add-name extra.tree.test -y" >"$STATE/log/a4-addname.log" 2>&1; rc=$?
  check a4 "SPKI pin matches, --add-name writes extra_names, re-run keeps key + kek + pin" \
    bash -c "[ $rc = 0 ] && [ \"\$(docker exec ot-vps-a /usr/local/lib/yggdrasil-trunk/bifrost-net ap-pin /etc/yggdrasil-trunk/cert.pem)\" = 'pin = \"sha-256 $PIN_A\"' ] && \
      docker exec ot-vps-a grep -q 'extra_names *=.*\"extra.tree.test\"' /etc/yggdrasil-trunk/trunk.toml && \
      [ \"\$(docker exec ot-vps-a bash -c 'sha256sum </etc/yggdrasil-trunk/key.pem')\" = '$KEYSUM' ] && \
      [ \"\$(docker exec ot-vps-a bash -c 'sha256sum </etc/yggdrasil-trunk/trunk-kek')\" = '$KEKSUM' ]"

  docker cp ot-vps-a:/etc/yggdrasil-trunk/cert.pem "$STATE/sim/trunk-a.pem" >/dev/null && chmod 644 "$STATE/sim/trunk-a.pem"
  if [ $REALSTAMP = 0 ]; then
    vps ot-vps-a "mkdir -p /etc/systemd/system/yggdrasil-trunk-update.service.d && printf '[Service]\nEnvironment=YGG_RELEASE_TEST_SIGNERS=$TS\n' \
      >/etc/systemd/system/yggdrasil-trunk-update.service.d/test-signers.conf && systemctl daemon-reload"
  fi

  # ---- claim ot-vps-a via trunk-ctl claim-code --json + scripted agent
  CLAIM_JSON=$(vps ot-vps-a 'trunk-ctl claim-code --json')
  CLAIM_CODE=$(printf '%s' "$CLAIM_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])' 2>/dev/null || true)
  outside "python3 /sim/v1-agent.py claim --url https://$A --code '$CLAIM_CODE' --cookies /sim/cookies-a.json --cacert /sim/trunk-a.pem" >"$STATE/log/a5-claim.log" 2>&1; rc=$?
  check a5 "claim via trunk-ctl claim-code --json + scripted agent: /t/state claimed, /run/trunk/claim gone, claim-code refuses" \
    bash -c "[ $rc = 0 ] && outside \"curl -s --cacert /sim/trunk-a.pem https://$A/t/state\" | grep -q '\"claimed\":true' && \
      ! docker exec ot-vps-a test -e /run/trunk/claim && \
      ! docker exec ot-vps-a trunk-ctl claim-code --json >/dev/null 2>&1"

  # ------------------------------------------------------------------------------- home computer (root.sh)
  say "stage a: plain Debian 12 computer — /install/root.sh (tamper checks, enroll + approve, running)"
  docker run -d --name ot-home --hostname home-pc --network "$NET" --ip "$IP_HOME" \
    -v "$ROOT/root/mock:/mock:ro" -v "$STATE/sim:/sim" debian:12 sleep infinity >/dev/null
  dx ot-home bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      curl ca-certificates openssh-client libopus0 python3 iproute2 procps >/dev/null && useradd -m -s /bin/bash '"$HU" >"$STATE/log/home-apt.log" 2>&1
  # trust the self-signed trunk cert in the container's system CA store
  docker cp "$STATE/sim/trunk-a.pem" ot-home:/usr/local/share/ca-certificates/trunk-a.crt >/dev/null
  dx ot-home update-ca-certificates >/dev/null 2>&1
  to_box ot-home
  docker cp "$DIST/root.sh" ot-home:"$HH/root-dist.sh" >/dev/null && dx ot-home chown "$HU:$HU" "$HH/root-dist.sh"
  homesh 'mkdir -p ~/mock && cd ~/mock && (setsid nohup python3 /mock/mock_upstream.py 18397 >mock.log 2>&1 &) &&
    printf "YGG_UPSTREAM_BASE_URL=http://127.0.0.1:18397\nYGG_UPSTREAM_STYLE=anthropic\nYGG_UPSTREAM_API_KEY=mock\nYGG_UPSTREAM_MODEL=mock\n" >~/model.env'

  check h0 "home computer has no node, npm, cargo, rustc or git" \
    homesh '! command -v node && ! command -v npm && ! command -v cargo && ! command -v rustc && ! command -v git'

  if [ -n "$KEY" ]; then
    for v in 9.9.1 9.9.2; do
      homesh "cd ~ && $HREL bash root-dist.sh --trunk https://$A --version $v --upstream-env ~/model.env" >"$STATE/log/h0-$v.log" 2>&1 </dev/null
      echo "rc=$?" >>"$STATE/log/h0-$v.log"
    done
    check h0t "root.sh refuses forged releases (SHA256SUMS changed / archive changed); nothing unpacked" \
      bash -c "grep -q 'NOT signed by the yggdrasil release key' '$STATE/log/h0-9.9.1.log' && grep -q 'rc=1' '$STATE/log/h0-9.9.1.log' && \
        grep -q 'does not match SHA256SUMS' '$STATE/log/h0-9.9.2.log' && grep -q 'rc=1' '$STATE/log/h0-9.9.2.log' && \
        ! docker exec ot-home test -e $HH/.local/share/yggdrasil/release/9.9.2"
  else
    skip h0t "root.sh refuses forged releases" "needs OT_DIST_KEY"
  fi
  homesh "sed \"s/^YGG_RELEASE_TEST='1'/YGG_RELEASE_TEST=''/\" ~/root-dist.sh >~/root-real.sh && cp ~/root-dist.sh ~/root-changed.sh && echo '# one line more' >>~/root-changed.sh"
  homesh "cd ~ && $HREL YGG_RELEASE_TEST_SIGNERS=$TS bash root-real.sh --trunk https://$A --upstream-env ~/model.env" >"$STATE/log/h0p-real.log" 2>&1 </dev/null; rc=$?
  homesh "cd ~ && $HREL bash root-changed.sh --trunk https://$A --upstream-env ~/model.env" >"$STATE/log/h0s-changed.log" 2>&1 </dev/null; rc2=$?
  check h0p "real release's root.sh with YGG_RELEASE_TEST_SIGNERS refuses (64) before downloading" \
    bash -c "[ $rc = 64 ] && grep -q 'it trusts only the yggdrasil release key' '$STATE/log/h0p-real.log'"
  check h0s "tampered root.sh stops before downloading the archive" \
    bash -c "[ $rc2 = 1 ] && grep -q 'is not the one release v$VER signed' '$STATE/log/h0s-changed.log' && \
      ! docker exec ot-home test -e $HH/.local/share/yggdrasil/release/$VER"

  # Download root.sh directly from the trunk (baked URL + trunk key), run it while the rig approves!
  homesh "curl -fsSL https://$A/install/root.sh -o ~/root.sh" >"$STATE/log/h1-fetch.log" 2>&1
  homesh "cd ~ && $HREL YGG_TRUNK_PIN='sha-256 $PIN_A' bash root.sh --upstream-env ~/model.env" >"$STATE/log/h1-root.log" 2>&1 </dev/null &
  ROOT_PID=$!
  outside "python3 /sim/v1-agent.py approve --url https://$A --cookies /sim/cookies-a.json --name home-pc --timeout 120 --cacert /sim/trunk-a.pem" >"$STATE/log/h1-approve.log" 2>&1; appr_rc=$?
  wait "$ROOT_PID"; root_rc=$?
  # wait briefly for bridge to write trunk-state.json with link.state == "up"
  for _ in $(seq 20); do
    homesh 'grep -q "\"state\": *\"up\"" ~/.local/share/yggdrasil-root/trunk-state.json 2>/dev/null' && break
    sleep 1
  done
  ROOT_ID=$(homesh 'sed -n "s/^ROOT_ID=//p" ~/.local/share/yggdrasil-root/root.conf 2>/dev/null')
  check h1 "GET /install/root.sh + enroll + rig approval: exit 0, bridge [trunk] A4, brain A5, E7 librarian+cclive, trunk-state up, online in /t/roots" \
    bash -c "[ $appr_rc = 0 ] && [ $root_rc = 0 ] && [ -n '$ROOT_ID' ] && \
      homesh 'test -f ~/.local/share/yggdrasil-root/root.json && [ \"\$(stat -c %a ~/.local/share/yggdrasil-root/root.json)\" = 600 ] && \
        grep -q \"^\[trunk\]\" ~/.local/share/yggdrasil-root/bridge.toml && \
        grep -q \"^url = \\\"https://$A\\\"\" ~/.local/share/yggdrasil-root/bridge.toml && \
        grep -q \"^root_id = \\\"$ROOT_ID\\\"\" ~/.local/share/yggdrasil-root/bridge.toml && \
        grep -q \"^trunk_state = \" ~/.local/share/yggdrasil-root/wg.toml && \
        grep -qx \"YGG_ROOT_NAME=$ROOT_ID\" ~/.local/share/yggdrasil-root/brain.env && \
        grep -q \"^YGG_PEER_TOKEN=ygp-\" ~/.local/share/yggdrasil-root/brain.env && \
        grep -qx \"BIFROST_AUTH=trunk\" ~/.local/share/yggdrasil-root/app.env && \
        test -x ~/.local/share/yggdrasil-root/librarian/librarian.py && \
        test -x ~/.local/share/yggdrasil-root/cclive/cc_live.py && \
        grep -q \"\\\"state\\\": *\\\"up\\\"\" ~/.local/share/yggdrasil-root/trunk-state.json' && \
      outside \"python3 /sim/v1-agent.py roots --url https://$A --cookies /sim/cookies-a.json --cacert /sim/trunk-a.pem\" | grep -q '\"online\": true'"

  homesh "cd ~ && $HREL bash root.sh --upstream-env ~/model.env" >"$STATE/log/h2-rerun.log" 2>&1 </dev/null; rc=$?
  check h2 "root.sh re-run: idempotent (already joined, same root_id, exit 0)" \
    bash -c "[ $rc = 0 ] && grep -q 'already joined: root $ROOT_ID' '$STATE/log/h2-rerun.log'"

  # dtls_fp: the directory pin of the really-installed root is the bridge's actual certificate
  # fingerprint (what /identity and /offer carry), and a plain --update (nothing newer) keeps it.
  BR_PORT=$(homesh 'sed -n "s/^BRIDGE_PORT=//p" ~/.local/share/yggdrasil-root/root.conf')
  bridge_fp() { homesh "curl -s http://127.0.0.1:$BR_PORT/identity" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("fingerprint",""))'; }
  dir_fp() { outside "python3 /sim/v1-agent.py roots --url https://$A --cookies /sim/cookies-a.json --cacert /sim/trunk-a.pem" | python3 -c '
import json,sys
d=json.load(sys.stdin); d=d.get("roots",d) if isinstance(d,dict) else d
print(" ".join(r.get("dtls_fp","") for r in d if r.get("id")=="'$ROOT_ID'" or r.get("root_id")=="'$ROOT_ID'"))'; }
  FP0=$(bridge_fp); homesh "cd ~ && $HREL bash root.sh --update --upstream-env ~/model.env" >"$STATE/log/h3-update.log" 2>&1 </dev/null; rc=$?
  FP1=$(bridge_fp)
  check h1d "enrolled dtls_fp is non-empty, equals the bridge's real certificate fingerprint, and --update keeps it (rc $rc)" \
    bash -c "[ $rc = 0 ] && [ -n '$FP0' ] && [ '$FP0' = '$FP1' ] && [ \"\$(echo $(dir_fp))\" = '$FP0' ]"

  if [ -n "$KEY" ]; then
    latest 2.0.0-test
    homesh "cd ~ && $HREL bash root.sh --update --upstream-env ~/model.env" >"$STATE/log/h3-major.log" 2>&1 </dev/null; rc=$?
    check h3 "root.sh --update refuses a major bump (1.x → 2.0.0-test) without --major (exit 64)" \
      bash -c "[ $rc = 64 ] && grep -q 'crosses a MAJOR version' '$STATE/log/h3-major.log'"
    latest "$VER"
  else
    skip h3 "root.sh --update --major gate" "needs OT_DIST_KEY"
  fi

  # ---------------------------------------------------------------------- weekly update + --major gate
  say "stage a: weekly update — nothing newer; newer 1.0.1-test; forged; broken rollback; 2.0.0 --major gate"
  vps ot-vps-a 'systemctl start yggdrasil-trunk-update.service; journalctl -u yggdrasil-trunk-update -o cat --no-pager' >"$STATE/log/a7-update-none.log" 2>&1
  check a7 "update timer with nothing newer: 'is the newest release — nothing to do'" \
    bash -c "grep -q 'signature OK' '$STATE/log/a7-update-none.log' && grep -q '$VER is the newest release' '$STATE/log/a7-update-none.log'"

  if [ -n "$KEY" ]; then
    latest 1.0.1-test
    vps ot-vps-a 'systemctl start yggdrasil-trunk-update.service; journalctl -u yggdrasil-trunk-update -o cat --no-pager' >"$STATE/log/a8-update.log" 2>&1
    sleep 2
    check a8 "newer signed 1.0.1-test: updated by itself, same pin, trunk still claimed & answering" \
      bash -c "grep -q 'update: $VER → 1.0.1-test' '$STATE/log/a8-update.log' && \
        docker exec ot-vps-a grep -qx 'BINARY=bifrost-net-1.0.1-test-linux-x86_64' /etc/yggdrasil-trunk/trunk.conf && \
        docker exec ot-vps-a systemctl is-active -q yggdrasil-trunk && \
        outside \"curl -s --cacert /sim/trunk-a.pem https://$A/t/state\" | grep -q '\"claimed\":true'"

    latest 1.0.2-test
    vps ot-vps-a 'systemctl start yggdrasil-trunk-update.service; journalctl -u yggdrasil-trunk-update -o cat --no-pager -n 30' >"$STATE/log/a9-update-forged.log" 2>&1
    check a9 "forged newer release (1.0.2-test): refused, 1.0.1-test stays" \
      bash -c "grep -q 'NOT signed by the yggdrasil release key' '$STATE/log/a9-update-forged.log' && \
        docker exec ot-vps-a grep -qx 'BINARY=bifrost-net-1.0.1-test-linux-x86_64' /etc/yggdrasil-trunk/trunk.conf"

    GOODBIN=$(vps ot-vps-a 'sha256sum </usr/local/lib/yggdrasil-trunk/bifrost-net')
    latest 1.0.3-test
    vps ot-vps-a 'systemctl start yggdrasil-trunk-update.service; journalctl -u yggdrasil-trunk-update -o cat --no-pager -n 60' >"$STATE/log/a10-update-broken.log" 2>&1
    sleep 3
    check a10 "signed but broken 1.0.3-test: rolled back automatically to 1.0.1-test, answering again" \
      bash -c "grep -q 'update: 1.0.1-test → 1.0.3-test' '$STATE/log/a10-update-broken.log' && \
        grep -q 'the previous trunk is back and answering' '$STATE/log/a10-update-broken.log' && \
        [ \"\$(docker exec ot-vps-a bash -c 'sha256sum </usr/local/lib/yggdrasil-trunk/bifrost-net')\" = '$GOODBIN' ] && \
        docker exec ot-vps-a grep -qx 'BINARY=bifrost-net-1.0.1-test-linux-x86_64' /etc/yggdrasil-trunk/trunk.conf && \
        outside \"curl -s --cacert /sim/trunk-a.pem https://$A/t/state\" | grep -q '\"claimed\":true'"

    latest 2.0.0-test
    vps ot-vps-a "$TSENV /usr/local/sbin/yggdrasil-trunk --update" >"$STATE/log/a11-major-refused.log" 2>&1; rc1=$?
    vps ot-vps-a "$TSENV /usr/local/sbin/yggdrasil-trunk --update --major" >"$STATE/log/a11-major-ok.log" 2>&1; rc2=$?
    check a11 "--update refuses 2.0.0-test without --major (exit 64); --update --major crosses cleanly" \
      bash -c "[ $rc1 = 64 ] && grep -q 'crosses a MAJOR version' '$STATE/log/a11-major-refused.log' && \
        [ $rc2 = 0 ] && docker exec ot-vps-a grep -qx 'BINARY=bifrost-net-2.0.0-test-linux-x86_64' /etc/yggdrasil-trunk/trunk.conf && \
        outside \"curl -s --cacert /sim/trunk-a.pem https://$A/t/state\" | grep -q '\"claimed\":true'"
    latest "$VER"
  else
    skip a8 "newer signed update" "needs OT_DIST_KEY"
    skip a9 "forged update refused" "needs OT_DIST_KEY"
    skip a10 "broken update rollback" "needs OT_DIST_KEY"
    skip a11 "--update --major gate" "needs OT_DIST_KEY"
  fi
fi

# =========================================================================================== stage b
if stage b; then
  say "stage b: Pebble ACME standalone on :80, --renew --force (same SPKI pin), claim"
  new_vps ot-vps-b "$IP_B" "$B"
  vps ot-vps-b 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq ufw >/dev/null && ufw allow 22/tcp >/dev/null && ufw --force enable >/dev/null' >"$STATE/log/b-ufw.log" 2>&1
  docker cp "$DIST/trunk.sh" ot-vps-b:/root/trunk.sh >/dev/null
  docker cp "$STATE/bin/bifrost-net" ot-vps-b:/root/bifrost-net >/dev/null
  docker cp "$STATE/sim/pebble-acme-ca.pem" ot-vps-b:/root/pebble-acme-ca.pem >/dev/null
  PEB="REQUESTS_CA_BUNDLE=/root/pebble-acme-ca.pem"
  vps ot-vps-b "cd /root && $PEB bash trunk.sh --name $B --acme-server https://pebble:14000/dir --binary /root/bifrost-net -y" >"$STATE/log/b1-trunk.log" 2>&1; rc=$?
  PIN_B=$(pin_of "$STATE/log/b1-trunk.log")
  check b1 "trunk.sh --acme-server <Pebble>: exit 0, Pebble cert, ufw 80 + 443 open, cert timer enabled" \
    bash -c "[ $rc = 0 ] && [ -n '$PIN_B' ] && docker exec ot-vps-b openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -issuer | grep -qi pebble && \
      docker exec ot-vps-b ufw status | grep -q '^80/tcp.*ALLOW' && docker exec ot-vps-b ufw status | grep -q '^443/tcp.*ALLOW' && \
      docker exec ot-vps-b systemctl is-enabled -q yggdrasil-trunk-cert.timer"
  check b2 "outsider verifies full chain against Pebble root (no -k): https://$B/t/state → 200 unclaimed" \
    bash -c "outside \"curl -s --cacert /sim/pebble-root.pem https://$B/t/state\" | grep -q '\"claimed\":false'"
  SERIAL=$(vps ot-vps-b 'openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -serial')
  vps ot-vps-b "/usr/local/sbin/yggdrasil-trunk --renew --force" >"$STATE/log/b3-renew.log" 2>&1; rc=$?
  check b3 "renewal (--renew --force): new cert serial, SAME SPKI pin, still answers 200" \
    bash -c "[ $rc = 0 ] && [ \"\$(docker exec ot-vps-b openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -serial)\" != '$SERIAL' ] && \
      [ \"\$(docker exec ot-vps-b /usr/local/lib/yggdrasil-trunk/bifrost-net ap-pin /etc/yggdrasil-trunk/cert.pem)\" = 'pin = \"sha-256 $PIN_B\"' ] && \
      outside \"curl -s --cacert /sim/pebble-root.pem https://$B/t/state\" | grep -q '\"claimed\":false'"
  vps ot-vps-b 'systemctl start yggdrasil-trunk-cert.service' >"$STATE/log/b4-timer.log" 2>&1; rc=$?
  check b4 "cert timer unit runs clean: not due yet, nothing to do" \
    bash -c "[ $rc = 0 ] && docker exec ot-vps-b journalctl -u yggdrasil-trunk-cert -o cat --no-pager | grep -q 'nothing to do'"
  CLAIM_B=$(vps ot-vps-b 'trunk-ctl claim-code --json' | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])' 2>/dev/null || true)
  outside "python3 /sim/v1-agent.py claim --url https://$B --code '$CLAIM_B' --cookies /sim/cookies-b.json --cacert /sim/pebble-root.pem" >"$STATE/log/b5-claim.log" 2>&1; rc=$?
  check b5 "claim on Pebble trunk: /t/state claimed: true" \
    bash -c "[ $rc = 0 ] && outside \"curl -s --cacert /sim/pebble-root.pem https://$B/t/state\" | grep -q '\"claimed\":true'"
fi

# =========================================================================================== stage c
if stage c; then
  say "stage c: VPS with nginx website on :80/:443 — trunk.sh --behind-proxy --acme --webroot"
  new_vps ot-vps-c "$IP_C" "$C" "$WWW"
  # shellcheck disable=SC2016
  vps ot-vps-c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq nginx openssl curl >/dev/null &&
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /etc/nginx/www.key -out /etc/nginx/www.crt -days 30 \
      -subj /CN=www.tree.test -addext subjectAltName=DNS:www.tree.test 2>/dev/null &&
    cat >/etc/nginx/sites-enabled/default <<NGX
server { listen 80 default_server; server_name www.tree.test; location / { return 200 "WEBSITE OK (http)\n"; } }
server { listen 443 ssl default_server; server_name www.tree.test; ssl_certificate /etc/nginx/www.crt; ssl_certificate_key /etc/nginx/www.key;
         location / { return 200 "WEBSITE OK \$remote_addr\n"; } }
NGX
    nginx -t 2>/dev/null && systemctl restart nginx' >"$STATE/log/c-website.log" 2>&1
  docker cp ot-vps-c:/etc/nginx/www.crt "$STATE/sim/www.crt" >/dev/null; chmod 644 "$STATE/sim/www.crt"
  check c0 "website answers on :443 and :80 before anything" \
    outside "curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | grep -q '^WEBSITE OK' && curl -s -m 5 http://$WWW/ | grep -q '^WEBSITE OK (http)'"

  docker cp "$DIST/trunk.sh" ot-vps-c:/root/trunk.sh >/dev/null
  docker cp "$STATE/bin/bifrost-net" ot-vps-c:/root/bifrost-net >/dev/null
  docker cp "$STATE/sim/pebble-acme-ca.pem" ot-vps-c:/root/pebble-acme-ca.pem >/dev/null
  ENVC="REQUESTS_CA_BUNDLE=/root/pebble-acme-ca.pem"

  vps ot-vps-c "cd /root && $ENVC bash trunk.sh --name $C --acme-server https://pebble:14000/dir --binary /root/bifrost-net -y" >"$STATE/log/c1-busy.log" 2>&1; rc=$?
  check c1 "without --behind-proxy: refused (443 taken by nginx), nothing installed, website up" \
    bash -c "[ $rc != 0 ] && grep -q 'taken by .nginx' '$STATE/log/c1-busy.log' && grep -q -- '--behind-proxy' '$STATE/log/c1-busy.log' && \
      ! docker exec ot-vps-c test -e /etc/systemd/system/yggdrasil-trunk.service && \
      [ \"\$(outside \"curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | cut -c1-10\")\" = 'WEBSITE OK' ]"

  vps ot-vps-c "cd /root && $ENVC bash trunk.sh --name $C --behind-proxy --acme-server https://pebble:14000/dir --binary /root/bifrost-net -y" >"$STATE/log/c2-behind.log" 2>&1; rc=$?
  PIN_C=$(pin_of "$STATE/log/c2-behind.log")
  check c2 "--behind-proxy: plain http on 127.0.0.1:8080, trusted_proxies set, CERTIFICATE PENDING + nginx snippet, ufw 22/80/443" \
    bash -c "[ $rc = 0 ] && [ -n '$PIN_C' ] && grep -q 'CERTIFICATE PENDING' '$STATE/log/c2-behind.log' && grep -q 'nginx holds port 80' '$STATE/log/c2-behind.log' && \
      docker exec ot-vps-c grep -qx 'listen_http *= \"127.0.0.1:8080\"' /etc/yggdrasil-trunk/trunk.toml && \
      docker exec ot-vps-c grep -q 'trusted_proxies *= \[\"127.0.0.1/32\"' /etc/yggdrasil-trunk/trunk.toml && \
      docker exec ot-vps-c ufw status | grep -q '^Status: active' && \
      [ \"\$(outside \"curl -s -m 5 http://$WWW/ | cut -c1-10\")\" = 'WEBSITE OK' ]"

  awk '/nginx holds port 80/{f=1} f&&/^ *server \{/{p=1} p{print} p&&/^ *\}$/{exit}' "$STATE/log/c2-behind.log" | sed 's/^ *//' >"$STATE/sim/acme-snippet.conf"
  docker cp "$STATE/sim/acme-snippet.conf" ot-vps-c:/etc/nginx/conf.d/yggdrasil-trunk-acme.conf >/dev/null
  WR=$(sed -n 's/.*sudo bash trunk\.sh --webroot \([^ ]*\).*/\1/p' "$STATE/log/c2-behind.log" | head -1)
  vps ot-vps-c "nginx -t && systemctl reload nginx && cd /root && $ENVC bash trunk.sh --webroot $WR -y" >"$STATE/log/c3-webroot.log" 2>&1; rc=$?
  check c3 "printed nginx snippet + trunk.sh --webroot: Pebble cert through nginx :80, same SPKI pin, website up" \
    bash -c "[ $rc = 0 ] && ! grep -q 'CERTIFICATE PENDING' '$STATE/log/c3-webroot.log' && \
      docker exec ot-vps-c openssl x509 -in /etc/yggdrasil-trunk/cert.pem -noout -issuer | grep -qi pebble && \
      grep -q 'pin: *sha-256 $PIN_C' '$STATE/log/c3-webroot.log' && \
      [ \"\$(outside \"curl -s -m 5 http://$WWW/ | cut -c1-10\")\" = 'WEBSITE OK' ]"

  # nginx HTTPS reverse proxy for $C -> http://127.0.0.1:8080 with X-Forwarded-For
  # shellcheck disable=SC2016
  vps ot-vps-c 'cat >/etc/nginx/conf.d/yggdrasil-trunk-https.conf <<'"'NGX'"'
server {
    listen 443 ssl;
    server_name '"$C"';
    ssl_certificate /etc/yggdrasil-trunk/cert.pem;
    ssl_certificate_key /etc/yggdrasil-trunk/key.pem;
    location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
}
NGX
    nginx -t && systemctl reload nginx' >"$STATE/log/c4-proxy.log" 2>&1; rc=$?
  sleep 1
  outside "curl -sv --cacert /sim/pebble-root.pem https://$C/t/state" >"$STATE/log/c4-curl.log" 2>&1 || true
  check c4 "nginx HTTPS reverse proxy -> 127.0.0.1:8080: outsider reaches https://$C/t/state (Pebble cert), website still up" \
    bash -c "[ $rc = 0 ] && grep -q '\"claimed\":false' '$STATE/log/c4-curl.log' && \
      [ \"\$(outside \"curl -s -m 5 --cacert /sim/www.crt https://$WWW/ | cut -c1-10\")\" = 'WEBSITE OK' ]"
fi

# =========================================================================================== stage j
if stage j; then
  say "stage j: Debian 10 (glibc 2.28) refused plainly by root.sh before downloading anything"
  docker run -d --name ot-buster --hostname buster debian:10 sleep infinity >/dev/null
  docker cp "$DIST/root.sh" ot-buster:/root/root.sh >/dev/null
  dx ot-buster bash -c "cd /root && $HREL bash root.sh --trunk https://$A" >"$STATE/log/j2-buster.log" 2>&1 </dev/null; rc=$?
  check j2 "Debian 10 (glibc 2.28): refused plainly before anything is downloaded" \
    bash -c "[ $rc = 1 ] && grep -q 'glibc 2.28: the release needs 2.31 or newer' '$STATE/log/j2-buster.log' && \
      grep -q 'Nothing was downloaded' '$STATE/log/j2-buster.log' && ! docker exec ot-buster test -e /root/.local/share/yggdrasil"
fi

# =========================================================================================== stage u
if stage u; then
  say "stage u: --uninstall — root.sh and trunk.sh leave nothing behind"
  if up ot-home; then
    homesh "bash ~/root.sh --uninstall" >"$STATE/log/u0-home-ask.log" 2>&1 </dev/null; rc0=$?
    homesh "bash ~/root.sh --uninstall -y" >"$STATE/log/u1-home.log" 2>&1; rc=$?
    sleep 1
    check u1 "root.sh --uninstall asks without -y (64); -y removes dir, units, release, processes" \
      bash -c "[ $rc0 = 64 ] && [ $rc = 0 ] && grep -q 'removed' '$STATE/log/u1-home.log' && \
        ! docker exec ot-home test -e $HH/.local/share/yggdrasil-root && \
        ! docker exec ot-home test -e $HH/.local/share/yggdrasil && \
        ! docker exec ot-home ps -eo stat=,args= | grep -v '^Z' | grep -E 'bifrost-net|yggdrasil|server\.mjs'"
  fi
  if up ot-vps-a; then
    vps ot-vps-a "/usr/local/sbin/yggdrasil-trunk --uninstall" >"$STATE/log/u2-trunk-ask.log" 2>&1 </dev/null; rc0=$?
    vps ot-vps-a "/usr/local/sbin/yggdrasil-trunk --uninstall -y" >"$STATE/log/u3-trunk.log" 2>&1; rc=$?
    check u3 "trunk.sh --uninstall asks without -y (64); -y removes units, config, binary, trunk-ctl, static user; ufw active, 22 open, 443 closed" \
      bash -c "[ $rc0 = 64 ] && [ $rc = 0 ] && ! docker exec ot-vps-a sh -c 'ls /etc/systemd/system/yggdrasil-* 2>/dev/null | grep -q .' && \
        ! docker exec ot-vps-a test -e /etc/yggdrasil-trunk && ! docker exec ot-vps-a test -e /usr/local/lib/yggdrasil-trunk && \
        ! docker exec ot-vps-a test -e /usr/local/sbin/yggdrasil-trunk && ! docker exec ot-vps-a test -e /usr/local/bin/trunk-ctl && \
        ! docker exec ot-vps-a test -e /var/lib/yggdrasil-trunk && ! docker exec ot-vps-a id trunk >/dev/null 2>&1 && \
        ! docker exec ot-vps-a pgrep -x bifrost-net && docker exec ot-vps-a ufw status | grep -q '^Status: active' && \
        docker exec ot-vps-a ufw status | grep -q '^22/tcp.*ALLOW' && ! docker exec ot-vps-a ufw status | grep -q '^443/tcp'"
  fi
fi

# ====================================================================================== the table
echo
printf '%-5s %-4s %s\n' STEP "" WHAT
fails=0 skips=0
while IFS=$'\t' read -r res id what detail; do
  printf '%-5s %-4s %s%s\n' "$id" "$res" "$what" "${detail:+  $detail}"
  case $res in PASS) ;; SKIP) skips=$((skips + 1)) ;; *) fails=$((fails + 1)) ;; esac
done <"$RESULTS"
echo "state + logs: $STATE"
if [ "$fails" != 0 ]; then echo "OWN-TRUNK: RED ($fails failed)"; exit 1; fi
echo "OWN-TRUNK: GREEN$( [ "$skips" = 0 ] || echo " ($skips skipped — see SKIP above)")"
