#!/usr/bin/env bash
# v1-ladder.sh — the trunk v1 ladder (spec rev 3 §9) on ONE clean commit, writing the gate file R2 is checked against.
#
#   sim/v1-ladder.sh <sha>                          every gate in sim/v1-gates.json → ~/.cache/trunk-v1/gates/<sha>.json
#   sim/v1-ladder.sh <sha> --only G0,G1.2 | --from G2.1     milestone checks → gates/<sha>.partial.json (never the full name)
#   sim/v1-ladder.sh <sha> --only G2,G3.1 --v09    the v0.9 versions of 'port' gates (the branch-point baseline; partial)
#   sim/v1-ladder.sh <sha> --skip G5.2             recorded SKIPPED: that file can never be complete
#   sim/v1-ladder.sh --show <gate file>            the table
#   --fresh: re-create the throwaway worktree · --no-wait: exit 75 at once when another run holds the lock
#
# What it does (details: sim/v1_ladder.py, the gate list: sim/v1-gates.json, the check: trunk/deploy/gate-check.sh):
#   flock ~/.cache/trunk-v1/ladder.lock · git worktree add --detach ~/.cache/trunk-v1/wt/<sha> (reused when it is
#   there: reset --hard + clean to exactly <sha>; build caches reflinked in from ~/Work/trunk-v1 or another
#   checkout) · cargo build --release in root/ and trunk/, npm run build in branch/ (its version stamp put back) ·
#   every gate in order, logs under gates/<sha>/, the file rewritten after each gate · rig leftovers (transient
#   units, docker containers the gate names) stopped by exact name, also on failure · TMPDIR under
#   ~/.cache/trunk-v1/tmp/ladder · brain sims on --port-base 18700 (ports 18700-18799) · twin gates under twin.lock.
# Exit 0 = the full file is green (or every gate of a partial run is GREEN); 1 = not; 2 = bad commit; 75 = locked.
set -euo pipefail
mkdir -p "$HOME/.cache/trunk-v1/tmp/ladder"
export TMPDIR="$HOME/.cache/trunk-v1/tmp/ladder"
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/v1_ladder.py" "$@"
