#!/usr/bin/env bash
# verify-8447.sh — for a shell OUTSIDE the :8447 sandbox (the :8443 opencode, or a terminal on omarchy):
# deploy :8447's app from ~/Work/tree-next, then run the phone suites against it (Pixel 7 taps):
# e2e/terminal-sessions.spec.ts + e2e/cc-live.spec.ts + e2e/notify-per-session.spec.ts + e2e/list-order.spec.ts. The verdict is the last line: "== VERIFY: GREEN|RED".
#   setsid nohup bash ~/Work/root-coord/lab/root-sim/verify-8447.sh > ~/Work/root-coord/lab/root-sim/verify-8447.log 2>&1 < /dev/null &
set -uo pipefail
# a service's short PATH: the tools the suites drive (claude, agy, opencode, node) from mise / ~/.local/bin
for d in "$HOME/.local/bin" "$HOME/.local/share/mise/installs/node/latest/bin" "$HOME/.local/share/mise/installs/claude/latest" \
         "$HOME/.local/share/mise/installs/opencode/latest"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
echo "== deploy $(date +%T)"
bash "$HOME/Work/root-coord/lab/root-sim/preview-app-up.sh" || { echo "== VERIFY: RED (the deploy failed)"; exit 1; }
# the live helper too (lab/yggdrasil/cc-live): it tells the brain what is open in a terminal
bash "$HOME/Work/root-coord/lab/root-sim/cc-live-up.sh" || { echo "== VERIFY: RED (the live helper)"; exit 1; }
cd "$HOME/Work/tree-next/branch" || exit 1
export TS_CLAUDE=070d6b89-df88-495a-b061-1a0a80cfbea0 TS_AGY=1a289121-819e-47e3-b617-d9979520bf50 \
       TS_OC=ses_e1f017bdfffeE4rDioWgFH8kKN PW_BASE_URL=https://omarchy.tail5435b1.ts.net:8447
# full access (11-18): the box's enrollment code, for the toggle spec (reads owner.key, never in git)
[ -s "$HOME/.cache/root-sim/full-access/owner.key" ] && export TS_FA_CODE=$(cat "$HOME/.cache/root-sim/full-access/owner.key")
echo "== suites $(date +%T)"
TMPDIR=$HOME/.cache/tmp timeout 3600 npx playwright test e2e/terminal-sessions.spec.ts e2e/cc-live.spec.ts e2e/notify-per-session.spec.ts e2e/list-order.spec.ts e2e/full-access.spec.ts \
  --reporter=line --workers=1
rc=$?
# what the suites opened in "terminals" (tmux, script) must not outlive them
pkill -9 -f '[c]laude --resume 070d6b89' 2>/dev/null; pkill -9 -f '[a]gy --conversation 1a289121' 2>/dev/null
[ $rc = 0 ] && echo "== VERIFY: GREEN $(date +%T)" || echo "== VERIFY: RED (playwright exit $rc) $(date +%T)"
