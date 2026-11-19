#!/usr/bin/env bash
# preview-up.sh — restart a preview brain on a new binary, keeping its data and upstream.
# No sandbox (owner 11-18: every session on every root has full access — like a terminal).
# The model tiers, the vision model and the review agent's artifacts folder (the one the preview
# PWA serves) are set here.
#
#   preview-up.sh [binary]            the preview you open: :8447 → app :8101 → brain :4101
#   PREVIEW=ui preview-up.sh [binary] the scratch pair the e2e runs use: app :8191 → brain :4191
#   (binary default: the brain's target/release/yggdrasil)
set -euo pipefail
NAME=${PREVIEW:-preview}
UNIT=rootsim-$NAME
UI="$HOME/.cache/root-sim/$NAME"
BIN=${1:-$HOME/Work/root-coord/lab/yggdrasil/target/release/yggdrasil}
ART="$HOME/Work/root-coord-pwa/artifacts" # lib/artifacts.ts: the worktree's ../artifacts

# the running unit's environment (upstream key included) — reused as is, a few keys set
# (systemd quotes values with spaces, e.g. YGG_ROOT_NOTE: split like a shell would)
mapfile -t ENVV < <(systemctl --user show "$UNIT" -p Environment --value | python3 -c 'import shlex,sys; print("\n".join(shlex.split(sys.stdin.read())))' | grep -vE '^(YGG_MODELS|YGG_VISION_MODELS|YGG_ARTIFACTS_DIR|YGG_EXTENSIONS|YGG_HARNESS_LIVE|YGG_OPENCODE_XDG_DATA|YGG_OPENCODE_XDG_CONFIG|YGG_HARNESS_HELPER|YGG_HARNESS_HELPER_TOKEN|YGG_HARNESS_RUNNER)=')
# the unit gone (11-19: an agent's `pkill -f yggdrasil` took every brain down, and a transient unit
# keeps no environment once it is gone): the copy saved at the last start, else brain-up.sh's base
if [ "${#ENVV[@]}" -le 10 ] && [ -s "$UI/brain.env" ]; then
  mapfile -t ENVV < <(grep -vE '^(YGG_MODELS|YGG_VISION_MODELS|YGG_ARTIFACTS_DIR|YGG_EXTENSIONS|YGG_HARNESS_LIVE)=' "$UI/brain.env")
  echo "environment: from $UI/brain.env (the unit was gone)"
elif [ "${#ENVV[@]}" -le 10 ]; then
  case "$NAME" in preview) PORT0=4101 ;; ui) PORT0=4191 ;; *) PORT0= ;; esac
  [ -n "$PORT0" ] || { echo "no environment read from $UNIT"; exit 1; }
  mapfile -t ENVV < <(set -a; . "$HOME/.config/yggdrasil/yggdrasil.env"; set +a
    printf '%s\n' "YGG_UPSTREAM_BASE_URL=$YGG_UPSTREAM_BASE_URL" "YGG_UPSTREAM_API_KEY=$YGG_UPSTREAM_API_KEY" \
      "YGG_UPSTREAM_STYLE=${YGG_UPSTREAM_STYLE:-anthropic}" "YGG_UPSTREAM_MODEL=glm-5.3-flash" "YGG_MAX_TOKENS=16384" \
      "YGG_THINK_HIGH=8192" "YGG_DEFAULT_VARIANT=high" "YGG_VOICE=1" "YGG_LISTEN=127.0.0.1:$PORT0" "YGG_DATA_DIR=$UI/data" \
      "YGG_PROJECT_DIR=$UI/work" "YGG_MAX_INFLIGHT=5" "YGG_WAKE_DEBOUNCE_MS=4000" "YGG_PROFILES=$UI/agents.json" \
      "YGG_ROOT_NAME=omarchy-$NAME" "HOME=$HOME" "VIRTUAL_ENV=$HOME/.cache/root-sim/_venv" \
      "PATH=$HOME/.local/bin:$HOME/.local/share/mise/installs/node/latest/bin:$HOME/.local/share/mise/installs/opencode/latest:$HOME/.local/share/mise/installs/codex/latest/bin:$HOME/.cache/root-sim/_venv/bin:/usr/local/bin:/usr/bin:/bin")
  echo "environment: rebuilt from brain-up.sh's base (the unit was gone, no saved copy)"
fi
ENVV+=("YGG_MODELS=glm-5.3-flash,glm-5.3,glm-5.2" "YGG_VISION_MODELS=glm-5.3-flash" "YGG_ARTIFACTS_DIR=$ART")
[ "${#ENVV[@]}" -gt 10 ] || { echo "no environment read from $UNIT"; exit 1; }

# Google's harness: Antigravity CLI (`agy`, ~/.local/bin; only agy is bound there) on the brain's
# PATH (Gemini CLI is gone, 11-14); its conversations are ~/.gemini, shared with the terminal like
# ~/.claude; its Google sign-in is in the keyring (below).
# GEMINI_API_KEY=… preview-up.sh   runs it on a key instead (kept on the next restarts).
MISE="$HOME/.local/share/mise/installs"
for i in "${!ENVV[@]}"; do
  case "${ENVV[$i]}" in
    PATH=*) p=":${ENVV[$i]#PATH=}:"
      p=${p//":$MISE/gemini/latest/node_modules/.bin:"/:}
      for d in "$MISE/node/latest/bin" "$HOME/.local/bin"; do
        case "$p" in *":$d:"*) ;; *) p=":$d$p" ;; esac
      done
      p=${p#:}; ENVV[$i]="PATH=${p%:}" ;;
  esac
done
if [ -n "${GEMINI_API_KEY:-}" ]; then
  mapfile -t ENVV < <(printf '%s\n' "${ENVV[@]}" | grep -v '^GEMINI_API_KEY=')
  ENVV+=("GEMINI_API_KEY=$GEMINI_API_KEY")
fi
mkdir -p "$HOME/.gemini"
B="http://$(printf '%s\n' "${ENVV[@]}" | sed -n 's/^YGG_LISTEN=//p')"

# agy's Google sign-in is a keyring item on the session bus: the real bus, nothing filtered (the
# filtered proxy rc-$NAME-secrets was for the sandbox, gone since 11-18)
systemctl --user stop "rc-$NAME-secrets" 2>/dev/null || true
systemctl --user reset-failed "rc-$NAME-secrets" 2>/dev/null || true
rm -f "$UI/secrets.bus"
# …and the owner's own XDG folders (gh, mise trust, git config): the private ones were the sandbox's
mapfile -t ENVV < <(printf '%s\n' "${ENVV[@]}" | grep -vE '^(DBUS_SESSION_BUS_ADDRESS|AGY_CLI_DISABLE_AUTO_UPDATE|YGG_HARNESS_RUNNER|XDG_(CONFIG|DATA|STATE|CACHE)_HOME)=')
ENVV+=("AGY_CLI_DISABLE_AUTO_UPDATE=1") # the terminal's agy updates the shared binary
ENVV+=("DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}")
# Claude Code's own binary first: ~/.local/bin/claude is a launcher (`mise use -g` + `mise x`) that
# hangs in a service's environment; the sandbox used to hide it, so the binary is what always ran
CC_DIR="$HOME/.local/share/mise/installs/claude/latest"
OLD_PATH=$(printf '%s\n' "${ENVV[@]}" | sed -n 's/^PATH=//p' | tr ':' '\n' | grep -vxF "$CC_DIR" | paste -sd:)
mapfile -t ENVV < <(printf '%s\n' "${ENVV[@]}" | grep -v '^PATH=')
ENVV+=("PATH=$CC_DIR:$OLD_PATH")

# the preview's extensions (outside the core): the librarian indexes this brain (:4310)
if [ "$NAME" = preview ]; then
  systemctl --user stop rc-preview-librarian 2>/dev/null || true
  systemctl --user reset-failed rc-preview-librarian 2>/dev/null || true
  systemd-run --user --unit rc-preview-librarian --collect -p "StandardOutput=append:$UI/librarian.log" -p "StandardError=append:$UI/librarian.log" \
    python3 "$HOME/Work/root-coord/extensions/librarian/librarian.py" --root "$B" --port 4310 --db "$UI/librarian.db" --artifacts "$ART" >/dev/null
  ENVV+=("YGG_EXTENSIONS=librarian=http://127.0.0.1:4310")
fi

# Claude Code live (11-14): the helper the app's live session view talks to (unsandboxed, loopback).
# Since 11-15 it follows every harness (Claude Code, Antigravity, opencode) and writes what is open
# in a terminal to $UI/harness-live.json: the brain never runs a turn on those (one writer at a time).
PREVIEW=$NAME "$(dirname "$0")/cc-live-up.sh" || echo "cc-live: not started (the app's live view will say so)"
ENVV+=("YGG_HARNESS_LIVE=$UI/harness-live.json")
# …and the coordinator reaches them through it (sessions_find/read/send/start from=): its address + token
case "$NAME" in preview) HPORT=4320 ;; ui) HPORT=4321 ;; *) HPORT= ;; esac
if [ -n "$HPORT" ] && [ -s "$HOME/.cache/root-sim/cc-live.token" ]; then
  ENVV+=("YGG_HARNESS_HELPER=http://127.0.0.1:$HPORT" "YGG_HARNESS_HELPER_TOKEN=$(cat "$HOME/.cache/root-sim/cc-live.token")")
fi

# the terminal's conversations, both ways (11-15, the preview you open only): its opencode shares
# the owner's opencode data (backup before the first run: ~/.cache/root-sim/backups/opencode-pre-two-way.db)
if [ "$NAME" = preview ]; then
  ENVV+=("YGG_OPENCODE_XDG_DATA=$HOME/.local/share" "YGG_OPENCODE_XDG_CONFIG=$HOME/.config")
fi

# the preview's agents: the staged overlay's models (fix included)
python3 - "$UI/agents.json" "$HOME/.cache/root-sim/stage/yggdrasil-profiles.json" <<'PY'
import json, sys
ui, staged = (json.load(open(p)) for p in sys.argv[1:3])
for k, v in staged.get("agent", {}).items():
    ui.setdefault("agent", {}).setdefault(k, v)
json.dump(ui, open(sys.argv[1], "w"), indent=1)
PY

systemctl --user stop "$UNIT" 2>/dev/null || true
install -m755 "$BIN" "$UI/bin/yggdrasil"
mkdir -p "$ART"
# a stray kill (any agent has full access) brings it back in 2 s; `systemctl stop` still stops it
args=(--user --unit "$UNIT" --collect -p Restart=always -p RestartSec=2
  -p "StandardOutput=append:$UI/brain.log" -p "StandardError=append:$UI/brain.log")
for e in "${ENVV[@]}"; do args+=(--setenv="$e"); done
# saved for a start after the unit is gone (0600: the upstream key is in it)
(umask 077; printf '%s\n' "${ENVV[@]}" > "$UI/brain.env")
systemd-run "${args[@]}" "$UI/bin/yggdrasil" >/dev/null
for _ in $(seq 1 40); do curl -sf -m 2 "$B/root" >/dev/null && break; sleep 0.5; done
curl -sf -m 5 "$B/root" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("'"$NAME"' brain up:", [(m["id"], m["tier"]) for m in d["models"]])'
curl -sf -m 5 "$B/agent" | python3 -c 'import json,sys; print("agents:", [a["name"] for a in json.load(sys.stdin)])'
sleep 4; curl -sf -m 5 "$B/extensions" | python3 -c 'import json,sys; print("extensions:", [(x["name"], x["up"], [t["name"] for t in x["tools"]]) for x in json.load(sys.stdin)])'
