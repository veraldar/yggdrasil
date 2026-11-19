#!/usr/bin/env python3
"""cc_model.py — a scripted Anthropic Messages endpoint for a REAL Claude Code inside the rigs.

Why: the namespace rigs have no route out (no Anthropic API) and Claude Code has no login there.
The brain's harness runs the real `claude` binary; its env points it here (ANTHROPIC_BASE_URL,
ANTHROPIC_API_KEY=anything, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 → one request per step,
IS_SANDBOX=1 → it accepts --dangerously-skip-permissions as the namespace's uid 0). Everything
Claude Code does is real — its prompt, its Read and Write tools, its transcript; only the MODEL's
choices are scripted, and the scripted model only knows what Claude Code sends it:

  "reply with exactly: X"                → X
  a turn holding the brain's line         step 0: Read {file_path: <that path>}
  "[attached by the owner: NAME (MIME,    step 1: the tool_result's bytes (a PDF arrives as a base64
   SIZE) — /path — open it with your             `document` block) → pdftotext → "The marker word in
   file tools]" + asking for a marker            NAME is <WORD>." (the word found in the text, if any)
  "… marker.html …" (write it, link it)  step 0: Write {<artifacts folder>/marker.html} — the folder
                                                 as the request names it (CLAUDE.md: "artifacts folder:
                                                 /path"), the word from its own earlier answer
                                         step 1: "Here it is: [marker.html](/api/artifact/marker.html)"
  anything else                          → "OK."

    cc_model.py --port P --log FILE      one JSON line per request in FILE (no file bytes)
"""
import argparse, base64, hashlib, json, os, re, subprocess, tempfile, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ATTACHED = re.compile(r"\[attached(?: by the owner)?: (?P<name>.+?) \((?P<mime>[^,()]+), (?P<size>[^)]+)\) — (?P<path>/.+?) — open it with your file tools\]")
MARKER = re.compile(r"marker word is ([A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])")
SAID = re.compile(r"marker word in .+? is ([A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])")
ARTDIR = re.compile(r"artifacts folder(?: is|:)\s*`?(/[^\s`'\"]+)")
EXACT = re.compile(r"reply with exactly:\s*(\S+)", re.I)
LOG = {"f": None}


def log(d):
    LOG["f"].write(json.dumps({"t": round(time.time(), 3), **d}) + "\n")
    LOG["f"].flush()


def blocks(m):
    c = m.get("content")
    return c if isinstance(c, list) else [{"type": "text", "text": c or ""}]


def texts(o):
    """every "text" string in a request (system, messages, tool results) — never file bytes"""
    if isinstance(o, dict):
        return ([o["text"]] if isinstance(o.get("text"), str) else []) + [t for k, v in o.items() if k not in ("text", "source", "data") for t in texts(v)]
    if isinstance(o, list):
        return [t for v in o for t in texts(v)]
    return [o] if isinstance(o, str) and len(o) < 200_000 else []


def turn_of(msgs):
    """(index of the newest user turn — text, no tool_result —, its prompt text without reminders)"""
    for i in range(len(msgs) - 1, -1, -1):
        m = msgs[i]
        if m.get("role") != "user":
            continue
        bs = blocks(m)
        if any(b.get("type") == "tool_result" for b in bs):
            continue
        texts = [b.get("text", "") for b in bs if b.get("type") == "text"]
        prompt = "\n".join(t for t in texts if not t.lstrip().startswith("<system-reminder>"))
        if prompt.strip():
            return i, prompt
    return None, ""


def text_of_result(b):
    """(text, {kinds, document bytes, sha256}) of one tool_result block — a PDF through pdftotext."""
    out, info = [], {"kinds": [], "document_bytes": 0}
    c = b.get("content")
    for x in (c if isinstance(c, list) else [{"type": "text", "text": c or ""}]):
        info["kinds"].append(x.get("type"))
        if x.get("type") == "text":
            out.append(x.get("text", ""))
        elif x.get("type") == "document" and (x.get("source") or {}).get("type") == "base64":
            raw = base64.b64decode(x["source"]["data"])
            info["document_bytes"], info["sha256"] = len(raw), hashlib.sha256(raw).hexdigest()
            with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
                f.write(raw)
                f.flush()
                r = subprocess.run(["pdftotext", f.name, "-"], capture_output=True, text=True, timeout=60)
                out.append(r.stdout)
                info["pdftotext_rc"] = r.returncode
    return "\n".join(out), info


def plan(body):
    msgs = body.get("messages") or []
    ui, prompt = turn_of(msgs)
    after = msgs[ui + 1:] if ui is not None else []
    step = sum(1 for m in after if m.get("role") == "assistant" and any(b.get("type") == "tool_use" for b in blocks(m)))
    results = [b for m in after if m.get("role") == "user" for b in blocks(m) if b.get("type") == "tool_result"]
    rec = {"step": step, "prompt": prompt[-300:]}
    ex = EXACT.search(prompt)
    att = ATTACHED.search(prompt)
    if ex:
        return rec | {"action": "exact"}, [{"type": "text", "text": ex.group(1).rstrip(".")}]
    if att and re.search(r"marker|pdf|what", prompt, re.I):
        rec |= {"attached": att.groupdict()}
        if step == 0:
            return rec | {"action": "read"}, [{"type": "text", "text": f"Opening {att['name']}."},
                                               {"type": "tool_use", "id": "toolu_01SimRead0", "name": "Read", "input": {"file_path": att["path"]}}]
        text, info = text_of_result(results[-1]) if results else ("", {})
        m = MARKER.search(text)
        rec |= {"result": info, "found": m.group(1) if m else None}
        if m:
            return rec | {"action": "answer"}, [{"type": "text", "text": f"The marker word in {att['name']} is {m.group(1)}."}]
        return rec | {"action": "answer"}, [{"type": "text", "text": f"I opened {att['name']} but found no marker word in it ({', '.join(info.get('kinds') or ['nothing'])})."}]
    if "marker.html" in prompt:
        d = ARTDIR.search("\n".join(texts([body.get("system"), msgs])))
        said = [SAID.search(b.get("text", "")) for m in msgs if m.get("role") == "assistant" for b in blocks(m) if b.get("type") == "text"]
        word = next((s.group(1) for s in reversed(said) if s), None)
        folder = d.group(1).rstrip(".,;:)").rstrip("/") if d else None
        if folder and os.path.basename(folder) != "artifacts":  # a guard: it writes into an artifacts folder or nowhere
            folder, d = None, None
        rec |= {"artifacts_dir": folder, "word": word}
        if not d or not word:
            return rec | {"action": "cannot"}, [{"type": "text", "text": "I can't: " + ("I don't know where your artifacts folder is." if not d else "I don't know the marker word yet.")}]
        if step == 0:
            html = f"<!doctype html><meta charset=utf-8><title>marker</title><h1>The marker word</h1><p id=marker>{word}</p>\n"
            return rec | {"action": "write"}, [{"type": "text", "text": "Writing marker.html."},
                                                {"type": "tool_use", "id": "toolu_01SimWrite0", "name": "Write",
                                                 "input": {"file_path": os.path.join(folder, "marker.html"), "content": html}}]
        res, _ = text_of_result(results[-1]) if results else ("", {})
        rec |= {"write_result": res[:200]}
        return rec | {"action": "link"}, [{"type": "text", "text": "Here it is: [marker.html](/api/artifact/marker.html)"}]
    return rec | {"action": "ok"}, [{"type": "text", "text": "OK."}]


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._json(404, {"type": "error", "error": {"type": "not_found_error", "message": self.path}})

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if "count_tokens" in self.path:
            return self._json(200, {"input_tokens": n // 4})
        if not self.path.split("?")[0].endswith("/v1/messages"):
            return self._json(404, {"type": "error", "error": {"type": "not_found_error", "message": self.path}})
        try:
            rec, content = plan(body)
        except Exception as e:  # noqa: BLE001 — say it, as a model would
            rec, content = {"action": "crash", "error": repr(e)[:300]}, [{"type": "text", "text": f"(cc_model: {e!r})"}]
        log({"bytes": n, "model": body.get("model"), **rec})
        stop = "tool_use" if any(b["type"] == "tool_use" for b in content) else "end_turn"
        msg = {"id": f"msg_sim{int(time.time() * 1000)}", "type": "message", "role": "assistant", "model": body.get("model") or "sim",
               "stop_sequence": None, "usage": {"input_tokens": n // 4, "output_tokens": 8}}
        if not body.get("stream"):
            return self._json(200, {**msg, "content": content, "stop_reason": stop})
        ev = lambda t, d: f"event: {t}\ndata: {json.dumps({'type': t, **d})}\n\n"
        frames = [ev("message_start", {"message": {**msg, "content": [], "stop_reason": None}})]
        for i, b in enumerate(content):
            if b["type"] == "text":
                frames += [ev("content_block_start", {"index": i, "content_block": {"type": "text", "text": ""}}),
                           ev("content_block_delta", {"index": i, "delta": {"type": "text_delta", "text": b["text"]}})]
            else:
                args = json.dumps(b["input"])
                frames += [ev("content_block_start", {"index": i, "content_block": {**b, "input": {}}}),
                           ev("content_block_delta", {"index": i, "delta": {"type": "input_json_delta", "partial_json": args}})]
            frames.append(ev("content_block_stop", {"index": i}))
        frames += [ev("message_delta", {"delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 8}}), ev("message_stop", {})]
        data = "".join(frames).encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--log", required=True)
    a = ap.parse_args()
    LOG["f"] = open(a.log, "a")
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()


if __name__ == "__main__":
    main()
