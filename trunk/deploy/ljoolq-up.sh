#!/usr/bin/env bash
# ljoolq-up.sh <sha> — the ONLY way code reaches the test container trunk-ljoolq on the VPS (spec §2, §10).
# Step 1, always first: gate_check (trunk/deploy/gate-check.sh) — this checkout must be exactly <sha>, clean, with a
# complete green ~/.cache/trunk-v1/gates/<sha>.json. Anything else: refused, nothing touched.
# M0: the deploy itself is not built yet (OPS stream, M6). This script never contacts the VPS.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WT=$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null) || { echo "ljoolq-up: not inside a git checkout" >&2; exit 1; }
# shellcheck source=gate-check.sh
. "$HERE/gate-check.sh"
[ $# -eq 1 ] || { echo "usage: $0 <sha>" >&2; exit 2; }
gate_check "$1" "$WT" || exit 1
echo "ljoolq-up: not built yet (OPS stream, M6)"
exit 3
