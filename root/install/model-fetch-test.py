#!/usr/bin/env python3
"""model-fetch-test.py — rootjoin.py model-fetch ("Same as the home root", the joiner's side) against a stand-in
for the door of this root's WireGuard node: GET /_wg/local/root/model with the peer token (contract:
artifacts/p4-model-route.md). Stdlib only, a few seconds.   python3 root/install/model-fetch-test.py"""
import http.server, json, os, stat, subprocess, sys, tempfile, threading

HERE = os.path.dirname(os.path.abspath(__file__))
KEY, TOKEN = "sk-test-NOT-A-REAL-KEY-0123456789", "peer-token-for-the-test"
GOOD = {"base_url": "https://api.z.ai/api/anthropic", "style": "anthropic", "model": "glm-5.3-flash", "api_key": KEY}
fails, plan, seen = 0, [], []


def check(name, ok, detail=""):
    global fails
    print("  %s  %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  [%s]" % detail), flush=True)
    fails += 0 if ok else 1


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        seen.append((self.path, self.headers.get("x-ygg-peer"), self.headers.get("x-ygg-root")))
        code, body = plan.pop(0) if len(plan) > 1 else plan[0]
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw))); self.end_headers(); self.wfile.write(raw)


def fetch(tmp, port, wg=True, wait="6"):
    state = os.path.join(tmp, "state"); os.makedirs(state, exist_ok=True)
    root = {"root_id": "mac-2", "peer_token": TOKEN, "hub": "https://hub.example", "hub_name": "home"}
    if wg:
        root["wg"] = {"ip": "10.99.5.2"}
    with open(os.path.join(state, "root.json"), "w") as f:
        json.dump(root, f)
    out = os.path.join(tmp, "up.env")
    if os.path.exists(out):
        os.remove(out)
    p = subprocess.run([sys.executable, os.path.join(HERE, "rootjoin.py"), "model-fetch", "--state", state,
                        "--peer-port", str(port), "--out", out, "--wait", wait], capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout + p.stderr, out


def main():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as tmp:
        plan[:] = [(200, GOOD)]; seen.clear()
        rc, text, out = fetch(tmp, port)
        lines = open(out).read().splitlines() if os.path.exists(out) else []
        check("200: exit 0, the four YGG_UPSTREAM_* lines, the file mode 600",
              rc == 0 and lines == ["YGG_UPSTREAM_BASE_URL=" + GOOD["base_url"], "YGG_UPSTREAM_STYLE=anthropic",
                                    "YGG_UPSTREAM_MODEL=glm-5.3-flash", "YGG_UPSTREAM_API_KEY=" + KEY]
              and stat.S_IMODE(os.stat(out).st_mode) == 0o600, "rc=%s %s" % (rc, text))
        check("it asked inside the tunnel's door: /_wg/local/root/model, with the peer token and its root id",
              seen and seen[0] == ("/_wg/local/root/model", TOKEN, "mac-2"), str(seen[:1]))
        check("what it prints names the model and the host, never the key",
              "glm-5.3-flash at api.z.ai (anthropic)" in text and KEY not in text, text)
        plan[:] = [(200, {**GOOD, "models": "glm-5.3-flash:lite,glm-5.3", "vision": "glm-5.3", "extra": 1})]
        rc, text, out = fetch(tmp, port)
        lines = open(out).read().splitlines() if os.path.exists(out) else []
        check("the home root's model list and vision models come along (YGG_MODELS, YGG_VISION_MODELS); unknown fields ignored",
              rc == 0 and lines[4:] == ["YGG_MODELS=glm-5.3-flash:lite,glm-5.3", "YGG_VISION_MODELS=glm-5.3"] and len(lines) == 6, str(lines[4:]))
        plan[:] = [(200, {**GOOD, "models": "a\nYGG_LISTEN=0.0.0.0:1", "vision": ""})]
        rc, text, out = fetch(tmp, port)
        lines = open(out).read().splitlines() if os.path.exists(out) else []
        check("a model list holding a line break is left out (no injected line); an empty one writes no line", rc == 0 and len(lines) == 4, str(lines))
        plan[:] = [(404, {}), (502, {}), (200, GOOD)]
        rc, text, out = fetch(tmp, port)
        check("the link still coming up (404, 502, then 200): it waits and gets it", rc == 0 and os.path.exists(out), "rc=%s" % rc)
        for code, want, what in ((404, 7, "a 404 that stays: an older home root (exit 7)"), (401, 8, "401: refused (exit 8)"),
                                 (403, 8, "403: refused (exit 8)"), (409, 9, "409: the home's model is on the home machine (exit 9)"),
                                 (503, 11, "503 until the time is up: no answer (exit 11)")):
            plan[:] = [(code, {"error": "x"})]
            rc, text, out = fetch(tmp, port, wait="13" if code == 404 else "3")
            check(what + ", nothing written", rc == want and not os.path.exists(out), "rc=%s %s" % (rc, text))
        for bad, what in (({**GOOD, "style": "soap"}, "an unknown kind"), ({**GOOD, "base_url": "ftp://x"}, "not an http(s) address"),
                          ({**GOOD, "api_key": "a\nYGG_LISTEN=0.0.0.0:1"}, "a key holding a line break (an env-file injection)"),
                          ({"base_url": GOOD["base_url"]}, "fields missing"), (b"not json", "not JSON")):
            plan[:] = [(200, bad)]
            rc, text, out = fetch(tmp, port)
            check("200 with %s: refused (exit 8), nothing written, the key not printed" % what,
                  rc == 8 and not os.path.exists(out) and KEY not in text, "rc=%s %s" % (rc, text))
        plan[:] = [(200, GOOD)]; seen.clear()
        rc, text, out = fetch(tmp, port, wg=False)
        check("no WireGuard tunnel in the join: never asked (exit 8) — the settings do not go over the plaintext path",
              rc == 8 and not seen and not os.path.exists(out), "rc=%s seen=%s" % (rc, seen))
        srv.shutdown()
        rc, text, out = fetch(tmp, port, wait="3")
        check("nothing listens: no answer (exit 11)", rc == 11 and not os.path.exists(out), "rc=%s" % rc)
    print("\n%s" % ("ALL PASS" if not fails else "%d FAILED" % fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
