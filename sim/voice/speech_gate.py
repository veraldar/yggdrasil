#!/usr/bin/env python3
"""speech_gate.py — one door to the speech server for every root of a voice-sim stack.

The Mac's speech server runs ONE generation at a time and a second /audio/speech_stream resets
the one in flight; each app serializes its own TTS, but two simulated roots on this box are two
apps. This pass-through puts their streams in ONE FIFO (a stream holds the slot until its body
has been fully relayed, like the app's own lock) and forwards everything else (STT for the
agents) untouched. Loopback only.

    speech_gate.py --upstream http://<speech-server>/v1 --port 4180
"""
import argparse, http.server, socketserver, sys, threading, time, urllib.request, urllib.error

LOCK = threading.Lock()


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    upstream = ""

    def log_message(self, fmt, *a):
        sys.stderr.write(time.strftime("%H:%M:%S ") + (fmt % a) + "\n")

    def _relay(self, method):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else None
        path = self.path[3:] if self.path.startswith("/v1/") else self.path
        url = self.upstream + self.path  # the upstream's origin + the same path
        hdr = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length", "connection")}
        stream = path.startswith("/audio/speech_stream")
        if stream:
            t = time.time()
            LOCK.acquire()
            q = time.time() - t
            if q > 0.5:
                self.log_message("speech_stream queued %.1fs", q)
        try:
            req = urllib.request.Request(url, data=body, method=method, headers=hdr)
            try:
                up = urllib.request.urlopen(req, timeout=600)
            except urllib.error.HTTPError as e:
                up = e
            self.send_response(up.status if hasattr(up, "status") else up.code)
            for k, v in up.headers.items():
                if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                    self.send_header(k, v)
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            while True:
                chunk = up.read1(65536) if hasattr(up, "read1") else up.read(65536)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            if stream:
                LOCK.release()

    def do_GET(self):
        self._relay("GET")

    def do_POST(self):
        self._relay("POST")


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--upstream", required=True)
    ap.add_argument("--port", type=int, required=True)
    a = ap.parse_args()
    up = a.upstream.rstrip("/")
    H.upstream = up[:-3] if up.endswith("/v1") else up
    S(("127.0.0.1", a.port), H).serve_forever()
