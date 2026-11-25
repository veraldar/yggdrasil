#!/usr/bin/env bash
# gate-check.sh — spec R2, made mechanical (trunk v1 spec rev 3 §2 "How R2 is enforced mechanically", §9 gate rules).
# Every script that changes anything on the VPS (ljoolq-up.sh, ljoolq-provision.sh, the sni-443 v2 install,
# hub-units.sh switch-v1 / rollback-v0) runs this FIRST and stops unless it passes.
#
#   source trunk/deploy/gate-check.sh; gate_check <sha> <worktree> || exit 1
#   trunk/deploy/gate-check.sh <sha> <worktree>          (the same, as a command)
#
# Passes (exit 0, one "gate-check: OK …" line) only when ALL of these hold; otherwise one "gate-check: REFUSED …"
# line on stderr and exit 1:
#   - <worktree> is a git checkout whose HEAD is exactly <sha> (a short sha is resolved there first)
#   - the worktree is clean: no modified, staged, deleted or untracked file (ignored build output is fine)
#   - ~/.cache/trunk-v1/gates/<full sha>.json exists (never a .partial.json) and parses
#   - its "sha" is <sha>, "complete" is true, "green" is true, "partial" is not true, "tree_clean" is true
#   - every gate in it is GREEN, ran the v1 commands (not a --v09 baseline variant),
#     and every gate id §9 lists (REQUIRED below) is present
# V1_GATES_DIR moves the gates folder (the refusal tests only; the default is the only real one).
# Needs: git, python3 (reads the JSON; nothing else is run).

GATE_CHECK_REQUIRED="G0.1 G0.2 G0.3 G0.4 G0.5
G1.1 G1.2 G1.3
G2.1 G2.2 G2.3 G2.4
G3.1 G3.2 G3.3 G3.4 G3.5 G3.6 G3.7 G3.8 G3.9
G4.1 G4.2 G4.3 G4.4 G4.5 G4.6
G5.1 G5.2 G5.3 G5.4"

gate_check() {
  local sha=${1:-} wt=${2:-} dir full head dirty file why
  _gc_no() { echo "gate-check: REFUSED $1" >&2; return 1; }
  [ -n "$sha" ] && [ -n "$wt" ] || { _gc_no "usage: gate_check <sha> <worktree>"; return 1; }
  [[ "$sha" =~ ^[0-9a-fA-F]{4,40}$ ]] || { _gc_no "'$sha' is not a commit id"; return 1; }
  [ -d "$wt" ] || { _gc_no "no worktree at $wt"; return 1; }
  head=$(git -C "$wt" rev-parse --verify --quiet HEAD 2>/dev/null) || { _gc_no "$wt is not a git checkout"; return 1; }
  full=$(git -C "$wt" rev-parse --verify --quiet "$sha^{commit}" 2>/dev/null) ||
    { _gc_no "$sha is not a commit in $wt"; return 1; }
  [ "$head" = "$full" ] || { _gc_no "worktree HEAD is ${head:0:12}, not ${full:0:12} ($wt)"; return 1; }
  dirty=$(git -C "$wt" status --porcelain --untracked-files=all 2>&1) ||
    { _gc_no "git status failed in $wt"; return 1; }
  [ -z "$dirty" ] || { _gc_no "worktree is not clean: $(printf '%s' "$dirty" | head -3 | tr '\n' ';' | cut -c1-160) ($wt)"; return 1; }
  dir=${V1_GATES_DIR:-$HOME/.cache/trunk-v1/gates}
  file=$dir/$full.json
  [ -f "$file" ] || { _gc_no "no gate file for ${full:0:12}: $file (run sim/v1-ladder.sh $full)"; return 1; }
  why=$(python3 -I - "$file" "$full" "$GATE_CHECK_REQUIRED" <<'PY'
import json, sys
path, sha, required = sys.argv[1], sys.argv[2], sys.argv[3].split()
try:
    d = json.load(open(path))
except (OSError, ValueError) as e:
    print(f"the gate file does not parse ({type(e).__name__})"); sys.exit(1)
if not isinstance(d, dict) or not isinstance(d.get("gates"), list):
    print("the gate file has no gates list"); sys.exit(1)
if d.get("sha") != sha:
    print(f"the gate file is for {str(d.get('sha'))[:12]}, not {sha[:12]}"); sys.exit(1)
if d.get("partial") is not False and d.get("partial") is not None:
    print("the gate file is a partial run (--only/--from/--v09)"); sys.exit(1)
if d.get("complete") is not True:
    print("the gate file is not complete (complete: %s)" % json.dumps(d.get("complete"))); sys.exit(1)
if d.get("tree_clean") is not True:
    print("the ladder did not run on a clean tree (tree_clean: %s)" % json.dumps(d.get("tree_clean"))); sys.exit(1)
seen = {}
for g in d["gates"]:
    if not isinstance(g, dict) or not isinstance(g.get("id"), str):
        print("a gate entry has no id"); sys.exit(1)
    seen.setdefault(g["id"], []).append(g)
missing = [r for r in required if r not in seen]
if missing:
    print("gate(s) absent from the file: " + " ".join(missing)); sys.exit(1)
for gid, gs in seen.items():
    for g in gs:
        if g.get("result") != "GREEN":
            print(f"gate {gid} is {g.get('result')}" + (f" ({str(g.get('reason'))[:80]})" if g.get("reason") else "")); sys.exit(1)
        if g.get("variant", "v1") != "v1":
            print(f"gate {gid} ran the {g.get('variant')} variant, not v1"); sys.exit(1)
if d.get("green") is not True:
    print("the gate file is not green (green: %s)" % json.dumps(d.get("green"))); sys.exit(1)
print(f"{len(seen)} gates GREEN, ladder {d.get('ladder_version')}, ended {d.get('ended')}")
PY
  ) || { _gc_no "${why:-the gate file could not be read}"; return 1; }
  echo "gate-check: OK ${full:0:12} — $why ($file)"
  return 0
}

# as a command (not when sourced)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ $# -eq 2 ] || { echo "gate-check: REFUSED usage: $0 <sha> <worktree>" >&2; exit 2; }
  gate_check "$1" "$2"
  exit $?
fi
