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
#   hub-units.sh deploy <id>        `current` → releases/<id>, running hub units restarted (the brain drains
#                                   first), back to the previous release if the health check fails
#   hub-units.sh switch             STAGE B: brain, librarian, live helper, voice agent and both apps become
#                                   these units (enabled, linger on); the transient rootsim-preview /
#                                   rc-preview-* stop; root renamed `omarchy`. Health check after; on a
#                                   failure the old transient units are put back by themselves
#   hub-units.sh stageb-back        the same way back, by hand
#   hub-units.sh health             the check switch/deploy run (exit 0 = all well)
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
PV=$HOME/.cache/root-sim/preview
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
ExecStop=-/usr/bin/curl -s -m 70 -X POST $BRAIN/admin/drain -H 'Content-Type: application/json' -d '{"max_s": 60}'
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

# run from a session inside the brain, stopping the brain would kill this script half-way: go on in
# a unit of its own (the same rule as preview-up.sh)
detach() {
  if [ -z "${HUB_UNITS_DETACHED:-}" ] && grep -qE '/(hub-brain|rootsim-preview)\.service' /proc/self/cgroup 2>/dev/null; then
    mkdir -p "$LOGS"
    systemd-run --user --unit "hub-units-$1-$(date +%s)" --collect -q -p "StandardOutput=append:$LOGS/switch.log" \
      -p "StandardError=append:$LOGS/switch.log" --setenv=HUB_UNITS_DETACHED=1 bash "$(readlink -f "$0")" "$@"
    echo "goes on outside this session (the brain restarts; this turn ends with it) — log: $LOGS/switch.log"
    exit 0
  fi
  echo "== $(date -Is) hub-units $*"
}

# every door answers: the brain (its name, MAIN), the librarian, the live helper, both apps (voice on
# the tailnet one), the bridge's link to the access point, the voice agent registered
health() {
  local ok=0 tok
  chk() { if eval "$2" >/dev/null 2>&1; then echo "  ok   $1"; else echo "  FAIL $1"; ok=1; fi; }
  for _ in $(seq 1 60); do curl -sf -m 2 -o /dev/null "$BRAIN/root" && break; sleep 1; done
  chk "brain :4101 is root omarchy" "curl -sf -m 5 $BRAIN/root | grep -q '\"name\":\"omarchy\"'"
  chk "brain: MAIN is there" "curl -sf -m 5 $BRAIN/session | grep -q '\[MAIN\]'"
  for _ in $(seq 1 20); do curl -sf -m 3 "$BRAIN/extensions" | grep -q '"up":true' && break; sleep 1; done
  chk "librarian :4310 up (as the brain sees it)" "curl -sf -m 5 $BRAIN/extensions | grep -q '\"up\":true'"
  tok=$(cat "$HOME/.cache/root-sim/cc-live.token" 2>/dev/null || true)
  chk "live helper :4320" "curl -sf -m 5 -H 'x-cc-live-token: $tok' http://127.0.0.1:4320/sessions"
  for _ in $(seq 1 30); do curl -sf -m 2 -o /dev/null http://127.0.0.1:8101/api/build && curl -sf -m 2 -o /dev/null http://127.0.0.1:4502/api/build && break; sleep 1; done
  chk "app :8101 (tailnet)" "curl -sf -m 5 http://127.0.0.1:8101/api/build"
  chk "app :8101 voice available" "curl -sf -m 5 http://127.0.0.1:8101/api/token | grep -q available"
  chk "app :4502 (public)" "curl -sf -m 5 http://127.0.0.1:4502/api/build"
  chk "ap.veraldar.org answers (HSTS)" "curl -sI -m 10 https://ap.veraldar.org/ | grep -qi strict-transport"
  for _ in $(seq 1 30); do tail -n 50 "$LOGS/bridge.log" | grep -q 'channel up' && break; sleep 1; done
  chk "bridge: channel to the access point up" "tail -n 50 $LOGS/bridge.log | grep -q 'channel up'"
  for _ in $(seq 1 45); do grep -q 'registered worker' <(tail -n 200 "$LOGS/voice-agent.log") && break; sleep 1; done
  chk "voice agent registered" "tail -n 200 $LOGS/voice-agent.log | grep -q 'registered worker'"
  return $ok
}

# the transient units as they ran before stage B (11-20), put back
stageb_back() {
  echo "-- back to the transient units"
  systemctl --user disable --now hub-brain hub-librarian hub-cclive 2>/dev/null || true
  # the tailnet app talks to the preview's voice agent again
  sed -i 's/^AGENT_NAME=.*/AGENT_NAME=bifrost-preview/' "$CONF/app-tailnet.env"
  systemctl --user restart hub-app-tailnet || true
  # brain + librarian + live helper the old way (its env from the saved brain.env: the unit is gone)
  PREVIEW_UP_DETACHED=1 DRAIN_S=1 "$HOME/Work/tree-next/scripts/preview-up.sh" "$PV/bin/yggdrasil" || true
  if ! systemctl --user is-active -q rc-preview-agent; then
    systemctl --user reset-failed rc-preview-agent 2>/dev/null || true
    systemd-run --user --unit rc-preview-agent --collect -q -p WorkingDirectory="$HOME/.cache/root-sim/preview-agent-code" \
      -p EnvironmentFile="$HOME/.cache/root-sim/preview-agent.env" -p "StandardOutput=append:$HOME/.cache/root-sim/preview-agent.log" \
      -p "StandardError=append:$HOME/.cache/root-sim/preview-agent.log" "$HOME/.local/share/mise/installs/uv/latest/.mise-bins/uv" run agent.py start
  fi
  status
}

switch() {
  detach switch
  [ -L "$HUB/current" ] || die "no release (current)"
  [ -s "$CONF/brain.env" ] || die "no $CONF/brain.env"
  render
  "$HOME/Work/tree-next/scripts/preview-backup.sh" || echo "backup failed — going on"
  echo "-- drain: $(curl -s -m 70 -X POST $BRAIN/admin/drain -H 'Content-Type: application/json' -d '{"max_s": 60}' | head -c 300)"
  systemctl --user stop rootsim-preview rc-preview-librarian rc-preview-cclive rc-preview-agent 2>/dev/null || true
  # one voice agent for both doors (AGENT_LOAD=off: a busy box no longer refuses calls)
  sed -i 's/^AGENT_NAME=.*/AGENT_NAME=bifrost-hub/' "$CONF/app-tailnet.env"
  systemctl --user enable -q $ALL
  systemctl --user restart hub-brain hub-librarian hub-cclive
  systemctl --user restart hub-app-tailnet
  for u in hub-voice-agent hub-app hub-bridge; do systemctl --user is-active -q "$u" || systemctl --user start "$u"; done
  echo "-- health"
  if health; then
    loginctl enable-linger "$USER" && echo "-- linger: $(loginctl show-user "$USER" -p Linger)"
    echo "== STAGE B: switched, healthy"
    status
  else
    echo "== STAGE B: health check failed — putting the old units back"
    stageb_back
    exit 1
  fi
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
  local id=${1:?release id} prev u
  [ -d "$HUB/releases/$id" ] || die "no release $id"
  detach deploy "$id"
  prev=$(readlink "$HUB/current" || true)
  ln -sfn "$HUB/releases/$id" "$HUB/current"
  render
  # the brain drains in its ExecStop; the others restart at once
  for u in $ALL; do systemctl --user is-active -q "$u" && systemctl --user restart "$u"; done
  if [ -n "$(systemctl --user is-active hub-brain 2>/dev/null | grep -x active)" ] && ! health; then
    echo "== deploy $id: health check failed — back to $prev"
    ln -sfn "$prev" "$HUB/current"
    for u in $ALL; do systemctl --user is-active -q "$u" && systemctl --user restart "$u"; done
    health || true
    exit 1
  fi
  if ! systemctl --user is-active -q hub-brain && { ! wait_http http://127.0.0.1:4502/api/build || { systemctl --user is-active -q hub-app-tailnet && ! wait_http http://127.0.0.1:8101/api/build; }; }; then
    echo "an app did not answer on $id: back to $prev" >&2
    ln -sfn "$prev" "$HUB/current"
    for u in $ALL; do systemctl --user is-active -q "$u" && systemctl --user restart "$u"; done
    exit 1
  fi
  echo "== deploy $id: done"
  status
}

public_back() {
  systemctl --user stop hub-bridge hub-app hub-voice-agent 2>/dev/null || true
  [ -x "$OLD/hub-up.sh" ] || die "no $OLD/hub-up.sh"
  bash "$OLD/hub-up.sh"
}

status() {
  for u in $ALL; do printf '%-16s %-9s %s\n' "$u" "$(systemctl --user is-active "$u" 2>/dev/null || true)" "$(systemctl --user is-enabled "$u" 2>/dev/null || true)"; done
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
  deploy) deploy "${2:-}" ;;
  switch) switch ;;
  stageb-back) detach stageb-back; stageb_back ;;
  health) health ;;
  status) status ;;
  *) die "usage: hub-units.sh release|render|deploy <id>|switch|stageb-back|health|public-up|public-back|tailnet-up|tailnet-back|status" ;;
esac
