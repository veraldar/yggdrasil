#!/usr/bin/env bash
# vps-meter-update.sh — step 2 of the trunk meter (proposal v2): the VPS reports home.
# Puts THIS tree's bifrost-net on the VPS as /usr/local/bin/trunk-ap and its sni-443.py as
# /usr/local/lib/yggdrasil-trunk/sni-443.py, keeping the previous two beside them (*.prev), and
# restarts trunk-ap and yggdrasil-sni-443. Configs and unit files are NOT touched (the meter needs
# no config key: the ap sends its minutes home over the channel; sni-443 sends its counts to the
# ap on udp 127.0.0.1:4481).
#
# Cost: the public door is cut for a few seconds (both restarts; the home bridge redials in ≤ 2 s;
# the website on :443 too, for the dispatcher's restart). Needs the OWNER's go (proposal v2 §7).
#
#   VPS_HOST=veraldar trunk/deploy/vps-meter-update.sh            do it (checks after; way back on a failure)
#   DRY_RUN=1 … / … back                                          print only / put the *.prev back by hand
set -euo pipefail
cd "$(dirname "$0")/.."
VPS=${VPS_HOST:-veraldar}
BIN=target/release/bifrost-net
SNI=deploy/sni-443.py
run() { if [ -n "${DRY_RUN:-}" ]; then echo "  [dry] ssh $VPS -- $*"; else ssh -o BatchMode=yes "$VPS" "$@"; fi; }
put() { if [ -n "${DRY_RUN:-}" ]; then echo "  [dry] scp $1 → $VPS:$2"; else scp -q "$1" "$VPS:$2"; fi; }

back() {
  echo "== the way back: the previous trunk-ap and sni-443.py"
  run 'set -e
    sudo install -m 755 /usr/local/bin/trunk-ap.prev /usr/local/bin/trunk-ap
    sudo install -m 644 /usr/local/lib/yggdrasil-trunk/sni-443.py.prev /usr/local/lib/yggdrasil-trunk/sni-443.py
    sudo systemctl restart yggdrasil-sni-443 trunk-ap
    sleep 2; systemctl is-active trunk-ap yggdrasil-sni-443'
}
[ "${1:-}" = back ] && { back; exit 0; }

[ -x "$BIN" ] || { echo "build first: (cd trunk && cargo build --release)"; exit 1; }
need=$(objdump -T "$BIN" | grep -o 'GLIBC_[0-9.]*' | sort -V | tail -1 | cut -d_ -f2)
have=$(run 'ldd --version | head -1 | grep -o "[0-9]*\.[0-9]*$"' || echo 0)
[ -n "${DRY_RUN:-}" ] || [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" = "$need" ] \
  || { echo "BLOCKED: the binary needs glibc $need, the VPS has $have"; exit 1; }
echo "== trunk meter → $VPS (binary needs glibc $need; VPS $have)"
put "$BIN" /tmp/trunk-ap.new
put "$SNI" /tmp/sni-443.py.new
run 'set -e
  sudo cp -p /usr/local/bin/trunk-ap /usr/local/bin/trunk-ap.prev
  sudo cp -p /usr/local/lib/yggdrasil-trunk/sni-443.py /usr/local/lib/yggdrasil-trunk/sni-443.py.prev
  sudo install -m 755 /tmp/trunk-ap.new /usr/local/bin/trunk-ap
  sudo install -m 644 /tmp/sni-443.py.new /usr/local/lib/yggdrasil-trunk/sni-443.py
  rm -f /tmp/trunk-ap.new /tmp/sni-443.py.new
  sudo systemctl restart yggdrasil-sni-443 trunk-ap'
[ -n "${DRY_RUN:-}" ] && exit 0
# checks: both up, the ap's meter on with its test request and the dispatcher's counts, the door
# answers from outside through the home bridge
ok=1
for _ in $(seq 30); do
  out=$(ssh -o BatchMode=yes "$VPS" 'systemctl is-active trunk-ap yggdrasil-sni-443; sudo journalctl -u trunk-ap -n 30 --no-pager -o cat' 2>/dev/null || true)
  echo "$out" | grep -q "bridge registered" && break
  sleep 1
done
for want in "meter: on — memory only" "test request every" "dispatcher's minute counts" "bridge registered"; do
  echo "$out" | grep -q "$want" && echo "  ok   $want" || { echo "  FAIL $want"; ok=0; }
done
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "https://${AP_DOMAIN:-ap.veraldar.org}/" || true)
[ "$code" = 200 ] && echo "  ok   https://${AP_DOMAIN:-ap.veraldar.org}/ 200 through the bridge" || { echo "  FAIL the door answers $code"; ok=0; }
if [ "$ok" = 1 ]; then
  echo "== done: the VPS's minute lines reach home as ap-min-*.jsonl within 2 minutes (the bridge's obs folder)"
else
  back
  exit 1
fi
