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
mapfile -t ENVV < <(systemctl --user show "$UNIT" -p Environment --value | python3 -c 'import shlex,sys; print("\n".join(shlex.split(sys.stdin.read())))' | grep -vE '^(YGG_MODELS|YGG_VISION_MODELS|YGG_ARTIFACTS_DIR|YGG_EXTENSIONS)=')
ENVV+=("YGG_MODELS=glm-5.3-flash,glm-5.3,glm-5.2" "YGG_VISION_MODELS=glm-5.3-flash" "YGG_ARTIFACTS_DIR=$ART")
[ "${#ENVV[@]}" -gt 10 ] || { echo "no environment read from $UNIT"; exit 1; }
B="http://$(printf '%s\n' "${ENVV[@]}" | sed -n 's/^YGG_LISTEN=//p')"

# the preview's extensions (outside the core): the librarian indexes this brain (:4310)
if [ "$NAME" = preview ]; then
  systemctl --user stop rc-preview-librarian 2>/dev/null || true
  systemctl --user reset-failed rc-preview-librarian 2>/dev/null || true
  systemd-run --user --unit rc-preview-librarian --collect -p "StandardOutput=append:$UI/librarian.log" -p "StandardError=append:$UI/librarian.log" \
    python3 "$HOME/Work/root-coord/extensions/librarian/librarian.py" --root "$B" --port 4310 --db "$UI/librarian.db" --artifacts "$ART" >/dev/null
  ENVV+=("YGG_EXTENSIONS=librarian=http://127.0.0.1:4310")
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
  -p "BindPaths=$HOME/.claude" -p "BindPaths=$HOME/.claude.json" -p "BindReadOnlyPaths=$HOME/.local/share/mise"
  -p "StandardOutput=append:$UI/brain.log" -p "StandardError=append:$UI/brain.log")
for e in "${ENVV[@]}"; do args+=(--setenv="$e"); done
systemd-run "${args[@]}" "$UI/bin/yggdrasil" >/dev/null
for _ in $(seq 1 40); do curl -sf -m 2 "$B/root" >/dev/null && break; sleep 0.5; done
curl -sf -m 5 "$B/root" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("'"$NAME"' brain up:", [(m["id"], m["tier"]) for m in d["models"]])'
curl -sf -m 5 "$B/agent" | python3 -c 'import json,sys; print("agents:", [a["name"] for a in json.load(sys.stdin)])'
sleep 4; curl -sf -m 5 "$B/extensions" | python3 -c 'import json,sys; print("extensions:", [(x["name"], x["up"], [t["name"] for t in x["tools"]]) for x in json.load(sys.stdin)])'
