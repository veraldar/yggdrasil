# run: cd branch/voice && uv run python test_repeat_turn.py   (exit 0 = green)
"""Two rules of the voice agent (11-20):
1. The same words said AGAIN are a new turn ("yes" … "yes"): only the SAME stored turn again (a
   hold that caught nothing) is "already sent". A job stays in its room for hours.
2. One agent per room, and never none: of the jobs that wait at the same time exactly one takes
   the room (two used to wait for each other and both leave)."""
import asyncio, json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from livekit.agents.llm import ChatContext
from livekit.agents.types import APIConnectOptions
import agent as A
from agent import OpenCodeLLM, OpenCodeStream, sibling_verdict

POSTS = []

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"id": "ses_x", "title": "x"}).encode())
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0); body = self.rfile.read(n)
        if "/message" in self.path:
            POSTS.append(json.loads(body or b"{}"))
            self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
            self.wfile.write(b'event: message.part.delta\ndata: {"sessionID":"ses_x","text":"ok."}\n\n'); self.wfile.flush()
            self.connection.shutdown(2); return
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"id": "ses_x"}).encode())

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
oc = OpenCodeLLM(f"http://127.0.0.1:{srv.server_port}")  # ONE job: it remembers its last turn
oc._sid = "ses_x"
async def _sid(): return "ses_x"
oc._ensure_session = _sid

async def run(ctx):
    s = OpenCodeStream(llm=oc, chat_ctx=ctx, tools=[], conn_options=APIConnectOptions(max_retry=0))
    async for _ in s:
        pass

def sent(): return [" ".join(p.get("text", "") for p in b.get("parts", [])) for b in POSTS]

fails = 0
def check(name, ok, detail=""):
    global fails
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f" — {detail}"))
    fails += 0 if ok else 1

ctx = ChatContext(); ctx.add_message(role="user", content="yes")
asyncio.run(run(ctx))
check("a turn is sent", len(POSTS) == 1 and "yes" in sent()[0], sent())
asyncio.run(run(ctx))  # a hold that caught nothing: the same stored turn is still the newest
check("the same stored turn again is not sent twice", len(POSTS) == 1, sent())
ctx.add_message(role="user", content="yes")  # said again, right away: one utterance committed twice
asyncio.run(run(ctx))
check("the same words within two seconds: one utterance committed twice, not sent", len(POSTS) == 1, sent())
oc.last_sent_at = time.monotonic() - 5  # …and said again a moment later
ctx.add_message(role="user", content="yes")
asyncio.run(run(ctx))
check("the same words said AGAIN are a new turn", len(POSTS) == 2 and "yes" in sent()[1], sent())
ctx.add_message(role="user", content="yes please open it")
oc.last_sent_at = time.monotonic() - 5
asyncio.run(run(ctx))
check("a turn that grew sends only what is new (as before)", len(POSTS) == 3 and "please open it" in sent()[2] and "yes" not in sent()[2].split("please")[0], sent())

V = sibling_verdict
check("alone in the room: take it", V("agent-b", []) == "take")
check("one serving or draining: wait", V("agent-b", [("agent-a", False)]) == "wait" and V("agent-a", [("agent-z", False), ("agent-b", True)]) == "wait")
pair = {"agent-a": V("agent-a", [("agent-b", True)]), "agent-b": V("agent-b", [("agent-a", True)])}
check("two that wait at once: exactly one takes it, the other leaves", sorted(pair.values()) == ["leave", "take"] and pair["agent-a"] == "take", pair)
three = [V(m, [(o, True) for o in ("agent-a", "agent-b", "agent-c") if o != m]) for m in ("agent-a", "agent-b", "agent-c")]
check("three that wait: one takes, two leave — never none, never two", three.count("take") == 1 and three.count("leave") == 2, three)

print("REPEAT-TURN: " + ("GREEN" if not fails else f"RED ({fails})"))
sys.exit(1 if fails else 0)
