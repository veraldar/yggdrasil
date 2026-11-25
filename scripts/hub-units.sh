#!/usr/bin/env bash
# hub-units.sh — the home root's services on omarchy as persistent user units (plan AP-1), run from a
# FROZEN release folder (~/.local/share/yggdrasil/hub/current → releases/<id>), never a git worktree:
# a dev build can never swap what serves ap.veraldar.org or :8447.
#
#   hub-units.sh release            build this tree into releases/<id> (brain, bifrost-net, app, librarian,
#                                   cc-live, voice agent source); prints the id. `current` is not moved.
#   hub-units.sh render             write the unit files into ~/.config/systemd/user (nothing started)
#   hub-units.sh public-up          stage A: the public door (hub-app :4502 + hub-bridge) from `current`,
#                                   pointed at the :4101 brain; the old trunk-preview-{app,bridge} stopped
#                                   first (the access point keeps ONE bridge link)
#   hub-units.sh public-back        the way back: hub units stopped, the old hub-up.sh stack started
#   hub-units.sh tailnet-up         the tailnet app (:8101) from `current` instead of rc-preview-pwa
#   hub-units.sh tailnet-back       rc-preview-pwa again
#   hub-units.sh deploy <id> [unit…] `current` → releases/<id>, running hub units restarted (the brain drains
#                                   first), back to the previous release if the health check fails. With
#                                   units named (e.g. hub-voice-agent) only those restart: no turn is cut
#   hub-units.sh switch             STAGE B: brain, librarian, live helper, voice agent and both apps become
#                                   these units (enabled, linger on); the transient rootsim-preview /
#                                   rc-preview-* stop; root renamed `omarchy`. Health check after; on a
#                                   failure the old transient units are put back by themselves
#   hub-units.sh stageb-back        the same way back, by hand
#   hub-units.sh health             the check switch/deploy run (exit 0 = all well)
#   hub-units.sh wg-on              the root ↔ root leg (AP-10): the home root's own WireGuard node
#                                   (hub-wg, a NEW key made here), the bridge relays its frames, the brain
#                                   learns and reaches roots inside the tunnel, the app pins a joining
#                                   machine's key. Needed before any computer joins. Restarts bridge, brain
#                                   and both apps; health check after, the old settings back by itself on a
#                                   failure. `wg-on --dry` shows what it would change, changes nothing
#   hub-units.sh wg-off             the way back by hand (the newest backup of the four files)
#   hub-units.sh rollback <id> <backup>  the way back later: releases/<id>, the brain's sessions and agents
#                                   file restored from <backup> (the folder a deploy prints), health
#   hub-units.sh status
#
# trunk v1 (spec §11; each refuses without a green gate file — trunk/deploy/gate-check.sh, R2):
#   hub-units.sh switch-v1 --prepare <v1-release> --trunk-url URL --trunk-key KEY --root-id ID
#                                   omarchy's v1 root key ($CONF/v1/root.key) and the v1 config rendered into
#                                   $CONF/v1/ (app-public.env BIFROST_AUTH=trunk, bridge [trunk], wg-hub.toml)
#                                   from today's; prints what changes (names only) and the import-v0 inputs.
#                                   Nothing live changes
#   hub-units.sh switch-v1 <v1-release>   $CONF/* + state/* → $CONF/backup-v0-<ts> (0700), the data backed up,
#                                   $CONF/v1/* in place, `current` → the release, all 8 units restarted, the v1
#                                   health profile; on a failure conf, state, data and release go back by
#                                   themselves
#   hub-units.sh rollback-v0 <v0.9-release> <backup-v0 dir> [--skip-route-check] [--sha SHA]
#                                   refuses while ap. still answers like v1 (the route moves first); conf and
#                                   state/ from the backup (what v1 left kept beside: undone-v1-<ts>), `current`
#                                   → the release, all 8 units, today's health. The brain's data is left as it
#                                   is (W8: v1 changes no data format)
# health picks its profile from app-public.env: BIFROST_AUTH=trunk → v1 ($PUBLIC_URL/t/state 200 claimed,
# $PUBLIC_URL/ → 302 /login, trunk-state.json link up and < 30 s old, instead of ap. / → 200); HUB_HEALTH=v0|v1
# forces one; PUBLIC_URL = HUB_PUBLIC_URL or the app's BIFROST_TRUNK_URL.
# Rehearsal overrides (G4.4): HUB_HOME HUB_CONF HUB_UNITS HUB_PREFIX (units HUB_PREFIX-*), HUB_*_PORT, HUB_SIM,
# HUB_BACKUP, HUB_AP_URL, HUB_RESOLVE; unset = today's values, byte for byte. HUB_TEST_SKIP_GATE=1 skips only
# the gate check, and only for a rehearsal prefix with its own HUB_HOME and HUB_CONF.
# switch / deploy / stageb-back restart the brain: run from inside it (a session's shell), they go on in
# a unit of their own (log: ~/.local/share/yggdrasil/hub/logs/switch.log).
#
# Config (mode 600, made once by hand from the old stack's state — see NOTES.md):
#   ~/.config/yggdrasil/hub/{app-public.env,app-tailnet.env,brain.env,bridge-public.toml,voice-agent.env,
#                            admin-token,peer-token}   (brain.env: the preview's, YGG_ROOT_NAME=omarchy,
#                            YGG_PEERS_FROM=http://127.0.0.1:4503/_roots, YGG_PEER_TOKEN)
#   data: ~/.cache/root-sim/preview/{data,librarian.db} (where they always were)
#   the voice agent's venv: state/voice-venv (uv sync --frozen in current/voice, UV_PROJECT_ENVIRONMENT)
#   ~/.local/share/yggdrasil/hub/state/{devices.json,bridge-dtls.json}
# Never run a plain install.sh on omarchy (AP-31): it would take the daily stack's files and ports.
set -euo pipefail
TREE=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
# rehearsal overrides (trunk v1, G4.4 sim/hub-switch-rehearsal.sh): unset, every one is today's value. A
# rehearsal runs throwaway units HUB_PREFIX-* (never hub-*) from its own HUB_HOME / HUB_CONF on its own ports.
HUB=${HUB_HOME:-$HOME/.local/share/yggdrasil/hub}
CONF=${HUB_CONF:-$HOME/.config/yggdrasil/hub}
UNITS=${HUB_UNITS:-$HOME/.config/systemd/user}
P=${HUB_PREFIX:-hub}
case $P in *[!a-z0-9]* | '' | [0-9]*) echo "hub-units: HUB_PREFIX: lower-case letters and digits" >&2; exit 1 ;; esac
NODE=${NODE:-$HOME/.local/share/mise/installs/node/26.8.1/bin/node}
OLD=$HOME/.local/state/trunk-preview
LOGS=$HUB/logs
PV=${HUB_PV:-$HOME/.cache/root-sim/preview}
ART=$HOME/Work/root-coord-pwa/artifacts
BRAIN=http://127.0.0.1:${HUB_BRAIN_PORT:-4101}
LIB_PORT=${HUB_LIBRARIAN_PORT:-4310} CCLIVE_PORT=${HUB_CCLIVE_PORT:-4320} TAILNET_PORT=${HUB_TAILNET_PORT:-8101}
PUBLIC_PORT=${HUB_PUBLIC_PORT:-4502} VOICE_PORT=${HUB_VOICE_PORT:-18084}
SIM=${HUB_SIM:-$HOME/.cache/root-sim}                                # cc-live's token and log
BACKUP_SH=${HUB_BACKUP:-$HOME/Work/tree-next/scripts/preview-backup.sh}
AP_URL=${HUB_AP_URL:-https://ap.veraldar.org}                         # the v0.9 public check
RESOLVE=()                                                            # curl --resolve for the public checks (rehearsal):
for r in ${HUB_RESOLVE:-}; do RESOLVE+=(--resolve "$r"); done          #   HUB_RESOLVE="name:port:addr …"

die() { echo "hub-units: $*" >&2; exit 1; }

release() {
  local b="$TREE/branch" id r
  [ -x "$TREE/root/target/release/yggdrasil" ] || die "build the brain first: (cd $TREE/root && cargo build --release)"
  [ -x "$TREE/trunk/target/release/bifrost-net" ] || die "build the trunk first: (cd $TREE/trunk && cargo build --release)"
  [ -f "$b/.next/standalone/server.js" ] || die "build the app first: (cd $b && npm ci && NEXT_OUTPUT=standalone npx next build)"
  id=$(date +%Y%m%d-%H%M)-$(git -C "$TREE" rev-parse --short=8 HEAD)
  r=$HUB/releases/$id
  [ -e "$r" ] && die "$r exists"
  mkdir -p "$r/bin" "$r/app/.next"
  install -m755 "$TREE/root/target/release/yggdrasil" "$TREE/trunk/target/release/bifrost-net" "$r/bin/"
  cp -a "$b/.next/standalone/." "$r/app/"
  cp -a "$b/.next/static" "$r/app/.next/static"
  cp -a "$b/public" "$b/artifacts-builtin" "$b/server.mjs" "$r/app/"
  rm -f "$r/app/server.js" # Next's own entry: ours is server.mjs (it stamps the peer address)
  cp -a "$TREE/root/extensions/librarian" "$r/librarian"
  cp -a "$TREE/root/cc-live" "$r/cc-live"
  (cd "$TREE" && git ls-files -z branch/voice | tar --null -cf - -T -) | tar -xf - -C "$r" && mv "$r/branch/voice" "$r/voice" && rmdir "$r/branch"
  # the trunk meter's reader (morning page, alerts, release check): run from the release
  install -D -m755 "$TREE/scripts/trunk-report.py" "$r/scripts/trunk-report.py"
  printf 'id=%s\ncommit=%s\nbuilt=%s\napp_build_id=%s\n' "$id" "$(git -C "$TREE" rev-parse HEAD)" "$(date -Is)" "$(cat "$b/.next/BUILD_ID")" >"$r/BUILD"
  chmod -R go-w "$r"
  echo "$id"
}

render() {
  mkdir -p "$UNITS" "$LOGS"
  cat >"$UNITS/$P-app.service" <<EOF
[Unit]
Description=yggdrasil home root: the public app (ap.veraldar.org, devices mode) → brain :4101
After=network-online.target

[Service]
WorkingDirectory=$HUB/current/app
EnvironmentFile=$CONF/app-public.env
ExecStart=$NODE server.mjs
Restart=on-failure
RestartSec=3
StandardOutput=append:$LOGS/app.log
StandardError=append:$LOGS/app.log

[Install]
WantedBy=default.target
EOF
  cat >"$UNITS/$P-bridge.service" <<EOF
[Unit]
Description=yggdrasil home root: the bridge to the trunk (ap.veraldar.org) — app, voice, root links
After=network-online.target $P-app.service

[Service]
ExecStart=$HUB/current/bin/bifrost-net bridge -c $CONF/bridge-public.toml
Restart=on-failure
RestartSec=3
StandardOutput=append:$LOGS/bridge.log
StandardError=append:$LOGS/bridge.log

[Install]
WantedBy=default.target
EOF
  # the home root's WireGuard node (root ↔ root, trunk/src/wg.rs): started and enabled by `wg-on`
  cat >"$UNITS/$P-wg.service" <<EOF
[Unit]
Description=yggdrasil home root: its WireGuard node (brain-to-brain calls between roots, end to end)
After=$P-bridge.service

[Service]
ExecStart=$HUB/current/bin/bifrost-net wg -c $CONF/wg-hub.toml
Restart=on-failure
RestartSec=3
StandardOutput=append:$LOGS/wg.log
StandardError=append:$LOGS/wg.log

[Install]
WantedBy=default.target
EOF
  # the voice agent (LiveKit worker → the brain). AGENT_LOAD=off in its env: the load LiveKit is told
  # is the whole login's cpu, so a busy box (sessions building) read as a full worker and no call was
  # answered (11-19: load 26 on 16 cores, the mic dead on both doors)
  cat >"$UNITS/$P-voice-agent.service" <<EOF
[Unit]
Description=yggdrasil home root: the voice agent (hold to talk) → brain :4101
After=network-online.target

[Service]
WorkingDirectory=$HUB/current/voice
EnvironmentFile=$CONF/voice-agent.env
ExecStart=$HUB/state/voice-venv/bin/python agent.py start
Restart=on-failure
RestartSec=3
StandardOutput=append:$LOGS/voice-agent.log
StandardError=append:$LOGS/voice-agent.log

[Install]
WantedBy=default.target
EOF
  # the tailnet door (:8447 → :8101): the same release, BIFROST_AUTH=tailnet; replaces the transient
  # rc-preview-pwa that served the git worktree itself
  cat >"$UNITS/$P-app-tailnet.service" <<EOF
[Unit]
Description=yggdrasil home root: the tailnet app (:8447 → :8101) → brain :4101
After=network-online.target

[Service]
WorkingDirectory=$HUB/current/app
EnvironmentFile=$CONF/app-tailnet.env
ExecStart=$NODE server.mjs
Restart=on-failure
RestartSec=3
StandardOutput=append:$LOGS/app-tailnet.log
StandardError=append:$LOGS/app-tailnet.log

[Install]
WantedBy=default.target
EOF
  # the brain: the preview's data where it always was; a stop drains first (short turns finish, the
  # rest is sent again once by the next start — C5)
  cat >"$UNITS/$P-brain.service" <<EOF
[Unit]
Description=yggdrasil home root: the brain (root omarchy, :4101) — MAIN and the sessions
After=network-online.target

[Service]
WorkingDirectory=%h
EnvironmentFile=$CONF/brain.env
ExecStart=$HUB/current/bin/yggdrasil
ExecStop=-/usr/bin/curl -s --connect-timeout 2 -m 70 -X POST $BRAIN/admin/drain -H 'Content-Type: application/json' -d '{"max_s": 60}'
TimeoutStopSec=90
Restart=always
RestartSec=2
StandardOutput=append:$PV/brain.log
StandardError=append:$PV/brain.log

[Install]
WantedBy=default.target
EOF
  cat >"$UNITS/$P-librarian.service" <<EOF
[Unit]
Description=yggdrasil home root: the librarian (search and memory, :4310)
After=$P-brain.service

[Service]
ExecStart=/usr/bin/python3 $HUB/current/librarian/librarian.py --root $BRAIN --port $LIB_PORT --db $PV/librarian.db --artifacts $ART
Restart=on-failure
RestartSec=3
StandardOutput=append:$PV/librarian.log
StandardError=append:$PV/librarian.log

[Install]
WantedBy=default.target
EOF
  cat >"$UNITS/$P-cclive.service" <<EOF
[Unit]
Description=yggdrasil home root: the live helper (the owner's terminal sessions, :4320)

[Service]
WorkingDirectory=%h
Environment=HOME=%h PATH=%h/.local/share/mise/shims:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 $HUB/current/cc-live/cc_live.py --port $CCLIVE_PORT --token-file $SIM/cc-live.token --claude $HOME/.local/share/mise/shims/claude --live-file $PV/harness-live.json
Restart=on-failure
RestartSec=3
StandardOutput=append:$SIM/cc-live-preview.log
StandardError=append:$SIM/cc-live-preview.log

[Install]
WantedBy=default.target
EOF
  # the trunk meter's reader (trunk observability, proposal v2): the morning page at 07:00 (filed in
  # MAIN's inbox as one line + the link) and a watcher every 5 min (an outage, a theft signal, a slow
  # revoke -> one line in MAIN's inbox, each incident once). Read-only on the meter's files. A post is
  # never a transcript turn, but each costs one digest call on the brain's model and may wake MAIN.
  local t cmd when
  for t in report watch; do
    cmd="day --post"; when="OnCalendar=*-*-* 07:00:00"
    [ "$t" = watch ] && cmd="watch --post" && when="OnCalendar=*:0/5"
    cat >"$UNITS/$P-trunk-$t.service" <<EOF
[Unit]
Description=yggdrasil home root: the trunk meter's $t (scripts/trunk-report.py $cmd)
# a release without the reader (a way back to an older one) skips cleanly, it never fails
ConditionPathExists=$HUB/current/scripts/trunk-report.py

[Service]
Type=oneshot
Environment=TRUNK_REPORT_ART=$ART
ExecStart=/usr/bin/python3 $HUB/current/scripts/trunk-report.py $cmd
StandardOutput=append:$LOGS/trunk-report.log
StandardError=append:$LOGS/trunk-report.log
EOF
    cat >"$UNITS/$P-trunk-$t.timer" <<EOF
[Unit]
Description=yggdrasil home root: the trunk meter's $t

[Timer]
$when

[Install]
WantedBy=timers.target
EOF
  done
  systemctl --user daemon-reload
  if [ -f "$HUB/current/scripts/trunk-report.py" ]; then
    systemctl --user enable -q --now $P-trunk-report.timer $P-trunk-watch.timer || true
  else
    systemctl --user disable -q --now $P-trunk-report.timer $P-trunk-watch.timer 2>/dev/null || true
  fi
  echo "rendered: $P-brain $P-librarian $P-cclive $P-voice-agent $P-app $P-app-tailnet $P-bridge $P-trunk-{report,watch}.timer"
}

wait_http() { for _ in $(seq 1 60); do curl -sf -m 2 -o /dev/null "$1" && return 0; sleep 0.5; done; return 1; }

public_up() {
  [ -L "$HUB/current" ] || die "no $HUB/current (hub-units.sh release, then ln -sfn releases/<id> current)"
  render
  # the access point keeps one bridge link: the old one goes first (its files stay: public-back)
  for u in trunk-preview-bridge trunk-preview-app; do systemctl --user stop "$u" 2>/dev/null || true; done
  systemctl --user restart $P-voice-agent
  systemctl --user restart $P-app
  wait_http http://127.0.0.1:$PUBLIC_PORT/api/build || die "$P-app did not answer on :$PUBLIC_PORT (log: $LOGS/app.log)"
  systemctl --user restart $P-bridge
  sleep 3
  status
}

ALL="$P-brain $P-librarian $P-cclive $P-voice-agent $P-app $P-app-tailnet $P-bridge"
# the root ↔ root leg (AP-10), beside the bridge's ports (4503 http, 4504 root-link, 4505 media): the
# node's front door (the brain's only way to other roots), its udp, the bridge's relay socket — loopback
WG_HTTP=${HUB_WG_HTTP:-4506} WG_UDP=${HUB_WG_UDP:-4507} WG_RELAY=${HUB_WG_RELAY:-4508}
WG_FILES="bridge-public.toml brain.env app-public.env app-tailnet.env"

# run from a session inside the brain, stopping the brain would kill this script half-way: go on in
# a unit of its own (the same rule as preview-up.sh)
detach() {
  if [ -z "${HUB_UNITS_DETACHED:-}" ] && grep -qE "/($P-brain|rootsim-preview)\.service" /proc/self/cgroup 2>/dev/null; then
    mkdir -p "$LOGS"
    local pass=() v
    for v in HUB_HOME HUB_CONF HUB_UNITS HUB_PREFIX HUB_PUBLIC_URL HUB_AP_URL HUB_RESOLVE HUB_HEALTH HUB_BACKUP HUB_SIM \
             HUB_BRAIN_PORT HUB_LIBRARIAN_PORT HUB_CCLIVE_PORT HUB_TAILNET_PORT HUB_PUBLIC_PORT HUB_VOICE_PORT \
             HUB_WG_HTTP HUB_WG_UDP HUB_WG_RELAY HUB_TRUNK_STATE; do
      if [ -n "${!v:-}" ]; then pass+=("--setenv=$v=${!v}"); fi
    done
    systemd-run --user --unit "$P-units-$1-$(date +%s)-$$" --collect -q -p "StandardOutput=append:$LOGS/switch.log" \
      -p "StandardError=append:$LOGS/switch.log" --setenv=HUB_UNITS_DETACHED=1 "${pass[@]}" bash "$(readlink -f "$0")" "$@"
    echo "goes on outside this session (the brain restarts; this turn ends with it) — log: $LOGS/switch.log"
    exit 0
  fi
  echo "== $(date -Is) hub-units $*"
}

# every door answers: the brain (its name, MAIN), the librarian, the live helper, both apps (voice on
# the tailnet one), the public door end to end (access point → bridge → app), the voice agent
health() {
  local ok=0 tok out code
  # chk "what" command…  — a failing check never aborts the script (set -e), it is counted
  chk() { local what=$1; shift; if "$@" >/dev/null 2>&1; then echo "  ok   $what"; else echo "  FAIL $what"; ok=1; fi; }
  has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
  for _ in $(seq 1 60); do curl -sf -m 2 -o /dev/null "$BRAIN/root" && break; sleep 1; done
  out=$(curl -sf -m 5 "$BRAIN/root" || true)
  chk "brain :${BRAIN##*:} is root omarchy" has "$out" '"name":"omarchy"'
  out=$(curl -sf -m 10 "$BRAIN/session" || true)
  chk "brain: MAIN is there" has "$out" '[MAIN]'
  for _ in $(seq 1 30); do out=$(curl -sf -m 3 "$BRAIN/extensions" || true); has "$out" '"up":true' && break; sleep 1; done
  chk "librarian :$LIB_PORT up (as the brain sees it)" has "$out" '"up":true'
  tok=$(cat "$SIM/cc-live.token" 2>/dev/null || true)
  for _ in $(seq 1 20); do curl -sf -m 3 -o /dev/null -H "x-cc-live-token: $tok" http://127.0.0.1:$CCLIVE_PORT/sessions && break; sleep 1; done
  chk "live helper :$CCLIVE_PORT" curl -sf -m 5 -o /dev/null -H "x-cc-live-token: $tok" http://127.0.0.1:$CCLIVE_PORT/sessions
  for _ in $(seq 1 30); do curl -sf -m 2 -o /dev/null http://127.0.0.1:$TAILNET_PORT/api/build && curl -sf -m 2 -o /dev/null http://127.0.0.1:$PUBLIC_PORT/api/build && break; sleep 1; done
  chk "app :$TAILNET_PORT (tailnet)" curl -sf -m 5 -o /dev/null http://127.0.0.1:$TAILNET_PORT/api/build
  out=$(curl -sf -m 5 http://127.0.0.1:$TAILNET_PORT/api/token || true)
  chk "app :$TAILNET_PORT voice available" has "$out" available
  chk "app :$PUBLIC_PORT (public)" curl -sf -m 5 -o /dev/null http://127.0.0.1:$PUBLIC_PORT/api/build
  if [ "$(health_profile)" = v1 ]; then health_public_v1; else
  # 200 from outside = access point → the bridge's channel → the public app (503 = no bridge link)
  code=000
  for _ in $(seq 1 40); do code=$(curl "${RESOLVE[@]}" -s -o /dev/null -w '%{http_code}' -m 8 "$AP_URL/" || true); [ "$code" = 200 ] && break; sleep 1; done
  chk "ap.veraldar.org answers through the bridge ($code)" test "$code" = 200
  fi
  for _ in $(seq 1 60); do curl -sf -m 2 -o /dev/null http://127.0.0.1:$VOICE_PORT/ && break; sleep 1; done
  chk "voice agent up (its worker answers on :$VOICE_PORT)" curl -sf -m 5 -o /dev/null http://127.0.0.1:$VOICE_PORT/
  if systemctl --user is-enabled -q $P-wg 2>/dev/null; then
    for _ in $(seq 1 20); do curl -sf -m 2 -o /dev/null "http://127.0.0.1:$WG_HTTP/_wg" && break; sleep 1; done
    chk "WireGuard node :$WG_HTTP (root ↔ root)" curl -sf -m 5 -o /dev/null "http://127.0.0.1:$WG_HTTP/_wg"
    chk "…and it lists the roots for the brain" curl -sf -m 5 -o /dev/null "http://127.0.0.1:$WG_HTTP/_wg/_roots"
  fi
  return $ok
}

# the transient units as they ran before stage B (11-20), put back
stageb_back() {
  echo "-- back to the transient units"
  local u rc=0
  for u in $P-brain $P-librarian $P-cclive; do systemctl --user disable --now "$u" 2>/dev/null || true; done
  # the tailnet app talks to the preview's voice agent again
  sed -i 's/^AGENT_NAME=.*/AGENT_NAME=bifrost-preview/' "$CONF/app-tailnet.env" || true
  systemctl --user restart $P-app-tailnet || true
  # brain + librarian + live helper the old way (its env from the saved brain.env: the unit is gone)
  PREVIEW_UP_DETACHED=1 DRAIN_S=1 "$HOME/Work/tree-next/scripts/preview-up.sh" "$PV/bin/yggdrasil" || rc=1
  if ! systemctl --user is-active -q rc-preview-agent; then
    systemctl --user reset-failed rc-preview-agent 2>/dev/null || true
    systemd-run --user --unit rc-preview-agent --collect -q -p WorkingDirectory="$HOME/.cache/root-sim/preview-agent-code" \
      -p EnvironmentFile="$HOME/.cache/root-sim/preview-agent.env" -p "StandardOutput=append:$HOME/.cache/root-sim/preview-agent.log" \
      -p "StandardError=append:$HOME/.cache/root-sim/preview-agent.log" "$HOME/.local/share/mise/installs/uv/latest/.mise-bins/uv" run agent.py start || rc=1
  fi
  if [ "$rc" != 0 ] || ! curl -sf -m 5 -o /dev/null "$BRAIN/root"; then
    echo "!! THE WAY BACK FAILED: no brain on :4101. By hand: systemctl --user disable --now hub-brain; ~/Work/tree-next/scripts/preview-up.sh $PV/bin/yggdrasil"
  fi
  status || true
}

switch() {
  detach switch
  local f resp
  # everything it needs, checked BEFORE anything stops
  [ -L "$HUB/current" ] || die "no release (current)"
  for f in "$CONF/brain.env" "$CONF/app-tailnet.env" "$CONF/app-public.env" "$CONF/voice-agent.env" "$CONF/bridge-public.toml" \
           "$HUB/current/bin/yggdrasil" "$HUB/current/librarian/librarian.py" "$HUB/current/cc-live/cc_live.py" \
           "$HUB/state/voice-venv/bin/python" "$PV/bin/yggdrasil" "$PV/brain.env" "$HOME/Work/tree-next/scripts/preview-up.sh"; do
    [ -s "$f" ] || die "missing $f — nothing was touched"
  done
  curl -sf -m 5 -o /dev/null "$BRAIN/root" || die "the brain does not answer now — nothing was touched"
  render
  "$BACKUP_SH" || echo "backup failed — going on"
  resp=$(curl -s -m 70 -X POST "$BRAIN/admin/drain" -H 'Content-Type: application/json' -d '{"max_s": 60}' || true)
  echo "-- drain: ${resp:0:300}"
  systemctl --user stop rootsim-preview rc-preview-librarian rc-preview-cclive rc-preview-agent 2>/dev/null || true
  # from here on no brain runs: every failure goes the way back
  if ! switch_on; then
    echo "== STAGE B: a step failed — putting the old units back"
    stageb_back
    exit 1
  fi
  echo "-- health"
  if health; then
    loginctl enable-linger "$(id -un)" && echo "-- linger: $(loginctl show-user "$(id -un)" -p Linger)" || echo "-- linger NOT set (loginctl enable-linger $(id -un))"
    echo "== STAGE B: switched, healthy"
    status || true
  else
    echo "== STAGE B: health check failed — putting the old units back"
    stageb_back
    exit 1
  fi
}

# the hub units on (called with the old brain stopped; any failed step = false)
switch_on() {
  local u
  # one voice agent for both doors (AGENT_LOAD=off: a busy box no longer refuses calls)
  sed -i 's/^AGENT_NAME=.*/AGENT_NAME=bifrost-hub/' "$CONF/app-tailnet.env" || return 1
  systemctl --user enable -q $ALL || return 1
  systemctl --user restart $P-brain || return 1
  systemctl --user restart $P-librarian $P-cclive || return 1
  systemctl --user restart $P-app-tailnet || return 1
  for u in $P-voice-agent $P-app $P-bridge; do
    systemctl --user is-active -q "$u" || systemctl --user start "$u" || return 1
  done
  return 0
}

# the tailnet app onto the release (rc-preview-pwa stopped; its way back: tailnet-back)
tailnet_up() {
  render
  systemctl --user stop rc-preview-pwa 2>/dev/null || true
  systemctl --user restart $P-app-tailnet
  wait_http http://127.0.0.1:$TAILNET_PORT/api/build || { echo "$P-app-tailnet did not answer: back to rc-preview-pwa" >&2; tailnet_back; exit 1; }
  status
}

# rc-preview-pwa is transient (gone once stopped): recreated exactly as it ran on 11-20
tailnet_back() {
  systemctl --user stop $P-app-tailnet 2>/dev/null || true
  systemctl --user reset-failed rc-preview-pwa 2>/dev/null || true
  systemctl --user is-active -q rc-preview-pwa || systemd-run --user --unit rc-preview-pwa --collect -q \
    -p WorkingDirectory="$HOME/Work/tree-next/branch" -p EnvironmentFile="$HOME/.cache/root-sim/preview.env" \
    --setenv=NODE_ENV=production --setenv=ARTIFACTS_DIR="$HOME/Work/root-coord-pwa/artifacts" \
    "$NODE" node_modules/next/dist/bin/next start -p 8101 -H 127.0.0.1
  wait_http http://127.0.0.1:8101/api/build && echo "rc-preview-pwa back on :8101"
}

# a new release behind every hub unit that is running: `current` moves, the units restart, and if
# an app does not answer `current` goes back (the brain is preview-up.sh's, until stage B)
deploy() {
  local id=${1:?release id} prev u brain=0 bad=0 only
  shift
  only=" $* "
  [ -d "$HUB/releases/$id" ] || die "no release $id"
  [ -x "$HUB/releases/$id/bin/yggdrasil" ] || die "release $id has no brain"
  for u in "$@"; do case " $ALL $P-wg " in *" $u "*) ;; *) die "unknown unit $u (one of: $ALL $P-wg)" ;; esac; done
  # only named units (e.g. `deploy <id> hub-voice-agent`): the brain keeps running, no turn is cut
  case "$only" in "  " | *" $P-brain "*) detach deploy "$id" "$@" ;; *) echo "== $(date -Is) hub-units deploy $id $*" ;; esac
  prev=$(readlink "$HUB/current" || true)
  local running=""
  for u in $ALL $P-wg; do
    systemctl --user is-active -q "$u" || continue
    case "$only" in "  " | *" $u "*) running="$running $u" ;; esac
  done
  case " $running " in *" $P-brain "*) brain=1 ;; esac
  local bk=""
  if [ "$brain" = 1 ]; then
    bk=$(backup_data)
    # a release may change the data when it starts (11-22): no way back without a backup — no deploy
    [ -n "$bk" ] || die "the backup failed — nothing was deployed"
    echo "-- the way back for the data: $bk"
  fi
  ln -sfn "$HUB/releases/$id" "$HUB/current"
  local t_deploy
  t_deploy=$(date +%s%3N)
  render
  # the brain drains in its ExecStop; the others restart at once
  for u in $running; do systemctl --user restart "$u" || bad=1; done
  if [ "$bad" = 0 ]; then health || bad=1; fi
  if [ "$bad" = 1 ]; then
    echo "== deploy $id: failed — back to $prev"
    ln -sfn "$prev" "$HUB/current"
    render >/dev/null # the previous release's units (its trunk-meter timers, or none)
    systemctl --user stop "$P-trunk-release-check-*.timer" 2>/dev/null || true
    if [ "$brain" = 1 ]; then
      # the new release may have changed the sessions when it started: the old one gets them back as
      # it left them
      systemctl --user stop $P-brain || true
      restore_data "$bk" || echo "!! data NOT restored — the old release starts on what the new one left"
    fi
    for u in $running; do systemctl --user restart "$u" || true; done
    health || echo "!! the previous release does not pass the health check either"
    exit 1
  fi
  echo "== deploy $id: done"
  # the release check (report only): its first 15 minutes against the hour before, into MAIN's inbox
  if [ -f "$HUB/current/scripts/trunk-report.py" ]; then
    systemd-run --user -q --on-active=16min --unit="$P-trunk-release-check-$(date +%s)" \
      /usr/bin/python3 "$HUB/current/scripts/trunk-report.py" release-check "$id" "$t_deploy" --post || true
  fi
  status || true
}

# the brain's data backed up; prints the backup's folder on its last line (empty: it failed)
backup_data() {
  local out
  out=$("$BACKUP_SH" 2>&1) || { echo "$out" >&2; echo; return 0; }
  echo "$out" >&2
  sed -n 's/^backup: \([^ ]*\) (.*/\1/p' <<<"$out" | tail -n 1
}

# the brain's sessions and its agents file put back from a backup (hub-brain must be stopped): a
# release may change them when it starts (11-22: roles + engines), and the release before it must
# find them as it left them. What was there is kept beside them (…undone-<time>), never deleted.
restore_data() {
  local bk=$1 t
  [ -n "$bk" ] && [ -s "$bk/sessions.tgz" ] || { echo "!! no backup to restore from (${bk:-none})"; return 1; }
  if [ -z "${HUB_PV:-}" ] && systemctl --user is-active -q $P-brain; then echo "!! $P-brain still runs: not restoring under it"; return 1; fi
  tar -tzf "$bk/sessions.tgz" >/dev/null 2>&1 || { echo "!! $bk/sessions.tgz is unreadable"; return 1; }
  t=$(date +%Y%m%d-%H%M%S)
  if [ -d "$PV/data/session" ]; then mv "$PV/data/session" "$PV/data/session.undone-$t" || return 1; fi
  if ! tar -C "$PV" -xzf "$bk/sessions.tgz"; then
    echo "!! restoring the sessions failed: the copy before is $PV/data/session.undone-$t"
    return 1
  fi
  if [ -f "$bk/agents.json" ]; then
    [ -f "$PV/agents.json" ] && cp -p "$PV/agents.json" "$PV/agents.json.undone-$t"
    cp -p "$bk/agents.json" "$PV/agents.json" || return 1
  fi
  echo "-- sessions and agents file restored from $bk (what was there: data/session.undone-$t, agents.json.undone-$t)"
}

# the way back, later and by hand: `current` → releases/<id>, the brain stopped, its data restored
# from <backup> (the folder the deploy printed), everything restarted, health
rollback() {
  local id=${1:?release id} bk=${2:?backup folder (~/.cache/root-sim/backups/<time>)} u
  [ -x "$HUB/releases/$id/bin/yggdrasil" ] || die "no release $id"
  [ -s "$bk/sessions.tgz" ] || die "no sessions.tgz in $bk"
  detach rollback "$id" "$bk"
  ln -sfn "$HUB/releases/$id" "$HUB/current"
  render
  systemctl --user stop "$P-trunk-release-check-*.timer" 2>/dev/null || true
  systemctl --user stop $P-brain
  restore_data "$bk" || { echo "!! data not restored: $P-brain stays stopped — look at $PV/data"; exit 1; }
  for u in $ALL $P-wg; do systemctl --user is-enabled -q "$u" 2>/dev/null && systemctl --user restart "$u"; done
  health || echo "!! the health check fails on $id too"
  echo "== rollback to $id: done"
  status || true
}

# ── the root ↔ root leg (AP-10) ──────────────────────────────────────────────────────────────────
# setenv FILE KEY VALUE — the line is replaced, or added; nothing else in the file moves
setenv() {
  local f=$1 k=$2 v=$3
  if grep -q "^$k=" "$f"; then
    grep -qxF "$k=$v" "$f" && return 0
    grep -v "^$k=" "$f" >"$f.tmp"; echo "$k=$v" >>"$f.tmp"; chmod 600 "$f.tmp"; mv "$f.tmp" "$f"
  else
    echo "$k=$v" >>"$f"
  fi
}

# what wg-on writes: the node's key and config, and its lines in the four files. Idempotent; it never
# prints a value
wg_files() {
  local roots=$HUB/state/roots.json
  umask 077 # brain.env holds the model key: its rewritten copy is never readable by others, not for a moment
  [ -f "$CONF/wg-hub.key" ] || "$HUB/current/bin/bifrost-net" wg-key "$CONF/wg-hub.key" >/dev/null || return 1
  chmod 600 "$CONF/wg-hub.key"
  [ -s "$CONF/wg-hub.key.pub" ] || return 1
  cat >"$CONF/wg-hub.toml" <<EOF
# the home root's WireGuard node (hub-wg). Its key never leaves the file beside this one; its peers are
# the roots a paired phone approved (roots.json: pinned key, not removed, the approving phone still paired).
[wg]
key_file = "$CONF/wg-hub.key"
udp = "127.0.0.1:$WG_UDP"
relay = "127.0.0.1:$WG_RELAY"
http = "127.0.0.1:$WG_HTTP"
brain = "$BRAIN"
roots_file = "$roots"
devices_file = "$HUB/state/devices.json"
EOF
  chmod 600 "$CONF/wg-hub.toml"
  # the bridge relays the node's frames (ciphertext only) to and from the root links
  grep -q '^wg_relay' "$CONF/bridge-public.toml" ||
    sed -i "/^\[bridge\.root-link\]/a wg_relay = \"127.0.0.1:$WG_RELAY\"\nwg_local = \"127.0.0.1:$WG_UDP\"" "$CONF/bridge-public.toml"
  grep -q '^wg_relay' "$CONF/bridge-public.toml" || return 1
  # the brain learns the approved roots from the node and reaches each one inside its tunnel
  setenv "$CONF/brain.env" YGG_PEERS_FROM "http://127.0.0.1:$WG_HTTP/_wg/_roots"
  setenv "$CONF/brain.env" YGG_PEERS_VIA "http://127.0.0.1:$WG_HTTP/_wg/{id}"
  # the app pins a joining machine's key at approval and hands it the home node's; both doors share one
  # registry of roots (the roots sheet on :8447 removes from the same file)
  setenv "$CONF/app-public.env" BIFROST_WG_PUB_FILE "$CONF/wg-hub.key.pub"
  setenv "$CONF/app-public.env" BIFROST_ROOTS_FILE "$roots"
  setenv "$CONF/app-tailnet.env" BIFROST_ROOTS_FILE "$roots"
}

wg_restart() {
  local u bad=0
  systemctl --user daemon-reload
  # the bridge first (its relay socket), then the node, then the brain (it drains) and the apps
  systemctl --user restart $P-bridge || bad=1
  if [ "$1" = on ]; then
    systemctl --user enable -q $P-wg || bad=1
    systemctl --user restart $P-wg || bad=1
  else
    systemctl --user disable -q --now $P-wg 2>/dev/null || true
  fi
  for u in $P-brain $P-app $P-app-tailnet; do systemctl --user restart "$u" || bad=1; done
  return $bad
}

wg_restore() {
  local b=$1 f
  for f in $WG_FILES; do cp -p "$b/$f" "$CONF/$f" || return 1; done
}

wg_on() {
  local b f p bad=0
  [ -x "$HUB/current/bin/bifrost-net" ] || die "no release in $HUB/current"
  for f in $WG_FILES; do [ -f "$CONF/$f" ] || die "no $CONF/$f"; done
  grep -q '^\[bridge\.root-link\]' "$CONF/bridge-public.toml" || die "bridge-public.toml has no [bridge.root-link]"
  if ! systemctl --user is-active -q $P-wg; then
    for p in $WG_HTTP $WG_UDP $WG_RELAY; do
      if ss -Hltnu 2>/dev/null | awk '{print $5}' | grep -q ":$p\$"; then die "port $p is taken"; fi
    done
  fi
  if [ "${1:-}" = --dry ]; then
    echo "would: make $CONF/wg-hub.key (if missing) and wg-hub.toml (node :$WG_HTTP, udp :$WG_UDP, relay :$WG_RELAY)"
    if grep -q '^wg_relay' "$CONF/bridge-public.toml"; then echo "bridge-public.toml: wg_relay is already there"
    else echo "bridge-public.toml [bridge.root-link]: + wg_relay, wg_local"; fi
    echo "brain.env: YGG_PEERS_FROM → the node's /_wg/_roots, + YGG_PEERS_VIA"
    echo "app-public.env: + BIFROST_WG_PUB_FILE, BIFROST_ROOTS_FILE · app-tailnet.env: + BIFROST_ROOTS_FILE"
    echo "restart: $P-bridge, $P-wg (new), $P-brain (drains), $P-app, $P-app-tailnet · then the health check"
    return 0
  fi
  detach wg-on
  b=$CONF/backup-wg-$(date +%Y%m%d-%H%M%S)
  mkdir -p "$b" && chmod 700 "$b"
  for f in $WG_FILES; do cp -p "$CONF/$f" "$b/$f"; done
  "$BACKUP_SH" || echo "backup failed — going on"
  wg_files || bad=1
  render
  if [ "$bad" = 0 ]; then wg_restart on || bad=1; fi
  if [ "$bad" = 0 ]; then health || bad=1; fi
  if [ "$bad" = 1 ]; then
    echo "== wg-on: failed — the settings from $b go back"
    wg_restore "$b" && wg_restart off
    health || echo "!! the old settings do not pass the health check either"
    exit 1
  fi
  echo "== wg-on: done — the home node's key: $(sed -n 's/^fingerprint = "\(.*\)"/\1/p' <<<"$("$HUB/current/bin/bifrost-net" wg-key "$CONF/wg-hub.key" 2>/dev/null)")"
  status || true
}

wg_off() {
  local b
  b=$(ls -d "$CONF"/backup-wg-* 2>/dev/null | tail -n 1)
  [ -n "$b" ] || die "no backup-wg-* in $CONF"
  detach wg-off
  wg_restore "$b" && wg_restart off
  health
}

# ── trunk v1 (spec §11): the switchover, its way back, the v1 health profile ────────────────────────────
V1_FILES="app-public.env bridge-public.toml wg-hub.toml"   # what v1 changes in $CONF (rendered into $CONF/v1/)

# the v1 profile once the public app checks the trunk's tokens (HUB_HEALTH=v0|v1 forces one)
health_profile() {
  case "${HUB_HEALTH:-}" in v0 | v1) echo "$HUB_HEALTH"; return ;; esac
  if grep -qx 'BIFROST_AUTH=trunk' "$CONF/app-public.env" 2>/dev/null; then echo v1; else echo v0; fi
}
public_url() { echo "${HUB_PUBLIC_URL:-$(sed -n 's/^BIFROST_TRUNK_URL=//p' "$CONF/app-public.env" 2>/dev/null | tail -n 1)}"; }
trunk_state_file() { # the bridge's [trunk] state_file (C5), else state/trunk-state.json
  local f
  f=$(sed -n '/^\[trunk\]/,/^\[/s/^state_file *= *"\(.*\)"/\1/p' "$CONF/bridge-public.toml" 2>/dev/null | head -n 1)
  echo "${HUB_TRUNK_STATE:-${f:-$HUB/state/trunk-state.json}}"
}
link_up() { # FILE — trunk-state.json (C5): version 1, link up, written less than 30 s ago
  python3 -c 'import json, sys, time
d = json.load(open(sys.argv[1])); l = d.get("link") or {}
sys.exit(0 if d.get("version") == 1 and l.get("state") == "up" and 0 <= time.time() * 1000 - l.get("written", 0) < 30000 else 1)' "$1" 2>/dev/null
}
login_redirect() { # CODE REDIRECT_URL PUBLIC_URL — a 302 to the trunk's /login
  [ "$1" = 302 ] || return 1
  case $2 in "$3/login" | "$3/login?"*) return 0 ;; *) return 1 ;; esac
}
# v1's public door (spec §11 step 4), inside health(): its chk, has and ok
health_public_v1() {
  local url st code=000 loc='' out=''
  url=$(public_url)
  st=$(trunk_state_file)
  if [ -z "$url" ]; then echo "  FAIL v1: no public url (BIFROST_TRUNK_URL in app-public.env, or HUB_PUBLIC_URL)"; ok=1; return 0; fi
  for _ in $(seq 1 40); do out=$(curl "${RESOLVE[@]}" -sf -m 8 "$url/t/state" || true); has "$out" '"claimed":true' && break; sleep 1; done
  chk "$url/t/state → 200, claimed" has "$out" '"claimed":true'
  for _ in $(seq 1 20); do
    read -r code loc < <(curl "${RESOLVE[@]}" -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -m 8 "$url/" || echo "000 -")
    [ "$code" = 302 ] && break
    sleep 1
  done
  chk "$url/ → 302 /login ($code)" login_redirect "$code" "$loc" "$url"
  for _ in $(seq 1 40); do link_up "$st" && break; sleep 1; done
  chk "the bridge's trunk link is up ($(basename "$st") written < 30 s ago)" link_up "$st"
}

rel_commit() { sed -n 's/^commit=//p' "$HUB/releases/$1/BUILD" 2>/dev/null | head -n 1; }
# R2: no switch and no way back without a green gate file for the commit (trunk/deploy/gate-check.sh, the LADDER
# stream's; until it is in this tree a stand-in that refuses)
gate() {
  if [ "${HUB_TEST_SKIP_GATE:-0}" = 1 ]; then
    if [ "$P" = hub ] || [ -z "${HUB_HOME:-}" ] || [ -z "${HUB_CONF:-}" ] || [ "$HUB" = "$HOME/.local/share/yggdrasil/hub" ] || [ "$CONF" = "$HOME/.config/yggdrasil/hub" ]; then
      die "HUB_TEST_SKIP_GATE=1 is for a rehearsal (its own HUB_PREFIX, HUB_HOME and HUB_CONF), never the live hub — nothing was changed"
    fi
    echo "-- TEST OVERRIDE: the gate check is SKIPPED (HUB_TEST_SKIP_GATE=1, rehearsal units $P-*) — every other step runs"
    return 0
  fi
  [ -n "${1:-}" ] || die "no commit to check (the release's BUILD has no commit=) — nothing was changed"
  if [ -f "$TREE/trunk/deploy/gate-check.sh" ]; then
    # shellcheck source=/dev/null
    . "$TREE/trunk/deploy/gate-check.sh"
  else
    gate_check() { echo "gate check: trunk/deploy/gate-check.sh (LADDER) is not in this tree yet — refusing" >&2; return 1; }
  fi
  gate_check "$1" "$TREE" || die "the gate check refused $1 — nothing was changed"
  echo "-- gate check: $1 is green"
}

unit_known() { systemctl --user is-enabled -q "$1" 2>/dev/null || systemctl --user is-active -q "$1"; }

changed_keys() { # OLD NEW — the keys and tables that differ, as names (a value is never printed)
  python3 -c 'import hashlib, re, sys
def kv(p):
    out, sec = {}, ""
    for line in open(p):
        t = line.strip()
        m = re.match(r"^\[([^\]]+)\]$", t)
        if m:
            sec = m.group(1) + "."
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$", t)
        if m:
            out[sec + m.group(1)] = hashlib.sha256(m.group(2).encode()).hexdigest()
    return out
a, b = kv(sys.argv[1]), kv(sys.argv[2])
for k in sorted(set(a) | set(b)):
    print(("- " if k not in b else "+ " if k not in a else "~ ") + k) if a.get(k) != b.get(k) else None' "$1" "$2"
}

switch_v1_prepare() {
  local id=${1:?switch-v1 --prepare <v1-release> --trunk-url URL --trunk-key KEY --root-id ID} url='' key='' rid='' rel f st
  shift
  while [ $# -gt 0 ]; do
    case $1 in --trunk-url) url=$2; shift ;; --trunk-key) key=$2; shift ;; --root-id) rid=$2; shift ;; *) die "switch-v1 --prepare: unknown $1" ;; esac
    shift
  done
  rel=$HUB/releases/$id
  [ -x "$rel/bin/bifrost-net" ] || die "no release $id"
  [ -n "$url" ] && [ -n "$key" ] && [ -n "$rid" ] || die "switch-v1 --prepare $id --trunk-url URL --trunk-key KEY --root-id ID (the trunk's key and omarchy's id: trunk-ctl import-v0)"
  case $url in https://?*) ;; *) die "--trunk-url: https://…" ;; esac
  case $key$rid in *[!A-Za-z0-9_-]*) die "--trunk-key / --root-id: b64url and rt_… only" ;; esac
  for f in $V1_FILES; do [ -f "$CONF/$f" ] || die "no $CONF/$f"; done
  [ "$(health_profile)" = v0 ] || die "the hub already runs v1"
  gate "$(rel_commit "$id")"
  umask 077
  mkdir -p "$CONF/v1" && chmod 700 "$CONF/v1"
  # omarchy's v1 root key (spec §11 step 2): made once, kept (bifrost-net root-key FILE → FILE + FILE.pub, like wg-key)
  if [ ! -s "$CONF/v1/root.key" ]; then "$rel/bin/bifrost-net" root-key "$CONF/v1/root.key" >/dev/null || die "bifrost-net root-key failed"; fi
  chmod 600 "$CONF/v1/root.key"
  st=$HUB/state/trunk-state.json
  # the public app checks the trunk's tokens (C6); the tailnet app is untouched (W2)
  cp -p "$CONF/app-public.env" "$CONF/v1/app-public.env"
  setenv "$CONF/v1/app-public.env" BIFROST_AUTH trunk
  setenv "$CONF/v1/app-public.env" BIFROST_TRUNK_STATE "$st"
  setenv "$CONF/v1/app-public.env" BIFROST_TRUNK_URL "$url"
  setenv "$CONF/v1/app-public.env" BIFROST_TRUST_PROXY 1
  # the bridge: [ap] and the root-link switchboard out, [trunk] in (C5, spec §5.5)
  python3 -c 'import re, sys
src, dst, url, key, keyfile, rid, st = sys.argv[1:]
out, skip = [], False
for line in open(src):
    m = re.match(r"^\s*\[([^\]]+)\]\s*$", line)
    if m:
        skip = m.group(1).strip() in ("ap", "bridge.root-link", "trunk")
    if not skip:
        out.append(line)
while out and not out[-1].strip():
    out.pop()
out.append(f"\n[trunk]\nurl = \"{url}\"\ntrunk_key = \"{key}\"\nroot_key_file = \"{keyfile}\"\nroot_id = \"{rid}\"\nstate_file = \"{st}\"\n")
open(dst, "w").write("".join(out))' "$CONF/bridge-public.toml" "$CONF/v1/bridge-public.toml" "$url" "$key" "$CONF/v1/root.key" "$rid" "$st" ||
    die "bridge-public.toml: not rendered"
  # the WireGuard node: peers from the signed directory in trunk-state.json, not roots.json + devices.json (C5)
  sed -e '/^roots_file *=/d' -e '/^devices_file *=/d' "$CONF/wg-hub.toml" >"$CONF/v1/wg-hub.toml"
  printf 'trunk_state_file = "%s"\n' "$st" >>"$CONF/v1/wg-hub.toml"
  chmod 600 "$CONF/v1/"*
  echo "-- prepared $CONF/v1 for $id (nothing live changed); switch-v1 $id puts in place (names only):"
  for f in $V1_FILES; do changed_keys "$CONF/$f" "$CONF/v1/$f" | sed "s/^/   $f  /"; done
  echo "-- trunk-ctl import-v0 on the trunk's console (spec §7) reads: --roots $HUB/state/roots.json --dtls $HUB/state/bridge-dtls.json"
  echo "   --hub-name omarchy --hub-wg-pub $(cat "$CONF/wg-hub.key.pub" 2>/dev/null || echo '?') --hub-root-pub $(cat "$CONF/v1/root.key.pub" 2>/dev/null || echo '?')"
}

# $CONF/* and state/* (files; never a folder such as the voice venv) → $CONF/backup-v0-<time> (0700) + MANIFEST
backup_v0() {
  local b f
  b=$CONF/backup-v0-$(date +%Y%m%d-%H%M%S)
  mkdir -p "$b/state" || return 1
  chmod 700 "$b" || return 1
  for f in "$CONF"/*; do if [ -f "$f" ]; then cp -p "$f" "$b/" || return 1; fi; done
  for f in "$HUB"/state/*; do if [ -f "$f" ]; then cp -p "$f" "$b/state/" || return 1; fi; done
  echo "${1##*/}" >"$b/release"
  (cd "$b" && find . -type f ! -name MANIFEST -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum >MANIFEST) || return 1
  echo "$b"
}

# $CONF's files and state/'s files exactly as the backup has them; what is there now is kept beside (undone-v1-<time>)
restore_v0() {
  local b=$1 a f n
  [ -s "$b/MANIFEST" ] || { echo "!! $b has no MANIFEST"; return 1; }
  (cd "$b" && sha256sum --quiet -c MANIFEST) || { echo "!! $b does not match its MANIFEST"; return 1; }
  a=$CONF/undone-v1-$(date +%Y%m%d-%H%M%S)
  mkdir -p "$a/state" && chmod 700 "$a" || return 1
  for f in "$CONF"/*; do
    if [ -f "$f" ]; then
      n=${f##*/}
      cp -p "$f" "$a/" || return 1
      if [ ! -f "$b/$n" ] || [ "$n" = MANIFEST ] || [ "$n" = release ]; then rm -f "$f"; fi
    fi
  done
  for f in "$HUB"/state/*; do if [ -f "$f" ]; then mv "$f" "$a/state/" || return 1; fi; done
  for f in "$b"/*; do
    n=${f##*/}
    if [ -f "$f" ] && [ "$n" != MANIFEST ] && [ "$n" != release ]; then cp -p "$f" "$CONF/$n" || return 1; fi
  done
  for f in "$b"/state/*; do if [ -f "$f" ]; then cp -p "$f" "$HUB/state/" || return 1; fi; done
  echo "-- $CONF and state/ restored from $b (what was there: $a)"
}

switch_v1() {
  if [ "${1:-}" = --prepare ]; then shift; switch_v1_prepare "$@"; return; fi
  local id=${1:?switch-v1 <v1-release> (after switch-v1 --prepare)} prev rel bk dbk f u bad=0
  rel=$HUB/releases/$id
  [ -x "$rel/bin/yggdrasil" ] && [ -x "$rel/bin/bifrost-net" ] || die "no release $id"
  for f in $V1_FILES; do [ -s "$CONF/v1/$f" ] || die "no $CONF/v1/$f — switch-v1 --prepare $id … first"; done
  grep -qx 'BIFROST_AUTH=trunk' "$CONF/v1/app-public.env" || die "$CONF/v1/app-public.env is not v1's (BIFROST_AUTH=trunk)"
  [ "$(health_profile)" = v0 ] || die "the hub already runs v1"
  prev=$(readlink "$HUB/current" || true)
  [ -n "$prev" ] || die "no current release"
  gate "$(rel_commit "$id")"
  detach switch-v1 "$id"
  # 1. the way back first (spec §11 step 1, the wg-on pattern)
  bk=$(backup_v0 "$prev") || die "the backup of $CONF and state/ failed — nothing was changed"
  echo "-- the way back for the config: $bk"
  dbk=$(backup_data)
  [ -n "$dbk" ] || die "the data backup failed — nothing was changed (config backup: $bk)"
  echo "-- the way back for the data: $dbk"
  # 2. v1's config, the release, every unit (the brain drains in its ExecStop), the v1 health profile
  for f in $V1_FILES; do install -m 600 "$CONF/v1/$f" "$CONF/$f" || bad=1; done
  ln -sfn "$HUB/releases/$id" "$HUB/current"
  render
  if [ "$bad" = 0 ]; then for u in $ALL $P-wg; do if unit_known "$u"; then systemctl --user restart "$u" || bad=1; fi; done; fi
  if [ "$bad" = 0 ]; then HUB_HEALTH=v1 health || bad=1; fi
  if [ "$bad" = 1 ]; then
    echo "== switch-v1 $id: failed — back to ${prev##*/}: config and state/ from $bk, data from $dbk"
    systemctl --user stop "$P-trunk-release-check-*.timer" 2>/dev/null || true
    systemctl --user stop $P-brain || true
    restore_v0 "$bk" || echo "!! config / state/ NOT restored from $bk — look before anything else"
    ln -sfn "$prev" "$HUB/current"
    render >/dev/null
    restore_data "$dbk" || echo "!! data NOT restored — the old release starts on what the new one left"
    for u in $ALL $P-wg; do if unit_known "$u"; then systemctl --user restart "$u" || true; fi; done
    HUB_HEALTH=v0 health || echo "!! the previous release does not pass today's health check either"
    exit 1
  fi
  echo "== switch-v1 $id: done (v1 health) — the way back: hub-units.sh rollback-v0 ${prev##*/} $bk"
  status || true
}

rollback_v0() {
  local id=${1:?rollback-v0 <v0.9-release> <backup-v0 dir>} bk=${2:?rollback-v0 <v0.9-release> <backup-v0 dir>} skip=0 sha='' u code=000 loc='' more=()
  shift 2
  while [ $# -gt 0 ]; do
    case $1 in --skip-route-check) skip=1; more+=(--skip-route-check) ;; --sha) sha=$2; more+=(--sha "$2"); shift ;; *) die "rollback-v0: unknown $1" ;; esac
    shift
  done
  bk=${bk%/}
  [ -x "$HUB/releases/$id/bin/yggdrasil" ] || die "no release $id"
  [ -s "$bk/MANIFEST" ] || die "no MANIFEST in $bk (a backup-v0-* folder that switch-v1 made)"
  [ "$(stat -c %a "$bk")" = 700 ] || die "$bk is not mode 0700"
  (cd "$bk" && sha256sum --quiet -c MANIFEST) || die "$bk does not match its MANIFEST — nothing was changed"
  if grep -qx 'BIFROST_AUTH=trunk' "$bk/app-public.env" 2>/dev/null; then die "$bk holds a v1 config, not v0.9's"; fi
  gate "${sha:-$(rel_commit "$(basename "$(readlink "$HUB/current" || echo none)")")}"
  # the route moves first (spec §11, rollback 1): ap. must be trunk-ap again, which answers 503 until the bridge links
  if [ "$skip" = 0 ]; then
    read -r code loc < <(curl "${RESOLVE[@]}" -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -m 8 "$AP_URL/" || echo "000 -")
    if login_redirect "$code" "$loc" "$AP_URL"; then
      die "$AP_URL/ still answers like v1 (302 /login): move the route first (sni-443.conf: route ap.veraldar.org 127.0.0.1:4443 proxy · ice 127.0.0.1:4479, then systemctl reload yggdrasil-sni-443) — nothing was changed"
    fi
    echo "-- the route: $AP_URL/ → $code (not v1's 302 /login)"
  else
    echo "-- the route check skipped (--skip-route-check)"
  fi
  detach rollback-v0 "$id" "$bk" "${more[@]}"
  systemctl --user stop "$P-trunk-release-check-*.timer" 2>/dev/null || true
  restore_v0 "$bk" || { echo "!! config / state/ not restored from $bk"; exit 1; }
  ln -sfn "$HUB/releases/$id" "$HUB/current"
  render
  for u in $ALL $P-wg; do if unit_known "$u"; then systemctl --user restart "$u" || true; fi; done
  if HUB_HEALTH=v0 health; then
    echo "== rollback-v0 to $id: done — today's health check passes (the brain's data was left as it is)"
    status || true
  else
    echo "!! rollback-v0: today's health check fails on $id"
    status || true
    exit 1
  fi
}

# the stage-B commands touch the old transient units (rootsim-preview, rc-preview-*): the live hub's alone
live_only() {
  if [ "$P" != hub ] || [ -n "${HUB_HOME:-}" ] || [ -n "${HUB_CONF:-}" ]; then die "$1 is a stage-B command of the live hub — not with HUB_PREFIX / HUB_HOME / HUB_CONF"; fi
}

public_back() {
  systemctl --user stop $P-bridge $P-app $P-voice-agent 2>/dev/null || true
  [ -x "$OLD/hub-up.sh" ] || die "no $OLD/hub-up.sh"
  bash "$OLD/hub-up.sh"
}

status() {
  for u in $ALL $P-wg; do printf '%-16s %-9s %s\n' "$u" "$(systemctl --user is-active "$u" 2>/dev/null || true)" "$(systemctl --user is-enabled "$u" 2>/dev/null || true)"; done
  echo "release: $(readlink "$HUB/current" 2>/dev/null || echo none)"
  printf 'app :%s /api/build → %s\n' "$PUBLIC_PORT" "$(curl -s -m 3 http://127.0.0.1:$PUBLIC_PORT/api/build || echo down)"
  printf 'app :%s /api/build → %s\n' "$TAILNET_PORT" "$(curl -s -m 3 http://127.0.0.1:$TAILNET_PORT/api/build || echo down)"
  tail -n 3 "$LOGS/bridge.log" 2>/dev/null | sed 's/^/bridge: /' || true
}

case "${1:-status}" in
  release) release ;;
  render) render ;;
  public-up) live_only public-up; public_up ;;
  public-back) live_only public-back; public_back ;;
  tailnet-up) live_only tailnet-up; tailnet_up ;;
  tailnet-back) live_only tailnet-back; tailnet_back ;;
  deploy) shift; deploy "$@" ;;
  rollback) shift; rollback "$@" ;;
  switch) live_only switch; switch ;;
  stageb-back) live_only stageb-back; detach stageb-back; stageb_back ;;
  switch-v1) shift; switch_v1 "$@" ;;
  rollback-v0) shift; rollback_v0 "$@" ;;
  health) health ;;
  wg-on) shift; wg_on "$@" ;;
  wg-off) wg_off ;;
  status) status ;;
  *) die "usage: hub-units.sh release|render|deploy <id>|rollback <id> <backup>|switch|stageb-back|health|public-up|public-back|tailnet-up|tailnet-back|status" ;;
esac
