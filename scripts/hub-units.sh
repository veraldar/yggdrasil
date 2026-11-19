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
#   hub-units.sh status
#
# Config (mode 600, made once by hand from the old stack's state — see NOTES.md):
#   ~/.config/yggdrasil/hub/{app-public.env,bridge-public.toml,voice-agent.env,admin-token,peer-token}
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
  systemctl --user daemon-reload
  echo "rendered: hub-app.service hub-bridge.service hub-voice-agent.service"
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

public_back() {
  systemctl --user stop hub-bridge hub-app hub-voice-agent 2>/dev/null || true
  [ -x "$OLD/hub-up.sh" ] || die "no $OLD/hub-up.sh"
  bash "$OLD/hub-up.sh"
}

status() {
  for u in hub-app hub-bridge hub-voice-agent; do printf '%-12s %s\n' "$u" "$(systemctl --user is-active "$u" 2>/dev/null || true)"; done
  echo "release: $(readlink "$HUB/current" 2>/dev/null || echo none)"
  printf 'app :4502 /api/build → %s\n' "$(curl -s -m 3 http://127.0.0.1:4502/api/build || echo down)"
  tail -n 3 "$LOGS/bridge.log" 2>/dev/null | sed 's/^/bridge: /' || true
}

case "${1:-status}" in
  release) release ;;
  render) render ;;
  public-up) public_up ;;
  public-back) public_back ;;
  status) status ;;
  *) die "usage: hub-units.sh release|render|public-up|public-back|status" ;;
esac
