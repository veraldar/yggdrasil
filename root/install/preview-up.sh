#!/usr/bin/env bash
# preview-up.sh (tree-next copy, phase 0) — restart a preview brain on a new binary, keeping its
# data and upstream.   preview-up.sh [binary]
#   preview: :8447 → app :8101 → brain :4101    PREVIEW=ui: app :8191 → brain :4191
# Default binary (phase 0 fix): THIS tree's root/target/release/yggdrasil — the live tree-next
# build, never the stale lab clone (which was 4 days old and sha-different).
# The unit's environment is reused as is (upstream key included); see the original in
# ~/Work/root-coord/lab/root-sim/preview-up.sh for the long notes.
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)   # scripts/ of this tree (worktree or main checkout)
NAME=${PREVIEW:-preview}
UNIT=rootsim-$NAME
UI="$HOME/.cache/root-sim/$NAME"
BIN=${1:-$SRC/../root/target/release/yggdrasil}
[ -x "$BIN" ] || { echo "no brain binary: $BIN (build it first: (cd root && cargo build --release))"; exit 1; }
ART="$HOME/Work/root-coord-pwa/artifacts"

mapfile -t ENVV < <(systemctl --user show "$UNIT" -p Environment --value | python3 -c 'import shlex,sys; print("\n".join(shlex.split(sys.stdin.read())))' | grep -vE '^(YGG_MODELS|YGG_VISION_MODELS|YGG_ARTIFACTS_DIR|YGG_EXTENSIONS|YGG_HARNESS_LIVE|YGG_OPENCODE_XDG_DATA|YGG_OPENCODE_XDG_CONFIG|YGG_HARNESS_HELPER|YGG_HARNESS_HELPER_TOKEN|YGG_HARNESS_RUNNER)=')
ENVV+=("YGG_MODELS=glm-5.3-flash,glm-5.3,glm-5.2" "YGG_VISION_MODELS=glm-5.3-flash" "YGG_ARTIFACTS_DIR=$ART")
[ "${#ENVV[@]}" -gt 10 ] || { echo "no environment read from $UNIT"; exit 1; }

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

systemctl --user stop "rc-$NAME-secrets" 2>/dev/null || true
systemctl --user reset-failed "rc-$NAME-secrets" 2>/dev/null || true
rm -f "$UI/secrets.bus"
mapfile -t ENVV < <(printf '%s\n' "${ENVV[@]}" | grep -vE '^(DBUS_SESSION_BUS_ADDRESS|AGY_CLI_DISABLE_AUTO_UPDATE|YGG_HARNESS_RUNNER|XDG_(CONFIG|DATA|STATE|CACHE)_HOME)=')
ENVV+=("AGY_CLI_DISABLE_AUTO_UPDATE=1")
ENVV+=("DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}")
CC_DIR="$HOME/.local/share/mise/installs/claude/latest"
OLD_PATH=$(printf '%s\n' "${ENVV[@]}" | sed -n 's/^PATH=//p' | tr ':' '\n' | grep -vxF "$CC_DIR" | paste -sd:)
mapfile -t ENVV < <(printf '%s\n' "${ENVV[@]}" | grep -v '^PATH=')
ENVV+=("PATH=$CC_DIR:$OLD_PATH")

# the librarian runs from THIS tree (B8: never a third worktree), its own DB kept
if [ "$NAME" = preview ]; then
  systemctl --user stop rc-preview-librarian 2>/dev/null || true
  systemctl --user reset-failed rc-preview-librarian 2>/dev/null || true
  systemd-run --user --unit rc-preview-librarian --collect -p "StandardOutput=append:$UI/librarian.log" -p "StandardError=append:$UI/librarian.log" \
    python3 "$SRC/../root/extensions/librarian/librarian.py" --root "$B" --port 4310 --db "$UI/librarian.db" --artifacts "$ART" >/dev/null
  ENVV+=("YGG_EXTENSIONS=librarian=http://127.0.0.1:4310")
fi

CC_LIVE_DIR="$SRC/../root/cc-live" PREVIEW=$NAME "$HOME/Work/root-coord/lab/root-sim/cc-live-up.sh" >/dev/null 2>&1 || echo "cc-live: not started (the app's live view will say so)"
ENVV+=("YGG_HARNESS_LIVE=$UI/harness-live.json")
case "$NAME" in preview) HPORT=4320 ;; ui) HPORT=4321 ;; *) HPORT= ;; esac
if [ -n "$HPORT" ] && [ -s "$HOME/.cache/root-sim/cc-live.token" ]; then
  ENVV+=("YGG_HARNESS_HELPER=http://127.0.0.1:$HPORT" "YGG_HARNESS_HELPER_TOKEN=$(cat "$HOME/.cache/root-sim/cc-live.token")")
fi
if [ "$NAME" = preview ]; then
  ENVV+=("YGG_OPENCODE_XDG_DATA=$HOME/.local/share" "YGG_OPENCODE_XDG_CONFIG=$HOME/.config")
fi

python3 - "$UI/agents.json" "$HOME/.cache/root-sim/stage/yggdrasil-profiles.json" <<'PY'
import json, sys
ui, staged = (json.load(open(p)) for p in sys.argv[1:3])
for k, v in staged.get("agent", {}).items():
    ui.setdefault("agent", {}).setdefault(k, v)
json.dump(ui, open(sys.argv[1], "w"), indent=1)
PY

# backup before the swap (phase 0: every deploy is preceded by one)
"$(dirname "$0")/preview-backup.sh" || echo "backup failed — continuing anyway (the sessions tar is the only writer)"

systemctl --user stop "$UNIT" 2>/dev/null || true
install -m755 "$BIN" "$UI/bin/yggdrasil"
mkdir -p "$ART"
args=(--user --unit "$UNIT" --collect
  -p "StandardOutput=append:$UI/brain.log" -p "StandardError=append:$UI/brain.log")
for e in "${ENVV[@]}"; do args+=(--setenv="$e"); done
systemd-run "${args[@]}" "$UI/bin/yggdrasil" >/dev/null
for _ in $(seq 1 40); do curl -sf -m 2 "$B/root" >/dev/null && break; sleep 0.5; done
curl -sf -m 5 "$B/root" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("'"$NAME"' brain up:", [(m["id"], m["tier"]) for m in d["models"]])'
curl -sf -m 5 "$B/agent" | python3 -c 'import json,sys; print("agents:", [a["name"] for a in json.load(sys.stdin)])'
sleep 4; curl -sf -m 5 "$B/extensions" | python3 -c 'import json,sys; print("extensions:", [(x["name"], x["up"], [t["name"] for t in x["tools"]]) for x in json.load(sys.stdin)])'
