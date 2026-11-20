#!/usr/bin/env python3
"""msm fake upstream: both dialects, one JSON log line per POST (host, path, x-api-key,
Authorization, model) — the matrix's evidence. Streams SSE when asked, like a provider.
Usage: msm_upstream.py PORT LOGFILE [TLSCERT TLSKEY]  (binds 0.0.0.0; TLS wraps if given)"""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, LOGPATH = int(sys.argv[1]), sys.argv[2]
LOG = open(LOGPATH, "a", buffering=1)

def reply_text(body):
    msgs = body.get("messages") or []
    last_user = ""
    for m in msgs:
        if m.get("role") == "user":
            c = m.get("content")
            last_user = c if isinstance(c, str) else "".join(b.get("text", "") for b in c if isinstance(b, dict))
    return ("msm says: " + last_user.strip())[:200] or "msm ok"

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _rec(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n)) if n else {}
        except Exception:
            body = {}
        LOG.write(json.dumps({
            "host": self.headers.get("Host"), "path": self.path,
            "x_api_key": self.headers.get("x-api-key"),
            "auth": self.headers.get("Authorization"),
            "model": body.get("model"),
        }) + "\n")
        return body

    def json(self, code, obj):
        out = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

    def do_GET(self):
        if self.path.endswith("/models"):
            return self.json(200, {"data": [{"id": "mock"}, {"id": "mock-b"}]})
        self.send_error(404)

    def do_POST(self):
        body = self._rec()
        text = reply_text(body)
        if self.path.endswith("/v1/messages"):   # anthropic dialect
            if not body.get("stream"):
                return self.json(200, {"id": "msg_msm", "type": "message", "role": "assistant",
                                       "model": body.get("model"), "content": [{"type": "text", "text": text}],
                                       "stop_reason": "end_turn", "stop_sequence": None,
                                       "usage": {"input_tokens": 9, "output_tokens": 9}})
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            ev = lambda t, d: f"event: {t}\ndata: {json.dumps({'type': t, **d})}\n\n".encode()
            for f in (ev("message_start", {"message": {"id": "msg_msm", "type": "message", "role": "assistant",
                        "model": body.get("model"), "content": [], "stop_reason": None, "usage": {}}}),
                      ev("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}}),
                      ev("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": text}}),
                      ev("content_block_stop", {"index": 0}),
                      ev("message_delta", {"delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 9}}),
                      ev("message_stop", {})):
                self.wfile.write(f); self.wfile.flush()
            return
        if not self.path.endswith("/chat/completions"):
            return self.send_error(404)
        if not body.get("stream"):
            return self.json(200, {"id": "cmpl_msm", "object": "chat.completion", "model": body.get("model"),
                                   "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                                "finish_reason": "stop"}], "usage": {"prompt_tokens": 9, "completion_tokens": 9}})
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
        for d in ({"role": "assistant"}, {"content": text}, {"content": ""}):
            self.wfile.write(f"data: {json.dumps({'choices': [{'index': 0, 'delta': d}]})}\n\n".encode()); self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")

srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
if len(sys.argv) > 4:
    import ssl
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(sys.argv[3], sys.argv[4])
    srv.socket = c.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
