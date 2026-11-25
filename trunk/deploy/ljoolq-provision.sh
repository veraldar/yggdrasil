#!/usr/bin/env bash
# ljoolq-provision.sh — step V0 of trunk v1 (spec §10): Incus from Debian on the VPS and the test trunk's own
# container `trunk-ljoolq`, with the v1 trunk installed inside the way a user installs it. Run at HOME, from a
# clean worktree at <sha>: the gate check runs here, then the steps run on the target as root.
#
#   ljoolq-provision.sh [--target T] up <sha> [options]   provision (idempotent: a re-run changes nothing)
#   ljoolq-provision.sh [--target T] snapshot <sha> NAME  incus snapshot of trunk-ljoolq
#   ljoolq-provision.sh [--target T] restore <sha> NAME   trunk-ljoolq back to that snapshot
#   ljoolq-provision.sh [--target T] status               what is there (reads only, no gate)
#
#   --target ssh:HOST       the VPS (default ssh:veraldar): `ssh HOST sudo bash`
#   --target docker:NAME    a rehearsal box (sim/ljoolq-provision-e2e.sh, G4.6): `docker exec -i NAME bash`
# up options:
#   --installer FILE        the trunk installer run inside (default trunk/install/trunk.sh — the v0.9 installer as
#                           a stand-in until the INSTALL stream's v1 trunk.sh exists)
#   --installer-args "…"    its arguments (default: --name ljoolq.veraldar.org --behind-proxy)
#   --push FILE             a file put beside the installer in the container (/root/ljoolq-install/), repeatable
#   --check-url URL         the trunk answers here after the install (default http://10.99.0.2:8080/t/state, v1)
#   --check-codes "C…"      the HTTP codes that count as an answer (default 200)
#   --check-resolve IP      curl --resolve the URL's host:port to IP
#   --check-in-container    run the check inside the container (a trunk that listens on its loopback only)
#   --check-proxy-protocol  the check sends a PROXY v1 line first (a trunk behind a :443 router, like v0.9's)
#   --image IMG             the container's image (default images:debian/13)
#
# What `up` makes on the target (each step checked, each skipped when already so):
#   packages   incus-base (containers only: no qemu), btrfs-progs, dnsmasq-base, apparmor, iptables — Debian's
#              own (trixie: Incus 6.0.x; refused when another major comes up)
#   storage    pool `ljoolq`: btrfs in a loop file (6 GiB, sparse) — quotas and cheap snapshots on an ext4 VPS
#   network    bridge `ljoolqbr0` 10.99.0.1/24, NAT out, no IPv6; nothing listens on a public address
#   firewall   ufw (when active): in + routed traffic on ljoolqbr0 allowed (DHCP, DNS, the container's way out);
#              Docker (when its DOCKER-USER chain is there: dockerd sets FORWARD to DROP): the same two rules,
#              re-applied by trunk-ljoolq-fw.service whenever docker starts
#   profile    `trunk-ljoolq`: 384 MiB (hard), half a CPU (hard: 50ms/100ms), a 2 GiB root disk, unprivileged, no nesting,
#              autostart, a snapshot every night at 03:00 kept 7 days
#   container  `trunk-ljoolq` (10.99.0.2), then the installer inside, then the check
# Never touched: trunk-ap, sni-443, caddy, coturn, docker's own containers, ufw's other rules.
#
# Gate (spec R2): every command but `status` first runs gate_check <sha> from trunk/deploy/gate-check.sh (the
# LADDER stream's; until it is merged a stand-in that always refuses). LJOOLQ_TEST_SKIP_GATE=1 skips ONLY the
# gate check, ONLY for a docker: target (the G4.6 rehearsal), and says so; with an ssh: target it is refused.
set -euo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
TREE=$(cd "$HERE/../.." && pwd)
NAME=ljoolq.veraldar.org
CT=trunk-ljoolq
PROFILE=trunk-ljoolq
POOL=ljoolq
POOL_SIZE=6GiB
BR=ljoolqbr0
BR_ADDR=10.99.0.1/24
CT_IP=10.99.0.2
MEM=384MiB
CPU=50ms/100ms  # a HARD cap: half a CPU (a bare "50%" is only a soft weight in Incus)
DISK=2GiB
INCUS_MAJOR=6.0

say() { printf '==> %s\n' "$*"; }
die() { printf 'xx  ljoolq-provision: %s\n' "$*" >&2; exit 1; }

# ════════════════════════════════════════════════════════════════════ on the target (root)
on_target() {
  local cmd=$1; shift
  export DEBIAN_FRONTEND=noninteractive LC_ALL=C
  [ "$(id -u)" = 0 ] || die "on the target: not root"
  case $cmd in
    up) t_up "$@" ;;
    snapshot) t_have_ct; t_snapshot "$1" ;;
    restore) t_have_ct; t_restore "$1" ;;
    status) t_status ;;
    *) die "on the target: unknown $cmd" ;;
  esac
}

t_have_ct() { command -v incus >/dev/null && incus info "$CT" >/dev/null 2>&1 || die "no container $CT here"; }

t_preflight() {
  local v avail free
  v=$(. /etc/os-release && echo "${ID:-}:${VERSION_ID:-}")
  [ "$v" = debian:13 ] || die "this is $v, not Debian 13 — nothing was changed"
  [ -d /run/systemd/system ] || die "no systemd as PID 1 — nothing was changed"
  avail=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
  free=$(df -Pm / | awk 'NR==2 {print $4}')
  say "target: Debian 13, systemd, ${avail} MiB available, ${free} MiB free on /"
  if ! incus info "$CT" >/dev/null 2>&1; then
    [ "$avail" -ge 600 ] || die "only ${avail} MiB available: the container needs $MEM and Incus ~60 MiB — nothing was changed"
    [ "$free" -ge 7000 ] || die "only ${free} MiB free on /: the pool is ${POOL_SIZE} (sparse) — nothing was changed"
  fi
}

t_packages() {
  local miss=() p v
  for p in incus-base btrfs-progs dnsmasq-base apparmor iptables curl; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || miss+=("$p")
  done
  if [ ${#miss[@]} -gt 0 ]; then
    v=$(apt-cache policy incus-base 2>/dev/null | sed -n 's/^  Candidate: //p')
    [ -n "$v" ] || { apt-get update -qq; v=$(apt-cache policy incus-base | sed -n 's/^  Candidate: //p'); }
    case $v in "$INCUS_MAJOR".*) ;; *) die "Debian offers incus-base '$v', not $INCUS_MAJOR.x — nothing was installed" ;; esac
    say "apt-get install --no-install-recommends ${miss[*]} (incus-base $v)"
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends "${miss[@]}" >/dev/null
  fi
  v=$(dpkg-query -W -f='${Version}' incus-base)
  case $v in "$INCUS_MAJOR".*) ;; *) die "incus-base $v is installed, not $INCUS_MAJOR.x" ;; esac
  systemctl enable -q --now incus.socket incus.service >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do incus info >/dev/null 2>&1 && break; sleep 1; done
  incus info >/dev/null 2>&1 || die "the Incus daemon does not answer"
  say "incus $(incus --version) (Debian's incus-base $v), daemon up"
}

t_storage() {
  if incus storage show "$POOL" >/dev/null 2>&1; then
    say "storage pool $POOL: there ($(incus storage get "$POOL" size 2>/dev/null || echo '?'), $(incus storage show "$POOL" | sed -n 's/^driver: //p'))"
  else
    say "storage pool $POOL: btrfs in a loop file, $POOL_SIZE (sparse)"
    incus storage create "$POOL" btrfs size="$POOL_SIZE" >/dev/null
  fi
}

t_network() {
  if incus network show "$BR" >/dev/null 2>&1; then
    say "network $BR: there ($(incus network get "$BR" ipv4.address))"
  else
    say "network $BR: $BR_ADDR, NAT out, no IPv6"
    incus network create "$BR" ipv4.address="$BR_ADDR" ipv4.nat=true ipv6.address=none \
      ipv4.dhcp=true dns.mode=managed >/dev/null
  fi
}

# the two rules a container behind a dropping FORWARD chain needs: out through the bridge, and the answers back
FW_SCRIPT=/usr/local/lib/trunk-ljoolq/fw.sh
t_firewall() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    if ufw status | grep -q "on $BR"; then say "ufw: $BR rules there"; else
      say "ufw: allow in + routed on $BR (DHCP and DNS from the container, its way out)"
      ufw allow in on "$BR" comment 'trunk-ljoolq: DHCP + DNS' >/dev/null
      ufw route allow in on "$BR" comment 'trunk-ljoolq: the way out' >/dev/null
      ufw route allow out on "$BR" comment 'trunk-ljoolq: answers back' >/dev/null
    fi
  else
    say "ufw: not active — nothing to add"
  fi
  if iptables -nL DOCKER-USER >/dev/null 2>&1 || systemctl cat docker.service >/dev/null 2>&1; then
    install -d -m 755 "$(dirname "$FW_SCRIPT")"
    cat >"$FW_SCRIPT.new" <<EOF
#!/bin/sh
# trunk-ljoolq-fw: dockerd sets the FORWARD policy to DROP and makes DOCKER-USER empty at each start; these two
# rules let the trunk-ljoolq container out through $BR (and its answers back). Made by ljoolq-provision.sh.
iptables -nL DOCKER-USER >/dev/null 2>&1 || exit 0
iptables -C DOCKER-USER -i $BR -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -i $BR -j ACCEPT
iptables -C DOCKER-USER -o $BR -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null ||
  iptables -I DOCKER-USER -o $BR -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
EOF
    chmod 755 "$FW_SCRIPT.new" && mv -f "$FW_SCRIPT.new" "$FW_SCRIPT"
    cat >/etc/systemd/system/trunk-ljoolq-fw.service.new <<EOF
# made by ljoolq-provision.sh: the container's way out past docker's FORWARD DROP, after every docker start
[Unit]
Description=trunk-ljoolq: the container's way out past docker's FORWARD DROP
After=docker.service incus.service
PartOf=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$FW_SCRIPT
[Install]
WantedBy=multi-user.target docker.service
EOF
    if cmp -s /etc/systemd/system/trunk-ljoolq-fw.service.new /etc/systemd/system/trunk-ljoolq-fw.service; then
      rm -f /etc/systemd/system/trunk-ljoolq-fw.service.new
    else
      mv -f /etc/systemd/system/trunk-ljoolq-fw.service.new /etc/systemd/system/trunk-ljoolq-fw.service
      systemctl daemon-reload
    fi
    systemctl enable -q trunk-ljoolq-fw.service
    systemctl restart trunk-ljoolq-fw.service
    say "docker: DOCKER-USER lets $BR out (trunk-ljoolq-fw.service, after every docker start)"
  fi
}

t_profile() {
  incus profile show "$PROFILE" >/dev/null 2>&1 || incus profile create "$PROFILE" >/dev/null
  incus profile edit "$PROFILE" <<EOF
description: "trunk v1 test trunk $NAME (spec §10): 384 MiB, half a CPU, 2 GiB, unprivileged, nightly snapshots"
config:
  limits.memory: $MEM
  limits.memory.enforce: hard
  limits.cpu.allowance: "$CPU"
  security.privileged: "false"
  security.nesting: "false"
  boot.autostart: "true"
  snapshots.schedule: "0 3 * * *"
  snapshots.schedule.stopped: "false"
  snapshots.pattern: "nightly-%d"
  snapshots.expiry: 7d
devices:
  root:
    type: disk
    path: /
    pool: $POOL
    size: $DISK
  eth0:
    type: nic
    name: eth0
    network: $BR
EOF
  say "profile $PROFILE: $MEM (hard), CPU $CPU (half a CPU, hard), $DISK root on $POOL, unprivileged, autostart, nightly 03:00 kept 7 d"
}

t_container() {
  local image=$1
  if incus info "$CT" >/dev/null 2>&1; then
    say "container $CT: there ($(incus list "$CT" -c s -f csv))"
    [ "$(incus list "$CT" -c s -f csv)" = RUNNING ] || incus start "$CT"
  else
    say "container $CT from $image ($CT_IP)"
    incus launch "$image" "$CT" --profile "$PROFILE" --device "eth0,ipv4.address=$CT_IP" >/dev/null
  fi
  for _ in $(seq 1 60); do
    incus exec "$CT" -- sh -c 'systemctl is-system-running 2>/dev/null | grep -qE "running|degraded" && ip -4 -o addr show eth0 | grep -q inet' 2>/dev/null && break
    sleep 1
  done
  incus exec "$CT" -- ip -4 -o addr show eth0 | grep -q "inet $CT_IP/" || die "$CT has no $CT_IP"
  for _ in $(seq 1 30); do incus exec "$CT" -- getent hosts deb.debian.org >/dev/null 2>&1 && break; sleep 1; done
  incus exec "$CT" -- getent hosts deb.debian.org >/dev/null 2>&1 || die "$CT resolves no names (the bridge's DNS, the firewall?)"
  say "container $CT: up, $CT_IP, names resolve"
}

t_install() { # DIR ARGS… — the installer as a user runs it, inside; re-runs it on every `up` (it is idempotent)
  local dir=$1; shift
  incus exec "$CT" -- sh -c 'command -v curl >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null; }'
  incus exec "$CT" -- rm -rf /root/ljoolq-install
  incus exec "$CT" -- mkdir -p /root/ljoolq-install
  local f
  for f in "$dir"/*; do incus file push -q "$f" "$CT/root/ljoolq-install/"; done
  say "inside $CT: bash $(basename "$INSTALLER_NAME") $*"
  incus exec "$CT" --cwd /root/ljoolq-install -- bash "/root/ljoolq-install/$INSTALLER_NAME" "$@"
}

t_check() { # URL CODES RESOLVE INSIDE PROXY
  local url=$1 codes=$2 res=$3 inside=$4 code=000 hp a=()
  if [ -n "$res" ]; then hp=$(sed -E 's#^[a-z]+://([^/]+).*#\1#' <<<"$url"); case $hp in *:*) ;; *) hp="$hp:80" ;; esac; a=(--resolve "$hp:$res"); fi
  [ "$5" = 1 ] && a+=(--haproxy-protocol)
  for _ in $(seq 1 30); do
    if [ "$inside" = 1 ]; then code=$(incus exec "$CT" -- curl -sk -o /dev/null -m 5 -w '%{http_code}' "${a[@]}" "$url" || true)
    else code=$(curl -sk -o /dev/null -m 5 -w '%{http_code}' "${a[@]}" "$url" || true); fi
    case " $codes " in *" $code "*) break ;; esac
    sleep 1
  done
  case " $codes " in *" $code "*) say "the trunk answers: $url → $code$( [ "$inside" = 1 ] && echo ' (inside)')" ;;
    *) die "the trunk does not answer $url as expected ($code, want $codes)" ;; esac
}

t_up() {
  local image=$1 url=$2 codes=$3 res=$4 inside=$5 proxy=$6 dir=$7; shift 7
  t_preflight
  t_packages
  t_storage
  t_network
  t_firewall
  t_profile
  t_container "$image"
  t_install "$dir" "$@"
  t_check "$url" "$codes" "$res" "$inside" "$proxy"
  t_status
  say "up: done"
}

t_snapshot() {
  [ -n "${1:-}" ] || die "snapshot NAME"
  incus snapshot create "$CT" "$1" --reuse
  say "snapshot $CT/$1: $(incus snapshot list "$CT" -f csv -c nT | grep "^$1," | cut -d, -f2)"
}

t_restore() {
  [ -n "${1:-}" ] || die "restore NAME"
  incus snapshot list "$CT" -f csv -c n | grep -qx "$1" || die "no snapshot $1 of $CT"
  incus snapshot restore "$CT" "$1"
  [ "$(incus list "$CT" -c s -f csv)" = RUNNING ] || incus start "$CT"
  say "restored $CT to $1 ($(incus list "$CT" -c s -f csv))"
}

t_status() {
  if ! command -v incus >/dev/null; then say "status: Incus is not installed"; return 0; fi
  say "status: incus $(incus --version); $(incus list "$CT" -f csv -c ns4 2>/dev/null || echo "no $CT")"
  incus info "$CT" >/dev/null 2>&1 || return 0
  say "status: limits $(incus config get "$CT" limits.memory --expanded 2>/dev/null || true) · $(incus config get "$CT" limits.cpu.allowance --expanded 2>/dev/null || true) · root $(incus config device get "$CT" root size 2>/dev/null || incus profile device get "$PROFILE" root size) · snapshots: $(incus snapshot list "$CT" -f csv -c n | tr '\n' ' ')"
}

if [ "${1:-}" = --on-target ]; then shift; on_target "$@"; exit $?; fi

# ════════════════════════════════════════════════════════════════════ at home
TARGET=ssh:veraldar
INSTALLER=$TREE/trunk/install/trunk.sh
INSTALLER_ARGS="--name $NAME --behind-proxy"
PUSH=() IMAGE=images:debian/13 CHECK_URL="http://$CT_IP:8080/t/state" CHECK_CODES=200 CHECK_RESOLVE='' CHECK_INSIDE=0 CHECK_PROXY=0
[ "${1:-}" = --target ] && { TARGET=${2:?--target ssh:HOST|docker:NAME}; shift 2; }
CMD=${1:-}; shift || true
case $CMD in
  status) SHA='' ;;
  up|snapshot|restore) SHA=${1:?"$CMD <sha>"}; shift ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64 ;;
esac
ARG1=''
case $CMD in snapshot|restore) ARG1=${1:?"$CMD <sha> NAME"}; shift ;; esac
while [ $# -gt 0 ]; do
  case $1 in
    --installer) INSTALLER=$2; shift ;;
    --installer-args) INSTALLER_ARGS=$2; shift ;;
    --push) PUSH+=("$2"); shift ;;
    --check-url) CHECK_URL=$2; shift ;;
    --check-codes) CHECK_CODES=$2; shift ;;
    --check-resolve) CHECK_RESOLVE=$2; shift ;;
    --check-in-container) CHECK_INSIDE=1 ;;
    --check-proxy-protocol) CHECK_PROXY=1 ;;
    --image) IMAGE=$2; shift ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
case $TARGET in ssh:?*|docker:?*) ;; *) die "--target ssh:HOST or docker:NAME, not '$TARGET'" ;; esac
run_on_target() { # SCRIPT — bash as root on the target, stdin passed through (ssh re-parses its command line:
  #                 the script goes quoted; docker exec does not)
  case $TARGET in
    ssh:*) ssh -o BatchMode=yes "${TARGET#ssh:}" "sudo bash -c $(printf '%q' "$1")" ;;
    docker:*) docker exec -i "${TARGET#docker:}" bash -c "$1" ;;
  esac
}

# ── the gate (R2): before anything reaches the target
if [ "$CMD" != status ]; then
  if [ "${LJOOLQ_TEST_SKIP_GATE:-0}" = 1 ]; then
    case $TARGET in docker:*) ;; *) die "LJOOLQ_TEST_SKIP_GATE=1 is for a docker: rehearsal box only, never $TARGET — nothing was done" ;; esac
    say "TEST OVERRIDE: the gate check is SKIPPED (LJOOLQ_TEST_SKIP_GATE=1, rehearsal target $TARGET) — every other step runs as on the VPS"
  else
    if [ -f "$HERE/gate-check.sh" ]; then
      # shellcheck source=/dev/null
      . "$HERE/gate-check.sh"
    else
      gate_check() { echo "gate check: trunk/deploy/gate-check.sh (LADDER) is not in this tree yet — refusing every VPS step" >&2; return 1; }
    fi
    gate_check "$SHA" "$TREE" || die "the gate check refused $SHA — nothing was done on $TARGET"
    say "gate check: $SHA is green"
  fi
fi

# ── the payload: this script, the installer and its files, streamed to the target as one tar on stdin
export TMPDIR=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ops}
mkdir -p "$TMPDIR"
PAY=$(mktemp -d "$TMPDIR/ljoolq-provision.XXXXXX")
trap 'rm -rf "$PAY"' EXIT
mkdir -p "$PAY/install"
cp "$0" "$PAY/ljoolq-provision.sh"
INSTALLER_NAME=''
if [ "$CMD" = up ]; then
  [ -f "$INSTALLER" ] || die "no installer $INSTALLER"
  cp "$INSTALLER" "$PAY/install/"
  INSTALLER_NAME=$(basename "$INSTALLER")
  for f in "${PUSH[@]}"; do [ -f "$f" ] || die "no file $f"; cp "$f" "$PAY/install/"; done
fi
q() { printf '%q ' "$@"; }
case $CMD in
  up) # shellcheck disable=SC2086  # the installer's arguments are words, as typed
    REMOTE_ARGS=$(q up "$IMAGE" "$CHECK_URL" "$CHECK_CODES" "$CHECK_RESOLVE" "$CHECK_INSIDE" "$CHECK_PROXY" '$d/install' $INSTALLER_ARGS) ;;
  snapshot|restore) REMOTE_ARGS=$(q "$CMD" "$ARG1") ;;
  status) REMOTE_ARGS=status ;;
esac
REMOTE_ARGS=${REMOTE_ARGS//\\\$d/\$d}
say "$CMD on $TARGET"
SCRIPT="set -e; d=\$(mktemp -d /root/ljoolq-provision.XXXXXX); trap 'rm -rf \"\$d\"' EXIT; tar -xf - -C \"\$d\"; INSTALLER_NAME=$(q "$INSTALLER_NAME") bash \"\$d/ljoolq-provision.sh\" --on-target $REMOTE_ARGS"
[ "${LJOOLQ_SHOW:-0}" = 1 ] && { printf 'would run on %s as root: %s\n' "$TARGET" "$SCRIPT"; exit 0; }
tar -C "$PAY" -cf - . | run_on_target "$SCRIPT"
