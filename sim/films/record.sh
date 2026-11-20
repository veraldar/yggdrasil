#!/usr/bin/env bash
# record.sh [OUT] — record the site's films and cut them: one command, the same films every time.
#   sim/films/record.sh                 → ~/.cache/p5-films/<date-time>/{talk,tree,file}.{mp4,webm,jpg} + -sheet.jpg
#   FILMS_ONLY=talk sim/films/record.sh    one film
# The world is sim/trunk-rtc-e2e.sh --scenario films (private namespaces: nothing live is touched).
# Needs what that rig needs: this tree's root/target/release/yggdrasil, trunk/target/release/bifrost-net,
# branch built (npm run build), ~/.cache/trunk-rtc (sim/trunk-rtc/setup.sh), ffmpeg.
# Exit 0 = every film recorded AND passed cut.py's checks. Then look at each <name>-sheet.jpg by eye.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-$HOME/.cache/p5-films/$(date +%m%d-%H%M%S)}
mkdir -p "$OUT/state"
echo "films → $OUT"
rc=0
FILMS_OUT="$OUT" TRUNK_RTC_STATE="$OUT/state" nice -n 10 "$ROOT/sim/trunk-rtc-e2e.sh" --scenario films >"$OUT/rig.log" 2>&1 || rc=$?
grep -E '^(PASS|FAIL|F0|talk|tree|file|TRUNK-RTC|STEP)|↳|·' "$OUT/rig.log" | tail -30 || true
ls "$OUT"/*.json >/dev/null 2>&1 || { echo "nothing was recorded — $OUT/rig.log"; exit 1; }
nice -n 10 python3 -I "$ROOT/sim/films/cut.py" "$OUT" || rc=1
echo "rig+cut exit $rc — films in $OUT"
exit $rc
