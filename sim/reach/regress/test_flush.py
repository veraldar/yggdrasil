import sys, threading, time, json
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from rig import *
start()
try:
    p1 = make_proxy("reach"); p2 = make_proxy("reach2")
    print("proxies", p1, p2)
    DELAY["async_post"] = 3.0
    out = {}
    t = threading.Thread(target=sse, args=(HOME, f"/session/{p1}/message", {"parts": [{"type": "text", "text": "word " * 600}]}, out, "A", 40), daemon=True)
    t.start(); t.join(45)
    print("client A:", out.get("A_headers_at"), "headers at;", len(out.get("A", [])), "events;", out.get("A_end"))
    lab_rid = req(HOME, "GET", f"/session/{p1}").get("remote", {}).get("id")
    msgs = req(LAB, "GET", f"/session/{lab_rid}/message")
    print("lab finished the turn:", msgs[-1]["info"]["role"], bool(msgs[-1]["info"]["time"].get("completed")), len("".join(p.get("text","") for p in msgs[-1]["parts"] if p.get("type")=="text")), "chars")
    print("home /session/status:", req(HOME, "GET", "/session/status"))
    DELAY["async_post"] = 0
    r = req(HOME, "POST", f"/session/{p2}/message?async=1", {"parts": [{"type": "text", "text": "Reply with exactly: TWO"}]}, 60)
    print("second proxy async post:", r)
    time.sleep(15)
    print("15 s later, home /session/status:", req(HOME, "GET", "/session/status"))
    lab2 = req(HOME, "GET", f"/session/{p2}").get("remote", {}).get("id")
    m2 = req(LAB, "GET", f"/session/{lab2}/message")
    print("lab answered the second:", "".join(p.get("text","") for p in m2[-1]["parts"] if p.get("type")=="text"))
finally:
    stop()
