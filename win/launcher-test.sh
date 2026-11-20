#!/usr/bin/env bash
# launcher-test.sh — Veraldar-Setup-<version>.exe under wine, in its own window (Xvfb, driven with xdotool), with a
# FAKE wsl.exe (win/test/fake-wsl.c) that records every call and answers per case from a scenario file. Its
# "-e bash wsl-bootstrap.sh …" calls run the REAL wsl-bootstrap.sh as a Unix process, with win/test/fake-join.sh
# as join.sh: the step codes come out of the real classification, the code and the QR BMP out of the real
# bootstrap. One case per step code (W-OS, W-WSL x2, W-NET, W-SIG, W-JOIN x4, W-MODEL, W-RUN), success, the
# restart + /continue path, a non-Debian default distribution, a mistyped address, Cancel while waiting, the
# report's masking, keepalive.vbs -> launcher.bat, the uninstaller.
# What it cannot prove: real WSL, UAC, RunOnce after a real restart, SmartScreen, Windows' own fonts (see NOTES-win.md).
#
#   win/launcher-test.sh [EXE] [--join FILE] [--shots DIR]
#     EXE      Veraldar-Setup-<version>.exe (the version is taken from its name); default: built now with
#              scripts/build-win.sh 0.9.1 and the tree's join.sh
#     --join   the join.sh the exe must embed byte for byte (default: the tree's root/install/join.sh; a release's
#              exe: dist/<version>/join.sh, the stamped one)
#     --shots  a PNG of each screen (win-installer-<screen>.png) into DIR
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
EXE='' SHOTS='' JOINSH=$REPO/root/install/join.sh
while [ $# -gt 0 ]; do
  case $1 in
    --shots) SHOTS=$(mkdir -p "$2" && cd "$2" && pwd); shift ;;
    --join) JOINSH=${2:?--join FILE}; shift ;;
    *) EXE=$1 ;;
  esac
  shift
done
IMAGE=${WINE_IMAGE:-veraldar-wine-test:local}
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building $IMAGE (wine + mingw + imagemagick + xdotool)" >&2
  docker build -q -t "$IMAGE" - >/dev/null <<'EOF'
FROM veraldar-wine-check:local
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    gcc-mingw-w64-x86-64 imagemagick xdotool python3 >/dev/null && rm -rf /var/lib/apt/lists/*
EOF
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if [ -z "$EXE" ]; then EXE=$("$REPO/scripts/build-win.sh" 0.9.1 "$REPO/root/install/join.sh" "$TMP"); fi
EXE=$(cd "$(dirname "$EXE")" && pwd)/$(basename "$EXE")
VERSION=$(basename "$EXE" | sed -n 's/^Veraldar-Setup-\([0-9][0-9A-Za-z.+-]*\)\.exe$/\1/p')
[ -n "$VERSION" ] || { echo "launcher-test: $EXE is not named Veraldar-Setup-<version>.exe" >&2; exit 64; }
[ -f "$JOINSH" ] || { echo "launcher-test: no join.sh at $JOINSH" >&2; exit 64; }
JOINSH=$(cd "$(dirname "$JOINSH")" && pwd)/$(basename "$JOINSH")
echo "testing $(basename "$EXE") (version $VERSION), expecting it to embed $JOINSH"
SHOTARGS=(); [ -n "$SHOTS" ] && SHOTARGS=(-v "$SHOTS:/shots")

INNER=$(cat <<'INNER'
set -u
export WINEPREFIX=/tmp/wp WINEDEBUG=-all DISPLAY=:99
Xvfb :99 -screen 0 1024x768x24 >/dev/null 2>&1 &
x86_64-w64-mingw32-gcc -O2 -o /tmp/wsl.exe /repo/win/test/fake-wsl.c || { echo "fake wsl.exe: build failed"; exit 1; }
wineboot -i >/dev/null 2>&1 </dev/null
cp /tmp/wsl.exe $WINEPREFIX/drive_c/windows/system32/wsl.exe
mkdir -p $WINEPREFIX/drive_c/fake /tmp/www && echo pong >/tmp/www/root
python3 -m http.server 4180 --bind 127.0.0.1 --directory /tmp/www >/dev/null 2>&1 &   # the root's brain, for "ok"
U=$WINEPREFIX/drive_c/users/root
I=$U/AppData/Local/Veraldar
UI=$WINEPREFIX/dosdevices/c:/users/root/AppData/Local/Veraldar    # the install folder, as the fake's wslpath gives it
STARTUP="$U/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/StartUp"   # wine's spelling
CALLS=$WINEPREFIX/drive_c/wsl-calls.txt
pass=0 fail=0
check() { # NAME STATUS
  if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  PASS  $1"
  else fail=$((fail + 1)); echo "  FAIL  $1"; tail -n 8 "$I/setup.log" 2>/dev/null | tr -d '\r'; tail -n 4 "$CALLS" 2>/dev/null; fi
}
reset() { # a clean PC for the next case
  [ -f /tmp/inst.rc ] || [ -z "$(win)" ] || { wineserver -k; sleep 1; }   # a case that failed half-way: its windows go
  rm -rf "$I" $WINEPREFIX/drive_c/fake/state.ini "$CALLS" /tmp/wslhome /tmp/fakewsl "$STARTUP/Veraldar.lnk" \
    "$U/AppData/Local/Microsoft/WindowsApps/ubuntu.exe" /tmp/inst.rc
  wine reg delete 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Veraldar' /f >/dev/null 2>&1
  wine reg delete 'HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce' /v Veraldar /f >/dev/null 2>&1
}
scenario() { { printf '[wsl]\r\n'; for kv in "$@"; do printf '%s\r\n' "$kv"; done; } >$WINEPREFIX/drive_c/fake/scenario.ini; }
start() { rm -f /tmp/inst.rc; (wine "$@" >/dev/null 2>&1 </dev/null; echo $? >/tmp/inst.rc) & }
wait_log() { local i; for i in $(seq 1 $((${2:-90} * 5))); do grep -qF -- "$1" "$I/setup.log" 2>/dev/null && return 0; sleep 0.2; done; return 1; }
win() { xdotool search --onlyvisible --name "${1:-Veraldar}" 2>/dev/null | tail -n 1; }
wait_win() { local i; for i in $(seq 1 150); do [ -n "$(win "$@")" ] && return 0; sleep 0.2; done; return 1; }
key() { local w; w=$(win); [ -n "$w" ] || return 1; xdotool windowfocus "$w" 2>/dev/null; sleep 0.3; xdotool key "$@"; }
typein() { local w; w=$(win); xdotool windowfocus "$w" 2>/dev/null; sleep 0.2; xdotool key Home shift+End BackSpace; xdotool type --delay 20 "$1"; }
click_cancel() { # the Cancel button: 58 px from the right, 23 from the bottom of the window
  local w g W H; w=$(win); eval "$(xdotool getwindowgeometry --shell "$w")"
  xdotool mousemove --window "$w" $((WIDTH - 58)) $((HEIGHT - 23)) click 1
}
wait_exit() { local i; for i in $(seq 1 150); do [ -f /tmp/inst.rc ] && return 0; sleep 0.2; done; return 1; }
shot() { [ -d /shots ] || return 0; sleep 0.6; local w; w=$(win "${2:-Veraldar}"); [ -n "$w" ] && import -window "$w" "/shots/win-installer-$1.png" 2>/dev/null; }
report() { tr -d '\r' <"$I/install-report.txt" 2>/dev/null; }
result() { report | sed -n 's/^result: *//p'; }
calls() { tr -d '\r' <"$CALLS" 2>/dev/null; }
J() { printf -- '-d | %s | -u | %s | -e | bash | %s/wsl-bootstrap.sh | --hub | %s | --name | TESTPC | --out | %s' "$1" "$2" "$UI" "${3:-https://ap.veraldar.org}" "$UI"; }
KEEP='-e | sh | -c | s=$HOME/.local/share/yggdrasil-root/bin/start; [ -x $s ] && exec $s --hold'
STOP='-e | sh | -c | s=$HOME/.local/share/yggdrasil-root/bin/stop; [ -x $s ] && $s'
flow() { # JOIN-MODE [SHOT] [scenario...]: a whole install through the address page to the last page
  local mode=$1 name=${2:-}; shift 2
  reset; scenario default=ok "join=$mode" wait=2 "$@"; start /x/setup.exe
  wait_log 'page: address' 180 && key Return && wait_log 'page: done' 120
  local rc=$?
  [ -n "$name" ] && shot "$name"
  key Return; wait_exit
  return $rc
}

echo "[1 Windows: W-OS]"
reset; scenario default=ok
wine winecfg /v win7 >/dev/null 2>&1
start /x/setup.exe
wait_win 'Veraldar Setup'; shot w-os 'Veraldar Setup'
key Return; wait_exit
[ "$(result)" = "W-OS - needs Windows 10 build 19041 or newer / Windows 11, x86_64" ] && [ ! -s "$CALLS" ] && [ ! -f "$I/wsl-bootstrap.sh" ]
check 'Windows 7: one message, report result W-OS, nothing installed, wsl.exe never called' $?
wine winecfg /v win10 >/dev/null 2>&1

echo "[success: an Ubuntu already there]"
reset; scenario default=ok join=ok prep=3 wait=4 probe_ms=1500
start /x/setup.exe
wait_win; sleep 1.2; shot prepare
wait_log 'page: address' 180; shot address
key Return
wait_log 'join: started' 60; shot connecting
wait_log 'code is up' 60; shot code
wait_log 'page: done' 60; shot done-ok
[ "$(result)" = "connected as TESTPC" ]
check 'success: last page "Connected as TESTPC", report result connected' $?
calls | grep -qxF -- '-e | sh | -c | . /etc/os-release; echo vb:$WSL_DISTRO_NAME:$(id -un):$(id -u):$ID $ID_LIKE:$(uname -r):$PRETTY_NAME'
check 'step 2: probes the default distribution (Debian/Ubuntu? user? WSL2 kernel?)' $?
calls | grep -qxF -- "-d | Ubuntu | -u | root | -e | bash | $UI/wsl-bootstrap.sh | --setup | --out | $UI | --user | alice"
check 'step 2: wsl -u root wsl-bootstrap.sh --setup --user alice (its default user; packages by apt-get, no password)' $?
calls | grep -qxF -- "$(J Ubuntu alice)"
check 'step 4: wsl -d Ubuntu -u alice -e bash <installed wsl-bootstrap.sh> --hub https://ap.veraldar.org --name TESTPC --out <install folder>' $?
cmp -s "$I/join.sh" /x/join.sh && ! grep -q $'\r' "$I/wsl-bootstrap.sh" && grep -q $'\r' "$I/launcher.bat" && ! grep -q 'git clone' "$I/wsl-bootstrap.sh"
check 'install folder: join.sh embedded byte for byte, wsl-bootstrap.sh LF (no git clone), launcher.bat CRLF' $?
[ -f "$I/join-qr.bmp" ] && [ "$(head -c 2 "$I/join-qr.bmp")" = BM ]
check 'step 5: the QR BMP the window showed came from the real bootstrap (join.sh PNG -> BMP)' $?
sleep 2
calls | grep -qxF -- "-d | Ubuntu | -u | alice | $KEEP" && [ -f "$STARTUP/Veraldar.lnk" ]
check 'step 6: Startup "Veraldar" entry; keepalive.vbs -> launcher.bat -> wsl -d Ubuntu -u alice ...bin/start --hold' $?
tr -d '\r' <"$I/wsl.ini" | grep -qx 'distro=Ubuntu' && tr -d '\r' <"$I/wsl.ini" | grep -qx 'user=alice' && tr -d '\r' <"$I/wsl.ini" | grep -qx 'name=TESTPC'
check 'wsl.ini: distro, user, name (launcher.bat and the uninstaller read it)' $?
R=$(report)
grep -qxF "installer:  Veraldar-Setup $VERSION" <<<"$R" && grep -q '^windows:    Windows 10 .*x86_64$' <<<"$R" && grep -q '^wsl:        WSL version: 2.3.26.0$' <<<"$R" \
  && grep -q '^distro:     Ubuntu (Ubuntu 24.04.1 LTS), kernel 5.15.167.4-microsoft-standard-WSL2, Linux user alice$' <<<"$R" \
  && grep -q '^  4-5 join     approved on the phone$' <<<"$R" && [ "$(sed -n '/^last 40 log lines/,$p' <<<"$R" | wc -l)" -le 41 ] \
  && grep -q 'Code (check it matches the phone):  K7QM2XWP' <<<"$R" && [ -z "$(LC_ALL=C grep -n '[^[:print:][:space:]]' <<<"$R")" ]
check 'step 7: install-report.txt: versions, distro, each step, the last 40 log lines, plain ASCII' $?
wine reg query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Veraldar' /v DisplayVersion 2>/dev/null | tr -d '\r' | sed -n 's/.*REG_SZ *//p' | grep -qxF "$VERSION"
check "Apps list: Veraldar $VERSION (per user)" $?
key Return; wait_exit

echo "[keepalive.vbs -> launcher.bat, again (as at logon)]"
: >"$CALLS"
wine wscript.exe //B //Nologo "C:\\users\\root\\AppData\\Local\\Veraldar\\keepalive.vbs" >/dev/null 2>&1
for _ in $(seq 1 25); do [ -s "$CALLS" ] && break; sleep 0.2; done
[ "$(calls)" = "-d | Ubuntu | -u | alice | $KEEP" ]
check 'at logon: one wsl call, no window, no question: the root started and held' $?

echo "[uninstall]"
: >"$CALLS"
start "C:\\users\\root\\AppData\\Local\\Veraldar\\Uninstall.exe"
wait_win; sleep 0.5; shot uninstall
key Return
for _ in $(seq 1 100); do [ ! -d "$I" ] && break; sleep 0.2; done
sleep 1; shot uninstall-done
key Return; sleep 1.5
calls | grep -qxF -- "-d | Ubuntu | -u | alice | $STOP" && [ ! -d "$I" ] && [ ! -f "$STARTUP/Veraldar.lnk" ] \
  && ! wine reg query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Veraldar' >/dev/null 2>&1
check 'uninstall: stops the root in WSL (bin/stop), Startup entry, files and Apps entry gone; WSL left alone' $?
! calls | grep -q -- '--unregister\|--uninstall'
check 'uninstall: the distribution is not touched' $?

echo "[step codes from join.sh, through the real wsl-bootstrap.sh]"
flow net done-net;            [ "$(result | cut -d' ' -f1)" = W-NET ];   check 'release unreachable -> W-NET' $?
flow hubnet '';               [ "$(result | cut -d' ' -f1)" = W-NET ];   check 'trunk unreachable -> W-NET' $?
flow sig done-sig;            [ "$(result | cut -d' ' -f1)" = W-SIG ] && grep -q 'NOT signed' <<<"$(result)"; check 'signature refused -> W-SIG' $?
flow refused done-refused;    [ "$(result)" = "W-JOIN - refused on the phone" ];  check 'refused on the phone (3) -> W-JOIN' $?
flow expired done-expired;    [ "$(result)" = "W-JOIN - the request expired before it was approved" ]; check 'expired (4) -> W-JOIN' $?
flow other done-join;         [ "$(result | cut -d' ' -f1)" = W-JOIN ];  check 'other join failure -> W-JOIN' $?
flow model done-model;        [ "$(result | cut -d' ' -f1)" = W-MODEL ]; check 'no model upstream -> W-MODEL' $?
flow run done-run;            [ "$(result | cut -d' ' -f1)" = W-RUN ] && [ -f "$STARTUP/Veraldar.lnk" ]
check 'joined, the brain does not answer -> W-RUN (start-at-login entry still installed)' $?
flow secret ''
R=$(report)
[ "$(result)" = "connected as TESTPC" ] && ! grep -qE 'abcdefghijklmnop|Zx9Yw8Vu7Ts6|9f8e7d6c5b4a|hunter2|Q2xhdWRl|4f9c2e1a7b3d' <<<"$R" "$I/setup.log" \
  && grep -q 'YGG_UPSTREAM_API_KEY=\*\*\*' <<<"$R"
check 'report: keys and tokens join.sh printed are masked (setup.log too)' $?

echo "[WSL]"
reset; scenario default=ok setup=fail; start /x/setup.exe
wait_log 'page: done' 120; shot done-wsl; key Return; wait_exit
[ "$(result)" = "W-WSL - apt-get could not install curl python3" ] && ! grep -q 'page: address' "$I/setup.log"
check 'packages cannot be installed -> W-WSL (no address asked)' $?
reset; scenario default=none ubuntu=none install_rc=1; start /x/setup.exe
wait_log 'page: done' 120; key Return; wait_exit
calls | grep -qxF -- '--install | -d | Ubuntu | --no-launch' && [ "$(result)" = "W-WSL - wsl --install failed (exit 1)" ]
check 'no WSL, its install fails -> W-WSL' $?
reset; scenario default=other ubuntu=installed install_rc=0 join=ok; start /x/setup.exe
wait_log 'page: address' 180; key Return; wait_log 'page: done' 120; key Return; wait_exit
calls | grep -qxF -- '--install | -d | Ubuntu | --no-launch' && calls | grep -qxF -- "$(J Ubuntu alice)" && [ "$(result)" = "connected as TESTPC" ]
check 'default distribution is not Debian/Ubuntu (Arch): Ubuntu installed, no restart needed, joined there' $?

echo "[restart: WSL was missing]"
reset; scenario default=none ubuntu=registered install_rc=0 join=ok; start /x/setup.exe
wait_log 'page: restart' 180; shot restart
RO=$(wine reg query 'HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce' /v Veraldar 2>/dev/null | tr -d '\r' | sed -n 's/.*REG_SZ *//p')
key Escape; wait_exit
[ "$RO" = '"C:\users\root\AppData\Local\Veraldar\Veraldar-Setup.exe" /continue' ] && [ -f "$I/Veraldar-Setup.exe" ] \
  && calls | grep -qxF -- '--install | -d | Ubuntu | --no-launch' && [ "$(result)" = "waiting for the restart (WSL installed)" ]
check 'elevated wsl --install, "Windows must restart", RunOnce -> the installer copy with /continue' $?
# "after the restart": Ubuntu is an app now, not set up yet (ubuntu.exe), its default user would be root
cp /tmp/wsl.exe "$U/AppData/Local/Microsoft/WindowsApps/ubuntu.exe" 2>/dev/null || { mkdir -p "$U/AppData/Local/Microsoft/WindowsApps"; cp /tmp/wsl.exe "$U/AppData/Local/Microsoft/WindowsApps/ubuntu.exe"; }
wine reg delete 'HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce' /v Veraldar /f >/dev/null 2>&1
: >"$CALLS"
start "C:\\users\\root\\AppData\\Local\\Veraldar\\Veraldar-Setup.exe" /continue
wait_log 'page: address' 180; key Return; wait_log 'page: done' 120; key Return; wait_exit
calls | grep -qxF 'ubuntu.exe | install | --root' && ! calls | grep -q -- '--install' \
  && calls | grep -qxF -- "-d | Ubuntu | -u | root | -e | bash | $UI/wsl-bootstrap.sh | --setup | --out | $UI | --win-user | root" \
  && calls | grep -qxF -- "$(J Ubuntu veraldar)" && calls | grep -qxF 'ubuntu.exe | config | --default-user | veraldar' \
  && [ "$(result)" = "connected as TESTPC" ] && grep -q 'continue after restart: 1' "$I/setup.log"
check '/continue: ubuntu.exe install --root (no Linux user question), user "veraldar" made, joined; no second UAC' $?

echo "[the address]"
reset; scenario default=ok join=ok; start /x/setup.exe
wait_log 'page: address' 180
typein 'ftp://nope'; xdotool key Return
wait_win 'Veraldar Setup'; sleep 0.5; shot bad-address 'Veraldar Setup'; xdotool key Return; sleep 0.5
grep -q 'page: join' "$I/setup.log"; bad=$?
typein ' https://other.example/ '; xdotool key Return
wait_log 'page: done' 120; key Return; wait_exit
[ $bad = 1 ] && calls | grep -qxF -- "$(J Ubuntu alice https://other.example)"
check 'an address that is not https:// is refused on the page; blanks and the trailing / are dropped' $?

echo "[Cancel while the code is up]"
reset; scenario default=ok join=wait; start /x/setup.exe
wait_log 'page: address' 180; key Return; wait_log 'code is up' 60
click_cancel; wait_exit; sleep 1
calls | grep -qxF -- "-d | Ubuntu | -u | alice | -e | bash | $UI/wsl-bootstrap.sh | --cancel" && ! ps -eo args | grep -v grep | grep -q 'fake-join.sh' \
  && [ "$(result)" = "W-JOIN - cancelled in Setup" ] && [ ! -f "$STARTUP/Veraldar.lnk" ]
check 'Cancel: the join inside WSL is stopped (wsl-bootstrap.sh --cancel), nothing started, report says so' $?

echo; echo "$pass/$((pass + fail)) checks passed"
[ "$fail" = 0 ]
INNER
)
docker run --rm --hostname testpc -e VERSION="$VERSION" -v "$EXE:/x/setup.exe:ro" -v "$JOINSH:/x/join.sh:ro" -v "$REPO:/repo:ro" \
  ${SHOTARGS[@]+"${SHOTARGS[@]}"} \
  --entrypoint bash "$IMAGE" -c "$INNER"
