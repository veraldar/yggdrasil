#!/usr/bin/env python3
"""trunk-obs-bench.py — what the meter costs: the same requests through ap → bridge → a stub, with
the meter on and with BIFROST_OBS=off; latency per request (client side) and the bridge's and the
ap's CPU time. Loopback only, its own processes (killed by PID).   trunk-obs-bench.py [N=1500] [ROUNDS=3]"""
import hashlib, json, os, random, socket, ssl, statistics, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ.get("BIN") or os.path.join(HERE, "..", "trunk", "target", "release", "bifrost-net")
N = int(sys.argv[1]) if len(sys.argv) > 1 else 1500
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 3

class Up(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_GET(self):
        b = b"x" * 512
        self.send_response(200); self.send_header("Content-Length", str(len(b))); self.send_header("Connection", "close"); self.end_headers(); self.wfile.write(b)

def cpu(pid):
    f = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    return (int(f[11]) + int(f[12])) / os.sysconf("SC_CLK_TCK")

def run(mode, w, port0):
    up = ThreadingHTTPServer(("127.0.0.1", port0 + 3), Up); threading.Thread(target=up.serve_forever, daemon=True).start()
    out = lambda *a: subprocess.run([BIN, *a], capture_output=True, text=True, check=True).stdout
    cert = out("ap-cert", f"{w}/tls", "localhost", "127.0.0.1"); pin = cert.split('pin = "')[1].split('"')[0]
    tok = out("ap-token"); raw = tok.split('token = "')[1].split('"')[0]; h = tok.split('bridge_token_sha256 = "')[1].split('"')[0]
    priv = out("keygen").split('private_key = "')[1].split('"')[0]
    dev = os.urandom(24).hex(); os.makedirs(f"{w}/state", exist_ok=True)
    json.dump({"version": 2, "killEpoch": 0, "devices": [{"id": "dev_b", "revoked": False, "access": [{"hash": hashlib.sha256(dev.encode()).hexdigest(), "exp": int(time.time() * 1000) + 3600_000, "region": "loopback"}]}]}, open(f"{w}/state/devices.json", "w"))
    open(f"{w}/ap.toml", "w").write(f'[ap]\nlisten = "127.0.0.1:{port0}"\ncert_path = "{w}/tls/cert.pem"\nkey_path = "{w}/tls/key.pem"\nbridge_token_sha256 = "{h}"\n')
    open(f"{w}/bridge.toml", "w").write(f'[node]\nname = "bench"\nprivate_key = "{priv}"\n\n[bridge]\nhttp = "127.0.0.1:{port0 + 1}"\nmedia = "127.0.0.1:{port0 + 2}"\ntokens_file = "{w}/state/devices.json"\nopencode_url = "http://127.0.0.1:9"\n\n[ap]\nurl = "wss://localhost:{port0}/ap"\npin = "{pin}"\ntoken = "{raw}"\nupstream = "127.0.0.1:{port0 + 3}"\n')
    env = dict(os.environ, BIFROST_PROBE="off")
    env.pop("BIFROST_OBS_DIR", None)
    if mode == "off":
        env["BIFROST_OBS"] = "off"
    ap = subprocess.Popen([BIN, "ap", "-c", f"{w}/ap.toml"], stdout=open(f"{w}/ap.log", "w"), stderr=subprocess.STDOUT, env=env)
    time.sleep(0.5)
    br = subprocess.Popen([BIN, "bridge", "-c", f"{w}/bridge.toml"], stdout=open(f"{w}/br.log", "w"), stderr=subprocess.STDOUT, env=env)
    for _ in range(100):
        if "channel up" in open(f"{w}/br.log").read():
            break
        time.sleep(0.1)
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    req = f"GET /api/session HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {dev}\r\nConnection: close\r\n\r\n".encode()
    def one():
        t = time.perf_counter()
        with socket.create_connection(("127.0.0.1", port0)) as s, ctx.wrap_socket(s, server_hostname="localhost") as tls:
            tls.sendall(req); data = b""
            while True:
                d = tls.recv(65536)
                if not d: break
                data += d
        assert data.startswith(b"HTTP/1.1 200"), data[:60]
        return (time.perf_counter() - t) * 1000
    for _ in range(50): one()  # warm
    c0b, c0a = cpu(br.pid), cpu(ap.pid)
    lat = [one() for _ in range(N)]
    c1b, c1a = cpu(br.pid), cpu(ap.pid)
    for p in (ap, br):
        p.terminate(); p.wait()
    up.shutdown()
    return {"p50": statistics.median(lat), "p95": sorted(lat)[int(0.95 * N)], "bridge_cpu_ms_per_req": (c1b - c0b) * 1000 / N, "ap_cpu_ms_per_req": (c1a - c0a) * 1000 / N}

res = {"on": [], "off": []}
for r in range(ROUNDS):
    for mode in (("on", "off") if r % 2 == 0 else ("off", "on")):
        with tempfile.TemporaryDirectory(dir=os.path.expanduser("~/.cache")) as w:
            res[mode].append(run(mode, w, 30000 + random.randrange(20000)))
for mode in ("on", "off"):
    rs = res[mode]
    agg = {k: round(statistics.median(x[k] for x in rs), 3) for k in rs[0]}
    print(f"meter {mode:3}: {N} requests × {ROUNDS}: latency p50 {agg['p50']} ms · p95 {agg['p95']} ms · bridge cpu {agg['bridge_cpu_ms_per_req']} ms/req · ap cpu {agg['ap_cpu_ms_per_req']} ms/req")
