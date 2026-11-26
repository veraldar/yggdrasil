#!/usr/bin/env bash
# s15-two-voice.sh <trunk url> <state dir> — the G3.6 step 15 hook (TRUNK_V1_S15_HELPER / PW_S15_HELPER
# in sim/trunk-v1-e2e.sh): two voice roots, each with its own LiveKit; a spoken turn reaches each
# through ONE trunk ICE-TCP port by dynamic ufrag registration (spec §5.7).
#
# It runs `sim/trunk-rtc-v1-e2e.sh --scenario two-voice` (sim/reach/two-voice-v1.mjs) in that rig's
# own namespaced world, from the same build: the G3.6 trunk (argument 1) is plain http on loopback
# with no :443 ICE route and no LiveKit, while two LiveKits behind one ICE-TCP port need the
# VPS-shaped world (sni-443's ICE route on :443, firewalled phone and roots, a byte tap). So the
# step claims and enrolls its own v1 trunk (`bifrost-net trunk`, claim-admin.py, enroll-root.py)
# and drives two phones: V3 (both talk at once, each root's MAIN hears its phone) + V4 (each
# LiveKit's ufrags registered by its own root only, routed, tcp :443) + V5 (each answer spoken).
#
# Exit 0 = GREEN. The last line is the summary G3.6 records. State + logs: <state dir>/s15.
# Takes ~3 min (two LiveKits, two agents, two speech servers start, then 90 s of driving).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
STATE_DIR=${2:?usage: $0 <trunk url> <state dir>}
OUT="$STATE_DIR/s15"
rm -rf "$OUT" && mkdir -p "$OUT"
t0=$(date +%s)
TRUNK_RTC_STATE="$OUT" bash "$ROOT/sim/trunk-rtc-v1-e2e.sh" --scenario two-voice >"$OUT/run.log" 2>&1
rc=$?
res() { awk -F'\t' -v s="$1" '$1==s{print $2}' "$OUT/steps.tsv" 2>/dev/null | tail -1; }
pass=$(awk -F'\t' '$2=="PASS"' "$OUT/steps.tsv" 2>/dev/null | wc -l)
all=$(wc -l <"$OUT/steps.tsv" 2>/dev/null || echo 0)
[ "$rc" = 0 ] || tail -n 25 "$OUT/run.log" >&2
echo "two voice roots on their own v1 trunk ($pass/$all PASS: V3 $(res V3), V4 $(res V4), V5 $(res V5); $(($(date +%s) - t0)) s; $OUT/run.log)"
exit "$rc"
