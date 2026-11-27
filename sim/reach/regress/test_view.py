import sys, threading, time, json
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from rig import *
POLL = sys.argv[1] == "poll"
start()
try:
    proxy = make_proxy()
    print("proxy", proxy, "phone polling messages every 2 s:", POLL)
    out = {}
    stop_poll = threading.Event()
    def poller():
        while not stop_poll.is_set():
            try: req(HOME, "GET", f"/session/{proxy}/message", timeout=10)
            except Exception as e: print("poll err", e)
            time.sleep(2)
    if POLL: threading.Thread(target=poller, daemon=True).start()
    sse(HOME, f"/session/{proxy}/message", {"parts": [{"type": "text", "text": "sleep 40 Reply with exactly: SLEPT"}]}, out, "A", timeout=120)
    stop_poll.set()
    print("client events:", [(e, d[:90], t) for e, d, t in out["A"]])
    print("end:", out["A_end"])
    card = {r["title"]: r for r in req(HOME, "GET", "/tree")}["reach"]["card"]
    print("home card:", card.get("status"), card.get("headline"))
    time.sleep(20)
    lab_rid = req(HOME, "GET", f"/session/{proxy}").get("remote", {}).get("id")
    msgs = req(LAB, "GET", f"/session/{lab_rid}/message")
    print("lab's last reply:", "".join(p.get("text","") for p in msgs[-1]["parts"] if p.get("type")=="text"), msgs[-1]["info"].get("error"))
    print("home log relay lines:", [l.strip() for l in open(f"{BASE}/home/brain.log") if "relay" in l][:6])
finally:
    stop()
