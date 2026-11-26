#!/usr/bin/env bash
# sim/trunk-v1-coexist.sh — G3.8: real v0.9 bifrost-net ap + real v1 bifrost-net trunk behind ONE
# trunk/deploy/sni-443.py (v2), with real LiveKit (~/.cache/trunk-rtc/livekit-server) on both sides.
# Runs in a private user+net+mount+pid namespace (nothing live touched, every process reaped at exit).
# Ports inside namespace: 19143–19170 (OPS range 19100–19199, CONTRACTS.md C7).
#
#   bash sim/trunk-v1-coexist.sh     exit 0 = every step PASS (step-table format for sim/v1-gates.json G3.8)
set -euo pipefail
ROOT=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
if [ -z "${COEXIST_NS:-}" ]; then
  exec unshare --user --map-root-user --net --mount --pid --fork --mount-proc \
    env COEXIST_NS=1 "$0" "$@"
fi

BIN=${BIFROST_NET_BIN:-$ROOT/trunk/target/release/bifrost-net}
LK_BIN=${LIVEKIT_BIN:-$HOME/.cache/trunk-rtc/livekit-server}
[ -x "$BIN" ] || { echo "build bifrost-net first: (cd trunk && cargo build --release)"; exit 2; }
[ -x "$LK_BIN" ] || { echo "no livekit-server at $LK_BIN"; exit 2; }

export TMPDIR=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ops}
mkdir -p "$TMPDIR"
STATE=${COEXIST_STATE:-$(mktemp -d "$TMPDIR/coexist.XXXXXX")}
mkdir -p "$STATE"/{v0/tls,v1/tls,v1/cred} && chmod 700 "$STATE"
rm -f "$STATE/steps.tsv"

# Bring up loopback + non-loopback dummy IPs (pion/ice requires non-loopback node_ip for ICE-TCP)
# and bind-mount /etc/hosts + /etc/nsswitch.conf so ap.veraldar.org & ljoolq.veraldar.org resolve to 127.0.0.1
ip link set lo up
ip link add d0 type dummy
ip addr add 198.51.100.20/24 dev d0
ip addr add 198.51.100.21/24 dev d0
ip link set d0 up
{ cat /etc/hosts; echo "127.0.0.1 ap.veraldar.org ljoolq.veraldar.org"; } >"$STATE/hosts"
printf 'hosts: files\n' >"$STATE/nsswitch.conf"
mount --bind "$STATE/hosts" /etc/hosts
mount --bind "$STATE/nsswitch.conf" /etc/nsswitch.conf

# OPS port range 19100–19199
DOOR_PORT=19143
V0_AP_PORT=19150 V0_ICE_PORT=19151 V0_APP_PORT=19152 V0_LK_HTTP=19153 V0_LK_TCP=19154 V0_LK_UDP=19155 V0_BR_HTTP=19156 V0_BR_MEDIA=19157
V1_TLS_PORT=19160 V1_HTTP_PORT=19161 V1_ICE_PORT=19162 V1_APP_PORT=19163 V1_LK_HTTP=19164 V1_LK_TCP=19165 V1_LK_UDP=19166 V1_BR_HTTP=19167 V1_BR_MEDIA=19168
SITE_PORT=19170

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  if [ -f "$STATE/v1/trunk.pid" ]; then kill "$(cat "$STATE/v1/trunk.pid")" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. Minimal app upstreams (v0.9 app, v1 app, default site) ────────────────────────────────────────────
python3 - "$V0_APP_PORT" "$V1_APP_PORT" "$SITE_PORT" >"$STATE/apps.log" 2>&1 <<'PY' &
import http.server, sys, threading, time

def start(port, label):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *a): pass
        def do_GET(self):
            if self.path == "/stream":
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                try:
                    for i in range(600):
                        chunk = f"tick-{i}\n".encode()
                        self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                        self.wfile.flush()
                        time.sleep(0.25)
                except OSError:
                    pass
                return
            body = f"{label}\n".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    s = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
    s.daemon_threads = True
    s.serve_forever()

for p, lbl in ((int(sys.argv[1]), "v0.9-app-ok"), (int(sys.argv[2]), "v1-app-ok"), (int(sys.argv[3]), "website-ok")):
    threading.Thread(target=start, args=(p, lbl), daemon=True).start()
while True:
    time.sleep(60)
PY
pids+=($!)

# ── 2. Real LiveKit servers (one for v0.9, one for v1) ───────────────────────────────────────────────────
LK0_KEY="APIv0$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
LK0_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
LK1_KEY="APIv1$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
LK1_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

cat >"$STATE/v0/livekit.yaml" <<YAML
port: $V0_LK_HTTP
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: $V0_LK_TCP
  udp_port: $V0_LK_UDP
  use_external_ip: false
  node_ip: 198.51.100.20
keys:
  $LK0_KEY: $LK0_SECRET
logging:
  level: warn
YAML
cat >"$STATE/v1/livekit.yaml" <<YAML
port: $V1_LK_HTTP
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: $V1_LK_TCP
  udp_port: $V1_LK_UDP
  use_external_ip: false
  node_ip: 198.51.100.21
keys:
  $LK1_KEY: $LK1_SECRET
logging:
  level: warn
YAML
chmod 600 "$STATE/v0/livekit.yaml" "$STATE/v1/livekit.yaml"
"$LK_BIN" --config "$STATE/v0/livekit.yaml" >"$STATE/v0/livekit.log" 2>&1 &
pids+=($!)
"$LK_BIN" --config "$STATE/v1/livekit.yaml" >"$STATE/v1/livekit.log" 2>&1 &
pids+=($!)

# ── 3. Real v0.9 bifrost-net ap ──────────────────────────────────────────────────────────────────────────
V0_CERT=$("$BIN" ap-cert "$STATE/v0/tls" ap.veraldar.org 127.0.0.1)
V0_PIN=$(sed -n 's/^pin = "\([^"]*\)".*/\1/p' <<<"$V0_CERT")
V0_TOK_OUT=$("$BIN" ap-token)
V0_APTOK=$(sed -n 's/^token = "\([^"]*\)".*/\1/p' <<<"$V0_TOK_OUT")
V0_APHASH=$(sed -n 's/^bridge_token_sha256 = "\([^"]*\)".*/\1/p' <<<"$V0_TOK_OUT")

cat >"$STATE/v0/ap.toml" <<TOML
[ap]
listen = "127.0.0.1:$V0_AP_PORT"
cert_path = "$STATE/v0/tls/cert.pem"
key_path = "$STATE/v0/tls/key.pem"
bridge_token_sha256 = "$V0_APHASH"
proxy_protocol = true

[[ap.tcp]]
name = "livekit-ice"
listen = "127.0.0.1:$V0_ICE_PORT"
TOML
"$BIN" ap -c "$STATE/v0/ap.toml" >"$STATE/v0/ap.log" 2>&1 &
pids+=($!)

# ── 4. Real v1 bifrost-net trunk (TLS + HTTP + ICE-TCP, TRUNK_TEST_FAST=1) ───────────────────────────────
V1_CERT=$("$BIN" ap-cert "$STATE/v1/tls" ljoolq.veraldar.org ap.veraldar.org 127.0.0.1)
V1_PIN=$(sed -n 's/^pin = "\([^"]*\)".*/\1/p' <<<"$V1_CERT")
"$BIN" trunk-kek "$STATE/v1/cred/trunk-kek" >/dev/null

cat >"$STATE/v1/trunk.toml" <<TOML
public_url = "https://ljoolq.veraldar.org:$DOOR_PORT"
extra_names = ["ap.veraldar.org"]
listen_http = "127.0.0.1:$V1_HTTP_PORT"
listen_tls = "127.0.0.1:$V1_TLS_PORT"
cert_path = "$STATE/v1/tls/cert.pem"
key_path = "$STATE/v1/tls/key.pem"
proxy_protocol = true
listen_ice = "127.0.0.1:$V1_ICE_PORT"
trusted_proxies = ["127.0.0.1/32"]
db = "$STATE/v1/trunk.db"
state_dir = "$STATE/v1"
cred_dir = "$STATE/v1/cred"
ctl_socket = "$STATE/v1/ctl.sock"
rp_id = "veraldar.org"
origins = ["https://ljoolq.veraldar.org:$DOOR_PORT", "https://ap.veraldar.org:$DOOR_PORT"]
ice_owner_from = ["127.0.0.1/32"]
TOML
chmod 600 "$STATE/v1/trunk.toml"

TRUNK_TEST_FAST=1 "$BIN" trunk -c "$STATE/v1/trunk.toml" >"$STATE/v1/trunk.log" 2>&1 &
V1_TRUNK_PID=$!
echo "$V1_TRUNK_PID" >"$STATE/v1/trunk.pid"
pids+=("$V1_TRUNK_PID")

for _ in $(seq 60); do
  curl -sf "http://127.0.0.1:$V1_HTTP_PORT/t/state" >/dev/null && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:$V1_HTTP_PORT/t/state" >/dev/null || { echo "v1 trunk did not start"; tail -30 "$STATE/v1/trunk.log"; exit 2; }

# Seed admin device + mint access token on v1 trunk
TRUNK_TEST_FAST=1 "$BIN" trunk-rig seed-admin -c "$STATE/v1/trunk.toml" --device dev_coexist >/dev/null
V1_DEV_TOK=$(TRUNK_TEST_FAST=1 "$BIN" trunk-rig mint -c "$STATE/v1/trunk.toml" --device dev_coexist --role admin --region loopback --ttl-s 3600 | tr -d '\r\n')

# ── 5. Real sni-443.py (v2) in front of BOTH trunks ──────────────────────────────────────────────────────
cat >"$STATE/sni-443.conf" <<CONF
listen 127.0.0.1:$DOOR_PORT
route ap.veraldar.org 127.0.0.1:$V0_AP_PORT proxy
route ljoolq.veraldar.org 127.0.0.1:$V1_TLS_PORT proxy
ice 127.0.0.1:$V0_ICE_PORT
ice_owner http://127.0.0.1:$V1_HTTP_PORT/t/ice/owner 127.0.0.1:$V1_ICE_PORT 200ms
default 127.0.0.1:$SITE_PORT
CONF
SNI443_STATS=off python3 -u "$ROOT/trunk/deploy/sni-443.py" -c "$STATE/sni-443.conf" >"$STATE/sni-443.log" 2>&1 &
SNI_PID=$!
pids+=("$SNI_PID")
for _ in $(seq 40); do
  python3 -c "import socket; socket.create_connection(('127.0.0.1',$DOOR_PORT),1).close()" 2>/dev/null && break
  sleep 0.2
done

# ── 6. Real v0.9 bridge (dials ap.veraldar.org through sni-443 v2) ───────────────────────────────────────
V0_DEV_TOK="coexist-v0-device-token-0123456789"
python3 - "$STATE/v0/devices.json" "$V0_DEV_TOK" <<'PY'
import hashlib, json, sys, time
h = hashlib.sha256(sys.argv[2].encode()).hexdigest()
doc = {"version": 2, "killEpoch": 0, "devices": [{"id": "phone-v0", "revoked": False, "access": [
    {"hash": h, "exp": int(time.time() * 1000) + 3600_000, "region": "loopback"}]}]}
open(sys.argv[1], "w").write(json.dumps(doc))
PY
V0_KEY=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
cat >"$STATE/v0/bridge.toml" <<TOML
[node]
name = "v0-home"
private_key = "$V0_KEY"

[bridge]
http = "127.0.0.1:$V0_BR_HTTP"
media = "127.0.0.1:$V0_BR_MEDIA"
tokens_file = "$STATE/v0/devices.json"
opencode_url = "http://127.0.0.1:$V0_APP_PORT"
candidates = ["127.0.0.1"]
dtls_cert_file = "$STATE/v0/bridge-dtls.json"
public_url = "http://127.0.0.1:$V0_BR_HTTP"

[ap]
url = "wss://ap.veraldar.org:$DOOR_PORT/ap"
pin = "$V0_PIN"
token = "$V0_APTOK"
upstream = "127.0.0.1:$V0_APP_PORT"
livekit = "127.0.0.1:$V0_LK_HTTP"
tcp = { livekit-ice = "198.51.100.20:$V0_LK_TCP" }
ice_tcp = ["127.0.0.1:$DOOR_PORT"]
TOML
"$BIN" bridge -c "$STATE/v0/bridge.toml" >"$STATE/v0/bridge.log" 2>&1 &
pids+=($!)

# ── 7. Enroll + start real v1 bridge (dials ljoolq.veraldar.org through sni-443 v2) ──────────────────────
V1_ROOT_PUB=$("$BIN" root-key "$STATE/v1/root.key" | sed -n 's/^public_key = "\(.*\)"/\1/p')
"$BIN" wg-key "$STATE/v1/wg.key" >/dev/null
V1_WG_PUB=$(cat "$STATE/v1/wg.key.pub")
ENROLL_JSON=$(python3 - "$V1_HTTP_PORT" "$V1_DEV_TOK" "$V1_ROOT_PUB" "$V1_WG_PUB" "$DOOR_PORT" <<'PY'
import json, sys, urllib.request
port, tok, rpub, wpub, door = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def post(path, body, hdrs=None):
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(),
                               method="POST", headers={"Content-Type": "application/json", **(hdrs or {})})
    with op.open(r, timeout=10) as resp:
        return json.loads(resp.read())
e = post("/t/roots/enroll", {"hostname": "v1-home", "os": "linux", "arch": "x86_64", "name": "v1-home",
                             "root_pub": rpub, "wg_pub": wpub, "has_app": True, "has_voice": True})
post(f"/t/roots/enroll/{e['id']}/approve", {"code": e["code"]},
     {"Cookie": f"bifrost_device={tok}", "Origin": f"https://ljoolq.veraldar.org:{door}"})
res = post(f"/t/roots/enroll/{e['id']}/poll", {"secret": e["poll_secret"]})
print(json.dumps(res))
PY
)
V1_ROOT_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["root_id"])' <<<"$ENROLL_JSON")
V1_TRUNK_KEY=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["trunk"]["trunk_key"])' <<<"$ENROLL_JSON")

V1_KEY=$("$BIN" keygen | sed -n 's/^private_key = "\(.*\)"/\1/p')
cat >"$STATE/v1/bridge.toml" <<TOML
[node]
name = "$V1_ROOT_ID"
private_key = "$V1_KEY"

[bridge]
http = "127.0.0.1:$V1_BR_HTTP"
media = "127.0.0.1:$V1_BR_MEDIA"
tokens_file = "$STATE/v1/unused-devices.json"
opencode_url = "http://127.0.0.1:$V1_APP_PORT"
candidates = ["127.0.0.1"]
dtls_cert_file = "$STATE/v1/bridge-dtls.json"
public_url = "http://127.0.0.1:$V1_BR_HTTP"

[trunk]
url = "https://ljoolq.veraldar.org:$DOOR_PORT"
trunk_key = "$V1_TRUNK_KEY"
root_key_file = "$STATE/v1/root.key"
root_id = "$V1_ROOT_ID"
state_file = "$STATE/v1/trunk-state.json"
pin = "$V1_PIN"
upstream = "127.0.0.1:$V1_APP_PORT"
livekit = "127.0.0.1:$V1_LK_HTTP"
tcp = { livekit-ice = "198.51.100.21:$V1_LK_TCP" }
ice_tcp = ["127.0.0.1:$DOOR_PORT"]
TOML
"$BIN" bridge -c "$STATE/v1/bridge.toml" >"$STATE/v1/bridge.log" 2>&1 &
pids+=($!)

# Wait for both bridges and both LiveKit servers to be up
for _ in $(seq 60); do
  if curl -skf "https://ap.veraldar.org:$DOOR_PORT/" | grep -q "v0.9-app-ok" \
     && [ -s "$STATE/v1/trunk-state.json" ] \
     && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["link"]["state"]=="up" else 1)' "$STATE/v1/trunk-state.json" 2>/dev/null \
     && python3 -c "import socket; socket.create_connection(('127.0.0.1',$V0_LK_HTTP),1).close(); socket.create_connection(('127.0.0.1',$V1_LK_HTTP),1).close()" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

# ── 8. Run the coexistence test driver ───────────────────────────────────────────────────────────────────
cat >"$STATE/cfg.json" <<JSON
{
  "steps_file": "$STATE/steps.tsv",
  "bin": "$BIN",
  "door_port": $DOOR_PORT,
  "v0_ap_port": $V0_AP_PORT,
  "v0_ice_port": $V0_ICE_PORT,
  "v1_tls_port": $V1_TLS_PORT,
  "v1_http_port": $V1_HTTP_PORT,
  "v1_ice_port": $V1_ICE_PORT,
  "site_port": $SITE_PORT,
  "sni_conf": "$STATE/sni-443.conf",
  "sni_log": "$STATE/sni-443.log",
  "sni_pid": $SNI_PID,
  "v1_trunk_pidfile": "$STATE/v1/trunk.pid",
  "v1_trunk_toml": "$STATE/v1/trunk.toml",
  "v1_trunk_log": "$STATE/v1/trunk.log",
  "v0_dev_token": "$V0_DEV_TOK",
  "v1_dev_token": "$V1_DEV_TOK",
  "lk0_key": "$LK0_KEY",
  "lk0_secret": "$LK0_SECRET",
  "lk1_key": "$LK1_KEY",
  "lk1_secret": "$LK1_SECRET"
}
JSON

echo ""
printf '%-6s %-8s %s\n' "STEP" "RES" "WHAT"
set +e
python3 "$ROOT/sim/trunk-v1-coexist/drive.py" "$STATE/cfg.json"
rc=$?
set -e
echo ""
pass=$(grep -c $'\tPASS\t' "$STATE/steps.tsv" 2>/dev/null || true); pass=${pass:-0}
fail=$(grep -c $'\tFAIL\t' "$STATE/steps.tsv" 2>/dev/null || true); fail=${fail:-0}
echo "TRUNK-V1 COEXIST (G3.8): pass=$pass fail=$fail (state: $STATE)"
[ "$rc" -eq 0 ] && [ "$fail" -eq 0 ]
