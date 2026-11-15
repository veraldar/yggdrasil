#!/usr/bin/env bash
# preview-up.sh — restart a preview brain on a new binary, keeping its data, upstream and sandbox.
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
mapfile -t ENVV < <(systemctl --user show "$UNIT" -p Environment --value | python3 -c 'import shlex,sys; print("\n".join(shlex.split(sys.stdin.read())))' | grep -vE '^(YGG_MODELS|YGG_VISION_MODELS|YGG_ARTIFACTS_DIR|YGG_EXTENSIONS|YGG_HARNESS_LIVE|YGG_OPENCODE_XDG_DATA|YGG_OPENCODE_XDG_CONFIG)=')
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

# agy's Google sign-in: a keyring item (Secret Service over the D-Bus session bus), which the
# sandbox cannot see (ProtectHome also hides /run/user). A filtered proxy (unit rc-$NAME-secrets,
# socket in the bound $UI) lets it read THAT item only: no other secret, no writes, no systemd,
# nothing else on the bus. Signed out (no item): no proxy, and a turn says how to sign in.
# A new sign-in (a new item) needs a rerun of this script.
SS=org.freedesktop.secrets SP=/org/freedesktop/secrets SBUS="$UI/secrets.bus"
systemctl --user stop "rc-$NAME-secrets" 2>/dev/null || true
systemctl --user reset-failed "rc-$NAME-secrets" 2>/dev/null || true
rm -f "$SBUS"
mapfile -t ENVV < <(printf '%s\n' "${ENVV[@]}" | grep -vE '^(DBUS_SESSION_BUS_ADDRESS|AGY_CLI_DISABLE_AUTO_UPDATE)=')
ENVV+=("AGY_CLI_DISABLE_AUTO_UPDATE=1") # the terminal's agy updates the shared binary
AGY_ITEM=$(busctl --user --json=short call "$SS" "$SP/aliases/default" org.freedesktop.Secret.Collection SearchItems 'a{ss}' 2 service gemini username antigravity 2>/dev/null |
  python3 -c 'import json,sys; d=json.load(sys.stdin)["data"][0]; print(d[0] if d else "")' 2>/dev/null || true)
if [ -n "$AGY_ITEM" ]; then
  systemd-run --user --unit "rc-$NAME-secrets" --collect -q \
    xdg-dbus-proxy "${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}" "$SBUS" --filter \
    --call="$SS=org.freedesktop.DBus.Properties.Get@$SP" --call="$SS=org.freedesktop.Secret.Service.OpenSession@$SP" \
    --call="$SS=org.freedesktop.Secret.Service.Unlock@$SP" --call="$SS=org.freedesktop.Secret.Collection.SearchItems@$SP/aliases/default" \
    --call="$SS=org.freedesktop.Secret.Item.GetSecret@$AGY_ITEM" --call="$SS=org.freedesktop.Secret.Session.Close@$SP/session/*"
  for _ in $(seq 1 40); do [ -S "$SBUS" ] && break; sleep 0.1; done
  ENVV+=("DBUS_SESSION_BUS_ADDRESS=unix:path=$SBUS")
else
  echo "agy: no Google sign-in in the keyring (run \`agy\` once in a terminal, then rerun this): its turns will say so"
fi

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

# the terminal's conversations, both ways (11-15, the preview you open only): the brain continues
# them in the folders they run in (~/Work), and its opencode shares the owner's opencode data
# (backup before the first run: ~/.cache/root-sim/backups/opencode-pre-two-way.db)
BINDS=()
if [ "$NAME" = preview ]; then
  BINDS=(-p "BindPaths=$HOME/Work" -p "BindPaths=-$HOME/.local/share/opencode" -p "BindPaths=-$HOME/.config/opencode")
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
args=(--user --unit "$UNIT" --collect -p ProtectHome=tmpfs
  -p "BindPaths=$UI" -p "BindPaths=$ART" -p "BindReadOnlyPaths=$HOME/.cache/root-sim/_venv"
  -p "BindPaths=$HOME/.claude" -p "BindPaths=$HOME/.claude.json" -p "BindPaths=$HOME/.gemini" -p "BindReadOnlyPaths=$HOME/.local/share/mise"
  -p "BindReadOnlyPaths=-$HOME/.local/bin/agy" "${BINDS[@]}"
  -p "StandardOutput=append:$UI/brain.log" -p "StandardError=append:$UI/brain.log")
for e in "${ENVV[@]}"; do args+=(--setenv="$e"); done
systemd-run "${args[@]}" "$UI/bin/yggdrasil" >/dev/null
for _ in $(seq 1 40); do curl -sf -m 2 "$B/root" >/dev/null && break; sleep 0.5; done
curl -sf -m 5 "$B/root" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("'"$NAME"' brain up:", [(m["id"], m["tier"]) for m in d["models"]])'
curl -sf -m 5 "$B/agent" | python3 -c 'import json,sys; print("agents:", [a["name"] for a in json.load(sys.stdin)])'
sleep 4; curl -sf -m 5 "$B/extensions" | python3 -c 'import json,sys; print("extensions:", [(x["name"], x["up"], [t["name"] for t in x["tools"]]) for x in json.load(sys.stdin)])'
