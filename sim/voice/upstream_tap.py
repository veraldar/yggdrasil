#!/usr/bin/env python3
"""upstream_tap.py — where a brain's model time goes: a pass-through for the anthropic dialect
(POST /v1/messages, streamed) that logs one JSON line per upstream call.

    upstream_tap.py --upstream https://api.z.ai/api/anthropic --port 4199 --log tap.jsonl

Per call: model, thinking budget, system/tools/messages sizes (chars), the provider's own token
counts (input, cache read/write, output), time to the response head, to the first thinking, text
and tool_use block, and to the end; the stop reason; the tool names asked for. The key is passed
through untouched and never logged. Point a brain at it with SIM_UPSTREAM_BASE_URL (brain-up.sh).
"""
import argparse, http.server, json, socketserver, sys, threading, time, urllib.request, urllib.error

LOG = None
LOCK = threading.Lock()


def note(rec):
    with LOCK:
        LOG.write(json.dumps(rec) + "\n")
        LOG.flush()


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    upstream = ""

    def log_message(self, fmt, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else b""
        t0 = time.time()
        rec = {"t": round(t0, 3), "path": self.path, "bytes": len(body)}
        try:
            j = json.loads(body)
            sysv = j.get("system")
            rec.update(model=j.get("model"), stream=j.get("stream"), think=(j.get("thinking") or {}).get("budget_tokens"),
                       system_chars=len(json.dumps(sysv)) if sysv else 0, tools=len(j.get("tools") or []),
                       tools_chars=len(json.dumps(j.get("tools") or [])), messages=len(j.get("messages") or []),
                       last_user_chars=len(json.dumps((j.get("messages") or [{}])[-1])))
        except ValueError:
            pass
        hdr = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length", "connection", "accept-encoding")}
        req = urllib.request.Request(self.upstream + self.path, data=body, method="POST", headers=hdr)
        try:
            try:
                up = urllib.request.urlopen(req, timeout=600)
            except urllib.error.HTTPError as e:
                up = e
            rec["status"] = up.status if hasattr(up, "status") else up.code
            rec["head_ms"] = int((time.time() - t0) * 1000)
            self.send_response(rec["status"])
            for k, v in up.headers.items():
                if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                    self.send_header(k, v)
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            buf, tools = b"", []
            while True:
                chunk = up.read1(65536) if hasattr(up, "read1") else up.read(65536)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.startswith(b"data:"):
                        continue
                    try:
                        d = json.loads(line[5:])
                    except ValueError:
                        continue
                    ms = int((time.time() - t0) * 1000)
                    ty = d.get("type")
                    if ty == "message_start":
                        u = (d.get("message") or {}).get("usage") or {}
                        rec.update(input_tokens=u.get("input_tokens"), cache_read=u.get("cache_read_input_tokens"),
                                   cache_write=u.get("cache_creation_input_tokens"))
                    elif ty == "content_block_start":
                        b = d.get("content_block") or {}
                        k = {"thinking": "first_think_ms", "text": "first_text_ms", "tool_use": "first_tool_ms"}.get(b.get("type"))
                        if k and k not in rec:
                            rec[k] = ms
                        if b.get("type") == "tool_use":
                            tools.append(b.get("name"))
                    elif ty == "message_delta":
                        u = d.get("usage") or {}
                        rec["output_tokens"] = u.get("output_tokens")
                        rec["stop"] = (d.get("delta") or {}).get("stop_reason")
                        if u.get("input_tokens") is not None:
                            rec["input_tokens"] = u.get("input_tokens")
                        if u.get("cache_read_input_tokens") is not None:
                            rec["cache_read"] = u.get("cache_read_input_tokens")
            self.wfile.write(b"0\r\n\r\n")
            rec["tool_names"] = tools
        except (BrokenPipeError, ConnectionResetError) as e:
            rec["error"] = str(e)
        rec["total_ms"] = int((time.time() - t0) * 1000)
        note(rec)


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--upstream", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--log", required=True)
    a = ap.parse_args()
    H.upstream = a.upstream.rstrip("/")
    LOG = open(a.log, "a")
    S(("127.0.0.1", a.port), H).serve_forever()
