#!/usr/bin/env bash
# deploy-voice.sh — run the daily stack's voice agent (lk-agent-ygg, :8443) from the root-coord
# agent (voice commands stop/faster/slower, manual turn-taking from the first frame, no doomed TTS)
# through a systemd drop-in: the lane2-merge worktree stays untouched, rollback is one file.
#   deploy-voice.sh apply | rollback
set -euo pipefail
UNIT=lk-agent-ygg
DROP="$HOME/.config/systemd/user/$UNIT.service.d/root-coord.conf"
DIR="$HOME/Work/root-coord/agent"
case "${1:-}" in
apply)
  (cd "$DIR" && uv sync --frozen >/dev/null 2>&1 || uv sync >/dev/null)   # its own .venv, same lockfile
  mkdir -p "$(dirname "$DROP")"
  printf '[Service]\nWorkingDirectory=%s\nEnvironment=AGENT_TTS=off\n' "$DIR" > "$DROP"
  ;;
rollback) rm -f "$DROP" ;;
*) echo "usage: $0 apply|rollback"; exit 2 ;;
esac
systemctl --user daemon-reload && systemctl --user restart "$UNIT"
for _ in $(seq 1 30); do
  journalctl --user -u "$UNIT" --since "-40s" -o cat | grep -q 'registered worker' && { echo "$UNIT registered ($1)"; exit 0; }
  sleep 1
done
echo "$UNIT did not register — check: journalctl --user -u $UNIT"; exit 1
