# run: cd branch/voice && uv run python test_no_resend.py   (exit 0 = green)
"""The voice agent never sends a turn twice once the brain answered the POST (package 2).
Fake brain: mode 'refuse' answers 502 {"error":"no answer from lab"}; mode 'drop' answers 200 SSE,
sends one delta without a sentence end, then closes. Each POST is counted."""
import asyncio, json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from livekit.agents.llm import ChatContext
from livekit.agents.types import APIConnectOptions
from agent import OpenCodeLLM, OpenCodeStream

MODE = {"m": "refuse"}
POSTS = []

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"id": "ses_x", "title": "x"}).encode())
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0); body = self.rfile.read(n)
        if "/message" in self.path:
            POSTS.append(self.path)
            if MODE["m"] == "hang":
                import time as _t; _t.sleep(4); return
            if MODE["m"] == "refuse":
                self.send_response(502); self.send_header("content-type", "application/json"); self.end_headers()
                self.wfile.write(b'{"error":"no answer from lab"}'); return
            self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
            self.wfile.write(b'event: message.part.delta\ndata: {"sessionID":"ses_x","text":"half a sente"}\n\n'); self.wfile.flush()
            self.connection.shutdown(2); return
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"id": "ses_x"}).encode())

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

async def turn():
    ctx = ChatContext(); ctx.add_message(role="user", content="hello there over")
    oc = OpenCodeLLM(f"http://127.0.0.1:{srv.server_port}")
    oc._sid = "ses_x"
    async def sid(): return "ses_x"
    oc._ensure_session = sid
    s = OpenCodeStream(llm=oc, chat_ctx=ctx, tools=[], conn_options=APIConnectOptions(max_retry=0))
    out = []
    async for c in s:  # the stream runs its own _run once
        out.append(c.delta.content)
    return out

fails = 0
import agent as _agent, httpx as _httpx
_orig = _httpx.AsyncClient
class _Short(_orig):
    def __init__(self, *a, **k):
        k["timeout"] = 2
        super().__init__(*a, **k)
for mode in ("refuse", "drop", "hang"):
    _agent.httpx.AsyncClient = _Short if mode == "hang" else _orig
    MODE["m"] = mode; POSTS.clear()
    said = asyncio.run(turn())
    ok = len(POSTS) == 1
    print(f"{'ok  ' if ok else 'FAIL'} {mode}: {len(POSTS)} POST(s); spoken: {said}")
    fails += not ok
print("GREEN" if not fails else "RED"); sys.exit(1 if fails else 0)
