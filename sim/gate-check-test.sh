#!/usr/bin/env bash
# gate-check-test.sh — G0.5: the refusal logic of trunk/deploy/gate-check.sh and the M0 VPS-step shells
# (ljoolq-up.sh, ljoolq-provision.sh), on SYNTHETIC gate files in a scratch git repo of its own.
# Never reads or writes the real ~/.cache/trunk-v1/gates (checked at the end). Never contacts anything:
# ssh/scp/rsync/curl/wget/incus/nc are shimmed on PATH and any call fails the run.
#
#   bash sim/gate-check-test.sh        exit 0 = every case PASS; one PASS/FAIL line per case
set -u
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BASE_TMP=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ladder}
mkdir -p "$BASE_TMP"
T=$(mktemp -d "$BASE_TMP/gate-check-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
REAL_GATES=$HOME/.cache/trunk-v1/gates
real_before=$(ls -la --time-style=+%s.%N "$REAL_GATES" 2>/dev/null | md5sum)
export V1_GATES_DIR=$T/gates
mkdir -p "$V1_GATES_DIR" "$T/shim"
for c in ssh scp rsync curl wget incus nc sftp; do
  printf '#!/bin/sh\necho "%s $*" >>"%s/shim/calls"\nexit 99\n' "$c" "$T" >"$T/shim/$c"
  chmod +x "$T/shim/$c"
done
export PATH="$T/shim:$PATH"
fails=0 n=0
pass() { n=$((n + 1)); echo "PASS $1"; }
fail() { n=$((n + 1)); fails=$((fails + 1)); echo "FAIL $1${2:+ — $2}"; }

# ---------------------------------------------------------------- a scratch repo holding the scripts under test
R=$T/repo
mkdir -p "$R/trunk/deploy" "$R/trunk/install"
cp "$SRC/trunk/deploy/gate-check.sh" "$SRC/trunk/deploy/ljoolq-up.sh" "$SRC/trunk/deploy/ljoolq-provision.sh" "$R/trunk/deploy/"
printf '#!/bin/sh\nexit 0\n' >"$R/trunk/install/trunk.sh"
echo one >"$R/file.txt"
g() { git -C "$R" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }
g init -q && g add -A && g commit -qm one
OLD=$(g rev-parse HEAD)
echo two >"$R/file.txt" && g commit -qam two
SHA=$(g rev-parse HEAD)

# a gate file: mkfile <name> <sha-in-file> [python statements mutating d]
mkfile() {
  python3 -I - "$V1_GATES_DIR/$1" "$2" "${3:-}" <<'PY'
import json, sys
path, sha, mut = sys.argv[1], sys.argv[2], sys.argv[3]
ids = "G0.1 G0.2 G0.3 G0.4 G0.5 G1.1 G1.2 G1.3 G2.1 G2.2 G2.3 G2.4 G3.1 G3.2 G3.3 G3.4 G3.5 G3.6 G3.7 G3.8 G3.9 G4.1 G4.2 G4.3 G4.4 G4.5 G4.6 G5.1 G5.2 G5.3 G5.4".split()
run = {"start": "2026-11-25T20:00:00Z", "end": "2026-11-25T20:01:00Z", "exit": 0, "counts": {"pass": 3, "fail": 0, "skip": 0}, "log": "/x.log"}
d = {"sha": sha, "tree_clean": True, "started": "2026-11-25T20:00:00Z", "ended": "2026-11-25T23:00:00Z", "host": "test",
     "ladder_version": "test", "partial": False, "mode": "v1",
     "gates": [{"id": i, "cmd": "true", "variant": "v1", "runs": [dict(run)] * (5 if i == "G3.6" else 1), "result": "GREEN"} for i in ids],
     "complete": True, "green": True}
G = {x["id"]: x for x in d["gates"]}
exec(mut)
open(path, "w").write(d if isinstance(d, str) else json.dumps(d))
PY
}
reset_files() { rm -f "$V1_GATES_DIR"/*; }

# expect_refused <case> <expected words in the reason> [gate_check args…] — the CLI, one REFUSED line, non-zero
expect_refused() {
  local name=$1 want=$2 out rc lines
  shift 2
  out=$(bash "$R/trunk/deploy/gate-check.sh" "$@" 2>&1); rc=$?
  lines=$(printf '%s\n' "$out" | grep -c .)
  if [ "$rc" -ne 0 ] && [ "$lines" = 1 ] && [[ "$out" == "gate-check: REFUSED "*"$want"* ]]; then pass "$name"
  else fail "$name" "rc=$rc out=$(printf '%s' "$out" | tr '\n' '|' | cut -c1-200)"; fi
}
# also as a function (sourced), in a subshell so a refusal cannot leak state
expect_refused_sourced() {
  local name=$1 out rc
  shift
  out=$( ( . "$R/trunk/deploy/gate-check.sh"; gate_check "$@" ) 2>&1 ); rc=$?
  if [ "$rc" -ne 0 ] && [[ "$out" == "gate-check: REFUSED "* ]]; then pass "$name (sourced)"; else fail "$name (sourced)" "rc=$rc $out"; fi
}

# ---------------------------------------------------------------- the cases
reset_files; mkfile "$SHA.json" "$SHA"
expect_refused "no arguments: usage" "usage"
expect_refused "a fake sha (not a commit here)" "is not a commit" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef "$R"
expect_refused "not a commit id at all" "is not a commit id" 'HEAD~1' "$R"
expect_refused "no worktree there" "no worktree" "$SHA" "$T/nowhere"
mkdir -p "$T/plain"
expect_refused "a folder that is not a git checkout" "not a git checkout" "$SHA" "$T/plain"
mkfile "$OLD.json" "$OLD"
expect_refused "worktree HEAD is another commit (an older, green one)" "worktree HEAD is" "$OLD" "$R"
expect_refused_sourced "worktree HEAD is another commit" "$OLD" "$R"

echo three >"$R/file.txt"
expect_refused "dirty tree: a modified tracked file" "not clean" "$SHA" "$R"
expect_refused_sourced "dirty tree" "$SHA" "$R"
g add file.txt
expect_refused "dirty tree: a staged change" "not clean" "$SHA" "$R"
g reset -q --hard
rm "$R/file.txt"
expect_refused "dirty tree: a deleted file" "not clean" "$SHA" "$R"
g checkout -q -- file.txt
touch "$R/stray.log"
expect_refused "an untracked file" "not clean" "$SHA" "$R"
mkdir -p "$R/sub/deep" && touch "$R/sub/deep/new.rs" && rm "$R/stray.log"
expect_refused "an untracked file in a new folder" "not clean" "$SHA" "$R"
rm -rf "$R/sub"
echo "*.ignored" >"$R/.git/info/exclude"; touch "$R/build.ignored"   # ignored build output is fine

reset_files
expect_refused "no gate file" "no gate file" "$SHA" "$R"
expect_refused_sourced "no gate file" "$SHA" "$R"
mkfile "$SHA.partial.json" "$SHA"
expect_refused "only a .partial.json (an --only run)" "no gate file" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$OLD"
expect_refused "gate file sha differs from <sha>" "is for" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd = "{\"sha\": "'
expect_refused "gate file does not parse" "does not parse" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd = []'
expect_refused "gate file is not an object" "no gates list" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd["complete"] = False'
expect_refused "incomplete file (complete: false)" "not complete" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'del d["complete"]'
expect_refused "complete absent" "not complete" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd["complete"] = "true"'
expect_refused "complete as a string, not true" "not complete" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd["partial"] = True'
expect_refused "a partial run under the full name" "partial run" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd["tree_clean"] = False'
expect_refused "the ladder ran on a dirty tree" "clean tree" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'G["G3.6"]["result"] = "RED"'
expect_refused "a RED gate" "gate G3.6 is RED" "$SHA" "$R"
expect_refused_sourced "a RED gate" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'G["G4.6"]["result"] = "MISSING"'
expect_refused "a MISSING gate" "gate G4.6 is MISSING" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'G["G1.1"]["result"] = "ERROR"'
expect_refused "an ERROR gate" "gate G1.1 is ERROR" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'G["G5.2"]["result"] = "SKIPPED"'
expect_refused "a SKIPPED gate" "gate G5.2 is SKIPPED" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'del G["G0.1"]["result"]'
expect_refused "a gate without a result" "gate G0.1 is None" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd["gates"].append(dict(G["G0.1"], result="RED"))'
expect_refused "a gate id twice, once RED" "gate G0.1 is RED" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd["gates"] = [x for x in d["gates"] if x["id"] != "G3.6"]'
expect_refused "a missing gate id (G3.6 absent)" "absent from the file: G3.6" "$SHA" "$R"
expect_refused_sourced "a missing gate id" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd["gates"] = [x for x in d["gates"] if not x["id"].startswith("G5")]'
expect_refused "the whole G5 tier absent" "G5.1 G5.2 G5.3 G5.4" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd["gates"] = []'
expect_refused "no gates at all" "absent from the file" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'G["G2.1"]["variant"] = "v09"'
expect_refused "a gate that ran the v0.9 baseline variant" "v09 variant" "$SHA" "$R"
reset_files; mkfile "$SHA.json" "$SHA" 'd["green"] = False'
expect_refused "green: false" "not green" "$SHA" "$R"

# the good file
reset_files; mkfile "$SHA.json" "$SHA"
out=$(bash "$R/trunk/deploy/gate-check.sh" "$SHA" "$R" 2>&1); rc=$?
[ $rc = 0 ] && [[ "$out" == "gate-check: OK ${SHA:0:12} — 31 gates GREEN"* ]] && pass "a complete green file: exit 0" || fail "a complete green file: exit 0" "rc=$rc $out"
out=$( ( . "$R/trunk/deploy/gate-check.sh"; gate_check "$SHA" "$R" ) 2>&1 ); rc=$?
[ $rc = 0 ] && pass "a complete green file: exit 0 (sourced)" || fail "a complete green file (sourced)" "rc=$rc $out"
out=$(bash "$R/trunk/deploy/gate-check.sh" "${SHA:0:12}" "$R" 2>&1); rc=$?
[ $rc = 0 ] && pass "a short sha resolves to the same file" || fail "a short sha resolves to the same file" "rc=$rc $out"
reset_files; mkfile "$SHA.json" "$SHA" 'd["gates"].append({"id": "G6.1", "result": "GREEN", "variant": "v1", "runs": []})'
out=$(bash "$R/trunk/deploy/gate-check.sh" "$SHA" "$R" 2>&1); rc=$?
[ $rc = 0 ] && pass "an extra (newer) GREEN gate does not refuse" || fail "an extra GREEN gate does not refuse" "rc=$rc $out"

# the M0 VPS-step shell still unbuilt (ljoolq-up): gate first; refusal stops before anything else; pass says not built yet, exit 3
reset_files; mkfile "$SHA.json" "$SHA"
for s in ljoolq-up; do
  out=$(bash "$R/trunk/deploy/$s.sh" "$SHA" 2>&1); rc=$?
  [ $rc = 3 ] && [[ "$out" == *"$s: not built yet (OPS stream, M6)"* ]] && [[ "$out" == "gate-check: OK"* ]] &&
    pass "$s.sh with a complete green file: gate OK, then 'not built yet', exit 3" || fail "$s.sh good file" "rc=$rc $out"
  touch "$R/stray.log"
  out=$(bash "$R/trunk/deploy/$s.sh" "$SHA" 2>&1); rc=$?
  [ $rc = 1 ] && [[ "$out" == "gate-check: REFUSED worktree is not clean"* ]] && [[ "$out" != *"not built yet"* ]] &&
    pass "$s.sh on a dirty tree: refused, stops before anything else" || fail "$s.sh dirty" "rc=$rc $out"
  rm -f "$R/stray.log"
  out=$(bash "$R/trunk/deploy/$s.sh" "$OLD" 2>&1); rc=$?
  [ $rc = 1 ] && [[ "$out" == *"REFUSED worktree HEAD is"* ]] && pass "$s.sh for a commit that is not checked out: refused" || fail "$s.sh other sha" "rc=$rc $out"
  out=$(bash "$R/trunk/deploy/$s.sh" 2>&1); rc=$?
  [ $rc = 2 ] && pass "$s.sh without a sha: usage, exit 2" || fail "$s.sh usage" "rc=$rc $out"
  mv "$V1_GATES_DIR/$SHA.json" "$T/held.json"
  out=$(bash "$R/trunk/deploy/$s.sh" "$SHA" 2>&1); rc=$?
  [ $rc = 1 ] && [[ "$out" == *"no gate file"* ]] && pass "$s.sh with no gate file: refused" || fail "$s.sh no file" "rc=$rc $out"
  mv "$T/held.json" "$V1_GATES_DIR/$SHA.json"
done
# the built OPS provisioning script (ljoolq-provision.sh): gate_check runs before anything reaches ssh/docker
out=$(TMPDIR="$T" LJOOLQ_SHOW=1 bash "$R/trunk/deploy/ljoolq-provision.sh" up "$SHA" 2>&1); rc=$?
[ $rc = 0 ] && [[ "$out" == *"gate-check: OK"* ]] && [[ "$out" == *"would run on ssh:veraldar as root:"* ]] &&
  pass "ljoolq-provision.sh up with a complete green file: gate OK (dry-run LJOOLQ_SHOW=1)" || fail "ljoolq-provision.sh good file" "rc=$rc $out"
touch "$R/stray.log"
out=$(TMPDIR="$T" bash "$R/trunk/deploy/ljoolq-provision.sh" up "$SHA" 2>&1); rc=$?
[ $rc = 1 ] && [[ "$out" == *"gate-check: REFUSED worktree is not clean"* ]] && [[ "$out" != *"would run"* ]] &&
  pass "ljoolq-provision.sh on a dirty tree: refused before any remote call" || fail "ljoolq-provision.sh dirty" "rc=$rc $out"
rm -f "$R/stray.log"
out=$(TMPDIR="$T" bash "$R/trunk/deploy/ljoolq-provision.sh" up "$OLD" 2>&1); rc=$?
[ $rc = 1 ] && [[ "$out" == *"REFUSED worktree HEAD is"* ]] && pass "ljoolq-provision.sh for another commit: refused" || fail "ljoolq-provision.sh other sha" "rc=$rc $out"
out=$(TMPDIR="$T" bash "$R/trunk/deploy/ljoolq-provision.sh" 2>&1); rc=$?
[ $rc = 64 ] && pass "ljoolq-provision.sh without a subcommand: usage, exit 64" || fail "ljoolq-provision.sh usage" "rc=$rc $out"
mv "$V1_GATES_DIR/$SHA.json" "$T/held.json"
out=$(TMPDIR="$T" bash "$R/trunk/deploy/ljoolq-provision.sh" up "$SHA" 2>&1); rc=$?
[ $rc = 1 ] && [[ "$out" == *"no gate file"* ]] && pass "ljoolq-provision.sh with no gate file: refused" || fail "ljoolq-provision.sh no file" "rc=$rc $out"
out=$(TMPDIR="$T" LJOOLQ_TEST_SKIP_GATE=1 bash "$R/trunk/deploy/ljoolq-provision.sh" up "$SHA" 2>&1); rc=$?
[ $rc = 1 ] && [[ "$out" == *"for a docker: rehearsal box only"* ]] && pass "ljoolq-provision.sh refuses LJOOLQ_TEST_SKIP_GATE=1 on ssh:veraldar" || fail "ljoolq-provision.sh skip-gate ssh" "rc=$rc $out"
mv "$T/held.json" "$V1_GATES_DIR/$SHA.json"
# the real scripts (not only the copies) are what was tested
for s in gate-check ljoolq-up ljoolq-provision; do
  cmp -s "$SRC/trunk/deploy/$s.sh" "$R/trunk/deploy/$s.sh" || fail "copy of $s.sh differs"
done
# no network, no VPS: no shimmed tool was called; no ssh/veraldar in gate-check or the unbuilt M0 shell's code lines
[ ! -s "$T/shim/calls" ] && pass "nothing tried ssh/scp/rsync/curl/wget/incus/nc" || fail "a network tool was called" "$(cat "$T/shim/calls")"
if grep -vE '^\s*#' "$SRC/trunk/deploy/ljoolq-up.sh" "$SRC/trunk/deploy/gate-check.sh" |
  grep -qE '\b(ssh|scp|rsync|curl|wget|incus|veraldar)\b'; then fail "gate-check / unbuilt M0 shell name a remote tool or the VPS in code"
else pass "gate-check and unbuilt M0 shell name no remote tool and no VPS host in code"; fi
real_after=$(ls -la --time-style=+%s.%N "$REAL_GATES" 2>/dev/null | md5sum)
[ "$real_before" = "$real_after" ] && pass "the real gates folder was not touched" || fail "the real gates folder changed during the test"

echo
if [ $fails = 0 ]; then echo "GATE-CHECK-TEST: GREEN ($n/$n PASS)"; exit 0; fi
echo "GATE-CHECK-TEST: RED ($fails of $n failed)"; exit 1
