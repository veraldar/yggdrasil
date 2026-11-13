#!/usr/bin/env bash
# deploy-live.sh — put the root-coord brain on the live :4100 root, through the watcher's swap
# law (scripts/watch-landings.sh: sha-verified, applied when MAIN is idle and no lane runs,
# frozen.conf rolled back by the watcher itself if the new process does not come up).
#
#   deploy-live.sh apply      backups → env + profiles → pending swap → wait for SWAP-DONE → probes
#   deploy-live.sh rollback   restore env + profiles from the backups → swap back to the previous binary
#
# Backups land in ~/.local/share/bifrost/backups/root-coord-live-<ts>/ (data dir tarball included).
set -euo pipefail
BRAIN_DIR="$HOME/.local/share/bifrost/brain"
ENV="$HOME/.config/yggdrasil/yggdrasil.env"
PROFILES="$HOME/.config/bifrost/yggdrasil-profiles.json"
STAGED_PROFILES="$HOME/.cache/root-sim/stage/yggdrasil-profiles.json"
UNIT=lk-yggdrasil
STATUS=/tmp/sub-status.tsv
PENDING=/tmp/brain-swap.pending
LAST="$HOME/.local/share/bifrost/backups/root-coord-live.last"

swap_to() { # $1 = binary basename; waits for the watcher's SWAP-DONE row
  local bin="$BRAIN_DIR/$1" sha
  sha=$(sha256sum "$bin" | cut -d' ' -f1)
  printf '{"unit": "%s", "binary": "%s", "sha": "%s"}\n' "$UNIT" "$bin" "$sha" > "$PENDING"
  echo "pending swap → $1 (watcher applies it when MAIN is idle and no lane runs)"
  for _ in $(seq 1 120); do
    grep -q "SWAP-DONE $1" "$STATUS" 2>/dev/null && { grep "SWAP-DONE $1" "$STATUS" | tail -1; return 0; }
    grep -qE "SWAP-(FAIL|SHA-BAD|ESCALATE) $1" "$STATUS" 2>/dev/null && { grep -E "SWAP-[A-Z-]+ $1" "$STATUS" | tail -2; return 1; }
    sleep 5
  done
  echo "no SWAP-DONE after 10 min (pending kept: $PENDING)"; return 1
}

probe() {
  local b=http://127.0.0.1:4100
  curl -sf -m 5 "$b/root" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("root", d["name"], "models", [m["id"] for m in d["models"]])'
  curl -sf -m 5 "$b/agent" | python3 -c 'import json,sys; print("profiles", [a["name"] for a in json.load(sys.stdin)])'
  curl -sf -m 10 "$b/session" | python3 -c 'import json,sys; d=json.load(sys.stdin); m=[s for s in d if s["title"]=="[MAIN]"]; print(len(d), "sessions; MAIN", [(x.get("agent"), x.get("model",{}).get("id")) for x in m])'
  curl -sf -m 10 "$b/tree" | python3 -c 'import json,sys; print("tree rows", len(json.load(sys.stdin)))'
}

case "${1:-}" in
apply)
  NEW=$(cat "$HOME/.cache/root-sim/stage/binary-name")
  [ -x "$BRAIN_DIR/$NEW" ] || { echo "missing $BRAIN_DIR/$NEW"; exit 1; }
  (cd "$BRAIN_DIR" && sha256sum -c "$NEW.sha256" >/dev/null) || { echo "sha mismatch"; exit 1; }
  OLD=$(basename "$(readlink "/proc/$(systemctl --user show $UNIT -p MainPID --value)/exe")")
  BK="$HOME/.local/share/bifrost/backups/root-coord-live-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BK"
  cp -p "$ENV" "$BK/yggdrasil.env"; cp -p "$PROFILES" "$BK/yggdrasil-profiles.json"
  tar -C "$HOME/.local/share" -czf "$BK/yggdrasil-data.tgz" yggdrasil
  echo "$OLD" > "$BK/previous-binary"; echo "$BK" > "$LAST"
  echo "backups → $BK (previous binary $OLD)"
  # env: the models this root serves + its name; everything else unchanged
  python3 - "$ENV" <<'PY'
import sys, re, os
p = sys.argv[1]; s = open(p).read()
def put(k, v):
    global s
    # quoted when it has spaces: systemd strips the quotes, and bash scripts `source` this file
    line = f'{k}="{v}"' if any(c in v for c in " '()") else f"{k}={v}"
    s = re.sub(rf"(?m)^{k}=.*$", line, s) if re.search(rf"(?m)^{k}=", s) else s.rstrip("\n") + f"\n{line}\n"
s += "" if "# root-coord" in s else "# root-coord (11-12): the coordinator door, profiles with models, roots, harness sessions\n"
put("YGG_MODELS", "glm-5.3-flash,glm-5.3,glm-5.2")
put("YGG_ROOT_NAME", "omarchy")
put("YGG_ROOT_NOTE", "the main computer (omarchy): 16 cpu / 30 GB, holds ~/Work and every project")
put("YGG_MAX_INFLIGHT", "5")
put("YGG_VISION_MODELS", "glm-5.3-flash")  # the one z.ai model here that reads images (probed 11-13)
put("YGG_ARTIFACTS_DIR", os.path.expanduser("~/Work/bifrost/artifacts"))  # the review agent's only write
put("YGG_VOICE_MAX_WORDS", "300")  # a safety limit now: voice commands control playback (11-13)
put("YGG_ROLLUP_TOKENS", "200000")  # owner 11-13: a session rolls up past ~200k tokens (keeps the last quarter)
open(p, "w").write(s)
PY
  install -m600 "$STAGED_PROFILES" "$PROFILES"
  swap_to "$NEW"
  sleep 2; probe
  ;;
rollback)
  BK=$(cat "$LAST"); OLD=$(cat "$BK/previous-binary")
  install -m600 "$BK/yggdrasil.env" "$ENV"; install -m600 "$BK/yggdrasil-profiles.json" "$PROFILES"
  echo "env + profiles restored from $BK; data tarball kept at $BK/yggdrasil-data.tgz (restore by hand if needed)"
  swap_to "$OLD"
  ;;
*) echo "usage: $0 apply|rollback"; exit 2 ;;
esac
