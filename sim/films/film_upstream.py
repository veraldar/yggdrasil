#!/usr/bin/env python3
"""film_upstream.py PORT — the model in the site's films (sim/films): root/mock/mock_upstream.py with
the films' lines on top. A turn whose words match a line in script.json gets that line's answer,
streamed at a reading pace; a line with "tools" first makes those tool calls (the real tools of the
real brain run them), then answers. Everything else is the mock's own reply, so the rig's other
steps behave as they do in sim/trunk-rtc-e2e.sh. Words come from real speech-to-text in the talk
film, so a line matches by key words, never by the whole sentence.
Env: FILMS_ART = the folder the app serves /api/artifact/ from (the "receipts" line writes there).
"""
import json, os, re, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
MOCK = os.path.join(HERE, "..", "..", "root", "mock", "mock_upstream.py")
src = open(MOCK).read()
head, sep, _ = src.rpartition("\nThreadingHTTPServer(")
assert sep, "mock_upstream.py no longer ends by starting its server: adapt film_upstream.py"
ns = {"__name__": "mock_upstream", "__file__": MOCK}
exec(compile(head, MOCK, "exec"), ns)

LINES = json.load(open(os.path.join(HERE, "script.json")))["lines"]
ART = os.environ.get("FILMS_ART", "")
mock_plan = ns["plan"]


def text_of(content):
    if isinstance(content, str):
        return content
    return " ".join(str(p.get("text", "")) for p in content if isinstance(p, dict))


def words_of(turn):
    """the owner's own words in a turn: without the brain's framing lines before and after"""
    lines = [l for l in text_of(turn).split("\n") if not l.startswith(("[context ", "[clock", "[inbox since", "- "))]
    core = "\n".join(lines)
    for marker in ("\n\n[roots]", "\n\n[tree]", "\n[roots]", "\n[tree]"):
        core = core.split(marker)[0]
    return core


def plan(body):
    msgs = body["messages"]
    first = msgs[0] if msgs else {}
    summary = first.get("role") == "system" and str(first.get("content", "")).startswith("[yggdrasil roll-up]")
    users = [i for i, m in enumerate(msgs) if m["role"] == "user"]
    if users and not summary:
        ui = users[-1]
        core = words_of(msgs[ui]["content"])
        for line in LINES:
            if re.search(line["match"], core, re.I):
                step = sum(1 for m in msgs[ui + 1:] if m["role"] == "assistant" and m.get("tool_calls"))
                tools = line.get("tools") or []
                if step < len(tools):
                    calls = [(f"call_film_{step}_{j}", n, json.dumps(a).replace("$FILMS_ART", ART))
                             for j, (n, a) in enumerate([tools[step]])]
                    return {"kind": "tools", "text": "", "calls": calls}
                return {"kind": "text", "text": line["answer"], "chunk": 5, "pace": 0.035, "nap": 0.5}
    return mock_plan(body)


def stream(self, p, frames, paced):
    """the mock's stream(), plus "pace": seconds after each text frame (a model writing)"""
    self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
    try:
        if p.get("latency"):
            time.sleep(float(os.environ.get("MOCK_LATENCY", "0")))
        time.sleep(p.get("nap", 0))
        for i, f in enumerate(frames):
            if p.get("cut") and i >= len(frames) // 2:
                self.close_connection = True
                return
            self.wfile.write(f.encode()); self.wfile.flush()
            if i in paced:
                time.sleep(p.get("pace") or (0.2 if p.get("slow") else 0))
    except (BrokenPipeError, ConnectionResetError):
        ns["CALLS"]["disconnects"] += 1


ns["plan"] = plan
ns["H"].stream = stream
if __name__ == "__main__":
    ns["ThreadingHTTPServer"](("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 18080), ns["H"]).serve_forever()
