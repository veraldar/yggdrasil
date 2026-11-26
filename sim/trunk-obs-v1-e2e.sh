#!/usr/bin/env bash
# trunk-obs-v1-e2e.sh — G3.5: the trunk meter (P16) end to end on v1 (`bifrost-net trunk` +
# `bridge [trunk]`) on loopback ports in LADDER's range (default OBS_PORT_BASE=18770, never live).
#
#   curl ──▶ v1 trunk (http loopback) ◀──WS /t/root proto 2── bridge [trunk] ──▶ stub upstream
#
# Keeps the exact P16 checks of sim/trunk-obs-e2e.sh (v0.9 version stays runnable for baselines).
#   sim/trunk-obs-v1-e2e.sh [--keep]      exit 0 = all green (≈ 3 minutes: waits for minute ticks)
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

BASE_TMP=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ladder}
mkdir -p "$BASE_TMP"
W=$(mktemp -d "$BASE_TMP/trunk-obs-v1.XXXXXX")
OBS=$W/obs
TR_PID=; BR_PID=; UP_PID=
cleanup() {
  for p in $TR_PID $BR_PID $UP_PID; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  [ "$KEEP" = --keep ] && echo "kept: $W" || rm -rf "$W"
}
trap cleanup EXIT

P=${OBS_PORT_BASE:-18770}
TR_PORT=$P; HTTP=$((P + 1)); MEDIA=$((P + 2)); UPP=$((P + 3)); ICE=$((P + 4))
HTTP_OFF=$((P + 5)); MEDIA_OFF=$((P + 6))

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

# v1 trunk config
mkdir -p "$W/trunk/cred" "$W/state"
"$BIN" trunk-kek "$W/trunk/cred/trunk-kek" >/dev/null
TRUNK_URL="http://127.0.0.1:$TR_PORT"
cat > "$W/trunk/trunk.toml" <<EOF
public_url = "$TRUNK_URL"
listen_http = "127.0.0.1:$TR_PORT"
listen_ice = "127.0.0.1:$ICE"
trusted_proxies = ["127.0.0.1/32"]
db = "$W/trunk/trunk.db"
state_dir = "$W/trunk"
cred_dir = "$W/trunk/cred"
ctl_socket = "$W/trunk/ctl.sock"
rp_id = "127.0.0.1"
origins = ["$TRUNK_URL"]
ice_owner_from = ["127.0.0.1/32"]
EOF

export BIFROST_PROBE_EVERY_S=4
echo "== the v1 trunk meter, end to end (work dir $W, ports $P..$((P+6)))"
BIFROST_OBS_DIR= TRUNK_TEST_FAST=1 "$BIN" trunk -c "$W/trunk/trunk.toml" > "$W/trunk.log" 2>&1 & TR_PID=$!
for _ in $(seq 50); do curl -sf "$TRUNK_URL/t/state" >/dev/null && break; sleep 0.1; done

# seed admin + mint tokens: GOOD (loopback), ROAM (other region), OLD (expired)
TRUNK_TEST_FAST=1 "$BIN" trunk-rig seed-admin -c "$W/trunk/trunk.toml" --device dev_good >/dev/null
GOOD=$(TRUNK_TEST_FAST=1 "$BIN" trunk-rig mint -c "$W/trunk/trunk.toml" --device dev_good)
ROAM=$(TRUNK_TEST_FAST=1 "$BIN" trunk-rig mint -c "$W/trunk/trunk.toml" --device dev_good --region "net:9.9.0.0/16" 2>/dev/null || echo "")

# enroll one door root
RK=$("$BIN" root-key "$W/state/root.key" | sed -n 's/^public_key = "\(.*\)"/\1/p')
WK=$("$BIN" wg-key "$W/state/wg.key" | sed -n 's/^public_key = "\(.*\)"/\1/p')
python3 - "$TRUNK_URL" "$GOOD" "$RK" "$WK" "$W/state/enrolled.json" <<'PY'
import json, sys, urllib.request
url, tok, rk, wk, out_path = sys.argv[1:6]
hdr = {"content-type": "application/json", "origin": url, "cookie": "bifrost_device=" + tok}
def post(path, body, h=None):
    req = urllib.request.Request(url + path, data=json.dumps(body).encode(), method="POST", headers=h or {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())
st = post("/t/roots/enroll", {"hostname": "obs-box", "os": "linux", "arch": "x86_64", "root_pub": rk, "wg_pub": wk, "has_app": True, "has_voice": False})
post(f"/t/roots/enroll/{st['id']}/approve", {"name": "obs-home"}, hdr)
res = post(f"/t/roots/enroll/{st['id']}/poll", {"secret": st["poll_secret"]})
assert res.get("status") == "approved", res
json.dump(res, open(out_path, "w"), indent=2)
PY
ROOT_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["root_id"])' "$W/state/enrolled.json")
TRUNK_KEY=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["trunk"]["trunk_key"])' "$W/state/enrolled.json")

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

[trunk]
url = "$TRUNK_URL"
trunk_key = "$TRUNK_KEY"
root_key_file = "$W/state/root.key"
root_id = "$ROOT_ID"
state_file = "$W/state/trunk-state.json"
upstream = "127.0.0.1:$UPP"
ice_tcp = []
EOF

# the bridge's meter folder defaults to <state>/../obs = $W/obs
env -u BIFROST_OBS_DIR "$BIN" bridge -c "$W/bridge.toml" > "$W/bridge.log" 2>&1 & BR_PID=$!
for _ in $(seq 100); do [ -f "$W/state/trunk-state.json" ] && grep -q '"state": "up"' "$W/state/trunk-state.json" 2>/dev/null && break; sleep 0.1; done
check "v1 channel up, meter on in bridge (files beside state folder)" \
  'grep -q "meter: on — $W/state/../obs" $W/bridge.log && grep -q "\"state\": \"up\"" $W/state/trunk-state.json'

C="curl -s -o /dev/null -w %{http_code}"
U="$TRUNK_URL"
codes=""
for path in / /api/session "/api/session/ses_secret123/messages?q=private" /api/slow /api/fail; do
  codes="$codes $($C -H "Authorization: Bearer $GOOD" "$U$path")"
done
codes="$codes $($C -H "Authorization: Bearer $GOOD" -H "X-Forwarded-For: 9.9.9.9" $U/api/session)" # region mismatch
codes="$codes $($C -H "Authorization: Bearer v4.public.invalid" $U/api/session)"                      # invalid token
codes="$codes $($C $U/api/session)"                                                                  # missing token
check "answers through the v1 trunk: 200 200 200 200 503 401 401 401 (got:$codes)" \
  '[ "$codes" = " 200 200 200 200 503 401 401 401" ]'

# wait for minute ticks (up to 130 s)
end=$(( $(date +%s) + 130 )); want=2
while [ "$(date +%s)" -lt $end ]; do
  n=$(cat "$OBS"/bridge-min-*.jsonl 2>/dev/null | wc -l)
  [ "$n" -ge $want ] && break
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
               and {200, 503} <= {s["st"] for s in streams} and all("ttfb_ms" in s and "ms" in s for s in streams),
    "minutes": c(mn, "streams") >= 5 and all("rss" in l.get("p", {}) for l in mn),
    "probe_ap": c(ap, "edge.probe.ok") >= 1 and any("edge.probe.link" in l["h"] for l in ap),
    "ap_home": bool(ap) and all("tot" in l and l["proc"] == "ap" for l in ap),
}
ok = checks[what]
if not ok:
    print(f"   ({what}: streams={[(s['route'], s['st']) for s in streams]} ap={len(ap)} min={len(mn)})", file=sys.stderr)
sys.exit(0 if ok else 1)
EOF2
chk() { python3 "$W/chk.py" "$OBS" "$1"; }
check "a record per stream: route classes, status, first byte" 'chk streams'
check "nothing secret in the files (no session id, no query, no token)" \
  '! grep -rq -e ses_secret123 -e "q=private" -e "$GOOD" "$OBS"'
check "minute lines: streams, process numbers" 'chk minutes'
check "the trunk's own test request answered by the bridge (PROBE over /t/root)" 'chk probe_ap'
check "the trunk's minute lines came home over /t/root (ap-min beside bridge-min)" 'chk ap_home'

O=$(curl -s "http://127.0.0.1:$HTTP/_obs")
check "/_obs answers on loopback: the last minutes" \
  'echo "$O" | python3 -c "import json,sys; v=json.load(sys.stdin); assert v[\"on\"] and v[\"proc\"]==\"bridge\" and v[\"minutes\"]"'
check "/_obs refuses a proxied request" \
  '[ "$(curl -s -o /dev/null -w %{http_code} -H "X-Forwarded-For: 1.2.3.4" "http://127.0.0.1:$HTTP/_obs")" = 403 ]'

# cut the channel: stop the trunk, wait, start it again
kill "$TR_PID"; wait "$TR_PID" 2>/dev/null; TR_PID=
sleep 6
BIFROST_OBS_DIR= TRUNK_TEST_FAST=1 "$BIN" trunk -c "$W/trunk/trunk.toml" > "$W/trunk2.log" 2>&1 & TR_PID=$!
for _ in $(seq 150); do [ "$(grep -c '"kind":"link.up"' "$OBS"/bridge-events-*.jsonl 2>/dev/null || echo 0)" -ge 2 ] && break; sleep 0.2; done
EV=$(cat "$OBS"/bridge-events-*.jsonl 2>/dev/null || true)
check "the channel's drop and reconnect are recorded in bridge events" \
  'echo "$EV" | grep -q "\"kind\":\"link.down\"" && [ "$(echo "$EV" | grep -c "\"kind\":\"link.up\"")" -ge 2 ]'

python3 "$HERE/../scripts/trunk-report.py" --obs "$OBS" --out "$W/art" day --day "$(date +%F)" > "$W/report.txt" 2>&1
check "the morning page builds from these files (no scripts in it)" \
  '[ -s "$W/art/trunk-day-$(date +%F).html" ] && ! grep -q "<script" "$W/art/trunk-day-$(date +%F).html" && grep -q "trunk-day" "$W/report.txt"'

# BIFROST_OBS=off: nothing written
kill "$BR_PID"; wait "$BR_PID" 2>/dev/null; BR_PID=
mkdir -p "$W/off/state"; cp "$W/state/root.key" "$W/off/state/"
sed "s#$W/state/#$W/off/state/#g; s/127.0.0.1:$HTTP/127.0.0.1:$HTTP_OFF/; s/127.0.0.1:$MEDIA/127.0.0.1:$MEDIA_OFF/" "$W/bridge.toml" > "$W/off/bridge.toml"
BIFROST_OBS=off "$BIN" bridge -c "$W/off/bridge.toml" > "$W/off/bridge.log" 2>&1 & BR_PID=$!
sleep 4
check "BIFROST_OBS=off: no folder, no files" '[ ! -e "$W/off/obs" ]'

echo "TRUNK-OBS-V1 E2E: $PASS/$TOTAL PASS"
[ "$PASS" = "$TOTAL" ]
