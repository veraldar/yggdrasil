import sys, threading, time, json
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from rig import *
start()
try:
    proxy = make_proxy()
    DELAY["async_post"] = float(os.environ.get("HOLD", "2"))
    print("proxy", proxy)
    out = {}
    ta = threading.Thread(target=sse, args=(HOME, f"/session/{proxy}/message", {"parts": [{"type": "text", "text": "Reply with exactly: AAA"}]}, out, "A"))
    tb = threading.Thread(target=sse, args=(HOME, f"/session/{proxy}/message", {"parts": [{"type": "text", "text": "Reply with exactly: BBB"}]}, out, "B"))
    ta.start(); time.sleep(0.05); tb.start()
    ta.join(60); tb.join(60)
    for k in ("A", "B"):
        done = [d for e, d, t in out.get(k, []) if e in ("message.completed", "error")]
        texts = [p.get("text") for d in done for p in (json.loads(d).get("parts") or []) if p.get("type") == "text"]
        print(f"client {k}: completed text={texts}; deltas={[json.loads(d).get('text') for e,d,t in out.get(k,[]) if e=='message.part.delta']}; end={out.get(k+'_end')}")
    lab_rid = req(HOME, "GET", f"/session/{proxy}").get("remote", {}).get("id")
    msgs = req(LAB, "GET", f"/session/{lab_rid}/message")
    print("lab transcript:", [(m["info"]["role"], m["info"]["id"], m["info"].get("parentID"), "".join(p.get("text","") for p in m["parts"] if p.get("type")=="text")[:40]) for m in msgs])
finally:
    stop()
