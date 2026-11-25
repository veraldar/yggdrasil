#!/usr/bin/env bash
# sim/hub-units-dryrun-diff.sh — proof for spec §3.3 W1: scripts/hub-units.sh's existing subcommands behave byte for
# byte as tree-next's copy when no override is set (and when every override is set to its default).
#
#   sim/hub-units-dryrun-diff.sh [OLD]     OLD = the copy to compare with (default: git show tree-next:scripts/hub-units.sh)
#
# Both copies run, one after the other, in the same throwaway HOME (a fake hub: releases, current, state, conf, data)
# from the same fake tree path, with every command that would act on the machine replaced by a logging stand-in
# (systemctl, systemd-run, loginctl, curl, git, date, sleep, ss, the backup script): nothing real is started,
# stopped, fetched or written outside the sandbox. Per case (render, health ok / failing, status, release, deploy
# ok / failing / one unit / a bad unit / no id / detached, rollback, wg-on --dry, a bad command) it compares
# stdout + stderr + exit code, every logged command line, and every file in the sandbox (path, mode, sha256, link
# target). exit 0 = identical in every case.
set -uo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
export TMPDIR=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ops}
SB=$TMPDIR/hub-dry/$(date +%Y%m%d-%H%M%S)
mkdir -p "$SB"
NEW=$ROOT/scripts/hub-units.sh
OLD=${1:-$SB/old-hub-units.sh}
if [ -z "${1:-}" ]; then git -C "$ROOT" show tree-next:scripts/hub-units.sh >"$OLD" || { echo "git show tree-next:scripts/hub-units.sh failed"; exit 2; }; fi
echo "old: ${1:-tree-next:scripts/hub-units.sh} ($(sha256sum <"$OLD" | cut -c1-12)) · new: $NEW ($(sha256sum <"$NEW" | cut -c1-12)) · sandbox $SB"

# ── the stand-ins ────────────────────────────────────────────────────────────────────────────────────────
SHIM=$SB/shim && mkdir -p "$SHIM"
log_line='{ printf "%s" "$(basename "$0")"; for a in "$@"; do printf " %q" "$a"; done; printf "\n"; } >>"$DRY_LOG"'
cat >"$SHIM/systemctl" <<EOF
#!/bin/bash
$log_line
# --user is-active|is-enabled [-q] UNIT: from the scenario's lists; everything else succeeds
args=("\$@"); [ "\${args[0]}" = --user ] && args=("\${args[@]:1}")
case "\${args[0]}" in
  is-active|is-enabled)
    q=0; u=\${args[1]}; [ "\$u" = -q ] && { q=1; u=\${args[2]}; }
    f=\$DRY_STATE/\${args[0]#is-}
    if grep -qx "\$u" "\$f" 2>/dev/null; then [ \$q = 1 ] || { [ "\${args[0]}" = is-active ] && echo active || echo enabled; }; exit 0; fi
    [ \$q = 1 ] || { [ "\${args[0]}" = is-active ] && echo inactive || echo disabled; }; exit 1 ;;
esac
# the scenario follows what was done: start/restart → active, stop → inactive, enable/disable (+ --now)
verb=\${args[0]}; now=0; units=()
for a in "\${args[@]:1}"; do case \$a in --now) now=1 ;; -*) ;; *) units+=("\$a") ;; esac; done
add() { grep -qx "\$2" "\$DRY_STATE/\$1" 2>/dev/null || echo "\$2" >>"\$DRY_STATE/\$1"; }
del() { grep -vx "\$2" "\$DRY_STATE/\$1" >"\$DRY_STATE/\$1.t" 2>/dev/null; mv "\$DRY_STATE/\$1.t" "\$DRY_STATE/\$1"; }
for u in "\${units[@]}"; do
  case \$verb in
    start|restart) add active "\$u" ;; stop) del active "\$u" ;;
    enable) add enabled "\$u"; [ \$now = 1 ] && add active "\$u" ;;
    disable) del enabled "\$u"; [ \$now = 1 ] && del active "\$u" ;;
  esac
done
exit 0
EOF
cat >"$SHIM/curl" <<EOF
#!/bin/bash
$log_line
url='' w=''
while [ \$# -gt 0 ]; do case \$1 in http*://*) url=\$1 ;; -w) w=\$2; shift ;; esac; shift; done
if [ "\$(cat "\$DRY_STATE/curl" 2>/dev/null)" = fail ]; then [ -n "\$w" ] && printf '000'; exit 7; fi
case \$url in
  */root) echo '{"name":"omarchy","version":"x"}' ;;
  */session) echo '[{"title":"[MAIN]"}]' ;;
  */extensions) echo '[{"name":"librarian","up":true}]' ;;
  */api/token) echo '{"available":true}' ;;
  */api/build) echo '{"build":"stub"}' ;;
  */admin/drain) echo '{"drained":true}' ;;
esac
[ -n "\$w" ] && printf '200'
exit 0
EOF
for c in systemd-run loginctl ss; do printf '#!/bin/bash\n%s\nexit 0\n' "$log_line" >"$SHIM/$c"; done
printf '#!/bin/bash\n%s\nexit 0\n' "$log_line" >"$SHIM/sleep"
cat >"$SHIM/date" <<EOF
#!/bin/bash
$log_line
case "\${1:-}" in
  +%Y%m%d-%H%M) echo 20261125-1200 ;; +%Y%m%d-%H%M%S) echo 20261125-120000 ;; +%s) echo 1764072000 ;;
  +%s%3N) echo 1764072000000 ;; -Is) echo 2026-11-25T12:00:00+01:00 ;; *) echo "date-stub \$*" ;;
esac
EOF
cat >"$SHIM/git" <<EOF
#!/bin/bash
$log_line
case "\$*" in
  *"rev-parse --short=8 HEAD"*) echo abcdef12 ;;
  *"rev-parse HEAD"*) echo abcdef1234567890abcdef1234567890abcdef12 ;;
  *"ls-files -z branch/voice"*) printf 'branch/voice/agent.py\0branch/voice/pyproject.toml\0' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$SHIM"/*

# ── the fake hub (a template; each run starts from a fresh copy at the same path) ─────────────────────────
T=$SB/template
H=$T/home
mk() { mkdir -p "$(dirname "$1")"; printf '%s\n' "${2:-x}" >"$1"; }
for r in R1 R2; do
  d=$H/.local/share/yggdrasil/hub/releases/$r
  mk "$d/bin/yggdrasil" '#!/bin/sh'; mk "$d/bin/bifrost-net" '#!/bin/sh'; chmod +x "$d/bin/"*
  mk "$d/scripts/trunk-report.py" '# stub'; mk "$d/BUILD" "id=$r"
done
ln -s "$H/.local/share/yggdrasil/hub/releases/R1" "$H/.local/share/yggdrasil/hub/current"
for f in devices.json roots.json bridge-dtls.json; do mk "$H/.local/share/yggdrasil/hub/state/$f" '{}'; done
mk "$H/.local/share/yggdrasil/hub/state/voice-venv/bin/python" '#!/bin/sh'
C=$H/.config/yggdrasil/hub
mk "$C/app-public.env" $'PORT=4502\nBIFROST_AUTH=devices'; mk "$C/app-tailnet.env" $'PORT=8101\nBIFROST_AUTH=tailnet\nAGENT_NAME=bifrost-hub'
mk "$C/brain.env" 'YGG_ROOT_NAME=omarchy'; mk "$C/voice-agent.env" 'AGENT_LOAD=off'
mk "$C/bridge-public.toml" $'[ap]\nurl = "wss://ap.example/ap"\n\n[bridge.root-link]\nlisten = "127.0.0.1:4504"'
mk "$C/wg-hub.toml" '[wg]'; mk "$C/wg-hub.key" 'k'; mk "$C/wg-hub.key.pub" 'p'
mk "$H/.cache/root-sim/preview/data/session/ses_1.json" '{}'; mk "$H/.cache/root-sim/preview/agents.json" '{}'
mk "$H/.cache/root-sim/cc-live.token" 't'
mkdir -p "$H/.config/systemd/user" "$H/.cache/root-sim/backups/B1"
tar -C "$H/.cache/root-sim/preview" -czf "$H/.cache/root-sim/backups/B1/sessions.tgz" data/session
cp "$H/.cache/root-sim/preview/agents.json" "$H/.cache/root-sim/backups/B1/agents.json"
mk "$H/Work/tree-next/scripts/preview-backup.sh" '#!/bin/bash
echo "preview-backup.sh $*" >>"$DRY_LOG"
b=$HOME/.cache/root-sim/backups/20261125-120000
mkdir -p "$b" && tar -C "$HOME/.cache/root-sim/preview" -czf "$b/sessions.tgz" data/session && cp "$HOME/.cache/root-sim/preview/agents.json" "$b/"
echo "backup: $b (stub)"'
chmod +x "$H/Work/tree-next/scripts/preview-backup.sh"
TR=$T/tree
for f in root/target/release/yggdrasil trunk/target/release/bifrost-net branch/.next/standalone/server.js branch/.next/static/chunk.js \
         branch/public/sw.js branch/artifacts-builtin/a.html branch/server.mjs root/extensions/librarian/librarian.py \
         root/cc-live/cc_live.py scripts/trunk-report.py branch/voice/agent.py branch/voice/pyproject.toml; do mk "$TR/$f" "# $f"; done
chmod +x "$TR/root/target/release/yggdrasil" "$TR/trunk/target/release/bifrost-net"
mk "$TR/branch/.next/BUILD_ID" 'build-stub'
mkdir -p "$T/state"

# ── one run: COPY CASE [ENV…] -- ARGS… ────────────────────────────────────────────────────────────────────
RUN=$SB/run
run_case() { # WHICH COPY CASE ACTIVE ENABLED CURL ENV… -- ARGS…
  local which=$1 copy=$2 case=$3 active=$4 enabled=$5 curl=$6 out=$SB/out/$3.$1; shift 6
  local envs=()
  while [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  rm -rf "$RUN" && cp -a "$T" "$RUN"
  # symlinks in the template point into $T: re-aim them at the run copy (same relative layout)
  ln -sfn "$RUN/home/.local/share/yggdrasil/hub/releases/R1" "$RUN/home/.local/share/yggdrasil/hub/current"
  cp "$copy" "$RUN/tree/scripts/hub-units.sh" && chmod +x "$RUN/tree/scripts/hub-units.sh"
  tr ' ' '\n' <<<"$active" >"$RUN/state/active"; tr ' ' '\n' <<<"$enabled" >"$RUN/state/enabled"; echo "$curl" >"$RUN/state/curl"
  mkdir -p "$SB/out"
  : >"$RUN/calls.log"
  (cd "$RUN" && env -i PATH="$SHIM:/usr/bin:/bin" HOME="$RUN/home" DRY_LOG="$RUN/calls.log" DRY_STATE="$RUN/state" \
     "${envs[@]}" bash "$RUN/tree/scripts/hub-units.sh" "$@" >"$out.stdout" 2>"$out.stderr"; echo "exit $?" >"$out.rc")
  # the detached unit's name carries the shell's PID: the one value that differs run to run
  sed -E 's/(units-[a-z0-9-]+-1764072000-)[0-9]+/\1PID/g' "$RUN/calls.log" >"$out.calls"
  sed -i -E 's/(units-[a-z0-9-]+-1764072000-)[0-9]+/\1PID/g' "$out.stdout" "$out.stderr"
  (cd "$RUN" && find . -path ./calls.log -prune -o -path ./tree/scripts/hub-units.sh -prune -o -printf '%y %m %p\n' | LC_ALL=C sort |
     while read -r y m p; do case $y in f) echo "$y $m $p $(sha256sum <"$p" | cut -c1-16)" ;; l) echo "$y $p -> $(readlink "$p")" ;; *) echo "$y $m $p" ;; esac; done) >"$out.files"
}
ALLU="hub-brain hub-librarian hub-cclive hub-voice-agent hub-app hub-app-tailnet hub-bridge hub-wg"
DEF=(HUB_HOME="$RUN/home/.local/share/yggdrasil/hub" HUB_CONF="$RUN/home/.config/yggdrasil/hub" HUB_UNITS="$RUN/home/.config/systemd/user"
     HUB_PREFIX=hub HUB_BRAIN_PORT=4101 HUB_LIBRARIAN_PORT=4310 HUB_CCLIVE_PORT=4320 HUB_TAILNET_PORT=8101 HUB_PUBLIC_PORT=4502
     HUB_VOICE_PORT=18084 HUB_WG_HTTP=4506 HUB_WG_UDP=4507 HUB_WG_RELAY=4508 HUB_SIM="$RUN/home/.cache/root-sim"
     HUB_BACKUP="$RUN/home/Work/tree-next/scripts/preview-backup.sh" HUB_AP_URL=https://ap.veraldar.org)
BK=$RUN/home/.cache/root-sim/backups/B1
CASES=(
  "render|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|render"
  "health-ok|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|health"
  "health-fail|$ALLU|$ALLU|fail|HUB_UNITS_DETACHED=1|health"
  "health-no-wg|$ALLU| |ok|HUB_UNITS_DETACHED=1|health"
  "status|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|status"
  "release|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|release"
  "deploy-ok|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|deploy R2"
  "deploy-fail|$ALLU|$ALLU|fail|HUB_UNITS_DETACHED=1|deploy R2"
  "deploy-one-unit|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|deploy R2 hub-voice-agent"
  "deploy-bad-unit|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|deploy R2 hub-nope"
  "deploy-no-release|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|deploy R9"
  "deploy-detached|$ALLU|$ALLU|ok|X_DRY=1|deploy R2"
  "rollback|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|rollback R1 $BK"
  "rollback-no-backup|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|rollback R1 /nonexistent"
  "wg-on-dry| |$ALLU|ok|HUB_UNITS_DETACHED=1|wg-on --dry"
  "bad-command|$ALLU|$ALLU|ok|HUB_UNITS_DETACHED=1|frobnicate"
)
fails=0 n=0
for c in "${CASES[@]}"; do
  IFS='|' read -r name active enabled curl env args <<<"$c"
  # shellcheck disable=SC2086
  run_case old "$OLD" "$name" "$active" "$enabled" "$curl" $env -- $args
  # shellcheck disable=SC2086
  run_case new "$NEW" "$name" "$active" "$enabled" "$curl" $env -- $args
  for v in plain defaults; do
    # set explicitly, the overrides ride along into a detached run (--setenv): that one case is plain only
    [ $v = defaults ] && [ "$name" = deploy-detached ] && continue
    n=$((n + 1))
    if [ $v = defaults ]; then
      # shellcheck disable=SC2086
      run_case new "$NEW" "$name" "$active" "$enabled" "$curl" $env "${DEF[@]}" -- $args
    fi
    d=$(for k in rc stdout stderr calls files; do diff -u "$SB/out/$name.old.$k" "$SB/out/$name.new.$k" >"$SB/out/$name.$v.$k.diff" || echo "$k"; done)
    lines=$(cat "$SB/out/$name.old.calls" | wc -l)
    label=$name; [ $v = defaults ] && label="$name, every override set to its default"
    if [ -z "$d" ]; then
      echo "PASS $label: identical — $(cat "$SB/out/$name.old.rc"), $lines command lines, $(wc -l <"$SB/out/$name.old.files") files"
    else
      fails=$((fails + 1)); echo "FAIL $name ($v): differs in: $d  (diffs: $SB/out/$name.$v.*.diff)"
    fi
  done
done
# the control: one character changed in a unit file must be caught
sed 's/^RestartSec=3$/RestartSec=4/' "$NEW" >"$SB/mutant.sh"
run_case old "$OLD" control "$ALLU" "$ALLU" ok HUB_UNITS_DETACHED=1 -- render
run_case new "$SB/mutant.sh" control "$ALLU" "$ALLU" ok HUB_UNITS_DETACHED=1 -- render
if diff -q "$SB/out/control.old.files" "$SB/out/control.new.files" >/dev/null; then
  fails=$((fails + 1)); echo "FAIL control: a changed RestartSec in the unit files went unseen — the comparison is blind"
else
  echo "PASS control: a one-character change (RestartSec=3 → 4) in the rendered units is caught"
fi
echo "hub-units dry-run diff: $((n - fails)) identical, $fails differ (of $n runs) · $SB"
[ "$fails" = 0 ] && { echo "VERDICT: GREEN"; exit 0; }
echo "VERDICT: RED"; exit 1
