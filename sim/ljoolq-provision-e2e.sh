#!/usr/bin/env bash
# sim/ljoolq-provision-e2e.sh — G4.6: trunk/deploy/ljoolq-provision.sh, the exact script step V0 runs on the VPS,
# rehearsed on a throwaway Debian 13 "VPS" at home: a privileged debian:13 docker container with systemd as
# PID 1, ufw on and a dockerd stand-in (FORWARD DROP), and Incus nested inside it. Nothing here reaches the VPS.
#
#   sim/ljoolq-provision-e2e.sh            exit 0 = GREEN · 1 = a check failed · 2 = the rig could not be built
#   G46_KEEP=1 …                          keep the box afterwards (docker rm -f v1ops-g46-vps)
#
# The provisioning script runs with LJOOLQ_TEST_SKIP_GATE=1: it skips ONLY the gate check (the box is not a
# VPS step), and says so in its output; every other step runs as it will on veraldar. The installer inside is
# today's trunk/install/trunk.sh as a stand-in (the INSTALL stream writes v1's); its check is its own loopback.
# Checks: refusals (no gate → nothing done; the override with an ssh: target → refused, no ssh run), the
# packages (Debian's incus-base 6.0.x, no qemu), the pool, bridge, firewall, profile limits as the kernel
# applies them (384 MiB, half a CPU, a 2 GiB disk that refuses more), unprivileged, the container's way out
# through ufw + docker's DROP, no new public port, the installer's trunk answering, a re-run that changes
# nothing, snapshot + restore, a scheduled snapshot firing, and a reboot of the box: autostart, firewall again.
set -uo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
export TMPDIR=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ops}
BOX=v1ops-g46-vps
IMG=v1ops/vps13:g46
STATE=$TMPDIR/g46/$(date +%Y%m%d-%H%M%S)
mkdir -p "$STATE"
LOG=$STATE/run.log
PROV=$ROOT/trunk/deploy/ljoolq-provision.sh
SHA=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)
CT=trunk-ljoolq
PASS=0 FAIL=0
say() { printf '\n== %s\n' "$*"; }
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "PASS $2"; else FAIL=$((FAIL + 1)); echo "FAIL $2${3:+  [$3]}"; fi; }
chk() { local what=$1; shift; if "$@" >>"$LOG" 2>&1; then ok 0 "$what"; else ok 1 "$what"; fi; }
bx() { docker exec "$BOX" bash -c "$*"; }
inct() { docker exec "$BOX" incus exec "$CT" -- bash -c "$*"; }
redact() { sed -E 's/(token=)[0-9a-f]+/\1<redacted>/g; s/(#pin=[0-9A-F:]+,token=)[^ ]*/\1<redacted>/g'; }
prov() { # ARGS… — the provisioning script against the box, its output (secrets redacted) to the log and $STATE/last
  LJOOLQ_TEST_SKIP_GATE=1 "$PROV" --target "docker:$BOX" "$@" 2>&1 | redact >"$STATE/last"
  local rc=${PIPESTATUS[0]}
  cat "$STATE/last" >>"$LOG"
  return "$rc"
}
cleanup() {
  if [ "${G46_KEEP:-0}" = 1 ]; then echo "kept: docker container $BOX (docker rm -f $BOX)"; return; fi
  docker rm -f "$BOX" >/dev/null 2>&1 || true
}
trap cleanup EXIT
wait_boot() {
  local s
  for _ in $(seq 1 60); do s=$(bx 'systemctl is-system-running' 2>/dev/null || true); case $s in running|degraded) return 0 ;; esac; sleep 1; done
  return 1
}

# ── the rig ───────────────────────────────────────────────────────────────────────────────────────────────
command -v docker >/dev/null || { echo "docker is needed"; exit 2; }
BIN=$ROOT/trunk/target/release/bifrost-net
[ -x "$BIN" ] || { echo "build bifrost-net first: (cd trunk && cargo build --release)"; exit 2; }
say "G4.6 — ljoolq-provision.sh on a throwaway Debian 13 box ($BOX) · commit $SHA · log $LOG"
docker rm -f "$BOX" >/dev/null 2>&1 || true
docker build -q -t "$IMG" -f "$HERE/ljoolq-provision/vps13.Dockerfile" "$HERE/ljoolq-provision" >>"$LOG" 2>&1 || { echo "image build failed (log $LOG)"; exit 2; }
docker run -d --name "$BOX" --hostname vps13 --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  -v /lib/modules:/lib/modules:ro "$IMG" >>"$LOG" 2>&1 || { echo "the box did not start"; exit 2; }
wait_boot || { echo "the box's systemd did not come up"; exit 2; }
# like the VPS: ufw on (ssh, 80, 443 in; nothing else), docker's FORWARD DROP (the stand-in unit)
bx 'ufw default deny incoming >/dev/null && ufw default allow outgoing >/dev/null && ufw allow 22/tcp >/dev/null &&
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw --force enable >/dev/null && systemctl enable -q ufw' >>"$LOG" 2>&1 ||
  { echo "ufw setup failed"; exit 2; }
bx 'ufw status | grep -q "Status: active" && iptables -S FORWARD | grep -q "^-P FORWARD DROP" && iptables -nL DOCKER-USER >/dev/null' ||
  { echo "the box is not VPS-like (ufw, FORWARD DROP)"; exit 2; }
bx "ss -Hltnu | awk '{print \$1, \$5}' | sort -u" >"$STATE/ports-before"
echo "the box: Debian $(bx '. /etc/os-release; echo $VERSION_ID'), ufw active, FORWARD DROP + DOCKER-USER (dockerd stand-in)"

# ── 1. refusals ───────────────────────────────────────────────────────────────────────────────────────────
say "1. refusals"
"$PROV" --target "docker:$BOX" up "$SHA" >"$STATE/refuse1" 2>&1; rc=$?
cat "$STATE/refuse1" >>"$LOG"
ok "$([ $rc != 0 ] && grep -q 'gate check refused' "$STATE/refuse1" && ! bx 'command -v incus' >/dev/null 2>&1; echo $?)" \
  "no gate file (gate-check stand-in) → refused, and the box is untouched (no incus)"
mkdir -p "$STATE/shim" && printf '#!/bin/sh\necho "ssh $*" >>"%s/ssh-called"\nexit 1\n' "$STATE" >"$STATE/shim/ssh" && chmod +x "$STATE/shim/ssh"
PATH="$STATE/shim:$PATH" LJOOLQ_TEST_SKIP_GATE=1 "$PROV" --target ssh:veraldar up "$SHA" >"$STATE/refuse2" 2>&1; rc=$?
cat "$STATE/refuse2" >>"$LOG"
ok "$([ $rc != 0 ] && grep -q 'docker: rehearsal box only' "$STATE/refuse2" && [ ! -e "$STATE/ssh-called" ]; echo $?)" \
  "the test override with an ssh: target (the VPS) → refused before any ssh"
PATH="$STATE/shim:$PATH" "$PROV" --target ssh:veraldar restore "$SHA" pre-test >"$STATE/refuse3" 2>&1; rc=$?
ok "$([ $rc != 0 ] && grep -q 'gate check refused' "$STATE/refuse3" && [ ! -e "$STATE/ssh-called" ]; echo $?)" \
  "restore without a gate file → refused before any ssh"

# ── 2. up ─────────────────────────────────────────────────────────────────────────────────────────────────
say "2. up (Incus from Debian, pool, bridge, firewall, profile, container, v1 trunk.sh inside)"
INST_ARGS="--name ljoolq.veraldar.org --rp-id veraldar.org --behind-proxy --bind 10.99.0.2 --trusted-proxy 10.99.0.1/32 --self-signed --binary /root/ljoolq-install/bifrost-net --no-firewall --no-auto-updates -y"
UP=(up "$SHA" --installer "$ROOT/trunk/install/trunk.sh" --push "$BIN"
    --installer-args "$INST_ARGS" --check-url http://10.99.0.2:8080/t/state --check-codes 200)
t0=$(date +%s)
prov "${UP[@]}"; rc=$?
ok "$rc" "ljoolq-provision.sh up exits 0 ($(( $(date +%s) - t0 )) s)" "$(tail -3 "$STATE/last" | tr '\n' ' ')"
ok "$(grep -q 'TEST OVERRIDE: the gate check is SKIPPED' "$STATE/last"; echo $?)" "its output says the gate check (only) was skipped"
grep '^==>' "$STATE/last" | sed 's/^/   /'
# rp_id: the passkeys' domain is the parent (spec §11 step 6), so ap. can be added at the switchover
ok "$(inct "grep -qx 'rp_id          = \"veraldar.org\"' /etc/yggdrasil-trunk/trunk.toml"; echo $?)" "the v1 trunk inside has rp_id = \"veraldar.org\" (not the name)"
inct 'cd /root/ljoolq-install && bash trunk.sh --add-name ap.veraldar.org --binary /root/ljoolq-install/bifrost-net -y' >>"$LOG" 2>&1; rcn=$?
sleep 3; code=$(bx "curl -s -o /dev/null -w '%{http_code}' http://10.99.0.2:8080/t/state")
ok "$([ $rcn = 0 ] && [ "$code" = 200 ] && inct "grep -q 'ap.veraldar.org' /etc/yggdrasil-trunk/trunk.toml && grep -qx 'rp_id          = \"veraldar.org\"' /etc/yggdrasil-trunk/trunk.toml && systemctl is-active -q yggdrasil-trunk"; echo $?)" "--add-name ap.veraldar.org: the trunk restarts and answers ($code), rp_id unchanged" "rc $rcn"
[ "$rc" = 0 ] || { echo "VERDICT: RED (up failed — the rest needs it) · log $LOG"; exit 1; }

say "3. what it made"
v=$(bx "dpkg-query -W -f='\${Version}' incus-base")
ok "$(case $v in 6.0.*) echo 0 ;; *) echo 1 ;; esac)" "Debian's incus-base $v (6.0.x, from trixie)"
ok "$(bx 'dpkg-query -W -f="\${Status}" qemu-system-x86 2>/dev/null | grep -q installed' && echo 1 || echo 0)" "no qemu (containers only, --no-install-recommends)"
chk "pool ljoolq: btrfs in a loop file" bx "incus storage show ljoolq | grep -q '^driver: btrfs' && incus storage get ljoolq source | grep -q '\.img\$'"
chk "bridge ljoolqbr0 10.99.0.1/24, NAT, no IPv6" bx "[ \"\$(incus network get ljoolqbr0 ipv4.address)\" = 10.99.0.1/24 ] && [ \"\$(incus network get ljoolqbr0 ipv4.nat)\" = true ] && [ \"\$(incus network get ljoolqbr0 ipv6.address)\" = none ]"
chk "container RUNNING at 10.99.0.2" bx "incus list $CT -c s4 -f csv | grep -q '^RUNNING,10.99.0.2 '"
um=$(inct 'cat /proc/self/uid_map' | awk '{print $1, $2}')
ok "$([ "${um%% *}" = 0 ] && [ "${um##* }" != 0 ]; echo $?)" "unprivileged: root inside is uid ${um##* } on the box" "$um"
chk "security.privileged / nesting off" bx "[ \"\$(incus config get $CT security.privileged --expanded)\" = false ] && [ \"\$(incus config get $CT security.nesting --expanded)\" = false ]"
ctm=$(bx "incus info $CT | sed -n 's/^ *Memory (current): //p'")
mm=$(bx "cat /sys/fs/cgroup/lxc.payload.$CT/memory.max" 2>/dev/null)
ok "$([ "$mm" = 402653184 ]; echo $?)" "memory: the kernel's limit is 384 MiB (memory.max $mm)"
fm=$(inct "free -m | awk '/^Mem:/ {print \$2}'")
ok "$([ "$fm" -le 384 ] 2>/dev/null; echo $?)" "memory: free inside says ${fm} MiB total (lxcfs)"
cm=$(bx "cat /sys/fs/cgroup/lxc.payload.$CT/cpu.max" 2>/dev/null)
ok "$([ "$cm" = "50000 100000" ]; echo $?)" "cpu: half a CPU (cpu.max $cm)"
dd_out=$(inct 'dd if=/dev/zero of=/root/fill bs=1M count=2600 2>&1; echo "rc=$?"; sync; du -m /root/fill | cut -f1; rm -f /root/fill' 2>&1)
dd_mb=$(sed -n '$p' <<<"$dd_out")
ok "$(grep -q 'rc=1' <<<"$dd_out" && [ "$dd_mb" -le 2100 ] 2>/dev/null; echo $?)" "disk: writing 2.6 GB is refused at ~2 GiB (wrote ${dd_mb} MB: $(grep -oiE 'quota exceeded|no space left' <<<"$dd_out" | head -1))" "$(tr '\n' ' ' <<<"$dd_out")"
chk "autostart on, nightly 03:00 snapshots kept 7 d" bx "[ \"\$(incus config get $CT boot.autostart --expanded)\" = true ] && [ \"\$(incus config get $CT snapshots.schedule --expanded)\" = '0 3 * * *' ] && [ \"\$(incus config get $CT snapshots.expiry --expanded)\" = 7d ]"
chk "the container's way out: DNS + https to deb.debian.org (through ufw and docker's DROP)" inct 'curl -sS -o /dev/null -m 15 https://deb.debian.org/debian/dists/trixie/Release'
chk "ufw: in + routed allowed on ljoolqbr0 (3 rules, + their v6 twins), nothing else opened" bx "ufw status | grep 'on ljoolqbr0' | grep -vc '(v6)' | grep -qx 3 && ! ufw status | grep -E '^(8080|4443|4479)'"
chk "docker's DOCKER-USER lets ljoolqbr0 out (trunk-ljoolq-fw.service)" bx "systemctl is-active -q trunk-ljoolq-fw && iptables -S DOCKER-USER | grep -q -- '-i ljoolqbr0 -j ACCEPT'"
bx "ss -Hltnu | awk '{print \$1, \$5}' | sort -u" >"$STATE/ports-after"
newp=$(comm -13 "$STATE/ports-before" "$STATE/ports-after" | grep -vE ' (10\.99\.0\.1|127\.[0-9.]+|\[::1\]|\[fe80:[^]]*\]|0\.0\.0\.0%ljoolqbr0|\*%ljoolqbr0|\[::\]%ljoolqbr0):[0-9]+$' || true)
ok "$([ -z "$newp" ]; echo $?)" "no new public port on the box (new listeners only on 10.99.0.1 / the bridge)" "$newp"
chk "the installer's trunk runs inside (yggdrasil-trunk.service)" inct 'systemctl is-active -q yggdrasil-trunk'
mem=$(bx "ps -C incusd,lxcfs,dnsmasq -o rss= | awk '{s+=\$1} END {print int(s/1024)}'")
echo "   cost on the box: incusd + lxcfs + dnsmasq ${mem} MiB RSS · the container ${ctm} right after up (before the disk test's page cache)"

# ── 4. re-run ─────────────────────────────────────────────────────────────────────────────────────────────
say "4. a re-run changes nothing"
uuid=$(bx "incus config get $CT volatile.uuid")
prov "${UP[@]}"; rc=$?
ok "$rc" "up again exits 0"
ok "$([ "$(bx "incus config get $CT volatile.uuid")" = "$uuid" ] && grep -q "container $CT: there" "$STATE/last" && grep -q 'storage pool ljoolq: there' "$STATE/last" && grep -q 'network ljoolqbr0: there' "$STATE/last" && grep -q 'ufw: ljoolqbr0 rules there' "$STATE/last"; echo $?)" \
  "the same container (volatile.uuid), pool, bridge and ufw rules — found, not made again"
ok "$(bx "ufw status | grep 'on ljoolqbr0' | grep -vc '(v6)'" | grep -qx 3; echo $?)" "ufw still has exactly 3 ljoolqbr0 rules (+ v6 twins)"
ok "$(bx "iptables -S DOCKER-USER | grep -c ljoolqbr0" | grep -qx 2; echo $?)" "DOCKER-USER still has exactly 2 ljoolqbr0 rules"

# ── 5. snapshot / restore ─────────────────────────────────────────────────────────────────────────────────
say "5. snapshot, break, restore"
prov snapshot "$SHA" pre-test; ok $? "snapshot pre-test"
inct 'systemctl disable -q --now yggdrasil-trunk; rm -f /etc/yggdrasil-trunk/trunk.toml' >>"$LOG" 2>&1
ok "$(inct 'systemctl is-active -q yggdrasil-trunk || [ -f /etc/yggdrasil-trunk/trunk.toml ]' && echo 1 || echo 0)" "broken on purpose: the trunk stopped, its trunk.toml gone"
prov restore "$SHA" pre-test; ok $? "restore pre-test"
for _ in $(seq 1 30); do inct 'systemctl is-active -q yggdrasil-trunk' 2>/dev/null && break; sleep 1; done
# a restored container needs a moment for its address and the trunk's listener: ask for up to 30 s (the check is unchanged)
code=000
for _ in $(seq 1 30); do
  code=$(bx 'curl -s -o /dev/null -m 5 -w "%{http_code}" http://10.99.0.2:8080/t/state' 2>/dev/null)
  [ "$code" = 200 ] && break
  sleep 1
done
ok "$(inct '[ -f /etc/yggdrasil-trunk/trunk.toml ] && systemctl is-active -q yggdrasil-trunk' && [ "$code" = 200 ]; echo $?)" "after the restore: trunk.toml back, the v1 trunk runs and answers from the host ($code)"

# ── 6. the nightly snapshot really fires (the schedule set to every minute for this check, then put back) ──
say "6. a scheduled snapshot fires (schedule '* * * * *' for one minute, then the profile's again)"
bx "incus config set $CT snapshots.schedule '* * * * *'"
got=''
for _ in $(seq 1 80); do got=$(bx "incus snapshot list $CT -f csv -c n | grep '^nightly-' | head -1"); [ -n "$got" ] && break; sleep 1; done
exp=$(bx "incus snapshot list $CT -f csv -c nE | grep '^$got,' | cut -d, -f2" 2>/dev/null)
bx "incus config unset $CT snapshots.schedule"
ok "$([ -n "$got" ] && [ -n "$exp" ]; echo $?)" "a scheduled snapshot '$got' was taken, expiring ${exp:-never}"
ok "$([ "$(bx "incus config get $CT snapshots.schedule --expanded")" = '0 3 * * *' ]; echo $?)" "the schedule is the profile's 03:00 again"

# ── 7. reboot ─────────────────────────────────────────────────────────────────────────────────────────────
say "7. the box reboots: the container comes back by itself, the firewall rules too"
docker restart -t 60 "$BOX" >>"$LOG" 2>&1
wait_boot; ok $? "the box is up again"
ok "$(bx 'journalctl --no-pager -b | grep -qi "ordering cycle"' && echo 1 || echo 0)" "no systemd ordering cycle (the provisioning's own trunk-ljoolq-fw.service included)" "$(bx 'journalctl --no-pager -b | grep -i "ordering cycle" | head -2' | tr '\n' ' ')"
st=''
for _ in $(seq 1 90); do st=$(bx "incus list $CT -c s -f csv" 2>/dev/null); [ "$st" = RUNNING ] && break; sleep 1; done
ok "$([ "$st" = RUNNING ]; echo $?)" "trunk-ljoolq autostarted ($st)"
code=000
for _ in $(seq 1 60); do code=$(bx 'curl -s -o /dev/null -m 5 -w "%{http_code}" http://10.99.0.2:8080/t/state' 2>/dev/null); [ "$code" = 200 ] && break; sleep 1; done
ok "$([ "$code" = 200 ]; echo $?)" "the v1 trunk inside answers from the host again ($code)"
chk "DOCKER-USER rules back after the docker stand-in started again" bx "iptables -S DOCKER-USER | grep -q -- '-i ljoolqbr0 -j ACCEPT' && iptables -S FORWARD | grep -q '^-P FORWARD DROP'"
chk "the way out works after the reboot" inct 'curl -sS -o /dev/null -m 15 https://deb.debian.org/debian/dists/trixie/Release'
chk "the snapshots survived (pre-test is there)" bx "incus snapshot list $CT -f csv -c n | grep -qx pre-test"
fm=$(inct "free -m | awk '/^Mem:/ {print \$2}'")
ok "$([ "$fm" -le 384 ] 2>/dev/null; echo $?)" "after the reboot: free inside says ${fm} MiB total (lxcfs)"
cm=$(bx "cat /sys/fs/cgroup/lxc.payload.$CT/cpu.max" 2>/dev/null)
ok "$([ "$cm" = "50000 100000" ]; echo $?)" "after the reboot: still half a CPU (cpu.max $cm)"
prov status; ok $? "status (reads only): $(grep 'status: limits' "$STATE/last" | sed 's/^==> status: //')"

say "G4.6 notes"
echo "   not rehearsed here: AppArmor (the VPS kernel enforces it, the home kernel runs none: Incus's AppArmor"
echo "   profiles load only on the VPS), the VPS's own kernel (6.12 vs home's), real dockerd (a stand-in sets its"
echo "   FORWARD DROP + DOCKER-USER), and v1's trunk.sh (INSTALL stream; today's trunk.sh stood in)."
echo
echo "G4.6: $PASS passed, $FAIL failed · log $LOG"
[ "$FAIL" = 0 ] && { echo "VERDICT: GREEN"; exit 0; }
echo "VERDICT: RED"; exit 1
