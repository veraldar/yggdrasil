#!/usr/bin/env bash
# sim/vps-caddy-rehearsal.sh — G4.5: trunk v1's Caddy changes (trunk/deploy/caddy/: phase 1, phase 2, the M7 ap ACME
# split, merged by caddy-merge.py into a COPY of the VPS's Caddyfile) in a local Caddy of the VPS's exact version,
# with Pebble for ACME, the VPS's own :443 router in front (its sni-443.py copy and conf), stub upstreams on the
# VPS's ports and a trunk stand-in for the container. The real names reach the rig by SNI/Host and the rig's DNS
# stub (pebble-challtestsrv answers every name with the rig's Caddy) — never by public DNS. Nothing reaches the VPS.
#
#   sim/vps-caddy-rehearsal.sh        exit 0 = GREEN · 1 = a check failed · 2 = the rig could not be built
#   CADDY_VPS_COPY=…                  the copy (default ~/.cache/trunk-v1/vps-ro/Caddyfile, read with `cat` on 11-25)
#   SNI443_VPS_CONF=…                 the VPS's sni-443.conf copy (default ~/.cache/trunk-v1/vps-ro/sni-443.conf)
#   G45_KEEP=1                        keep the rig (docker rm -f v1ops-g45-{dns,pebble,caddy,up,router,trunk})
#
# Stages: 0 the copy as it is → 1 phase 1 (V0) → 2 phase 2 (V3) → 3 the M7 ACME split → 4 everything removed. At each:
# `caddy validate`, `caddy reload` under load (4 clients hammering a site, a 5 s response in flight, websockets
# open), and the same request corpus over every existing site, byte for byte against stage 0 (Date aside).
# Rig-only, never on the VPS: a global options block pointing ACME at Pebble (acme_ca, acme_ca_root).
set -uo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
export TMPDIR=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ops}
STATE=$TMPDIR/g45/$(date +%Y%m%d-%H%M%S)
mkdir -p "$STATE"
LOG=$STATE/run.log
COPY=${CADDY_VPS_COPY:-$HOME/.cache/trunk-v1/vps-ro/Caddyfile}
SNICONF=${SNI443_VPS_CONF:-$HOME/.cache/trunk-v1/vps-ro/sni-443.conf}
VPS_CADDY_VERSION=${VPS_CADDY_VERSION:-$HOME/.cache/trunk-v1/vps-ro/caddy_version.txt}
MERGE=$ROOT/trunk/deploy/caddy/caddy-merge.py
CHECK=$HERE/vps-caddy/check.py
NET=v1ops-g45 SUBNET=10.191.45.0/24
IP_PEBBLE=10.191.45.2 IP_DNS=10.191.45.3 IP_CADDY=10.191.45.10 IP_TRUNK=10.191.45.20
C_DNS=v1ops-g45-dns C_PEBBLE=v1ops-g45-pebble C_CADDY=v1ops-g45-caddy C_UP=v1ops-g45-up C_ROUTER=v1ops-g45-router C_TRUNK=v1ops-g45-trunk
ALL=("$C_UP" "$C_ROUTER" "$C_CADDY" "$C_TRUNK" "$C_PEBBLE" "$C_DNS")
CADDY_IMG=caddy:2.11.4
PY_IMG=python:3.13-slim
LJ=ljoolq.veraldar.org
AP=ap.veraldar.org
HOST_TOKEN=HostTokenOnDiskAAAAAAAAAAAAAAAAAAAAAAAAAAA   # = check.py's: a renewal file of trunk-ap's on the host
TRUNK_TOKEN=TrunkTokenInTheContainerBBBBBBBBBBBBBBBB    # only in the trunk stand-in's webroot
PASS=0 FAIL=0
say() { printf '\n== %s\n' "$*"; }
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "PASS $2"; else FAIL=$((FAIL + 1)); echo "FAIL $2${3:+  [$3]}"; fi; }
cleanup() {
  if [ "${G45_KEEP:-0}" = 1 ]; then echo "kept: ${ALL[*]} · network $NET"; return; fi
  docker rm -f "${ALL[@]}" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
J() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }   # J 'expr on d'
req() { python3 "$CHECK" req "$1" "$IP_CADDY" "$STATE/pebble-root.pem" "${@:2}"; }

# ── the rig ───────────────────────────────────────────────────────────────────────────────────────────────
for f in "$COPY" "$SNICONF"; do [ -s "$f" ] || { echo "no copy at $f (read it with the brief's read-only command)"; exit 2; }; done
command -v docker >/dev/null || { echo "docker is needed"; exit 2; }
say "G4.5 — the VPS's Caddyfile + trunk v1's blocks in $CADDY_IMG · log $LOG"
have=$(docker run --rm "$CADDY_IMG" caddy version 2>/dev/null | cut -d' ' -f1)
want=$(cut -d' ' -f1 "$VPS_CADDY_VERSION" 2>/dev/null)
ok "$([ -n "$have" ] && [ "$have" = "$want" ]; echo $?)" "the rig's Caddy is the VPS's version ($have = ${want:-?})"
cp "$COPY" "$STATE/copy.caddyfile"

say "0. the merges, as text (caddy-merge.py on the copy; the copy itself is never written)"
CF=$STATE/cf && mkdir -p "$CF"
cp "$COPY" "$CF/0-before"
python3 "$MERGE" phase1 "$CF/0-before" "$CF/1-phase1" --container "$IP_TRUNK" 2>>"$LOG" &&
  python3 "$MERGE" phase2 "$CF/1-phase1" "$CF/2-phase2" --container "$IP_TRUNK" 2>>"$LOG" &&
  python3 "$MERGE" m7-acme "$CF/2-phase2" "$CF/3-m7" --container "$IP_TRUNK" 2>>"$LOG" &&
  python3 "$MERGE" remove "$CF/3-m7" "$CF/4-removed" 2>>"$LOG"
ok $? "phase1 → phase2 → m7-acme → remove: each step merges"
n=$(wc -c <"$CF/0-before")
ok "$(cmp -s <(head -c "$n" "$CF/1-phase1") "$CF/0-before"; echo $?)" "phase 1 = the copy byte for byte, then the block appended"
ok "$(cmp -s "$CF/4-removed" "$CF/0-before"; echo $?)" "remove gives the copy back byte for byte"
ok "$(diff "$CF/2-phase2" "$CF/3-m7" | grep '^<' | grep -vqE '^< (	file_server|$)' && echo 1 || echo 0)" "the M7 split changes only the http://$AP block's body"
cp "$COPY" "$STATE/copy-moved-ap"
sed -i 's#^\(\s*\)root \* /var/www/acme#\1root * /srv/elsewhere#' "$STATE/copy-moved-ap"
python3 "$MERGE" m7-acme "$STATE/copy-moved-ap" "$STATE/x" 2>"$STATE/refuse" ; rc=$?
ok "$([ $rc != 0 ] && grep -q 'not today' "$STATE/refuse" && [ ! -e "$STATE/x" ]; echo $?)" "refused: an ap block that is not today's (the VPS changed since the rehearsal)"
python3 "$MERGE" phase2 "$CF/0-before" "$STATE/x" 2>/dev/null; ok "$([ $? != 0 ] && [ ! -e "$STATE/x" ]; echo $?)" "refused: phase 2 without phase 1"
printf 'http://%s {\n\tredir https://example.org\n}\n' "$LJ" >>"$STATE/copy-moved-ap"
python3 "$MERGE" phase1 "$STATE/copy-moved-ap" "$STATE/x" 2>/dev/null; ok "$([ $? != 0 ] && [ ! -e "$STATE/x" ]; echo $?)" "refused: a copy that already names $LJ outside our blocks"

say "the rig: Pebble + its DNS, Caddy, the VPS's :443 router, the VPS's upstreams, the trunk stand-in"
docker rm -f "${ALL[@]}" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create --subnet "$SUBNET" "$NET" >>"$LOG" 2>&1 || { echo "network $NET"; exit 2; }
SITES=$(python3 "$CHECK" sites "$COPY")
UPPORTS=$(J '" ".join(sorted({str(p) for s in d for p in s["proxies"]}))' <<<"$SITES")
mkdir -p "$STATE/www" "$STATE/trunk-webroot/.well-known/acme-challenge" "$STATE/etc-caddy" "$STATE/router"
for r in $(J '" ".join(sorted({r for s in d for r in s["roots"]}))' <<<"$SITES"); do
  d=$STATE/www/${r#/var/www/}
  mkdir -p "$d"
  printf '<!doctype html><title>rig</title><p>%s index</p>\n' "$r" >"$d/index.html"
  python3 -c "import sys; sys.stdout.write(''.join(f'console.log({i}, \"rig asset line for gzip\");\n' for i in range(800)))" >"$d/app.js"
  case $r in */acme) mkdir -p "$d/.well-known/acme-challenge" && echo "host-file" >"$d/.well-known/acme-challenge/$HOST_TOKEN" ;; esac
  case $r in */rootlink) echo "# rig root-dial.py" >"$d/root-dial.py" ;; esac
done
chmod -R a+rwX "$STATE/www" "$STATE/trunk-webroot"
echo "trunk-file" >"$STATE/trunk-webroot/.well-known/acme-challenge/$TRUNK_TOKEN"
cat >"$STATE/pebble.json" <<'JSON'
{"pebble": {"listenAddress": "0.0.0.0:14000", "managementListenAddress": "0.0.0.0:15000",
  "certificate": "test/certs/localhost/cert.pem", "privateKey": "test/certs/localhost/key.pem",
  "httpPort": 80, "tlsPort": 5001, "ocspResponderURL": "", "externalAccountBindingRequired": false,
  "keyAlgorithm": "ecdsa", "profiles": {"default": {"description": "90 days", "validityPeriod": 7776000}}}}
JSON
chmod 644 "$STATE/pebble.json"
# the rig's DNS: every name → the rig's Caddy (how Pebble finds the sites it validates)
docker run -d --name "$C_DNS" --network "$NET" --ip "$IP_DNS" ghcr.io/letsencrypt/pebble-challtestsrv:latest \
  -defaultIPv4 "$IP_CADDY" -defaultIPv6 "" -dnsserver :8053 -http01 "" -https01 "" -tlsalpn01 "" -doh "" >>"$LOG" 2>&1 || exit 2
# Pebble: http-01 on :80 only — its TLS-ALPN port 5001 has nobody behind it, so every certificate here proves http-01
docker run -d --name "$C_PEBBLE" --network "$NET" --ip "$IP_PEBBLE" --network-alias pebble -e PEBBLE_VA_NOSLEEP=1 \
  -e PEBBLE_WFE_NONCEREJECT=0 -e PEBBLE_AUTHZREUSE=0 -v "$STATE/pebble.json:/pebble.json:ro" ghcr.io/letsencrypt/pebble:latest \
  -config /pebble.json -dnsserver "$IP_DNS:8053" >>"$LOG" 2>&1 || exit 2
docker cp "$C_PEBBLE:/test/certs/pebble.minica.pem" "$STATE/pebble-acme-ca.pem" >>"$LOG" 2>&1 || exit 2
chmod 644 "$STATE/pebble-acme-ca.pem"
RIG_GLOBAL=$(printf '# G4.5 rig only — never on the VPS: ACME from the rig'"'"'s Pebble instead of Let'"'"'s Encrypt\n{\n\tacme_ca https://pebble:14000/dir\n\tacme_ca_root /pebble/pebble-acme-ca.pem\n\tocsp_stapling off\n}\n\n')
stage_file() { printf '%s\n\n' "$RIG_GLOBAL" >"$STATE/etc-caddy/Caddyfile.next"; cat "$1" >>"$STATE/etc-caddy/Caddyfile.next"; }
stage_file "$CF/0-before" && mv "$STATE/etc-caddy/Caddyfile.next" "$STATE/etc-caddy/Caddyfile"
docker run -d --name "$C_CADDY" --network "$NET" --ip "$IP_CADDY" -v "$STATE/etc-caddy:/etc/caddy:ro" -v "$STATE/www:/var/www:ro" \
  -v "$STATE/pebble-acme-ca.pem:/pebble/pebble-acme-ca.pem:ro" --tmpfs /data --tmpfs /config "$CADDY_IMG" >>"$LOG" 2>&1 || exit 2
# the VPS's upstreams and its :443 router (the copy it runs: fb189bee's sni-443.py, routing = the branch point's) in
# Caddy's network namespace, on the VPS's own ports
git -C "$ROOT" show fb189bee:trunk/deploy/sni-443.py >"$STATE/router/sni-443.py" 2>>"$LOG" || { echo "git show fb189bee"; exit 2; }
cp "$SNICONF" "$STATE/router/sni-443.conf" && chmod -R a+rX "$STATE/router"
# shellcheck disable=SC2086
docker run -d --name "$C_UP" --network "container:$C_CADDY" -v "$HERE/vps-caddy:/s:ro" "$PY_IMG" python3 -u /s/stub.py upstream $UPPORTS >>"$LOG" 2>&1 || exit 2
docker run -d --name "$C_ROUTER" --network "container:$C_CADDY" -v "$STATE/router:/r:ro" "$PY_IMG" python3 -u /r/sni-443.py -c /r/sni-443.conf >>"$LOG" 2>&1 || exit 2
docker run -d --name "$C_TRUNK" --network "$NET" --ip "$IP_TRUNK" -v "$HERE/vps-caddy:/s:ro" -v "$STATE/trunk-webroot:/w:ro" "$PY_IMG" \
  python3 -u /s/stub.py trunk 8080 /w >>"$LOG" 2>&1 || exit 2
for _ in $(seq 30); do curl -sk -o "$STATE/pebble-root.pem" "https://$IP_PEBBLE:15000/roots/0" && [ -s "$STATE/pebble-root.pem" ] && break; sleep 1; done
[ -s "$STATE/pebble-root.pem" ] || { echo "no Pebble root"; exit 2; }
HTTPS_SITES=$(J '" ".join(s["host"] for s in d if s["scheme"] == "https")' <<<"$SITES")
wait_certs() { # NAME… — each certificate obtained (verified through :443 against Pebble's root), ≤ 120 s
  local n left
  for _ in $(seq 120); do
    left=0
    for n in "$@"; do python3 "$CHECK" tls-ok "$n" "$IP_CADDY" "$STATE/pebble-root.pem" 443 2>/dev/null || left=1; done
    [ $left = 0 ] && return 0
    sleep 1
  done
  return 1
}
# shellcheck disable=SC2086
wait_certs $HTTPS_SITES; ok $? "stage 0: Caddy got a Pebble certificate for each of the copy's $(wc -w <<<"$HTTPS_SITES") https sites (http-01, through the rig's :443 router)"
API_SITE=$(J 'next(s["host"] for s in d if s["scheme"] == "https" and "/api/*" in s["handles"])' <<<"$SITES")
WS_SITE=$(J 'next((s["host"] for s in d if s["scheme"] == "https" and "/rootlink*" in s["handles"]), "")' <<<"$SITES")
STREAM=https://$API_SITE/api/stream
WS_EXISTING=${WS_SITE:+wss://$WS_SITE/rootlink/ws}

corpus() { python3 "$CHECK" corpus "$COPY" "$IP_CADDY" "$STATE/pebble-root.pem" "$STATE/corpus-$1.json"; }
same_as_0() { # STAGE
  python3 "$CHECK" compare "$STATE/corpus-0.json" "$STATE/corpus-$1.json" >"$STATE/compare-$1.txt" 2>&1; local rc=$?
  ok $rc "stage $1: every existing site answers byte for byte as in stage 0 ($(tail -1 "$STATE/compare-$1.txt"))" "$(head -4 "$STATE/compare-$1.txt" | tr '\n' ' ')"
}
to_stage() { # STAGE FILE [WS…] — validate, then reload under load; the results checked
  local st=$1 f=$2; shift 2
  stage_file "$f"
  docker exec "$C_CADDY" caddy validate --config /etc/caddy/Caddyfile.next --adapter caddyfile >"$STATE/validate-$st.log" 2>&1
  ok $? "stage $st: caddy validate passes"
  mv "$STATE/etc-caddy/Caddyfile.next" "$STATE/etc-caddy/Caddyfile"
  reload "$st" "$@"
}
reload() { # STAGE [WS…] [-- force]
  local st=$1 force='' out; shift
  [ "${!#:-}" = --force ] && { force=--force; set -- "${@:1:$#-1}"; }
  out=$(python3 "$CHECK" reload "$IP_CADDY" "$STATE/pebble-root.pem" "$API_SITE" "$STREAM" "$@" -- \
        docker exec "$C_CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile $force)
  echo "$out" >"$STATE/reload-$st.json"
  ok "$(J 'int(not (d["reload_rc"] == 0 and d["h2_bad_n"] == 0 and d["h2_ok"] > 0))' <<<"$out")" \
    "stage $st: caddy reload${force:+ --force} ($(J 'd["reload_s"]' <<<"$out") s): browser-like clients (HTTP/2, a new connection each) $(J 'd["h2_ok"]' <<<"$out") answered, $(J 'd["h2_bad_n"]' <<<"$out") failed" \
    "$(J 'd["reload_err"] or d["h2_bad"]' <<<"$out")"
  ok "$(J 'int(not (d["stream"]["status"] == 200 and d["stream"]["len"] == 25000))' <<<"$out")" \
    "stage $st: a 5 s response in flight through the reload arrives whole ($(J 'd["stream"]' <<<"$out"))"
  echo "   INFO HTTP/1.1 clients opening a connection as the reload lands: $(J 'd["h1_bad_n"]' <<<"$out") empty replies of $(J 'd["h1_ok"] + d["h1_bad_n"]' <<<"$out") (stage 0's reload of the unchanged file: $( [ -f "$STATE/reload-0.json" ] && J 'd["h1_bad_n"]' <"$STATE/reload-0.json" || echo '—')) — Caddy's own reload; HTTP/2 gets a GOAWAY instead"
}
ws_result() { J "d.get('ws $2', {})" <"$STATE/reload-$1.json"; }

say "stage 0: the copy as it is"
corpus 0; ok $? "stage 0: the corpus ($(J 'len(d)' <"$STATE/corpus-0.json") requests over $(J 'len(d)' <<<"$SITES") sites + unknown names)"
reload 0 ${WS_EXISTING:+"$WS_EXISTING"} --force   # the baseline: today's file reloaded as it is
[ -n "$WS_EXISTING" ] && echo "   INFO a websocket through an existing site across a reload of TODAY's file: $(ws_result 0 "$WS_EXISTING") (Caddy's default: streams close at a reload)"
r=$(req "http://$LJ/x?y=1"); echo "   before: http://$LJ/ → $(J 'd.get("status", d.get("error"))' <<<"$r") (not ours yet)"
certbot_order() { # WEBROOT_DIR LABEL — an ACME http-01 order for ap. with certbot --webroot, validated by Pebble through Caddy
  docker run --rm --network "$NET" --user "$(id -u):$(id -g)" -e REQUESTS_CA_BUNDLE=/ca.pem -v "$STATE/pebble-acme-ca.pem:/ca.pem:ro" \
    -v "$1:/w" certbot/certbot:latest certonly --server https://pebble:14000/dir --webroot -w /w -d "$AP" --agree-tos \
    --register-unsafely-without-email --non-interactive --config-dir /tmp/c --work-dir /tmp/w --logs-dir /tmp/l >"$STATE/certbot-$2.log" 2>&1
}
certbot_order "$STATE/www/acme" host-0; ok $? "stage 0: trunk-ap's renewal (certbot --webroot /var/www/acme) validates through Caddy today"

say "stage 1: phase 1 (V0) — $LJ through Caddy to the container"
to_stage 1 "$CF/1-phase1" ${WS_EXISTING:+"$WS_EXISTING"}
[ -n "$WS_EXISTING" ] && echo "   INFO a websocket through an existing site (${WS_SITE%%.*}… /rootlink, Caddy's default) across the reload: $(ws_result 1 "$WS_EXISTING") — today's behaviour, untouched by us"
corpus 1; same_as_0 1
wait_certs "$LJ"; ok $? "stage 1: Caddy obtained $LJ's certificate (verified through :443 against Pebble's root)"
ok "$(docker logs "$C_CADDY" 2>&1 | grep "$LJ" | grep -q '"challenge_type":"http-01"' && ! docker logs "$C_CADDY" 2>&1 | grep "$LJ" | grep '"challenge_type":"tls-alpn-01"' | grep -q 'validated'; echo $?)" \
  "stage 1: … by http-01, answered by Caddy itself before the redirect block (Pebble has no TLS-ALPN port here)"
r=$(req "http://$LJ/x?y=1")
ok "$([ "$(J 'd["status"]' <<<"$r")" = 301 ] && J 'dict(d["headers"]).get("Location")' <<<"$r" | grep -qx "https://$LJ/x?y=1"; echo $?)" "stage 1: http://$LJ/x?y=1 → 301 https://$LJ/x?y=1" "$r"
r=$(req "https://$LJ/t/state")
ok "$([ "$(J 'd["status"]' <<<"$r")" = 200 ] && J 'd["body"]' <<<"$r" | grep -q '"claimed":false'; echo $?)" "stage 1: https://$LJ/t/state (through :443 → sni-443 default → Caddy) → the container's 200" "$r"
r=$(req "https://$LJ/echo" -H "X-Forwarded-For: 6.6.6.6")
xff=$(J '__import__("json").loads(d["body"])["xff"]' <<<"$r")
xfp=$(J '__import__("json").loads(d["body"])["xfp"]' <<<"$r"); host=$(J '__import__("json").loads(d["body"])["host"]' <<<"$r")
ok "$([ "$xff" != "6.6.6.6" ] && ! grep -q 6.6.6.6 <<<"$xff" && [ "$xfp" = https ] && [ "$host" = "$LJ" ]; echo $?)" \
  "stage 1: the container gets Host $LJ, X-Forwarded-Proto https, and never a client's own X-Forwarded-For (sent 6.6.6.6, got $xff)"
echo "   FINDING the client address the container sees through :443 is $xff: sni-443's default route carries no PROXY line,"
echo "   so Caddy sees every phone as the router's loopback (region binding and per-address limits see one client)"
r=$(req "https://$LJ/echo" --port 8443); echo "   (direct to :8443 the container would see $(J '__import__("json").loads(d["body"])["xff"]' <<<"$r" 2>/dev/null) — the provider blocks 8443 from outside)"
# a later reload (anything that touches the Caddyfile) with the trunk's links open: stream_close_delay keeps them
reload 1b "wss://$LJ/ws" ${WS_EXISTING:+"$WS_EXISTING"} --force
ok "$(J 'int(not (d["ws wss://'"$LJ"'/ws"]["before"] is True and d["ws wss://'"$LJ"'/ws"]["after"] is True))' <"$STATE/reload-1b.json")" \
  "stage 1: a root's websocket through $LJ survives a later caddy reload (stream_close_delay 10m): $(ws_result 1b "wss://$LJ/ws")"
[ -n "$WS_EXISTING" ] && echo "   INFO the existing site's websocket across that reload: $(ws_result 1b "$WS_EXISTING")"

say "stage 2: phase 2 (V3) — the trunk's own TLS; Caddy keeps plain http for $LJ"
to_stage 2 "$CF/2-phase2"
corpus 2; same_as_0 2
r=$(req "http://$LJ/.well-known/acme-challenge/$TRUNK_TOKEN")
ok "$([ "$(J 'd["status"]' <<<"$r")" = 200 ] && [ "$(J 'd["body"].strip()' <<<"$r")" = trunk-file ]; echo $?)" "stage 2: http://$LJ/.well-known/acme-challenge/<token> → the container's webroot" "$r"
r=$(req "http://$LJ/x?y=1")
ok "$([ "$(J 'd["status"]' <<<"$r")" = 301 ] && J 'dict(d["headers"]).get("Location")' <<<"$r" | grep -qx "https://$LJ/x?y=1"; echo $?)" "stage 2: http://$LJ/x?y=1 → 301 https" "$r"
r=$(req "http://$LJ/.well-known/acme-challenge/short")
ok "$([ "$(J 'd["status"]' <<<"$r")" = 301 ]; echo $?)" "stage 2: a name that is not token-shaped is not passed on (301)" "$r"
r=$(req "https://$LJ/t/state" --port 8443)
ok "$([ "$(J 'd.get("status")' <<<"$r")" != 200 ]; echo $?)" "stage 2: Caddy no longer serves https for $LJ ($(J 'd.get("status", d.get("error"))' <<<"$r"); sni-443 v2 routes it to the container)"

say "stage 3: the M7 ACME split for http://$AP"
to_stage 3 "$CF/3-m7"
corpus 3; same_as_0 3
r=$(req "http://$AP/.well-known/acme-challenge/$HOST_TOKEN")
ok "$([ "$(J 'd["status"]' <<<"$r")" = 200 ] && [ "$(J 'd["body"].strip()' <<<"$r")" = host-file ]; echo $?)" "stage 3: a token file on the host is served from disk (trunk-ap's renewals)" "$r"
r=$(req "http://$AP/.well-known/acme-challenge/$TRUNK_TOKEN")
ok "$([ "$(J 'd["status"]' <<<"$r")" = 200 ] && [ "$(J 'd["body"].strip()' <<<"$r")" = trunk-file ]; echo $?)" "stage 3: a token not on the host → the container's webroot" "$r"
certbot_order "$STATE/www/acme" host-3; ok $? "stage 3: trunk-ap's renewal (certbot --webroot on the host) still validates through Caddy"
certbot_order "$STATE/trunk-webroot" trunk-3; ok $? "stage 3: the trunk's own order for $AP (certbot --webroot in the container's webroot) validates through the split"

say "stage 4: every trunk-v1 block removed — the copy as it was"
to_stage 4 "$CF/4-removed"
corpus 4; same_as_0 4
r=$(req "http://$LJ/x?y=1"); ok "$([ "$(J 'd.get("status")' <<<"$r")" != 301 ] || ! J 'dict(d["headers"]).get("Location","")' <<<"$r" | grep -q "$LJ"; echo $?)" "stage 4: $LJ is not ours any more"

echo
echo "G4.5: $PASS passed, $FAIL failed · log $LOG · state $STATE"
[ "$FAIL" = 0 ] && { echo "VERDICT: GREEN"; exit 0; }
echo "VERDICT: RED"; exit 1
