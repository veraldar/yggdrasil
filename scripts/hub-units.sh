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
HUB=$HOME/.local/share/yggdrasil/hub
CONF=$HOME/.config/yggdrasil/hub
UNITS=$HOME/.config/systemd/user
NODE=${NODE:-$HOME/.local/share/mise/installs/node/26.8.1/bin/node}
OLD=$HOME/.local/state/trunk-preview
LOGS=$HUB/logs
PV=${HUB_PV:-$HOME/.cache/root-sim/preview}
ART=$HOME/Work/root-coord-pwa/artifacts
BRAIN=http://127.0.0.1:4101

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
  printf 'id=%s\ncommit=%s\nbuilt=%s\napp_build_id=%s\n' "$id" "$(git -C "$TREE" rev-parse HEAD)" "$(date -Is)" "$(cat "$b/.next/BUILD_ID")" >"$r/BUILD"
  chmod -R go-w "$r"
  echo "$id"
}

render() {
  mkdir -p "$UNITS" "$LOGS"
  cat >"$UNITS/hub-app.service" <<EOF
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
  cat >"$UNITS/hub-bridge.service" <<EOF
[Unit]
Description=yggdrasil home root: the bridge to the trunk (ap.veraldar.org) — app, voice, root links
After=network-online.target hub-app.service

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
  cat >"$UNITS/hub-wg.service" <<EOF
[Unit]
Description=yggdrasil home root: its WireGuard node (brain-to-brain calls between roots, end to end)
After=hub-bridge.service

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
  cat >"$UNITS/hub-voice-agent.service" <<EOF
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
  cat >"$UNITS/hub-app-tailnet.service" <<EOF
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
  cat >"$UNITS/hub-brain.service" <<EOF
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
  cat >"$UNITS/hub-librarian.service" <<EOF
[Unit]
Description=yggdrasil home root: the librarian (search and memory, :4310)
After=hub-brain.service

[Service]
ExecStart=/usr/bin/python3 $HUB/current/librarian/librarian.py --root $BRAIN --port 4310 --db $PV/librarian.db --artifacts $ART
Restart=on-failure
RestartSec=3
StandardOutput=append:$PV/librarian.log
StandardError=append:$PV/librarian.log

[Install]
WantedBy=default.target
EOF
  cat >"$UNITS/hub-cclive.service" <<EOF
[Unit]
Description=yggdrasil home root: the live helper (the owner's terminal sessions, :4320)

[Service]
WorkingDirectory=%h
Environment=HOME=%h PATH=%h/.local/share/mise/shims:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 $HUB/current/cc-live/cc_live.py --port 4320 --token-file $HOME/.cache/root-sim/cc-live.token --claude $HOME/.local/share/mise/shims/claude --live-file $PV/harness-live.json
Restart=on-failure
RestartSec=3
StandardOutput=append:$HOME/.cache/root-sim/cc-live-preview.log
StandardError=append:$HOME/.cache/root-sim/cc-live-preview.log

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  echo "rendered: hub-brain hub-librarian hub-cclive hub-voice-agent hub-app hub-app-tailnet hub-bridge"
}

wait_http() { for _ in $(seq 1 60); do curl -sf -m 2 -o /dev/null "$1" && return 0; sleep 0.5; done; return 1; }

public_up() {
  [ -L "$HUB/current" ] || die "no $HUB/current (hub-units.sh release, then ln -sfn releases/<id> current)"
  render
  # the access point keeps one bridge link: the old one goes first (its files stay: public-back)
  for u in trunk-preview-bridge trunk-preview-app; do systemctl --user stop "$u" 2>/dev/null || true; done
  systemctl --user restart hub-voice-agent
  systemctl --user restart hub-app
  wait_http http://127.0.0.1:4502/api/build || die "hub-app did not answer on :4502 (log: $LOGS/app.log)"
  systemctl --user restart hub-bridge
  sleep 3
  status
}

ALL="hub-brain hub-librarian hub-cclive hub-voice-agent hub-app hub-app-tailnet hub-bridge"
# the root ↔ root leg (AP-10), beside the bridge's ports (4503 http, 4504 root-link, 4505 media): the
# node's front door (the brain's only way to other roots), its udp, the bridge's relay socket — loopback
WG_HTTP=4506 WG_UDP=4507 WG_RELAY=4508
WG_FILES="bridge-public.toml brain.env app-public.env app-tailnet.env"

# run from a session inside the brain, stopping the brain would kill this script half-way: go on in
# a unit of its own (the same rule as preview-up.sh)
detach() {
  if [ -z "${HUB_UNITS_DETACHED:-}" ] && grep -qE '/(hub-brain|rootsim-preview)\.service' /proc/self/cgroup 2>/dev/null; then
    mkdir -p "$LOGS"
    systemd-run --user --unit "hub-units-$1-$(date +%s)-$$" --collect -q -p "StandardOutput=append:$LOGS/switch.log" \
      -p "StandardError=append:$LOGS/switch.log" --setenv=HUB_UNITS_DETACHED=1 bash "$(readlink -f "$0")" "$@"
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
  chk "brain :4101 is root omarchy" has "$out" '"name":"omarchy"'
  out=$(curl -sf -m 10 "$BRAIN/session" || true)
  chk "brain: MAIN is there" has "$out" '[MAIN]'
  for _ in $(seq 1 30); do out=$(curl -sf -m 3 "$BRAIN/extensions" || true); has "$out" '"up":true' && break; sleep 1; done
  chk "librarian :4310 up (as the brain sees it)" has "$out" '"up":true'
  tok=$(cat "$HOME/.cache/root-sim/cc-live.token" 2>/dev/null || true)
  for _ in $(seq 1 20); do curl -sf -m 3 -o /dev/null -H "x-cc-live-token: $tok" http://127.0.0.1:4320/sessions && break; sleep 1; done
  chk "live helper :4320" curl -sf -m 5 -o /dev/null -H "x-cc-live-token: $tok" http://127.0.0.1:4320/sessions
  for _ in $(seq 1 30); do curl -sf -m 2 -o /dev/null http://127.0.0.1:8101/api/build && curl -sf -m 2 -o /dev/null http://127.0.0.1:4502/api/build && break; sleep 1; done
  chk "app :8101 (tailnet)" curl -sf -m 5 -o /dev/null http://127.0.0.1:8101/api/build
  out=$(curl -sf -m 5 http://127.0.0.1:8101/api/token || true)
  chk "app :8101 voice available" has "$out" available
  chk "app :4502 (public)" curl -sf -m 5 -o /dev/null http://127.0.0.1:4502/api/build
  # 200 from outside = access point → the bridge's channel → the public app (503 = no bridge link)
  code=000
  for _ in $(seq 1 40); do code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 https://ap.veraldar.org/ || true); [ "$code" = 200 ] && break; sleep 1; done
  chk "ap.veraldar.org answers through the bridge ($code)" test "$code" = 200
  for _ in $(seq 1 60); do curl -sf -m 2 -o /dev/null http://127.0.0.1:18084/ && break; sleep 1; done
  chk "voice agent up (its worker answers on :18084)" curl -sf -m 5 -o /dev/null http://127.0.0.1:18084/
  if systemctl --user is-enabled -q hub-wg 2>/dev/null; then
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
  for u in hub-brain hub-librarian hub-cclive; do systemctl --user disable --now "$u" 2>/dev/null || true; done
  # the tailnet app talks to the preview's voice agent again
  sed -i 's/^AGENT_NAME=.*/AGENT_NAME=bifrost-preview/' "$CONF/app-tailnet.env" || true
  systemctl --user restart hub-app-tailnet || true
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
  "$HOME/Work/tree-next/scripts/preview-backup.sh" || echo "backup failed — going on"
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
  systemctl --user restart hub-brain || return 1
  systemctl --user restart hub-librarian hub-cclive || return 1
  systemctl --user restart hub-app-tailnet || return 1
  for u in hub-voice-agent hub-app hub-bridge; do
    systemctl --user is-active -q "$u" || systemctl --user start "$u" || return 1
  done
  return 0
}

# the tailnet app onto the release (rc-preview-pwa stopped; its way back: tailnet-back)
tailnet_up() {
  render
  systemctl --user stop rc-preview-pwa 2>/dev/null || true
  systemctl --user restart hub-app-tailnet
  wait_http http://127.0.0.1:8101/api/build || { echo "hub-app-tailnet did not answer: back to rc-preview-pwa" >&2; tailnet_back; exit 1; }
  status
}

# rc-preview-pwa is transient (gone once stopped): recreated exactly as it ran on 11-20
tailnet_back() {
  systemctl --user stop hub-app-tailnet 2>/dev/null || true
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
  for u in "$@"; do case " $ALL hub-wg " in *" $u "*) ;; *) die "unknown unit $u (one of: $ALL hub-wg)" ;; esac; done
  # only named units (e.g. `deploy <id> hub-voice-agent`): the brain keeps running, no turn is cut
  case "$only" in "  " | *" hub-brain "*) detach deploy "$id" "$@" ;; *) echo "== $(date -Is) hub-units deploy $id $*" ;; esac
  prev=$(readlink "$HUB/current" || true)
  local running=""
  for u in $ALL hub-wg; do
    systemctl --user is-active -q "$u" || continue
    case "$only" in "  " | *" $u "*) running="$running $u" ;; esac
  done
  case " $running " in *" hub-brain "*) brain=1 ;; esac
  local bk=""
  if [ "$brain" = 1 ]; then
    bk=$(backup_data)
    # a release may change the data when it starts (11-22): no way back without a backup — no deploy
    [ -n "$bk" ] || die "the backup failed — nothing was deployed"
    echo "-- the way back for the data: $bk"
  fi
  ln -sfn "$HUB/releases/$id" "$HUB/current"
  render
  # the brain drains in its ExecStop; the others restart at once
  for u in $running; do systemctl --user restart "$u" || bad=1; done
  if [ "$bad" = 0 ]; then health || bad=1; fi
  if [ "$bad" = 1 ]; then
    echo "== deploy $id: failed — back to $prev"
    ln -sfn "$prev" "$HUB/current"
    if [ "$brain" = 1 ]; then
      # the new release may have changed the sessions when it started: the old one gets them back as
      # it left them
      systemctl --user stop hub-brain || true
      restore_data "$bk" || echo "!! data NOT restored — the old release starts on what the new one left"
    fi
    for u in $running; do systemctl --user restart "$u" || true; done
    health || echo "!! the previous release does not pass the health check either"
    exit 1
  fi
  echo "== deploy $id: done"
  status || true
}

# the brain's data backed up; prints the backup's folder on its last line (empty: it failed)
backup_data() {
  local out
  out=$("$HOME/Work/tree-next/scripts/preview-backup.sh" 2>&1) || { echo "$out" >&2; echo; return 0; }
  echo "$out" >&2
  sed -n 's/^backup: \([^ ]*\) (.*/\1/p' <<<"$out" | tail -n 1
}

# the brain's sessions and its agents file put back from a backup (hub-brain must be stopped): a
# release may change them when it starts (11-22: roles + engines), and the release before it must
# find them as it left them. What was there is kept beside them (…undone-<time>), never deleted.
restore_data() {
  local bk=$1 t
  [ -n "$bk" ] && [ -s "$bk/sessions.tgz" ] || { echo "!! no backup to restore from (${bk:-none})"; return 1; }
  if [ -z "${HUB_PV:-}" ] && systemctl --user is-active -q hub-brain; then echo "!! hub-brain still runs: not restoring under it"; return 1; fi
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
  systemctl --user stop hub-brain
  restore_data "$bk" || { echo "!! data not restored: hub-brain stays stopped — look at $PV/data"; exit 1; }
  for u in $ALL hub-wg; do systemctl --user is-enabled -q "$u" 2>/dev/null && systemctl --user restart "$u"; done
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
  systemctl --user restart hub-bridge || bad=1
  if [ "$1" = on ]; then
    systemctl --user enable -q hub-wg || bad=1
    systemctl --user restart hub-wg || bad=1
  else
    systemctl --user disable -q --now hub-wg 2>/dev/null || true
  fi
  for u in hub-brain hub-app hub-app-tailnet; do systemctl --user restart "$u" || bad=1; done
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
  if ! systemctl --user is-active -q hub-wg; then
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
    echo "restart: hub-bridge, hub-wg (new), hub-brain (drains), hub-app, hub-app-tailnet · then the health check"
    return 0
  fi
  detach wg-on
  b=$CONF/backup-wg-$(date +%Y%m%d-%H%M%S)
  mkdir -p "$b" && chmod 700 "$b"
  for f in $WG_FILES; do cp -p "$CONF/$f" "$b/$f"; done
  "$HOME/Work/tree-next/scripts/preview-backup.sh" || echo "backup failed — going on"
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

public_back() {
  systemctl --user stop hub-bridge hub-app hub-voice-agent 2>/dev/null || true
  [ -x "$OLD/hub-up.sh" ] || die "no $OLD/hub-up.sh"
  bash "$OLD/hub-up.sh"
}

status() {
  for u in $ALL hub-wg; do printf '%-16s %-9s %s\n' "$u" "$(systemctl --user is-active "$u" 2>/dev/null || true)" "$(systemctl --user is-enabled "$u" 2>/dev/null || true)"; done
  echo "release: $(readlink "$HUB/current" 2>/dev/null || echo none)"
  printf 'app :4502 /api/build → %s\n' "$(curl -s -m 3 http://127.0.0.1:4502/api/build || echo down)"
  printf 'app :8101 /api/build → %s\n' "$(curl -s -m 3 http://127.0.0.1:8101/api/build || echo down)"
  tail -n 3 "$LOGS/bridge.log" 2>/dev/null | sed 's/^/bridge: /' || true
}

case "${1:-status}" in
  release) release ;;
  render) render ;;
  public-up) public_up ;;
  public-back) public_back ;;
  tailnet-up) tailnet_up ;;
  tailnet-back) tailnet_back ;;
  deploy) shift; deploy "$@" ;;
  rollback) shift; rollback "$@" ;;
  switch) switch ;;
  stageb-back) detach stageb-back; stageb_back ;;
  health) health ;;
  wg-on) shift; wg_on "$@" ;;
  wg-off) wg_off ;;
  status) status ;;
  *) die "usage: hub-units.sh release|render|deploy <id>|rollback <id> <backup>|switch|stageb-back|health|public-up|public-back|tailnet-up|tailnet-back|status" ;;
esac
