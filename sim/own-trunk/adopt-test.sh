#!/usr/bin/env bash
# adopt-test.sh — trunk.sh --adopt /etc/trunk-ap, proven on a fresh Debian 12 "VPS" (systemd as PID 1, docker)
# set up the way the real one was set up BY HAND (install-ap.sh + the vps-443 kit):
#   /etc/trunk-ap/{key.pem, cert.pem (a CA's, from that key), ap.toml (listen 127.0.0.1:4443, PROXY line, the
#   hub's token by its sha-256, [[ap.tcp]] livekit-ice :4479), sni-443.conf} · trunk-ap.service (the binary as
#   /usr/local/bin/trunk-ap) · yggdrasil-sni-443.service from the kit (:443 → the ap by name, else a website on
#   127.0.0.1:8443) · trunk-ap-cert.timer (renewal through /var/www/acme) · a website on 127.0.0.1:8443.
# Then, as the integrator will run it on the VPS:
#   1. a FAILED adopt (a binary that never serves): exit ≠ 0, the hand-made ap is back and answering
#   2. the adopt: the same key (pin), the same certificate, the hub's token still accepted, the website still
#      routed, trunk-ap stopped + disabled, its renewal timer off, /etc/trunk-ap byte-identical, no token printed
#   3. a plain re-run: unchanged, token kept
#
#   sim/own-trunk/adopt-test.sh BIFROST_NET     the trunk's binary (a release's bifrost-net, full build)
#   ADOPT_KEEP=1 leaves the container up
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
BIN=${1:?usage: adopt-test.sh BIFROST_NET}; [ -x "$BIN" ] || { echo "$BIN: not executable"; exit 2; }
C=p4-adopt NET=p4-adopt-net NAME=ap.tree.test
STATE=$(mktemp -d /tmp/adopt-test.XXXXXX); RESULTS=$STATE/results.tsv; : >"$RESULTS"
pass() { printf 'PASS\t%s\t%s\n' "$1" "$2" >>"$RESULTS"; printf '\033[32mPASS\033[0m %-4s %s\n' "$1" "$2"; }
fail() { printf 'FAIL\t%s\t%s\n' "$1" "$2" >>"$RESULTS"; printf '\033[31mFAIL\033[0m %-4s %s\n' "$1" "$2"; }
check() { local id=$1 what=$2; shift 2; if "$@" >>"$STATE/checks.log" 2>&1; then pass "$id" "$what"; else fail "$id" "$what"; fi; }
vps() { docker exec "$C" bash -c "$*"; }
cleanup() {
  [ "${ADOPT_KEEP:-0}" = 1 ] && { echo "kept: container $C, network $NET, state $STATE"; return; }
  docker rm -f "$C" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; true
}
trap cleanup EXIT
docker rm -f "$C" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1
docker build -q -t ot-vps:12 -f "$HERE/vps.Dockerfile" "$HERE" >/dev/null || exit 2
docker network create "$NET" >/dev/null || exit 2
docker run -d --name "$C" --hostname vps --network "$NET" --network-alias "$NAME" --network-alias www.tree.test \
  --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock ot-vps:12 >/dev/null || exit 2
for _ in $(seq 30); do s=$(docker exec "$C" systemctl is-system-running 2>/dev/null || true); case $s in running|degraded) break ;; esac; sleep 1; done
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$C")
echo "state + logs: $STATE   (vps $IP)"

# ------------------------------------------------------------------------- the access point made by hand
vps 'apt-get update -qq && apt-get install -y -qq --no-install-recommends curl openssl python3 libopus0 iproute2 >/dev/null' >"$STATE/apt.log" 2>&1 || { echo "apt failed"; exit 2; }
docker cp "$BIN" "$C:/usr/local/bin/trunk-ap" >/dev/null
docker exec "$C" mkdir -p /opt/trunk/install /opt/trunk/deploy /usr/local/lib/yggdrasil-trunk
docker cp "$ROOT/trunk/install/trunk.sh" "$C:/opt/trunk/install/trunk.sh" >/dev/null
docker cp "$ROOT/trunk/deploy/sni-443.py" "$C:/opt/trunk/deploy/sni-443.py" >/dev/null
docker cp "$ROOT/trunk/deploy/sni-443.py" "$C:/usr/local/lib/yggdrasil-trunk/sni-443.py" >/dev/null
docker cp "$ROOT/trunk/deploy/vps-443/yggdrasil-sni-443.service" "$C:/etc/systemd/system/yggdrasil-sni-443.service" >/dev/null
vps "set -e
install -d -m 755 /etc/trunk-ap /var/www/acme /opt/ca /opt/www
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out /etc/trunk-ap/key.pem 2>/dev/null; chmod 600 /etc/trunk-ap/key.pem
# a CA (stands in for Let's Encrypt) signs a certificate made from the ap's own key
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj '/CN=Test Encrypt R1' -keyout /opt/ca/ca.key -out /opt/ca/ca.pem 2>/dev/null
openssl req -new -key /etc/trunk-ap/key.pem -subj /CN=$NAME -addext subjectAltName=DNS:$NAME -out /opt/ca/ap.csr 2>/dev/null
openssl x509 -req -in /opt/ca/ap.csr -CA /opt/ca/ca.pem -CAkey /opt/ca/ca.key -CAcreateserial -days 80 -copy_extensions copy -out /opt/ca/ap.pem 2>/dev/null
cat /opt/ca/ap.pem /opt/ca/ca.pem >/etc/trunk-ap/cert.pem
trunk-ap ap-token >/opt/ca/token.txt
cat >/etc/trunk-ap/ap.toml <<EOF
# trunk access point (made by hand)
[ap]
listen = \"127.0.0.1:4443\"
cert_path = \"/etc/trunk-ap/cert.pem\"
key_path = \"/etc/trunk-ap/key.pem\"
\$(grep '^bridge_token_sha256' /opt/ca/token.txt)
proxy_protocol = true
[[ap.tcp]]
name = \"livekit-ice\"
listen = \"127.0.0.1:4479\"
EOF
printf 'listen  0.0.0.0:443\nroute   $NAME 127.0.0.1:4443 proxy\ndefault 127.0.0.1:8443\nice     127.0.0.1:4479\n' >/etc/trunk-ap/sni-443.conf
cat >/etc/systemd/system/trunk-ap.service <<EOF
[Unit]
Description=yggdrasil trunk access point (bifrost-net ap, :4443)
After=network-online.target
[Service]
ExecStart=/usr/local/bin/trunk-ap ap -c /etc/trunk-ap/ap.toml
# (the VPS's unit reads them as systemd credentials, DynamicUser=yes; docker gives no /run/credentials —
#  --adopt takes key.pem and cert.pem from the folder either way)
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF
cat >/usr/local/sbin/trunk-ap-cert.sh <<'EOF'
#!/bin/sh
D=/etc/trunk-ap
echo would run: certbot certonly --webroot -w /var/www/acme --csr from \$D/key.pem
EOF
chmod 755 /usr/local/sbin/trunk-ap-cert.sh
printf '[Unit]\nDescription=renew the trunk access point certificate\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/trunk-ap-cert.sh\n' >/etc/systemd/system/trunk-ap-cert.service
printf '[Unit]\nDescription=renew\n[Timer]\nOnCalendar=*-*-01,15 04:17\n[Install]\nWantedBy=timers.target\n' >/etc/systemd/system/trunk-ap-cert.timer
# the website on 127.0.0.1:8443 (what :443 sends every other name to)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj /CN=www.tree.test -keyout /opt/www/k.pem -out /opt/www/c.pem 2>/dev/null
echo 'the website' >/opt/www/index.html
cat >/etc/systemd/system/website.service <<EOF
[Service]
ExecStart=/usr/bin/python3 -c 'import http.server,ssl,functools; h=functools.partial(http.server.SimpleHTTPRequestHandler,directory=\"/opt/www\"); s=http.server.ThreadingHTTPServer((\"127.0.0.1\",8443),h); c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(\"/opt/www/c.pem\",\"/opt/www/k.pem\"); s.socket=c.wrap_socket(s.socket,server_side=True); s.serve_forever()'
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now -q trunk-ap website yggdrasil-sni-443 trunk-ap-cert.timer" >"$STATE/setup.log" 2>&1 || { tail "$STATE/setup.log"; exit 2; }
sleep 2
TOKEN=$(docker exec "$C" sed -n 's/^token = "\([0-9a-f]*\)".*/\1/p' /opt/ca/token.txt)   # the hub's (test only)
outside() { vps "curl -sk -o /dev/null -w '%{http_code}' --resolve $NAME:443:$IP --resolve www.tree.test:443:$IP $*"; }
pin() { vps "echo | openssl s_client -connect $IP:443 -servername $NAME 2>/dev/null | openssl x509 -noout -pubkey | openssl pkey -pubin -outform der | sha256sum | cut -c1-64"; }
certfp() { vps "echo | openssl s_client -connect $IP:443 -servername $NAME 2>/dev/null | openssl x509 -noout -fingerprint -sha256"; }
etcsum() { vps 'cd /etc/trunk-ap && sha256sum * | sha256sum | cut -c1-16'; }
inside() { docker exec -i "$C" bash -s; }   # a check script on stdin, run in the VPS
export C NAME IP; export -f vps outside inside
PIN0=$(pin) FP0=$(certfp) SUM0=$(etcsum)
check b1 "before: the hand-made ap answers through :443 (/pair 503: no hub), the hub's token 400 (no upgrade), a wrong one 401, the website 200" \
  bash -c "[ \"\$(outside https://$NAME/pair)\" = 503 ] && [ \"\$(outside -H 'Authorization:\ Bearer\ $TOKEN' https://$NAME/ap)\" = 400 ] &&
    [ \"\$(outside -H 'Authorization:\ Bearer\ 0123456789abcdef0123456789abcdef' https://$NAME/ap)\" = 401 ] && [ \"\$(outside https://www.tree.test/)\" = 200 ] && [ -n '$PIN0' ]"

# ------------------------------------------------------------------------ 1. a failed adopt puts it back
vps 'printf "#!/bin/sh\ncase \$1 in ap-token) exec /usr/local/bin/trunk-ap ap-token ;; *) exit 1 ;; esac\n" >/opt/broken-net && chmod 755 /opt/broken-net'
vps "cd /opt/trunk/install && bash trunk.sh --adopt /etc/trunk-ap --binary /opt/broken-net -y" >"$STATE/1-failed.log" 2>&1; rc=$?
sleep 2
check f1 "a binary that never serves: trunk.sh --adopt stops (exit $rc ≠ 0) and says the old access point is back" \
  bash -c "[ $rc != 0 ] && grep -q 'trunk-ap.service is back and answering' '$STATE/1-failed.log'"
check f2 "after the failure: trunk-ap active + enabled, ours inactive + disabled, /pair through :443 503 again, the hub's token still 400" \
  bash -c "docker exec $C systemctl is-active -q trunk-ap && docker exec $C systemctl is-enabled -q trunk-ap &&
    ! docker exec $C systemctl is-active -q yggdrasil-trunk && ! docker exec $C systemctl is-enabled -q yggdrasil-trunk &&
    [ \"\$(outside https://$NAME/pair)\" = 503 ] && [ \"\$(outside -H 'Authorization:\ Bearer\ $TOKEN' https://$NAME/ap)\" = 400 ] &&
    [ '$(pin)' = '$PIN0' ]"

# ------------------------------------------------------------------------------------------ 2. the adopt
docker cp "$BIN" "$C:/opt/bifrost-net" >/dev/null
vps "cd /opt/trunk/install && bash trunk.sh --adopt /etc/trunk-ap --binary /opt/bifrost-net -y" >"$STATE/2-adopt.log" 2>&1; rc=$?
sleep 2
check a1 "trunk.sh --adopt /etc/trunk-ap: exit 0 ($rc), 'adopted', the token kept (the connect line still works)" \
  bash -c "[ $rc = 0 ] && grep -q 'adopted: trunk-ap.service stopped and disabled' '$STATE/2-adopt.log' && grep -q 'token kept' '$STATE/2-adopt.log'"
check a2 "the same key (the pin) and the same certificate served on :443" \
  bash -c "docker exec $C cmp -s /etc/trunk-ap/key.pem /etc/yggdrasil-trunk/key.pem && [ '$(pin)' = '$PIN0' ] && [ '$(certfp)' = '$FP0' ]"
check a3 "through :443: /pair 503 (answering, no hub), the hub's OLD token 400 (accepted), a wrong one 401, the website 200" \
  bash -c "[ \"\$(outside https://$NAME/pair)\" = 503 ] && [ \"\$(outside -H 'Authorization:\ Bearer\ $TOKEN' https://$NAME/ap)\" = 400 ] &&
    [ \"\$(outside -H 'Authorization:\ Bearer\ 0123456789abcdef0123456789abcdef' https://$NAME/ap)\" = 401 ] && [ \"\$(outside https://www.tree.test/)\" = 200 ]"
check a4 "units: yggdrasil-trunk active + enabled; trunk-ap inactive + disabled; trunk-ap-cert.timer off; yggdrasil-trunk-cert.timer on; :443 router enabled, reading /etc/yggdrasil-trunk/sni-443.conf" inside <<'EOF'
set -e
systemctl is-active -q yggdrasil-trunk; systemctl is-enabled -q yggdrasil-trunk
! systemctl is-active -q trunk-ap; ! systemctl is-enabled -q trunk-ap
! systemctl is-enabled -q trunk-ap-cert.timer; systemctl is-active -q yggdrasil-trunk-cert.timer
systemctl is-enabled -q yggdrasil-sni-443
tr '\0' ' ' </proc/"$(systemctl show -p MainPID --value yggdrasil-sni-443)"/cmdline | grep -q -- '-c /etc/yggdrasil-trunk/sni-443.conf'
EOF
check a5 "trunk.conf + ap.toml: behind the router on 127.0.0.1:4443 with the PROXY line, ICE :4479 live, the token's hash, acme renewal through /var/www/acme, firewall untouched" inside <<EOF
set -e
c=/etc/yggdrasil-trunk/trunk.conf a=/etc/yggdrasil-trunk/ap.toml
for l in NAME=$NAME BEHIND_PROXY=1 PORT=4443 ICE_PORT=4479 CERT=acme WEBROOT=/var/www/acme FIREWALL=0 ADOPTED_FROM=/etc/trunk-ap; do grep -qx "\$l" \$c; done
grep -qx 'listen = "127.0.0.1:4443"' \$a; grep -qx 'proxy_protocol = true' \$a
h() { sed -n 's/^bridge_token_sha256 = "\\([0-9a-f]*\\)".*/\\1/p' "\$1"; }; [ -n "\$(h \$a)" ] && [ "\$(h \$a)" = "\$(h /etc/trunk-ap/ap.toml)" ]
grep -qx acme /etc/yggdrasil-trunk/cert.source
ss -Hltnp 'sport = :4479' | grep -q bifrost-net
EOF
check a6 "/etc/trunk-ap is left byte for byte as it was (the way back), and the token never appears in the output" \
  bash -c "[ '$(etcsum)' = '$SUM0' ] && ! grep -q '$TOKEN' '$STATE/1-failed.log' '$STATE/2-adopt.log'"

# ------------------------------------------------------------------------------------------ 3. a re-run
vps "cd /opt/trunk/install && bash trunk.sh -y" >"$STATE/3-rerun.log" 2>&1; rc=$?
check r1 "a plain re-run: exit 0, unchanged, the token kept, trunk-ap still off, /pair 503" \
  bash -c "[ $rc = 0 ] && grep -q 'running yggdrasil-trunk.service (unchanged)' '$STATE/3-rerun.log' && grep -q 'token kept' '$STATE/3-rerun.log' &&
    ! docker exec $C systemctl is-active -q trunk-ap && [ \"\$(outside https://$NAME/pair)\" = 503 ]"

echo; column -t -s $'\t' "$RESULTS"
! grep -q '^FAIL' "$RESULTS"
