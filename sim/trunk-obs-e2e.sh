#!/usr/bin/env bash
# trunk-obs-e2e.sh — the trunk meter (proposal v2) end to end on loopback, nothing live touched:
#   curl ─TLS─▶ ap (self-signed) ◀─wss, pinned─ bridge ─▶ a stub upstream (python, this script)
# Checks: per-stream records with route/status/ttfb; refusals by reason and hint (with the
# device); both test requests (home → ap → bridge, and the ap's own) answered by the bridge;
# the channel's ping round trip; the ap's minute lines arriving home over the channel
# (ap-min-*.jsonl beside the bridge's); /_obs on loopback (and refused when proxied); a channel
# cut → its reason, failing probes, the ap's backlog after it comes back; the log printing a
# repeated warning once. Then BIFROST_OBS=off writes nothing.
#
#   sim/trunk-obs-e2e.sh [--keep]      exit 0 = all green (≈ 3 minutes: it waits for minute ticks)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TRUNK=$HERE/../trunk
BIN=${BIN:-$TRUNK/target/release/bifrost-net}
KEEP=${1:-}
PASS=0; TOTAL=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); }
fail() { echo "  [FAIL] $1"; TOTAL=$((TOTAL+1)); }
check() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }
[ -x "$BIN" ] || (cd "$TRUNK" && cargo build --release -q) || { echo "build failed"; exit 1; }
W=$(mktemp -d "$HOME/.cache/trunk-obs-e2e.XXXXXX")
OBS=$W/obs
AP_PID=; BR_PID=; UP_PID=
cleanup() { for p in $AP_PID $BR_PID $UP_PID; do kill "$p" 2>/dev/null; done; [ "$KEEP" = --keep ] && echo "kept: $W" || rm -rf "$W"; }
trap cleanup EXIT
P=$((30000 + RANDOM % 20000)); APP=$P; HTTP=$((P + 1)); MEDIA=$((P + 2)); UPP=$((P + 3))

# the stub upstream: 200 for everything, a 503 on /api/fail, slow on /api/slow
cat > "$W/up.py" <<'EOF'
import http.server, sys, time
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/api/slow"): time.sleep(0.3)
        code = 503 if self.path.startswith("/api/fail") else 200
        body = b"stub\n"
        self.send_response(code); self.send_header("Content-Length", str(len(body))); self.send_header("Connection", "close"); self.end_headers(); self.wfile.write(body)
    do_POST = do_GET
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
EOF
python3 "$W/up.py" "$UPP" & UP_PID=$!

CERT=$("$BIN" ap-cert "$W/tls" localhost 127.0.0.1)
PIN=$(echo "$CERT" | sed -n 's/^pin = "\(.*\)"/\1/p')
TOK=$("$BIN" ap-token)
BTOK=$(echo "$TOK" | sed -n 's/^token = "\([0-9a-f]*\)".*/\1/p')
BHASH=$(echo "$TOK" | sed -n 's/^bridge_token_sha256 = "\([0-9a-f]*\)".*/\1/p')
cat > "$W/ap.toml" <<EOF
[ap]
listen = "127.0.0.1:$APP"
cert_path = "$W/tls/cert.pem"
key_path = "$W/tls/key.pem"
bridge_token_sha256 = "$BHASH"
EOF
sha() { printf %s "$1" | sha256sum | cut -d' ' -f1; }
GOOD=$(head -c 24 /dev/urandom | xxd -p | tr -d '\n'); ROAM=$(head -c 24 /dev/urandom | xxd -p | tr -d '\n')
OLD=$(head -c 24 /dev/urandom | xxd -p | tr -d '\n')
NOW=$(date +%s%3N); EXP=$((NOW + 3600000))
mkdir -p "$W/state"
cat > "$W/state/devices.json" <<EOF
{"version":2,"killEpoch":0,"devices":[
 {"id":"dev_good","revoked":false,"access":[{"hash":"$(sha "$GOOD")","exp":$EXP,"region":"loopback"}]},
 {"id":"dev_roam","revoked":false,"access":[{"hash":"$(sha "$ROAM")","exp":$EXP,"region":"net:9.9.0.0/16"}]},
 {"id":"dev_old","revoked":false,"access":[{"hash":"$(sha "$OLD")","exp":$((NOW - 1000)),"region":"loopback"}]}]}
EOF
PRIV=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
cat > "$W/bridge.toml" <<EOF
[node]
name = "obs-e2e"
private_key = "$PRIV"

[bridge]
http = "127.0.0.1:$HTTP"
media = "127.0.0.1:$MEDIA"
tokens_file = "$W/state/devices.json"
opencode_url = "http://127.0.0.1:9"

[ap]
url = "wss://localhost:$APP/ap"
pin = "$PIN"
token = "$BTOK"
upstream = "127.0.0.1:$UPP"
EOF
export BIFROST_PROBE_EVERY_S=4
echo "== the trunk meter, end to end (work dir $W)"
BIFROST_OBS_DIR= "$BIN" ap -c "$W/ap.toml" > "$W/ap.log" 2>&1 & AP_PID=$!
for _ in $(seq 50); do grep -q LIVE "$W/ap.log" && break; sleep 0.1; done
# the bridge's meter folder defaults to <state>/../obs = $W/obs
env -u BIFROST_OBS_DIR "$BIN" bridge -c "$W/bridge.toml" > "$W/bridge.log" 2>&1 & BR_PID=$!
for _ in $(seq 100); do grep -q "channel up" "$W/bridge.log" && break; sleep 0.1; done
check "channel up, meter on in both (bridge files beside the state folder, ap memory only)" \
  'grep -q "channel up" $W/bridge.log && grep -q "meter: on — $W/state/../obs" $W/bridge.log && grep -q "meter: on — memory only" $W/ap.log'

C="curl -sk --resolve localhost:$APP:127.0.0.1 -o /dev/null -w %{http_code}"
U=https://localhost:$APP
codes=""
for path in / /api/session "/api/session/ses_secret123/messages?q=private" /api/slow /api/fail; do
  codes="$codes $($C -H "Authorization: Bearer $GOOD" "$U$path")"
done
codes="$codes $($C -H "Authorization: Bearer $ROAM" $U/api/session)"   # issued in another region
codes="$codes $($C -H "Authorization: Bearer $OLD" $U/api/session)"    # expired
codes="$codes $($C $U/api/session)"                                     # no token at all
codes="$codes $($C $U/_probe)"                                          # a stranger's /_probe
check "answers through the trunk: 200 200 200 200 503 401 401 401 404 (got:$codes)" '[ "$codes" = " 200 200 200 200 503 401 401 401 404" ]'

# wait for the probes (every 4 s) and two minute ticks
end=$(( $(date +%s) + 130 )); want=2
while [ "$(date +%s)" -lt $end ]; do
  n=$(cat "$OBS"/bridge-min-*.jsonl 2>/dev/null | wc -l)
  [ "$n" -ge $want ] && grep -q '"from":"home","ok":true' "$OBS"/bridge-events-*.jsonl 2>/dev/null && ls "$OBS"/ap-min-*.jsonl >/dev/null 2>&1 && break
  sleep 2
done
cat > "$W/chk.py" <<'EOF2'
import glob, json, os, sys
obs, what = sys.argv[1], sys.argv[2]
def lines(pat):
    out = []
    for f in sorted(glob.glob(os.path.join(obs, pat))):
        out += [json.loads(x) for x in open(f) if x.strip()]
    return out
ev, mn, ap = lines("bridge-events-*.jsonl"), lines("bridge-min-*.jsonl"), lines("ap-min-*.jsonl")
streams = [e for e in ev if e["kind"] == "stream"]
c = lambda L, k: sum(l["c"].get(k, 0) for l in L)
checks = {
    "streams": {"page", "api.session", "api.session.messages", "api.other"} <= {s["route"] for s in streams}
               and {200, 401, 503} <= {s["st"] for s in streams} and all("ttfb_ms" in s and "ms" in s for s in streams),
    "deny": any(e["kind"] == "deny" and e["why"] == "region" and e["device"] == "dev_roam" and e["hint"] == "refresh" for e in ev)
            and any(e["kind"] == "deny" and e["why"] == "expired" and e["device"] == "dev_old" for e in ev),
    "probe_home": any(e["kind"] == "probe" and e["from"] == "home" and e["ok"] for e in ev),
    "minutes": c(mn, "streams") >= 9 and c(mn, "gate.deny.region") == 1 and any("link.rtt" in l["h"] for l in mn)
               and c(mn, "probe.home.ok") >= 1 and all("rss" in l.get("p", {}) for l in mn),
    "probe_ap": c(ap, "edge.probe.ok") >= 1 and any("edge.probe.link" in l["h"] for l in ap),
    "ap_home": bool(ap) and all("tot" in l and l["proc"] == "ap" for l in ap) and c(ap, "edge.tls.ok") >= 9,
}
ok = checks[what]
if not ok:
    print(f"   ({what}: streams={[(s['route'], s['st']) for s in streams]} denies={[e for e in ev if e['kind']=='deny']} ap={len(ap)} min={len(mn)})", file=sys.stderr)
sys.exit(0 if ok else 1)
EOF2
chk() { python3 "$W/chk.py" "$OBS" "$1"; }
check "a record per stream: route classes, status, first byte" 'chk streams'
check "nothing secret in the files (no session id, no query, no token)" \
  '! grep -rq -e ses_secret123 -e "q=private" -e "$GOOD" -e "$ROAM" -e "$OLD" "$OBS"'
check "refusals by reason, with the device and the hint (region→refresh dev_roam, expired dev_old)" 'chk deny'
check "the home test request (home → ap → channel → bridge → back) answered" 'chk probe_home'
check "minute lines: streams, gate counts, ping round trip, the probe, process numbers" 'chk minutes'
check "the ap's own test request answered by the bridge (PROBE over the channel)" 'chk probe_ap'
check "the ap's minute lines came home over the channel (ap-min beside bridge-min), with totals" 'chk ap_home'
O=$(curl -s "http://127.0.0.1:$HTTP/_obs")
check "/_obs answers on loopback: the last minutes + what the VPS sent" \
  'echo "$O" | python3 -c "import json,sys; v=json.load(sys.stdin); assert v[\"on\"] and v[\"proc\"]==\"bridge\" and v[\"minutes\"] and v[\"from\"][\"ap\"]"'
check "/_obs refuses a proxied request" \
  '[ "$(curl -s -o /dev/null -w %{http_code} -H "X-Forwarded-For: 1.2.3.4" "http://127.0.0.1:$HTTP/_obs")" = 403 ]'

# cut the channel: stop the ap, let probes fail, start it again
kill "$AP_PID"; wait "$AP_PID" 2>/dev/null; AP_PID=
sleep 12
BIFROST_OBS_DIR= "$BIN" ap -c "$W/ap.toml" > "$W/ap2.log" 2>&1 & AP_PID=$!
for _ in $(seq 150); do [ "$(grep -c 'channel up' "$W/bridge.log")" -ge 2 ] && break; sleep 0.2; done
sleep 6
EV=$(cat "$OBS"/bridge-events-*.jsonl)
check "the channel's drop has a reason, and the reconnect is an event" \
  'echo "$EV" | grep "\"kind\":\"link.down\"" | grep -q "\"why\":\"error\"" && echo "$EV" | grep "\"kind\":\"link.fail\"" | grep -q "\"why\":\"connect\"" && [ "$(echo "$EV" | grep -c "\"kind\":\"link.up\"")" -ge 2 ]'
check "probes failed while it was down, and answer again after" \
  'echo "$EV" | grep "\"kind\":\"probe\"" | grep -q "\"ok\":false" && echo "$EV" | grep "\"kind\":\"probe\"" | tail -1 | grep -q "\"ok\":true"'
python3 "$HERE/../scripts/trunk-report.py" --obs "$OBS" --out "$W/art" day --day "$(date +%F)" > "$W/report.txt" 2>&1
check "the morning page builds from these files (no scripts in it)" \
  '[ -s "$W/art/trunk-day-$(date +%F).html" ] && ! grep -q "<script" "$W/art/trunk-day-$(date +%F).html" && grep -q "trunk-day" "$W/report.txt"'
python3 "$HERE/../scripts/trunk-report.py" --obs "$OBS" watch > "$W/watch.txt" 2>&1
check "the watcher reports the outage (2+ failed test requests) once" \
  '[ "$(grep -c "was not answering\|not answering since" "$W/watch.txt")" = 1 ]'
python3 "$HERE/../scripts/trunk-report.py" --obs "$OBS" watch > "$W/watch2.txt" 2>&1
check "…and not again on its next run" '! grep -q "not answering" "$W/watch2.txt"'

# BIFROST_OBS=off: nothing written
kill "$BR_PID"; wait "$BR_PID" 2>/dev/null; BR_PID=
mkdir -p "$W/off/state"; cp "$W/state/devices.json" "$W/off/state/"
sed "s#$W/state/devices.json#$W/off/state/devices.json#; s/127.0.0.1:$HTTP/127.0.0.1:$((P + 4))/; s/127.0.0.1:$MEDIA/127.0.0.1:$((P + 5))/" "$W/bridge.toml" > "$W/off/bridge.toml"
BIFROST_OBS=off "$BIN" bridge -c "$W/off/bridge.toml" > "$W/off/bridge.log" 2>&1 & BR_PID=$!
sleep 4
check "BIFROST_OBS=off: no folder, no files" '[ ! -e "$W/off/obs" ]'

echo "TRUNK-OBS E2E: $PASS/$TOTAL PASS"
[ "$PASS" = "$TOTAL" ]
