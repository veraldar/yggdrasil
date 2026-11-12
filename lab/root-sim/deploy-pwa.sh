#!/usr/bin/env bash
# deploy-pwa.sh — serve the root-coord PWA (worktree ~/Work/root-coord-pwa, branch root-coord-pwa)
# on the daily stack (:8090 → tailnet :8443) through a systemd drop-in, so the sandbox tree and its
# uncommitted WIP stay untouched and rollback is one file.
#
#   deploy-pwa.sh apply      drop-in WorkingDirectory → restart bifrost-sandbox → probe the served BUILD_ID
#   deploy-pwa.sh rollback   remove the drop-in → restart → the sandbox tree's build is served again
#
# The build must exist first:  cd ~/Work/root-coord-pwa/pwa && npm run build
#                              && git -C .. checkout pwa/package.json pwa/package-lock.json
set -euo pipefail
UNIT=bifrost-sandbox
DROP="$HOME/.config/systemd/user/$UNIT.service.d/root-coord.conf"
TREE="$HOME/Work/root-coord-pwa/pwa"

probe() {
  local want="$1" got
  for _ in $(seq 1 40); do
    got=$(curl -s -m 3 http://127.0.0.1:8090/ | grep -oE '<!--[A-Za-z0-9_-]{21}-->' | head -1 | sed -E 's/^<!--(.*)-->$/\1/' || true)
    [ -n "$got" ] && break; sleep 0.5
  done
  echo "served build: ${got:-none} (expected $want)"
  [ "$got" = "$want" ]
  curl -s -m 5 -o /dev/null -w "/api/session %{http_code}\n" http://127.0.0.1:8090/api/session
  curl -s -m 5 -o /dev/null -w "/api/tree %{http_code}\n" http://127.0.0.1:8090/api/tree
}

case "${1:-}" in
apply)
  [ -f "$TREE/.next/BUILD_ID" ] || { echo "no build in $TREE/.next — build first"; exit 1; }
  mkdir -p "$(dirname "$DROP")"
  printf '[Service]\nWorkingDirectory=%s\n' "$TREE" > "$DROP"
  systemctl --user daemon-reload && systemctl --user restart "$UNIT"
  probe "$(cat "$TREE/.next/BUILD_ID")"
  ;;
rollback)
  rm -f "$DROP"
  systemctl --user daemon-reload && systemctl --user restart "$UNIT"
  probe "$(cat "$HOME/Work/bifrost-sandbox/pwa/.next/BUILD_ID")"
  ;;
*) echo "usage: $0 apply|rollback"; exit 2 ;;
esac
