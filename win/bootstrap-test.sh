#!/usr/bin/env bash
# bootstrap-test.sh — win/wsl-bootstrap.sh (the Linux half of Veraldar-Setup.exe) in a fresh Ubuntu container,
# as WSL would run it: --setup as root (the Linux user made without a password, curl/python3/openssh-client/
# ca-certificates installed with apt-get), then the join as that user against win/test/fake-join.sh, one case per
# outcome: status.ini (state, code, QR BMP, step code), exit codes, the masked setup.log, the model hand-over
# (upstream.env), --cancel. The real join.sh against a fake hub: root/install/join-test.py.
#
#   win/bootstrap-test.sh [IMAGE]       default ubuntu:24.04 (needs the network for apt-get)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
IMAGE=${1:-ubuntu:24.04}

INNER=$(cat <<'INNER'
set -u
B=/repo/win/wsl-bootstrap.sh FAKE=/repo/win/test/fake-join.sh
pass=0 fail=0
check() { if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  PASS  $1"; else fail=$((fail + 1)); echo "  FAIL  $1"; [ -n "${3:-}" ] && printf '%s\n' "$3" | tail -n 12; fi; }
ini() { tr -d '\r' <"$1" | sed -n "s/^$2=//p"; }

echo "[setup, as root]"
OUTS=/tmp/out-setup; mkdir -p "$OUTS"
for t in curl python3 ssh-keygen; do command -v $t >/dev/null && echo "  (note: $t already in the image)"; done
bash $B --setup --out $OUTS --win-user "John Smith" >/tmp/setup.out 2>&1; rc=$?
[ $rc = 0 ] && [ "$(ini $OUTS/setup.ini result)" = ok ] && [ "$(ini $OUTS/setup.ini user)" = johnsmith ] && [ "$(ini $OUTS/setup.ini made)" = 1 ]
check 'setup: exit 0, setup.ini result=ok user=johnsmith made=1 (from the Windows name "John Smith")' $? "$(cat /tmp/setup.out $OUTS/setup.ini 2>/dev/null)"
id johnsmith >/dev/null 2>&1 && [ "$(getent passwd johnsmith | cut -d: -f7)" = /bin/bash ] && [ "$(getent shadow johnsmith | cut -d: -f2)" = '!' ]
check 'setup: the Linux user exists, bash, no password (locked: nothing to type, wsl -u starts it)' $? "$(getent shadow johnsmith)"
grep -q '^\[user\]' /etc/wsl.conf && grep -q '^default=johnsmith$' /etc/wsl.conf
check 'setup: /etc/wsl.conf names it the default user' $? "$(cat /etc/wsl.conf 2>&1)"
command -v curl >/dev/null && python3 -c 'import ssl, json, urllib.request, zlib, fcntl' && command -v ssh-keygen >/dev/null && [ -s /etc/ssl/certs/ca-certificates.crt ]
check 'setup: curl, python3 (ssl), ssh-keygen, CA certificates installed by apt-get, no question' $?
grep -q 'installing curl python3 openssh-client ca-certificates' $OUTS/setup.log && grep -q $'\r$' $OUTS/setup.log
check 'setup: setup.log (CRLF) says what it installed' $? "$(cat $OUTS/setup.log)"
cp /etc/wsl.conf /tmp/wsl.conf.1
bash $B --setup --out $OUTS --user johnsmith >/tmp/setup.out 2>&1; rc=$?
[ $rc = 0 ] && [ "$(ini $OUTS/setup.ini made)" = 0 ] && [ "$(ini $OUTS/setup.ini user)" = johnsmith ] && cmp -s /etc/wsl.conf /tmp/wsl.conf.1
check 'setup again, --user johnsmith (the default user of an existing distro): kept, nothing made, wsl.conf untouched' $? "$(cat /tmp/setup.out)"
[ "$(ini $OUTS/setup.ini model)" = 0 ]
check 'setup: model=0 — this user has no root with a model yet (the installer asks for one)' $? "$(cat $OUTS/setup.ini)"
mkdir -p /home/johnsmith/.local/share/yggdrasil-root && printf 'YGG_UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1\n' >/home/johnsmith/.local/share/yggdrasil-root/brain.env
bash $B --setup --out $OUTS --user johnsmith >/tmp/setup.out 2>&1
[ "$(ini $OUTS/setup.ini model)" = 1 ]
check 'setup: model=1 once its root has a model (the installer does not ask; join.sh keeps it)' $? "$(cat $OUTS/setup.ini)"
rm -rf /home/johnsmith/.local/share/yggdrasil-root
bash $B --setup --out $OUTS --win-user "root" >/tmp/setup.out 2>&1; rc=$?
[ $rc = 0 ] && [ "$(ini $OUTS/setup.ini user)" = veraldar ]
check 'setup: a Windows name that is a system account here (root) -> the user "veraldar"' $? "$(cat /tmp/setup.out $OUTS/setup.ini)"
runuser -u johnsmith -- bash $B --setup --out /tmp >/tmp/setup.out 2>&1; rc=$?
[ $rc = 64 ]
check 'setup: refuses to run as a normal user (exit 64)' $?

apt-get install -y -qq --no-install-recommends zbar-tools qrencode procps >/dev/null 2>&1 || echo "  (could not install zbar-tools/qrencode)"

echo "[QR picture]"
python3 /repo/root/install/rootjoin.py qr "https://ap.veraldar.org/join?r=0123456789abcdef0123456789abcdef" --png /tmp/q1.png >/dev/null
bash $B --png2bmp /tmp/q1.png /tmp/q1.bmp 215 && [ "$(head -c2 /tmp/q1.bmp)" = BM ] \
  && [ "$(zbarimg -q --raw /tmp/q1.bmp 2>/dev/null)" = "https://ap.veraldar.org/join?r=0123456789abcdef0123456789abcdef" ]
check 'png2bmp: rootjoin.py PNG (8-bit grey) -> BMP that decodes to the same URL' $?
w=$(python3 -c 'import struct,sys; d=open("/tmp/q1.bmp","rb").read(); print(struct.unpack("<i", d[18:22])[0])')
[ "$w" -ge 150 ] && [ "$w" -le 215 ]
check "png2bmp: at most 215 px (got $w): fits the installer's window" $?
if command -v qrencode >/dev/null; then
  qrencode -o /tmp/q2.png -s 8 -m 4 "https://ap.veraldar.org/join?r=fedcba9876543210fedcba9876543210"
  bash $B --png2bmp /tmp/q2.png /tmp/q2.bmp 200 && [ "$(zbarimg -q --raw /tmp/q2.bmp 2>/dev/null)" = "https://ap.veraldar.org/join?r=fedcba9876543210fedcba9876543210" ]
  check "png2bmp: qrencode's PNG (1-bit palette) -> BMP that decodes" $?
fi
echo 'not a png' >/tmp/bad.png
! bash $B --png2bmp /tmp/bad.png /tmp/bad.bmp 2>/dev/null && [ ! -f /tmp/bad.bmp ]
check 'png2bmp: not a PNG -> fails, writes nothing' $?

echo "[mask]"
M=$(printf '%s\n' 'YGG_UPSTREAM_API_KEY=sk-live-abcdefghijklmnop1234567890' 'Authorization: Bearer x' \
  'link token: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc' 'export GH_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6' \
  'b64 Q2xhdWRlIGlzIG5vdCBhIHNlY3JldCBidXQgdGhpcyBpcz0+/abc=' 'ok /home/me/.local/share/yggdrasil-root/bin/start' \
  'url https://github.com/veraldar/yggdrasil/releases/download/v0.9.1/SHA256SUMS' 'code K7QM2XWP' $'\e[1;31mxx\e[0m  red' \
  'stop — re-run · “quoted” ‘one’ …' $'\e[30;107m\u2580\e[97;40m\u2580\e[0m' $'\e[40m    \e[0m' 'last' | bash $B --mask)
! grep -qE 'abcdefghijklmnop|9f8e7d6c5b4a|A1b2C3d4|Q2xhdWRl' <<<"$M" && grep -q 'YGG_UPSTREAM_API_KEY=\*\*\*' <<<"$M" \
  && grep -qF '/home/me/.local/share/yggdrasil-root/bin/start' <<<"$M" && grep -qF 'releases/download/v0.9.1/SHA256SUMS' <<<"$M" \
  && grep -q 'code K7QM2XWP' <<<"$M" && grep -q '^xx  red$' <<<"$M" && grep -qx "stop - re-run - \"quoted\" 'one' ..." <<<"$M" \
  && [ "$(tail -n 2 <<<"$M" | head -n 1)" = "stop - re-run - \"quoted\" 'one' ..." ]
check 'mask: keys, tokens, long random runs -> ***; paths, URLs, the code stay; ASCII only; colours and terminal QR gone' $? "$M"
[ -z "$(LC_ALL=C grep -n '[^[:print:][:space:]]' <<<"$M")" ]
check 'mask: the output is plain ASCII' $? "$M"

echo "[join, as the user]"
OUT=/tmp/out; mkdir -p $OUT; chown johnsmith $OUT
U=/home/johnsmith ST=/home/johnsmith/.local/state/veraldar
mkdir -p /tmp/www && echo pong >/tmp/www/root
python3 -m http.server 4180 --bind 127.0.0.1 --directory /tmp/www >/dev/null 2>&1 &
WWW=$!
boot() { # MODE [env...] — the join as the installer starts it; RC
  local mode=$1; shift
  rm -f $OUT/status.ini $OUT/setup.log $U/fake-join-args $U/fake-upstream
  runuser -u johnsmith -- env HOME=$U FAKE_JOIN_MODE=$mode FAKE_ROOTJOIN=/repo/root/install/rootjoin.py VERALDAR_JOIN_SH=$FAKE \
    VERALDAR_PROBE_SECS=1 FAKE_BRAIN_PORT=4180 "$@" bash $B --hub ' https://ap.veraldar.org'$'\r' --name PC --out $OUT >/tmp/boot.out 2>&1
  RC=$?
}
st() { ini $OUT/status.ini "$1"; }
case_is() { # MODE RC STEP NAME — the exit code and the step code status.ini gives the installer
  boot "$1"
  [ "$RC" = "$2" ] && [ "$(st state)" = fail ] && [ "$(st step)" = "$3" ] && [ "$(st rc)" = "$2" ]
  check "$4: exit $2, state=fail step=$3 ($(st why | cut -c1-60))" $? "rc=$RC $(cat /tmp/boot.out $OUT/status.ini)"
}
# success: watch status.ini while the code is up
rm -f $OUT/status.ini
runuser -u johnsmith -- env HOME=$U FAKE_JOIN_MODE=ok FAKE_WAIT=4 FAKE_ROOTJOIN=/repo/root/install/rootjoin.py VERALDAR_JOIN_SH=$FAKE \
  FAKE_BRAIN_PORT=4180 bash $B --hub https://ap.veraldar.org --name PC --out $OUT >/tmp/boot.out 2>&1 &
BP=$!
for _ in $(seq 1 50); do [ "$(st state 2>/dev/null)" = code ] && break; sleep 0.2; done
[ "$(st state)" = code ] && [ "$(st code)" = K7QM2XWP ] && [ "$(st qr)" = join-qr.bmp ] && [ "$(st name)" = PC ] \
  && [ "$(zbarimg -q --raw $OUT/join-qr.bmp 2>/dev/null)" = "https://ap.veraldar.org/join?r=4f9c2e1a7b3d5f60a8c4e2b9d1f3a5c7" ]
check 'ok: while waiting, status.ini state=code code=K7QM2XWP qr=join-qr.bmp (decodes to the approve URL)' $? "$(cat $OUT/status.ini 2>&1)"
[ -s $ST/join.pid ] && [ "$(ps -o pgid= -p "$(cat $ST/join.pid)" | tr -d ' ')" = "$(cat $ST/join.pid)" ]
check 'ok: the join runs in a process group of its own (join.pid = its group: --cancel stops all of it)' $?
wait $BP; RC=$?
[ "$RC" = 0 ] && [ "$(st state)" = done ] && [ -z "$(st step)" ] && [ "$(st rc)" = 0 ] && [ ! -f $ST/join.pid ]
check 'ok: exit 0, state=done, no step code (joined, the brain answers)' $? "rc=$RC $(cat /tmp/boot.out $OUT/status.ini)"
[ "$(tr '\n' ' ' <$U/fake-join-args)" = "--hub https://ap.veraldar.org --name PC --qr-png $ST/join-qr.png " ]
check 'ok: join.sh got --hub (CR/blank stripped) --name --qr-png, nothing else (no model file: no --upstream-env)' $? "$(cat $U/fake-join-args)"
grep -q 'Code (check it matches the phone):  K7QM2XWP' $OUT/setup.log && grep -q 'result: ok (exit 0)' $OUT/setup.log \
  && ! grep -q $'\e' $OUT/setup.log && grep -q 'Code (check' $ST/bootstrap.log
check 'ok: setup.log (Windows side) and bootstrap.log (inside WSL) have the run, no colour codes' $?
case_is run 5 W-RUN 'joined but the brain does not answer'
case_is refused 3 W-JOIN 'refused on the phone'
case_is expired 4 W-JOIN 'expired'
case_is sig 1 W-SIG 'SHA256SUMS not signed by the release key'
case_is net 1 W-NET 'release unreachable (curl + cannot download)'
case_is hubnet 1 W-NET 'trunk unreachable (rootjoin: cannot reach the hub)'
case_is model 64 W-MODEL 'no model upstream'
case_is other 1 W-JOIN 'any other join failure'
boot secret
! grep -qE 'abcdefghijklmnop|Zx9Yw8Vu7Ts6|9f8e7d6c5b4a|hunter2|Q2xhdWRl|4f9c2e1a7b3d' $OUT/setup.log \
  && grep -qF '/home/me/.local/share/yggdrasil-root/bin/start' $OUT/setup.log && [ "$RC" = 0 ]
check 'secrets printed by join.sh never reach setup.log (masked), readable paths stay' $? "$(cat $OUT/setup.log)"

echo "[the model, one place]"
printf 'YGG_UPSTREAM_BASE_URL=https://api.example/v1\nYGG_UPSTREAM_API_KEY=sk-test-1\n' >$OUT/upstream.env; chown johnsmith $OUT/upstream.env
cp $OUT/upstream.env /tmp/up.want
boot ok
grep -qx -- --upstream-env $U/fake-join-args && cmp -s $U/fake-upstream /tmp/up.want && [ ! -f $OUT/upstream.env ] \
  && [ -z "$(ls $ST/upstream.* 2>/dev/null)" ] && [ "$RC" = 0 ]
check 'upstream.env from the installer -> join.sh --upstream-env (same lines); Windows copy and WSL copy removed after' $? "$(cat $U/fake-join-args)"

echo "[cancel]"
rm -f $OUT/status.ini
runuser -u johnsmith -- env HOME=$U FAKE_JOIN_MODE=wait FAKE_ROOTJOIN=/repo/root/install/rootjoin.py VERALDAR_JOIN_SH=$FAKE \
  bash $B --hub https://ap.veraldar.org --name PC --out $OUT >/tmp/boot.out 2>&1 &
BP=$!
for _ in $(seq 1 50); do [ "$(st state 2>/dev/null)" = code ] && break; sleep 0.2; done
runuser -u johnsmith -- env HOME=$U bash $B --cancel; crc=$?
gone=1; for _ in $(seq 1 25); do kill -0 $BP 2>/dev/null || { gone=0; break; }; sleep 0.2; done
sleep 0.5
[ $crc = 0 ] && [ $gone = 0 ] && ! ps -eo args | grep -v grep | grep -q 'fake-join.sh\|sleep 600'
check '--cancel: the waiting join and everything under it stop' $? "$(ps -eo pid,pgid,args | grep -v ' ps ')"
kill $WWW 2>/dev/null
echo; echo "$pass/$((pass + fail)) checks passed"
[ $fail = 0 ]
INNER
)
exec docker run --rm -v "$REPO:/repo:ro" "$IMAGE" bash -c "$INNER"
