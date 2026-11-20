#!/usr/bin/env python3
# run: SIM_HARNESS=1 sim/brain-up.sh p2-s3 4275 <bin>; python3 sim/reach/s3.py 4275   (real upstream; the Claude Code half uses haiku)
"""S3 (G2 / package 2): a screenshot whose only text is ORANGE-7 reaches the worker.
1. MAIN gets it with the owner's words → must start a session with attach:true; that child's first
   message carries the image; its reply names ORANGE-7.
2. The same image straight to a Claude Code session (haiku) → its prompt names the file's path
   (exists); its reply names ORANGE-7."""
import hashlib, json, os, sys, time, urllib.request
B = "http://127.0.0.1:" + sys.argv[1]
def req(m, p, b=None, t=60, raw=None, ct="application/json"):
    d = raw if raw is not None else (json.dumps(b).encode() if b is not None else None)
    r = urllib.request.Request(B + p, data=d, method=m, headers={"content-type": ct})
    with urllib.request.urlopen(r, timeout=t) as x:
        s = x.read(); return json.loads(s) if s else None
def text(m): return "".join(p.get("text", "") for p in m.get("parts", []) if p.get("type") == "text")
F = []
def check(n, ok, d=""):
    print(("ok   " if ok else "FAIL ") + n + ("" if ok else f" — {str(d)[:400]}"), flush=True)
    if not ok: F.append(n)
img = open(os.path.join(os.path.dirname(__file__), "marker.png"), "rb").read()
up = req("POST", "/file/upload", {"name": "marker.png", "mime": "image/png", "size": len(img)})
ref = req("PUT", f"/file/upload/{up['upload']}?offset=0", raw=img, ct="application/octet-stream")["file"]
check("upload: the REF names the image's sha256", ref["hash"] == hashlib.sha256(img).hexdigest(), ref)
part = {"type": "file", "mime": "image/png", "filename": "marker.png", "url": f"/file/{ref['hash']}", "hash": ref["hash"], "size": ref["size"], "root": ref["root"]}

main = req("POST", "/session", {"title": "[MAIN]"})["id"]
words = "can u get someone to make me a little settings page in a new folder settings-page that looks exactly like this screenshot, same words on it"
r = req("POST", f"/session/{main}/message", {"parts": [{"type": "text", "text": words}, part]}, 300)
tools = [p for p in r.get("parts", []) if p.get("type") == "tool"]
starts = [p for p in tools if p.get("tool") in ("session_start", "session_send")]
check("MAIN hands it on with attach:true", any(p["state"]["input"].get("attach") is True for p in starts), [(p["tool"], p["state"]["input"]) for p in tools])
print("MAIN said:", text(r)[:300])
kids = [s for s in req("GET", "/session") if s.get("parentID") == main]
check("a child session exists", bool(kids), kids)
if kids:
    kid = kids[0]["id"]
    def done():
        ms = req("GET", f"/session/{kid}/message")
        return ms if any(m["info"]["role"] == "assistant" and m["info"].get("time", {}).get("completed") for m in ms) else None
    t0 = time.time(); ms = None
    while time.time() - t0 < 300 and not ms:
        time.sleep(3); ms = done()
    ms = ms or req("GET", f"/session/{kid}/message")
    first = next(m for m in ms if m["info"]["role"] == "user")
    imgs = [p for p in first["parts"] if p.get("type") == "file" and p.get("mime", "").startswith("image/")]
    check("the child's first message carries 1 image file part (the same hash)", len(imgs) == 1 and imgs[0].get("hash") == ref["hash"], first["parts"])
    reply = " ".join(text(m) for m in ms if m["info"]["role"] == "assistant")
    work = os.path.expanduser("~/.cache/root-sim/p2-s3/work")
    built = ""
    for d, _, fs in os.walk(work):
        for f in fs:
            if f.endswith((".html", ".css", ".js")):
                built += open(os.path.join(d, f), errors="replace").read()
    check("the child saw the pixels: its reply or the page it built holds ORANGE-7", "ORANGE-7" in (reply + built).upper(), (reply[:300], built[:300]))

if "--main-only" in sys.argv:
    print("GREEN" if not F else f"RED {F}"); sys.exit(1 if F else 0)
cc = req("POST", "/session", {"title": "s3 claude", "agent": "claude", "model": "haiku"})["id"]
r = req("POST", f"/session/{cc}/message", {"parts": [{"type": "text", "text": "what is the word on the button in this screenshot? answer with the word only"}, part]}, 600)
ms = req("GET", f"/session/{cc}/message")
first = next(m for m in ms if m["info"]["role"] == "user")
fp = [p for p in first["parts"] if p.get("type") == "file"][0]
check("the Claude Code session's message part has a path that exists", bool(fp.get("path")) and os.path.exists(fp["path"]), fp)
check("Claude Code's reply names ORANGE-7", "ORANGE-7" in text(r).upper().replace("ORANGE 7", "ORANGE-7"), text(r)[:300] or r.get("info", {}).get("error"))
print("GREEN" if not F else f"RED {F}")
