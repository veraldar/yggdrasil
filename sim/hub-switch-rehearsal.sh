#!/usr/bin/env bash
# sim/hub-switch-rehearsal.sh — G4.4: scripts/hub-units.sh switch-v1 [--prepare], forced health-failure
# auto-restore, and rollback-v0 on throwaway systemd user units (hubrh-* only, never hub-*), with HUB_HOME /
# HUB_CONF / HUB_PV / HUB_SIM under ~/.cache/trunk-v1/tmp/ops/ and a local sni-443 v2 + loopback VPS stand-in
# (sim/hub-switch/rig.py) on ports 19100–19199 (CONTRACTS.md C7).
#
# Runs against stub binaries (sim/hub-switch/stub-bin.py + server.mjs) that speak every health endpoint and
# link protocol; the real-binary run comes once WIRE/IDP/APP releases are assembled.
#
#   sim/hub-switch-rehearsal.sh     exit 0 = GREEN · 1 = a check failed · 2 = rig setup failed
set -uo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
export TMPDIR=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ops}
STATE=$TMPDIR/g44/$(date +%Y%m%d-%H%M%S)-$$
mkdir -p "$STATE"
LOG=$STATE/run.log

# ── OPS port range 19100–19199 (C7) ────────────────────────────────────────────────────────────────────────
P=hubrh
BRAIN_PORT=19101 LIB_PORT=19102 CCLIVE_PORT=19103 PUBLIC_PORT=19104 TAILNET_PORT=19105 VOICE_PORT=19106
WG_HTTP=19107 WG_UDP=19108 WG_RELAY=19109
DOOR_PORT=19120 AP_PORT=19121 TRUNK_PORT=19122 OWNER_PORT=19123 SITE_PORT=19124 ICE_PORT=19125 ICE1_PORT=19126

HUB=$STATE/hub
CONF=$STATE/conf
PV=$STATE/pv
SIM=$STATE/sim
UNITS=${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR required}/systemd/user
mkdir -p "$HUB" "$CONF" "$PV/data/session" "$SIM" "$UNITS"

RIG_PID='' SNI_PID=''
ALL_UNITS=(
  "$P-brain.service" "$P-librarian.service" "$P-cclive.service" "$P-voice-agent.service"
  "$P-app.service" "$P-app-tailnet.service" "$P-bridge.service" "$P-wg.service"
  "$P-trunk-report.timer" "$P-trunk-watch.timer" "$P-trunk-report.service" "$P-trunk-watch.service"
)
PASS=0 FAIL=0
say() { printf '\n== %s\n' "$*"; }
ok() {
  if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "PASS $2"
  else FAIL=$((FAIL + 1)); echo "FAIL $2${3:+  [$3]}"; fi
}

cleanup() {
  for u in "${ALL_UNITS[@]}"; do
    systemctl --user disable --now "$u" >/dev/null 2>&1 || true
    systemctl --user stop "$u" >/dev/null 2>&1 || true
    rm -f "$UNITS/$u"
  done
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  [ -n "$SNI_PID" ] && kill "$SNI_PID" 2>/dev/null || true
  [ -n "$RIG_PID" ] && kill "$RIG_PID" 2>/dev/null || true
  wait "$SNI_PID" "$RIG_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Export the rehearsal overrides so every hub-units.sh invocation stays strictly inside $STATE and hubrh-*
export HUB_HOME=$HUB HUB_CONF=$CONF HUB_UNITS=$UNITS HUB_PREFIX=$P HUB_PV=$PV HUB_SIM=$SIM
export HUB_BRAIN_PORT=$BRAIN_PORT HUB_LIBRARIAN_PORT=$LIB_PORT HUB_CCLIVE_PORT=$CCLIVE_PORT
export HUB_PUBLIC_PORT=$PUBLIC_PORT HUB_TAILNET_PORT=$TAILNET_PORT HUB_VOICE_PORT=$VOICE_PORT
export HUB_WG_HTTP=$WG_HTTP HUB_WG_UDP=$WG_UDP HUB_WG_RELAY=$WG_RELAY
export HUB_BACKUP=$STATE/backup.sh
export HUB_AP_URL="https://ap.veraldar.org:$DOOR_PORT"
export HUB_RESOLVE="ap.veraldar.org:$DOOR_PORT:127.0.0.1 ljoolq.veraldar.org:$DOOR_PORT:127.0.0.1"
export CURL_CA_BUNDLE=$STATE/ca.pem

HU=$ROOT/scripts/hub-units.sh
SHA=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo 0000000000000000000000000000000000000000)

run_hu() { # [env…] hub-units args… (output appended to $LOG and $STATE/last)
  "$@" >"$STATE/last" 2>&1
  local rc=$?
  cat "$STATE/last" >>"$LOG"
  return $rc
}

snap_tree() { # DIR → sorted sha256 of regular files (excluding backup-v0-* / undone-v1-* / v1/ / MANIFEST)
  (cd "$1" && find . -maxdepth 1 -type f | LC_ALL=C sort | xargs -r sha256sum)
}

rig_val() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$STATE/rig-status.json" "$1" 2>/dev/null || echo -1; }

write_sni_conf() { # v0 | v1
  if [ "$1" = v0 ]; then
    cat >"$STATE/sni-443.conf" <<EOF
listen 127.0.0.1:$DOOR_PORT
route ap.veraldar.org 127.0.0.1:$AP_PORT proxy
ice 127.0.0.1:$ICE_PORT
default 127.0.0.1:$SITE_PORT
EOF
  else
    cat >"$STATE/sni-443.conf" <<EOF
listen 127.0.0.1:$DOOR_PORT
route ap.veraldar.org 127.0.0.1:$TRUNK_PORT
ice 127.0.0.1:$ICE_PORT
ice_owner http://127.0.0.1:$OWNER_PORT/t/ice/owner 127.0.0.1:$ICE1_PORT 200ms
default 127.0.0.1:$SITE_PORT
EOF
  fi
}

# ── 0. build the rehearsal rig ─────────────────────────────────────────────────────────────────────────────
say "G4.4 — hub-units.sh switch-v1 / forced failure / rollback-v0 on throwaway $P-* units (stubs) · log $LOG"

# Self-signed CA + server cert for ap.veraldar.org and ljoolq.veraldar.org
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=g44-ca" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$STATE/ca.key" -out "$STATE/ca.pem" >>"$LOG" 2>&1 || { echo "CA gen failed"; exit 2; }
openssl req -newkey rsa:2048 -nodes -subj "/CN=ap.veraldar.org" \
  -keyout "$STATE/srv.key" -out "$STATE/srv.csr" >>"$LOG" 2>&1 || { echo "CSR gen failed"; exit 2; }
cat >"$STATE/srv.ext" <<EOF
subjectAltName=DNS:ap.veraldar.org,DNS:ljoolq.veraldar.org
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in "$STATE/srv.csr" -CA "$STATE/ca.pem" -CAkey "$STATE/ca.key" -CAcreateserial \
  -out "$STATE/srv.pem" -days 2 -extfile "$STATE/srv.ext" >>"$LOG" 2>&1 || { echo "cert sign failed"; exit 2; }
cp "$STATE/ca.pem" "$CONF/rig-ca.pem"
chmod 600 "$CONF/rig-ca.pem"

# Start loopback VPS stand-in (rig.py) and sni-443 v2
python3 "$HERE/hub-switch/rig.py" "$STATE/srv.pem" "$STATE/srv.key" "$STATE/rig-status.json" \
  "$AP_PORT" "$TRUNK_PORT" "$OWNER_PORT" "$SITE_PORT" "$ICE_PORT" "$ICE1_PORT" >>"$STATE/rig.log" 2>&1 &
RIG_PID=$!
for _ in $(seq 1 40); do [ -s "$STATE/rig-status.json" ] && break; sleep 0.25; done
[ -s "$STATE/rig-status.json" ] || { echo "rig.py did not start (log $STATE/rig.log)"; exit 2; }

write_sni_conf v0
SNI443_STATS=off python3 "$ROOT/trunk/deploy/sni-443.py" -c "$STATE/sni-443.conf" >>"$STATE/sni.log" 2>&1 &
SNI_PID=$!
for _ in $(seq 1 40); do python3 -c "import socket; socket.create_connection(('127.0.0.1',$DOOR_PORT),1).close()" 2>/dev/null && break; sleep 0.25; done
kill -0 "$SNI_PID" 2>/dev/null || { echo "sni-443.py did not start (log $STATE/sni.log)"; exit 2; }

# Build 3 fake stub releases: R0-v0.9, R1-v1 (good), R1-v1-bad (bridge never links)
make_rel() {
  local id=$1 r=$HUB/releases/$1
  mkdir -p "$r/bin" "$r/app" "$r/librarian" "$r/cc-live" "$r/voice" "$r/scripts"
  install -m 755 "$HERE/hub-switch/stub-bin.py" "$r/bin/yggdrasil"
  install -m 755 "$HERE/hub-switch/stub-bin.py" "$r/bin/bifrost-net"
  install -m 755 "$HERE/hub-switch/stub-bin.py" "$r/librarian/librarian.py"
  install -m 755 "$HERE/hub-switch/stub-bin.py" "$r/cc-live/cc_live.py"
  install -m 755 "$HERE/hub-switch/stub-bin.py" "$r/voice/agent.py"
  install -m 644 "$HERE/hub-switch/server.mjs" "$r/app/server.mjs"
  printf '#!/usr/bin/env python3\nimport sys; sys.exit(0)\n' >"$r/scripts/trunk-report.py"
  chmod 755 "$r/scripts/trunk-report.py"
  printf 'id=%s\ncommit=%s\nbuilt=2026-11-25T23:00:00+01:00\napp_build_id=stub\n' "$id" "$SHA" >"$r/BUILD"
}
make_rel R0-v0.9
make_rel R1-v1
make_rel R1-v1-bad
touch "$HUB/releases/R1-v1-bad/bin/never-link"
ln -sfn "$HUB/releases/R0-v0.9" "$HUB/current"

# Fake state/, voice-venv, data/, cc-live token, backup script
mkdir -p "$HUB/state/voice-venv/bin"
ln -sfn /usr/bin/python3 "$HUB/state/voice-venv/bin/python"
printf '{"devices":[{"id":"dev_1"}]}\n' >"$HUB/state/devices.json"
printf '{"roots":[{"id":"rt_1"}]}\n' >"$HUB/state/roots.json"
printf '{"dtls":"sha-256 AA:BB"}\n' >"$HUB/state/bridge-dtls.json"
printf '{"id":"ses_1","title":"[MAIN]"}\n' >"$PV/data/session/ses_1.json"
printf '{"agents":[]}\n' >"$PV/agents.json"
printf 'rehearsal-cclive-token\n' >"$SIM/cc-live.token"

cat >"$STATE/backup.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
b="$STATE/data-backups/\$(date +%Y%m%d-%H%M%S)-\$\$"
mkdir -p "\$b"
tar -C "$PV" -czf "\$b/sessions.tgz" data/session
cp -p "$PV/agents.json" "\$b/agents.json"
echo "backup: \$b (rehearsal)"
EOF
chmod 755 "$STATE/backup.sh"

# Fake v0.9 $CONF/* (mode 600)
umask 077
cat >"$CONF/app-public.env" <<EOF
PORT=$PUBLIC_PORT
BIFROST_AUTH=devices
STUB_BUILD=public-v0
EOF
cat >"$CONF/app-tailnet.env" <<EOF
PORT=$TAILNET_PORT
BIFROST_AUTH=tailnet
AGENT_NAME=bifrost-hub
STUB_BUILD=tailnet
EOF
cat >"$CONF/brain.env" <<EOF
YGG_ROOT_NAME=omarchy
STUB_PORT=$BRAIN_PORT
STUB_LIBRARIAN=$LIB_PORT
EOF
cat >"$CONF/voice-agent.env" <<EOF
AGENT_LOAD=off
AGENT_HTTP_PORT=$VOICE_PORT
EOF
cat >"$CONF/bridge-public.toml" <<EOF
[node]
name = "omarchy"

[ap]
url = "https://ap.veraldar.org:$DOOR_PORT"
pin = "sha-256 00:00"
token = "v0-stub-token"
upstream = "127.0.0.1:$PUBLIC_PORT"

[bridge.root-link]
listen = "127.0.0.1:19110"
wg_relay = "127.0.0.1:$WG_RELAY"
wg_local = "127.0.0.1:$WG_UDP"
EOF
cat >"$CONF/wg-hub.toml" <<EOF
[wg]
key_file = "$CONF/wg-hub.key"
udp = "127.0.0.1:$WG_UDP"
relay = "127.0.0.1:$WG_RELAY"
http = "127.0.0.1:$WG_HTTP"
brain = "http://127.0.0.1:$BRAIN_PORT"
roots_file = "$HUB/state/roots.json"
devices_file = "$HUB/state/devices.json"
EOF
printf 'wg-stub-priv\n' >"$CONF/wg-hub.key"
printf 'wg-stub-pub\n' >"$CONF/wg-hub.key.pub"
chmod 600 "$CONF"/*
umask 022

# Render and start all 8 v0.9 units
run_hu "$HU" render || { echo "render failed (log $LOG)"; exit 2; }
for u in "$P-brain" "$P-librarian" "$P-cclive" "$P-voice-agent" "$P-app" "$P-app-tailnet" "$P-bridge" "$P-wg"; do
  systemctl --user enable -q --now "$u.service" >>"$LOG" 2>&1 || { echo "failed to start $u (log $LOG)"; exit 2; }
done

# ── 1. v0.9 baseline ───────────────────────────────────────────────────────────────────────────────────────
say "1. v0.9 baseline (8 $P-* units on R0-v0.9 behind local sni-443 v2)"
run_hu "$HU" health
ok $? "v0.9 health passes (ap.veraldar.org → 200 through the bridge, all 8 units)"
ok "$([ "$(rig_val v0_links)" = 1 ]; echo $?)" "rig sees 1 active v0.9 bridge link (v0_links=$(rig_val v0_links))"

# ── 2. refusals (R2 gate check & live-hub guard) ───────────────────────────────────────────────────────────
say "2. refusals (R2 gate check and live-hub safety guard)"
TRUNK_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
run_hu "$HU" switch-v1 --prepare R1-v1 --trunk-url "https://ap.veraldar.org:$DOOR_PORT" --trunk-key "$TRUNK_KEY" --root-id rt_omarchy
rc=$?
ok "$([ "$rc" != 0 ] && [ ! -d "$CONF/v1" ]; echo $?)" "switch-v1 --prepare without gate file is refused and creates no \$CONF/v1"
run_hu env HUB_TEST_SKIP_GATE=1 HUB_PREFIX=hub "$HU" switch-v1 --prepare R1-v1 --trunk-url "https://ap.veraldar.org:$DOOR_PORT" --trunk-key "$TRUNK_KEY" --root-id rt_omarchy
rc=$?
ok "$([ "$rc" != 0 ] && grep -q 'never the live hub' "$STATE/last"; echo $?)" "HUB_TEST_SKIP_GATE=1 with HUB_PREFIX=hub is refused (live-hub guard)"

# ── 3. switch-v1 --prepare ─────────────────────────────────────────────────────────────────────────────────
say "3. switch-v1 --prepare (renders \$CONF/v1/ without changing anything live)"
run_hu env HUB_TEST_SKIP_GATE=1 "$HU" switch-v1 --prepare R1-v1 --trunk-url "https://ap.veraldar.org:$DOOR_PORT" --trunk-key "$TRUNK_KEY" --root-id rt_omarchy
ok $? "switch-v1 --prepare R1-v1 succeeds with HUB_TEST_SKIP_GATE=1 (rehearsal override)"
ok "$([ "$(stat -c %a "$CONF/v1")" = 700 ] && [ "$(stat -c %a "$CONF/v1/root.key")" = 600 ] && [ -s "$CONF/v1/root.key.pub" ]; echo $?)" "\$CONF/v1 (0700) and root.key (0600) + root.key.pub created"
ok "$(grep -qx 'BIFROST_AUTH=trunk' "$CONF/v1/app-public.env" && grep -qx 'BIFROST_TRUST_PROXY=1' "$CONF/v1/app-public.env"; echo $?)" "\$CONF/v1/app-public.env has BIFROST_AUTH=trunk and BIFROST_TRUST_PROXY=1"
ok "$(grep -q '^\[trunk\]' "$CONF/v1/bridge-public.toml" && ! grep -q '^\[ap\]' "$CONF/v1/bridge-public.toml" && grep -q '^wg_relay =' "$CONF/v1/bridge-public.toml" && grep -q '^upstream =' "$CONF/v1/bridge-public.toml"; echo $?)" "\$CONF/v1/bridge-public.toml has [trunk] with carried-over upstream/wg_relay and no [ap]"
ok "$(grep -q '^trunk_state =' "$CONF/v1/wg-hub.toml" && ! grep -q '^roots_file' "$CONF/v1/wg-hub.toml" && ! grep -q '^devices_file' "$CONF/v1/wg-hub.toml"; echo $?)" "\$CONF/v1/wg-hub.toml has trunk_state= (A4) and no v0.9 roots_file/devices_file"
ok "$([ "$(basename "$(readlink "$HUB/current")")" = R0-v0.9 ] && grep -qx 'BIFROST_AUTH=devices' "$CONF/app-public.env"; echo $?)" "nothing live changed (current=R0-v0.9, app-public.env still BIFROST_AUTH=devices)"

# Snapshot v0.9 $CONF and state/ checksums before any switch
snap_tree "$CONF" >"$STATE/conf-v0.sha"
snap_tree "$HUB/state" >"$STATE/state-v0.sha"

# ── 4. forced health failure on switch-v1 R1-v1-bad → automatic restore ───────────────────────────────────
say "4. forced health failure (R1-v1-bad: bridge never links) → automatic restore of conf, state, data, release"
# Flip route to v1 trunk so /t/state and / → 302 pass, isolating the forced bridge health failure (never-link)!
# Wait: on auto-restore hub-units.sh runs HUB_HEALTH=v0 health; keep route on v0 so v1 health fails AND auto-restore v0 health passes!
run_hu env HUB_TEST_SKIP_GATE=1 "$HU" switch-v1 R1-v1-bad
rc=$?
ok "$([ "$rc" != 0 ]; echo $?)" "switch-v1 R1-v1-bad exits non-zero (health failure detected)"
ok "$([ "$(basename "$(readlink "$HUB/current")")" = R0-v0.9 ]; echo $?)" "current release automatically restored to R0-v0.9"
snap_tree "$CONF" >"$STATE/conf-after-fail.sha"
snap_tree "$HUB/state" >"$STATE/state-after-fail.sha"
ok "$(diff -u "$STATE/conf-v0.sha" "$STATE/conf-after-fail.sha" >/dev/null && diff -u "$STATE/state-v0.sha" "$STATE/state-after-fail.sha" >/dev/null; echo $?)" "\$CONF/* and state/* restored byte for byte to pre-switch state"
BK_FAIL=$(ls -d "$CONF"/backup-v0-* 2>/dev/null | tail -n 1)
ok "$([ -n "$BK_FAIL" ] && [ "$(stat -c %a "$BK_FAIL")" = 700 ] && (cd "$BK_FAIL" && sha256sum --quiet -c MANIFEST); echo $?)" "backup-v0-* created (mode 0700, valid MANIFEST)"
run_hu "$HU" health
ok $? "today's v0.9 health passes again after automatic restore"

# ── 5. switch-v1 R1-v1 (route moved to v1 trunk via sni-443 SIGHUP) ───────────────────────────────────────
say "5. switch-v1 R1-v1 (sni-443 SIGHUP → v1 trunk, switch-v1 passes v1 health profile)"
write_sni_conf v1
kill -HUP "$SNI_PID"
sleep 0.5
run_hu env HUB_TEST_SKIP_GATE=1 "$HU" switch-v1 R1-v1
ok $? "switch-v1 R1-v1 succeeds and passes the v1 health profile"
ok "$([ "$(basename "$(readlink "$HUB/current")")" = R1-v1 ]; echo $?)" "current release is now R1-v1"
ok "$([ -s "$HUB/state/trunk-state.json" ] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["version"]==1 and d["link"]["state"]=="up" else 1)' "$HUB/state/trunk-state.json"; echo $?)" "trunk-state.json written with version=1, link.state=up"
ok "$([ "$(rig_val v1_links)" = 1 ]; echo $?)" "rig sees 1 active v1 trunk link (v1_links=$(rig_val v1_links))"
run_hu "$HU" health
ok $? "standalone hub-units.sh health auto-selects v1 profile and passes"
# v0.9 state files untouched (spec §11 data rule)
snap_tree "$HUB/state" | grep -v 'trunk-state.json' >"$STATE/state-v1-v0files.sha"
ok "$(diff -u "$STATE/state-v0.sha" "$STATE/state-v1-v0files.sha" >/dev/null; echo $?)" "v0.9 state files (devices.json, roots.json, bridge-dtls.json) untouched in v1"

BK=$(ls -d "$CONF"/backup-v0-* 2>/dev/null | tail -n 1)

# ── 6. rollback-v0 refusal while route still points to v1 ─────────────────────────────────────────────────
say "6. rollback-v0 refusal while ap.veraldar.org still routes to v1 trunk"
run_hu env HUB_TEST_SKIP_GATE=1 "$HU" rollback-v0 R0-v0.9 "$BK"
rc=$?
ok "$([ "$rc" != 0 ] && grep -q 'still answers like v1' "$STATE/last"; echo $?)" "rollback-v0 refuses while ap. still answers 302 /login (move route first)"
ok "$([ "$(basename "$(readlink "$HUB/current")")" = R1-v1 ]; echo $?)" "nothing changed on refusal (current is still R1-v1)"

# ── 7. move route back + rollback-v0 → today's v0.9 health passes again ──────────────────────────────────
say "7. move route back (sni-443 SIGHUP → v0.9 ap) + rollback-v0 R0-v0.9"
write_sni_conf v0
kill -HUP "$SNI_PID"
sleep 0.5
code=$(curl --resolve "ap.veraldar.org:$DOOR_PORT:127.0.0.1" -s -o /dev/null -w '%{http_code}' -m 5 "https://ap.veraldar.org:$DOOR_PORT/" || echo 000)
ok "$([ "$code" = 503 ]; echo $?)" "after route flip back, ap.veraldar.org/ answers 503 (v0.9 ap waiting for bridge, got $code)"
run_hu env HUB_TEST_SKIP_GATE=1 "$HU" rollback-v0 R0-v0.9 "$BK"
ok $? "rollback-v0 R0-v0.9 succeeds and passes today's v0.9 health"
ok "$([ "$(basename "$(readlink "$HUB/current")")" = R0-v0.9 ]; echo $?)" "current release is back to R0-v0.9"
snap_tree "$CONF" >"$STATE/conf-after-rb.sha"
snap_tree "$HUB/state" >"$STATE/state-after-rb.sha"
ok "$(diff -u "$STATE/conf-v0.sha" "$STATE/conf-after-rb.sha" >/dev/null && diff -u "$STATE/state-v0.sha" "$STATE/state-after-rb.sha" >/dev/null; echo $?)" "\$CONF/* and state/* restored byte for byte (trunk-state.json moved to undone-v1-*)"
ok "$(ls -d "$CONF"/undone-v1-* >/dev/null 2>&1; echo $?)" "what v1 left was preserved beside in undone-v1-*"
ok "$([ "$(rig_val v0_links)" = 1 ]; echo $?)" "rig sees 1 active v0.9 bridge link again (v0_links=$(rig_val v0_links))"
run_hu "$HU" health
ok $? "standalone hub-units.sh health auto-selects v0 profile (ap. / → 200) and passes"

# ── 8. teardown verification ──────────────────────────────────────────────────────────────────────────────
say "8. teardown ($P-* units stopped and removed)"
cleanup
trap - EXIT
left=$(systemctl --user list-units --all --no-legend "$P-*" 2>/dev/null | grep -c ' active ' || true)
ok "$([ "$left" = 0 ]; echo $?)" "zero $P-* units remain active after teardown"

printf '\nG4.4: %d passed, %d failed · log %s\n' "$PASS" "$FAIL" "$LOG"
if [ "$FAIL" = 0 ]; then echo "VERDICT: GREEN"; exit 0; else echo "VERDICT: RED"; exit 1; fi
