#!/usr/bin/env bash
# ljoolq-provision.sh <sha> — provisions the VPS side of the test trunk (Incus, the trunk-ljoolq container and profile,
# Caddy phase 1; spec §10 V0). Step 1, always first: gate_check (trunk/deploy/gate-check.sh) — this checkout must be
# exactly <sha>, clean, with a complete green ~/.cache/trunk-v1/gates/<sha>.json. Anything else: refused.
# M0: provisioning is not built yet (OPS stream, M6). This script never contacts the VPS.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WT=$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null) || { echo "ljoolq-provision: not inside a git checkout" >&2; exit 1; }
# shellcheck source=gate-check.sh
. "$HERE/gate-check.sh"
[ $# -eq 1 ] || { echo "usage: $0 <sha>" >&2; exit 2; }
gate_check "$1" "$WT" || exit 1
echo "ljoolq-provision: not built yet (OPS stream, M6)"
exit 3
