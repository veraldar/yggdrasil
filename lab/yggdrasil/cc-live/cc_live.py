#!/usr/bin/env python3
"""cc-live — the box's running Claude Code sessions, live on the phone.

The app's "Claude Code live" page talks to this helper (never the brain: it runs outside the
brain's sandbox, because `claude attach` needs the Claude Code daemon's sockets in /tmp and
/run/user, the claude binary and its sign-in). It only ever runs three things:

  claude agents --json        which sessions are running (interactive and background)
  claude attach <short id>    a PTY on ONE background session, to type into it
  (and reads)                 that session's transcript, ~/.claude/projects/<cwd>/<id>.jsonl

There is no shell and no other command. A session must be in `claude agents --json` to be read;
only a background session (kind "background") takes input, and a page's input goes only to the
session its URL names, through the PTY attached to that session's short id. Interactive sessions
(a terminal's own `claude`) can't be attached: they are watch-only.

HTTP on loopback only, every call with the header x-cc-live-token (the token file, 0600, is
outside the brain's sandbox; the app reads it):

  GET  /sessions                      the running sessions {sessionId, short, name, kind, status,
                                      state, cwd, startedAt, title, canType}
  GET  /s/<id>/history?before=&limit= older items (scroll back): {items, cursor}
  GET  /s/<id>/stream                 SSE: hello, history (the last ~200 items), then items as the
                                      transcript grows, status (busy/idle/blocked + the permission
                                      prompt on screen, if any), sub (a subagent's progress)
  GET  /s/<id>/screen                 the attached screen as text + the prompt parsed from it
  POST /s/<id>/input  {text}          type text + Enter (refused while a prompt waits)
  POST /s/<id>/key    {key}           esc (interrupt / cancel) | enter | up | down | tab | shift-tab
  POST /s/<id>/answer {n, label}      pick option n of the prompt on screen (label must match)
  GET  /s/<id>/term                   SSE: the raw terminal (base64), for xterm.js
  POST /s/<id>/term   {data}          raw keys (Ctrl+Z dropped; ← on an empty input dropped: it
                                      would leave this session for the agent view)
  POST /s/<id>/term/size {cols, rows}

Run: cc_live.py --port 4320 --token-file ~/.cache/root-sim/cc-live.token [--claude PATH]
Standard library only.
"""
import argparse
import base64
import fcntl
import hmac
import json
import os
import pty
import queue
import re
import secrets
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript as T  # noqa: E402
import vt  # noqa: E402

CLAUDE = "claude"
TOKEN = ""
PROJECTS = os.path.expanduser("~/.claude/projects")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SHORT = re.compile(r"^[0-9a-z][0-9a-z-]{0,40}$")
COLS, ROWS = 100, 40
IDLE = 120  # s: a PTY nobody uses (no input, no terminal tab, no prompt on view) is closed


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


# ---- the running sessions ---------------------------------------------------------------------
class Agents:
    def __init__(self):
        self.lock = threading.Lock()
        self.at = 0.0
        self.rows = []
        self.err = ""

    def list(self, fresh=1.5):
        with self.lock:
            if time.time() - self.at > fresh:
                try:
                    out = subprocess.run([CLAUDE, "agents", "--json"], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
                    rows = json.loads(out.stdout or "[]")
                    self.rows = [r for r in rows if isinstance(r, dict) and UUID.match(str(r.get("sessionId", "")))]
                    self.err = "" if out.returncode == 0 else (out.stderr or "").strip()[:300]
                except (OSError, ValueError, subprocess.TimeoutExpired) as e:
                    self.err = f"claude agents --json failed: {e}"
                self.at = time.time()
            return list(self.rows)

    def get(self, sid, fresh=1.5):
        return next((r for r in self.list(fresh) if r.get("sessionId") == sid), None)

    def by_short(self, short):
        return next((r for r in self.list() if r.get("id") == short), None)


AGENTS = Agents()
_titles = {}


def title_of(path):
    """custom-title > newest ai-title > the first thing typed (metadata only, cached by size)."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return ""
    hit = _titles.get(path)
    if hit and hit[0] == size:
        return hit[1]
    title = ""
    try:
        with open(path, "rb") as f:
            f.seek(max(0, size - 512 * 1024))
            tail = f.read()
            for ln in reversed(tail.split(b"\n")):
                if b'"custom-title"' in ln or b'"ai-title"' in ln:
                    e = T._parse(ln) or {}
                    title = e.get("customTitle") or e.get("aiTitle") or ""
                    if title:
                        break
            if not title:
                f.seek(0)
                for ln in f.read(256 * 1024).split(b"\n"):
                    for it in T.items(T._parse(ln)) if ln.strip() else []:
                        if it["k"] == "user":
                            title = it["text"].strip().splitlines()[0] if it["text"].strip() else ""
                            break
                    if title:
                        break
    except OSError:
        pass
    title = title[:80]
    _titles[path] = (size, title)
    return title


def public(r):
    sid = r["sessionId"]
    p = T.path_for(PROJECTS, r.get("cwd", ""), sid)
    bg = r.get("kind") == "background" and bool(SHORT.match(str(r.get("id", ""))))
    return {"sessionId": sid, "short": r.get("id", ""), "name": r.get("name", ""), "kind": r.get("kind", ""),
            "status": r.get("status", ""), "state": r.get("state", ""), "cwd": r.get("cwd", ""),
            "startedAt": r.get("startedAt", 0), "title": title_of(p) if p else "", "canType": bg,
            "transcript": bool(p)}


# ---- what the attached screen shows -----------------------------------------------------------
OPT = re.compile(r"^\s*(❯\s*)?(\d)\.\s+(\S.*)$")
RULE = re.compile(r"^[\s─━╌┄═-]+$")


def input_box(lines):
    """True when the screen ends with Claude Code's input box (a rule, `❯ …`, a rule)."""
    for i in range(len(lines) - 1, 1, -1):
        if lines[i - 1].lstrip().startswith("❯") and "─" in lines[i - 2] and RULE.match(lines[i] or "x"):
            return True
    return False


def input_empty(lines):
    for i in range(len(lines) - 1, 1, -1):
        if lines[i - 1].lstrip().startswith("❯") and "─" in lines[i - 2] and RULE.match(lines[i] or "x"):
            return lines[i - 1].strip() == "❯"
    return False


def parse_prompt(lines):
    """A question with numbered options at the bottom of the screen (a permission prompt, a
    plan approval, a multiple-choice question): {question, context, options:[{n, label,
    selected}], footer} — None when the input box shows instead."""
    if input_box(lines):
        return None
    rows = list(lines)
    while rows and not rows[-1].strip():
        rows.pop()
    if not rows:
        return None
    opts = []
    first = last = None
    i = len(rows) - 1
    bottom = max(0, len(rows) - 30)
    # find the last option block (1., 2., … with indented continuation lines)
    while i >= bottom:
        m = OPT.match(rows[i])
        if m:
            last = i
            break
        i -= 1
    if last is None:
        return None
    j = last
    block = []
    while j >= bottom:
        m = OPT.match(rows[j])
        if m:
            block.append((j, m))
            if m.group(2) == "1":
                first = j
                break
        elif not rows[j].strip() or not rows[j].startswith("    "):
            break
        j -= 1
    if first is None:
        return None
    block.reverse()
    nums = [int(m.group(2)) for _, m in block]
    if nums != list(range(1, len(nums) + 1)) or len(nums) < 2:
        return None
    for k, (row, m) in enumerate(block):
        end = block[k + 1][0] if k + 1 < len(block) else last + 1
        label = m.group(3).strip()
        for r in range(row + 1, end):
            if rows[r].strip():
                label += " " + rows[r].strip()
        opts.append({"n": int(m.group(2)), "label": label, "selected": bool(m.group(1))})
    # continuation lines of the last option
    r = last + 1
    tail = []
    while r < len(rows):
        if rows[r].startswith("      ") and rows[r].strip():
            opts[-1]["label"] += " " + rows[r].strip()
        elif rows[r].strip():
            tail.append(rows[r].strip())
        r += 1
    q = first - 1
    while q >= 0 and not rows[q].strip():
        q -= 1
    question = rows[q].strip() if q >= 0 else ""
    ctx = []
    c = q - 1
    while c >= 0 and len(ctx) < 14:
        line = rows[c]
        if "─" in line and RULE.match(line):
            break
        if line.strip() and not RULE.match(line):
            ctx.append(line.rstrip())
        c -= 1
    ctx.reverse()
    pad = min((len(x) - len(x.lstrip()) for x in ctx), default=0)
    ctx = [x[pad:] for x in ctx]
    return {"question": question, "context": ctx, "options": opts, "footer": " ".join(tail)[:200]}


# ---- a PTY attached to one background session -------------------------------------------------
class Term:
    def __init__(self, entry):
        self.short = entry["id"]
        self.name = entry.get("name", "")
        self.sid = entry["sessionId"]
        self.cwd = entry.get("cwd") or os.path.expanduser("~")
        self.cols, self.rows = COLS, ROWS
        self.screen = vt.Screen(self.cols, self.rows)
        self.lock = threading.Lock()
        self.subs = []  # raw-terminal subscribers (queues of bytes)
        self.raw = bytearray()
        self.used = time.time()
        self.alive = False
        self.pid = self.fd = None

    def start(self):
        pid, fd = pty.fork()
        if pid == 0:  # the child: only ever `claude attach <short>`
            try:
                os.chdir(self.cwd)
            except OSError:
                pass
            env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
            os.execvpe(CLAUDE, [CLAUDE, "attach", self.short], env)
            os._exit(127)
        self.pid, self.fd, self.alive = pid, fd, True
        self._size()
        threading.Thread(target=self._read, daemon=True).start()
        log(f"attach {self.short} ({self.name}) pid {pid}")

    def _size(self):
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))
        except OSError:
            pass

    def resize(self, cols, rows):
        cols, rows = max(40, min(240, int(cols))), max(12, min(100, int(rows)))
        if (cols, rows) == (self.cols, self.rows):
            return
        with self.lock:
            self.cols, self.rows = cols, rows
            self.screen.resize(cols, rows)
        self._size()

    def _read(self):
        while True:
            try:
                d = os.read(self.fd, 65536)
            except OSError:
                d = b""
            if not d:
                break
            with self.lock:
                self.screen.feed(d)
                self.raw.extend(d)
                if len(self.raw) > 512 * 1024:
                    del self.raw[: len(self.raw) - 256 * 1024]
                subs = list(self.subs)
            for q in subs:
                q.put(d)
        self.alive = False
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        for q in list(self.subs):
            q.put(None)
        log(f"attach {self.short} ended")

    def lines(self):
        with self.lock:
            return self.screen.lines()

    def ready(self, timeout=12.0):
        end = time.time() + timeout
        while time.time() < end and self.alive:
            ls = self.lines()
            if (self.name and any(self.name in ln and "─" in ln for ln in ls)) or parse_prompt(ls):
                return True
            time.sleep(0.15)
        return False

    def write(self, b):
        self.used = time.time()
        os.write(self.fd, b)

    def close(self):
        if self.alive and self.pid:
            try:
                os.kill(self.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
        self.alive = False


class Terms:
    def __init__(self):
        self.lock = threading.Lock()
        self.by = {}
        threading.Thread(target=self._reap, daemon=True).start()

    def get(self, entry, create=True):
        with self.lock:
            t = self.by.get(entry["sessionId"])
            if t and not t.alive:
                t = None
            if t is None and create:
                t = Term(entry)
                t.start()
                self.by[entry["sessionId"]] = t
            return t

    def _reap(self):
        while True:
            time.sleep(10)
            with self.lock:
                for sid, t in list(self.by.items()):
                    if not t.alive:
                        del self.by[sid]
                    elif not t.subs and time.time() - t.used > IDLE:
                        log(f"detach {t.short}: idle")
                        t.close()
                        del self.by[sid]


TERMS = Terms()

KEYS = {"esc": b"\x1b", "enter": b"\r", "up": b"\x1b[A", "down": b"\x1b[B", "tab": b"\t", "shift-tab": b"\x1b[Z"}
CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def type_text(t, text):
    text = CTRL.sub("", text.replace("\r\n", "\n").replace("\r", "\n")).strip("\n")
    if "\n" in text:  # bracketed paste: newlines stay in the message instead of sending it
        t.write(b"\x1b[200~" + text.encode() + b"\x1b[201~")
    else:
        t.write(text.encode())
    time.sleep(0.3)
    t.write(b"\r")


def term_filter(t, data):
    """Raw keys from the terminal tab, minus the two that would leave this session: Ctrl+Z (drops
    the attach client to a shell it doesn't have) and ← on an empty input (the agent view)."""
    data = data.replace(b"\x1a", b"")
    if (b"\x1b[D" in data or b"\x1bOD" in data) and input_empty(t.lines()):
        data = data.replace(b"\x1b[D", b"").replace(b"\x1bOD", b"")
    return data


# ---- HTTP -------------------------------------------------------------------------------------
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def _auth(self):
        got = self.headers.get("x-cc-live-token", "")
        if TOKEN and hmac.compare_digest(got, TOKEN):
            return True
        self._send(401, {"error": "not allowed"})
        return False

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 256 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return None

    def _session(self, sid, fresh=1.5):
        if not UUID.match(sid):
            self._send(400, {"error": "not a session id"})
            return None
        r = AGENTS.get(sid, fresh)
        if r is None:
            r = AGENTS.get(sid, 0)  # just started? ask again once
        if r is None:
            self._send(404, {"error": "that Claude Code session is not running on this box", "code": "gone"})
            return None
        return r

    def _route(self):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        return u, parts

    def do_GET(self):
        if not self._auth():
            return
        u, parts = self._route()
        qs = parse_qs(u.query)
        if parts == ["sessions"]:
            rows = AGENTS.list()
            out = [public(r) for r in rows]
            out.sort(key=lambda r: (r["kind"] != "background", -int(r["startedAt"] or 0)))
            return self._send(200, {"sessions": out, "error": AGENTS.err})
        if len(parts) >= 3 and parts[0] == "s":
            r = self._session(parts[1])
            if r is None:
                return
            if parts[2] == "history":
                p = T.path_for(PROJECTS, r.get("cwd", ""), r["sessionId"])
                if not p:
                    return self._send(200, {"items": [], "cursor": 0})
                before = qs.get("before", [None])[0]
                limit = max(1, min(400, int(qs.get("limit", ["200"])[0] or 200)))
                pg = T.page(p, before=int(before) if before not in (None, "") else None, want=limit)
                return self._send(200, {"items": pg["items"], "cursor": pg["cursor"]})
            if parts[2] == "stream":
                return self._stream(r, qs)
            if parts[2] == "screen":
                t = TERMS.get(r, create=False)
                ls = t.lines() if t else []
                return self._send(200, {"attached": bool(t), "lines": ls, "prompt": parse_prompt(ls) if t else None})
            if parts[2] == "term" and len(parts) == 3:
                return self._term(r, qs)
        self._send(404, {"error": "no such route"})

    def do_POST(self):
        if not self._auth():
            return
        u, parts = self._route()
        if len(parts) < 3 or parts[0] != "s":
            return self._send(404, {"error": "no such route"})
        body = self._body()
        if body is None or not isinstance(body, dict):
            return self._send(400, {"error": "a JSON object, please"})
        r = self._session(parts[1], fresh=0.5)
        if r is None:
            return
        if r.get("kind") != "background" or not SHORT.match(str(r.get("id", ""))):
            return self._send(403, {"error": "this is a terminal's own Claude Code session (interactive): watch only — it can't be attached, so nothing can be typed into it from here"})
        act = "/".join(parts[2:])
        t = TERMS.get(r)
        if not t.ready():
            return self._send(503, {"error": "the session's screen did not come up (claude attach)"})
        t.used = time.time()
        if act == "input":
            text = body.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > 20000:
                return self._send(400, {"error": "text: 1–20000 characters"})
            pr = parse_prompt(t.lines())
            if pr:
                return self._send(409, {"error": "the session is asking something — answer it first", "prompt": pr})
            type_text(t, text)
            log(f"input {t.short}: {len(text)} chars")
            return self._send(200, {"ok": True})
        if act == "key":
            k = body.get("key")
            if k not in KEYS:
                return self._send(400, {"error": f"key: one of {', '.join(KEYS)}"})
            t.write(KEYS[k])
            log(f"key {t.short}: {k}")
            return self._send(200, {"ok": True})
        if act == "answer":
            pr = parse_prompt(t.lines())
            n = body.get("n")
            label = str(body.get("label") or "")
            opt = next((o for o in (pr or {}).get("options", []) if o["n"] == n), None)
            if not opt or (label and not opt["label"].startswith(label[:40])):
                return self._send(409, {"error": "that question is no longer on screen", "prompt": pr})
            t.write(str(n).encode())
            log(f"answer {t.short}: {n} ({opt['label'][:40]})")
            return self._send(200, {"ok": True})
        if act == "term":
            data = body.get("data")
            if not isinstance(data, str) or len(data) > 65536:
                return self._send(400, {"error": "data: a string"})
            b = term_filter(t, data.encode())
            if b:
                t.write(b)
            return self._send(200, {"ok": True})
        if act == "term/size":
            try:
                t.resize(body.get("cols"), body.get("rows"))
            except (TypeError, ValueError):
                return self._send(400, {"error": "cols, rows: numbers"})
            return self._send(200, {"ok": True, "cols": t.cols, "rows": t.rows})
        self._send(404, {"error": "no such route"})

    # ---- SSE ----------------------------------------------------------------------------------
    def _sse_open(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(b"retry: 3000\n\n")
        self.wfile.flush()

    def _ev(self, name, obj):
        self.wfile.write(f"event: {name}\ndata: {json.dumps(obj, ensure_ascii=False)}\n\n".encode())
        self.wfile.flush()

    def _stream(self, r, qs):
        sid = r["sessionId"]
        limit = max(1, min(400, int(qs.get("limit", ["200"])[0] or 200)))
        self._sse_open()
        try:
            self._ev("hello", public(r))
            path = None
            tail = None
            last_status = None
            subs = {}  # subagent id → [tool_use id, last size, done]
            t_status = t_sub = t_ping = 0.0
            while True:
                if tail is None:
                    path = T.path_for(PROJECTS, r.get("cwd", ""), sid)
                    if path:
                        pg = T.page(path, want=limit)
                        self._ev("history", {"items": pg["items"], "cursor": pg["cursor"]})
                        tail = T.Tail(path, pg["tail"])
                        self._track(pg["items"], subs)
                else:
                    new = tail.read()
                    if new:
                        new = T.merge(new)
                        self._ev("items", {"items": new})
                        self._track(new, subs)
                now = time.time()
                if now - t_status > 1.5:
                    t_status = now
                    cur = AGENTS.get(sid)
                    st = {"gone": cur is None}
                    if cur:
                        st.update(status=cur.get("status", ""), state=cur.get("state", ""), kind=cur.get("kind", ""))
                        bg = cur.get("kind") == "background" and SHORT.match(str(cur.get("id", "")))
                        t = TERMS.get(cur, create=bool(bg) and cur.get("state") == "blocked") if bg else None
                        if t:
                            if cur.get("state") == "blocked":
                                t.used = now  # a question on view keeps the PTY
                            st["attached"] = True
                            st["prompt"] = parse_prompt(t.lines())
                        if cur.get("id") and cur["sessionId"] != sid:
                            st["moved"] = cur["sessionId"]
                    else:
                        moved = None
                        if r.get("id"):
                            m = AGENTS.by_short(r["id"])
                            moved = m["sessionId"] if m else None
                        if moved:
                            st["moved"] = moved
                    if st != last_status:
                        self._ev("status", st)
                        last_status = st
                if path and now - t_sub > 2:
                    t_sub = now
                    for agent, rec in subs.items():
                        if rec[2]:
                            continue
                        s = T.subagent_stats(path, agent)
                        if s and s["size"] != rec[1]:
                            rec[1] = s["size"]
                            self._ev("sub", {"id": rec[0], "agent": agent, "tools": s["tools"], "last": s["last"]})
                if now - t_ping > 15:
                    t_ping = now
                    self._ev("ping", {"t": int(now)})
                time.sleep(0.25)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def _track(self, its, subs):
        for it in its:
            agent = it.get("agent")
            if not agent:
                continue
            if it["k"] in ("tool", "result") and agent not in subs:
                subs[agent] = [it["id"], -1, False]
            elif it["k"] == "note" and it.get("kind") == "agent" and agent in subs:
                subs[agent][2] = True
        if len(subs) > 40:  # only the newest few are followed
            for k in list(subs)[:-40]:
                del subs[k]

    def _term(self, r, qs):
        if r.get("kind") != "background" or not SHORT.match(str(r.get("id", ""))):
            return self._send(403, {"error": "watch only: an interactive session can't be attached"})
        t = TERMS.get(r)
        try:
            cols, rows = int(qs.get("cols", [COLS])[0]), int(qs.get("rows", [ROWS])[0])
        except ValueError:
            cols, rows = COLS, ROWS
        q = queue.Queue()
        with t.lock:
            t.subs.append(q)
        self._sse_open()
        try:
            t.resize(cols, rows)
            # what is on screen now, then the live bytes (a resize makes Claude Code redraw)
            ls = t.lines()
            snap = "\x1b[2J\x1b[H" + "\r\n".join(ls)
            self._ev("data", {"b": base64.b64encode(snap.encode()).decode()})
            t_ping = time.time()
            while True:
                try:
                    d = q.get(timeout=5)
                except queue.Empty:
                    d = b""
                if d is None:
                    self._ev("end", {})
                    return
                if d:
                    while not q.empty():
                        nxt = q.get_nowait()
                        if nxt is None:
                            break
                        d += nxt
                    self._ev("data", {"b": base64.b64encode(d).decode()})
                    t.used = time.time()
                if time.time() - t_ping > 15:
                    t_ping = time.time()
                    self._ev("ping", {})
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with t.lock:
                if q in t.subs:
                    t.subs.remove(q)
                last = not t.subs
            if last:
                t.resize(COLS, ROWS)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return  # a phone that went away mid-stream
        super().handle_error(request, client_address)


def main():
    global CLAUDE, TOKEN, PROJECTS
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=4320)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--claude", default="claude")
    ap.add_argument("--projects", default=PROJECTS)
    a = ap.parse_args()
    if a.host not in ("127.0.0.1", "::1", "localhost"):
        sys.exit("cc-live listens on loopback only")
    CLAUDE, PROJECTS = a.claude, a.projects
    tf = os.path.expanduser(a.token_file)
    if not os.path.exists(tf):
        fd = os.open(tf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, secrets.token_hex(24).encode())
        os.close(fd)
    TOKEN = open(tf).read().strip()
    if len(TOKEN) < 16:
        sys.exit("token file: at least 16 characters")
    srv = Server((a.host, a.port), H)
    log(f"cc-live on {a.host}:{a.port} · claude {CLAUDE}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
