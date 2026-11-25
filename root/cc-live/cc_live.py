#!/usr/bin/env python3
"""cc-live — the box's running Claude Code sessions, live on the phone.

The app's "Claude Code live" page talks to this helper (`claude attach` needs the Claude Code
daemon's sockets in /tmp and /run/user, the claude binary and its sign-in). It only ever runs
three things:

  claude agents --json        which sessions are running (interactive and background)
  claude attach <short id>    a PTY on ONE background session, to type into it
  (and reads)                 that session's transcript, ~/.claude/projects/<cwd>/<id>.jsonl

There is no shell and no other command. A session must be in `claude agents --json` to be read;
only a background session (kind "background") takes input, and a page's input goes only to the
session its URL names, through the PTY attached to that session's short id. Interactive sessions
(a terminal's own `claude`) can't be attached: they are watch-only.

HTTP on loopback only, every call with the header x-cc-live-token (the token file, 0600; the app
reads it):

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

Every harness (11-15) — Claude Code, Antigravity (agy), opencode — the same way, any of their
conversations (running or not), so the phone sees and continues them and the terminal does too:
  GET  /harness                       the newest conversations of each: {kind, id, cwd, title,
                                      modified, live: "bg" | "cmd" | "here" | null, canType, short}
  GET  /h/<kind>/<id>/history         as /s/… for any kind (kind: claude | antigravity | opencode)
  GET  /h/<kind>/<id>/stream          SSE: hello, history, items, status {live, …}
`live`: "cmd" open in a terminal (watch only here: one writer at a time), "tmux" open in a
terminal inside tmux (typed into from here too, through tmux — both ways), "bg" a Claude Code
background session (typed into through its PTY), "here" the brain is running a turn on it right
now, null not open anywhere (the phone continues it through the brain).
  POST /h/<kind>/<id>/input {text} · key {key} · answer {n, label}   type into a tmux or
                                      background session (as /s/… for Claude Code) What is open in a
terminal is written to --live-file every 2 s for the brain, which never runs a turn on those.
The agy and opencode conversations are read by harness_agy.py / harness_opencode.py (read only).

Run: cc_live.py --port 4320 --token-file ~/.cache/root-sim/cc-live.token [--claude PATH] [--live-file F]
Standard library only.
"""
import argparse
import base64
import fcntl
import fnmatch
import hmac
import json
import os
import pty
import queue
import re
import secrets
import shutil
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

READERS = {}  # brain harness kind → reader module (recent, live, page, Tail)
for _kind, _mod in (("antigravity", "harness_agy"), ("opencode", "harness_opencode")):
    try:
        READERS[_kind] = __import__(_mod)
    except ImportError:
        pass

CLAUDE = "claude"
TOKEN = ""
LIVE_FILE = ""
CWD_PREFIX = ""  # --cwd-prefix: only conversations in this folder (a sim's helper, never the owner's others)
PROJECTS = os.path.expanduser("~/.claude/projects")
PROC = "/proc"
# the brain's own units: a turn it runs (`claude -p`, opencode, agy) is its child, in its cgroup.
# hub-brain.service: the home root since stage B (11-20, scripts/hub-units.sh); rootsim-*: a sim's
# brain (sim/brain-up.sh, sim/acceptance/twin-up.sh) and the preview before stage B
HERE_UNITS = ("hub-brain.service", "rootsim-*")
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


def claude_find(sid):
    """A Claude Code transcript by session id, wherever it was started (running or not)."""
    try:
        for d in os.scandir(PROJECTS):
            p = os.path.join(d.path, f"{sid}.jsonl")
            if d.is_dir() and os.path.isfile(p):
                return p
    except OSError:
        pass
    return None


_cwds = {}


def claude_cwd(path):
    """The folder a transcript's session runs in (its events carry `cwd`)."""
    hit = _cwds.get(path)
    if hit:
        return hit
    cwd = ""
    try:
        with open(path, "rb") as f:
            for ln in f.read(256 * 1024).split(b"\n"):
                if b'"cwd"' in ln:
                    cwd = (T._parse(ln) or {}).get("cwd") or ""
                    if cwd:
                        break
    except OSError:
        pass
    if cwd:
        _cwds[path] = cwd
    return cwd


def own_work(cwd):
    """A brain's or a sim's own work folder: not a terminal's conversation (and, for a sim's
    helper, anything outside its --cwd-prefix)."""
    cwd = cwd or ""
    if CWD_PREFIX and not (cwd + "/").startswith(CWD_PREFIX.rstrip("/") + "/"):
        return True
    return cwd.startswith((os.path.expanduser("~/.cache/"), os.path.expanduser("~/.local/state/")))


def claude_recent(n=20):
    """The newest Claude Code conversations on this box (transcripts by mtime)."""
    rows = []
    try:
        for d in os.scandir(PROJECTS):
            if not d.is_dir():
                continue
            for f in os.scandir(d.path):
                if f.name.endswith(".jsonl") and UUID.match(f.name[:-6]) and f.is_file():
                    rows.append((f.stat().st_mtime, f.path, f.name[:-6]))
    except OSError:
        pass
    rows.sort(reverse=True)
    out = []
    for mt, path, sid in rows if CWD_PREFIX else rows[: n * 2]:
        cwd = claude_cwd(path)
        title = title_of(path)
        if not cwd or not title:  # an empty or bookkeeping-only transcript
            continue
        if own_work(cwd):
            continue
        out.append({"kind": "claude", "id": sid, "cwd": cwd, "title": title, "modified": int(mt * 1000)})
        if len(out) >= n:
            break
    return out


def where(pid):
    """Who has a conversation open: "here" when the process is the brain's own turn (its cgroup is
    one of HERE_UNITS), "cmd" when it runs anywhere else (a terminal, tmux, ssh), None when the
    process is gone (it holds nothing)."""
    try:
        with open(f"{PROC}/{int(pid)}/cgroup") as f:
            text = f.read()
    except (FileNotFoundError, ProcessLookupError):
        return None
    except (OSError, ValueError, TypeError):
        return "cmd"
    for ln in text.splitlines():  # "0::/user.slice/…/app.slice/hub-brain.service" (v1: one per controller)
        for unit in ln.split(":", 2)[-1].split("/"):
            if any(fnmatch.fnmatchcase(unit, u) for u in HERE_UNITS):
                return "here"
    return "cmd"


TMUX = shutil.which("tmux") or "tmux"


def _ppid(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return int(f.read().rsplit(")", 1)[1].split()[1])
    except (OSError, IndexError, ValueError):
        return 0


def tmux_panes():
    """pane's process → pane id, for every tmux pane on the box ({} without a tmux server)."""
    try:
        out = subprocess.run([TMUX, "list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    panes = {}
    for ln in out.stdout.splitlines():
        a = ln.split()
        if len(a) == 2 and a[0].isdigit():
            panes[int(a[0])] = a[1]
    return panes


def pane_of(pid, panes):
    """The tmux pane a process runs in (it, or one of its parents, is the pane's process)."""
    p = int(pid or 0)
    for _ in range(16):
        if p <= 1:
            return None
        if p in panes:
            return panes[p]
        p = _ppid(p)
    return None


class TmuxTerm:
    """A session open in a tmux pane: typed into with tmux itself, so the owner's terminal shows
    every key as it lands (both ways). Same face as Term for the routes: lines, write, ready."""
    NAMES = {b"\x1b": "Escape", b"\r": "Enter", b"\x1b[A": "Up", b"\x1b[B": "Down", b"\t": "Tab", b"\x1b[Z": "BTab"}

    def __init__(self, pane):
        self.pane = pane
        self.short = pane
        self.used = time.time()

    def _tmux(self, *a, data=None):
        subprocess.run([TMUX, *a], input=data, capture_output=True, timeout=10)

    def ready(self, timeout=0):
        return True

    def lines(self):
        try:
            out = subprocess.run([TMUX, "capture-pane", "-p", "-t", self.pane], capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            return []
        return out.stdout.rstrip("\n").split("\n") if out.returncode == 0 else []

    def write(self, b):
        name = self.NAMES.get(b)
        if name:
            self._tmux("send-keys", "-t", self.pane, name)
        else:
            self._tmux("send-keys", "-t", self.pane, "-l", "--", b.decode(errors="replace"))

    def type(self, text):
        # a paste (bracketed when the program asked for it): newlines stay in the message
        self._tmux("load-buffer", "-b", "cclive", "-", data=text.encode())
        self._tmux("paste-buffer", "-p", "-d", "-b", "cclive", "-t", self.pane)
        time.sleep(0.3)
        self._tmux("send-keys", "-t", self.pane, "Enter")


def live_all():
    """Every conversation open right now: {"<kind>:<id>": {how, pid, cwd, pane?}}."""
    out = {}
    panes = tmux_panes()
    for r in AGENTS.list():
        bg = r.get("kind") == "background"
        how = "bg" if bg else where(r.get("pid"))
        if how:
            out[f"claude:{r['sessionId']}"] = {"how": how, "pid": r.get("pid"), "cwd": r.get("cwd", "")}
    for kind, mod in READERS.items():
        try:
            for sid, v in (mod.live() or {}).items():
                how = where(v.get("pid"))
                if how:
                    out[f"{kind}:{sid}"] = {"how": how, "pid": v.get("pid"), "cwd": v.get("cwd", "")}
        except Exception as e:  # a reader's bug never takes the helper down
            log(f"{kind} live(): {e!r}")
    if CWD_PREFIX:
        out = {k: e for k, e in out.items() if not own_work(e.get("cwd"))}
    for e in out.values():  # in a tmux pane: typed into from the phone too
        pane = pane_of(e.get("pid"), panes) if e["how"] == "cmd" and panes else None
        if pane:
            e["how"], e["pane"] = "tmux", pane
    return out


def can_type(kind, sid, e=None):
    e = e if e is not None else LIVE.get().get(f"{kind}:{sid}")
    if not e:
        return False
    if e["how"] == "tmux":
        return True
    if e["how"] == "bg" and kind == "claude":
        r = AGENTS.get(sid)
        return bool(r and SHORT.match(str(r.get("id", ""))))
    return False


class Live:
    """live_all(), cached for a moment (the stream and the list share it); the writer thread
    keeps --live-file fresh for the brain."""

    def __init__(self):
        self.lock = threading.Lock()
        self.at = 0.0
        self.v = {}

    def get(self, fresh=1.5):
        with self.lock:
            if time.time() - self.at > fresh:
                self.v = live_all()
                self.at = time.time()
                # written as soon as it is known: the brain never knows less than the phone is
                # shown (a turn sent the moment the phone says "open in a terminal" is refused)
                self.write()
            return dict(self.v)

    def write(self):
        if not LIVE_FILE:
            return
        try:
            v = {k: e for k, e in self.v.items() if e["how"] != "here"}
            tmp = f"{LIVE_FILE}.tmp"
            with open(tmp, "w") as f:
                json.dump({"at": int(time.time() * 1000), "live": v}, f)
            os.replace(tmp, LIVE_FILE)
        except Exception as e:
            log(f"live file: {e!r}")

    def write_loop(self):
        while True:  # fresh every 2 s, so the brain can tell a helper that is down (15 s)
            self.get(1.0)
            time.sleep(2)


LIVE = Live()


def harness_list(n=20):
    """The newest conversations of every harness, open ones first."""
    rows = claude_recent(n)
    for kind, mod in READERS.items():
        try:
            rows += [dict(r, kind=kind) for r in mod.recent(n * 3 if CWD_PREFIX else n) if not (CWD_PREFIX and own_work(r.get("cwd")))]
        except Exception as e:
            log(f"{kind} recent(): {e!r}")
    live = LIVE.get()
    seen = {(r["kind"], r["id"]) for r in rows}
    running = {r["sessionId"]: r for r in AGENTS.list()}
    for key, e in live.items():  # running but not among the newest (quiet, or nothing typed yet)
        kind, sid = key.split(":", 1)
        if kind == "claude" and (kind, sid) not in seen:
            p = claude_find(sid)
            a = running.get(sid, {})
            if own_work(e.get("cwd") or a.get("cwd")):
                continue
            rows.append({"kind": kind, "id": sid, "cwd": e.get("cwd") or (claude_cwd(p) if p else ""),
                         "title": (title_of(p) if p else "") or a.get("name") or "Claude Code session",
                         "modified": int(os.path.getmtime(p) * 1000) if p else int(a.get("startedAt") or 0)})
    shorts = {r["sessionId"]: r.get("id", "") for r in AGENTS.list() if r.get("kind") == "background"}
    for r in rows:
        e = live.get(f"{r['kind']}:{r['id']}")
        r["live"] = e["how"] if e else None
        r["canType"] = bool(e) and (e["how"] == "tmux" or (e["how"] == "bg" and bool(SHORT.match(shorts.get(r["id"], "")))))
        r["short"] = shorts.get(r["id"], "")
    rows.sort(key=lambda r: (r["live"] is None, -int(r.get("modified") or 0)))
    return rows


def public(r):
    sid = r["sessionId"]
    p = T.path_for(PROJECTS, r.get("cwd", ""), sid)
    bg = r.get("kind") == "background" and bool(SHORT.match(str(r.get("id", ""))))
    return {"sessionId": sid, "short": r.get("id", ""), "name": r.get("name", ""), "kind": r.get("kind", ""),
            "status": r.get("status", ""), "state": r.get("state", ""), "cwd": r.get("cwd", ""),
            "startedAt": r.get("startedAt", 0), "title": title_of(p) if p else "", "canType": bg,
            "transcript": bool(p), "harness": "claude", "live": live_of("claude", sid)} | ({"canType": True} if live_of("claude", sid) == "tmux" else {})


def live_of(kind, sid):
    e = LIVE.get().get(f"{kind}:{sid}")
    return e["how"] if e else None


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
    if isinstance(t, TmuxTerm):
        return t.type(text)
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

    def _session(self, sid, fresh=1.5, read=False):
        if not UUID.match(sid):
            self._send(400, {"error": "not a session id"})
            return None
        r = AGENTS.get(sid, fresh)
        if r is None:
            r = AGENTS.get(sid, 0)  # just started? ask again once
        if r is None and read:
            # not running: its transcript still reads (the phone may continue it through the brain)
            p = claude_find(sid)
            if p:
                return {"sessionId": sid, "cwd": claude_cwd(p), "kind": "", "id": "", "name": "", "status": "", "state": ""}
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
        if parts == ["harness"]:
            return self._send(200, {"sessions": harness_list(), "error": AGENTS.err})
        if len(parts) == 4 and parts[0] == "h":
            kind, sid, what = parts[1], parts[2], parts[3]
            if kind == "claude":
                parts = ["s", sid, what]  # the Claude Code routes below, read-only ones
            elif kind in READERS and what in ("history", "stream") and re.match(r"^[A-Za-z0-9_-]{1,80}$", sid):
                return self._reader(kind, sid, what, qs)
            else:
                return self._send(404, {"error": f"no such harness or route ({kind})"})
        if parts == ["sessions"]:
            rows = AGENTS.list()
            out = [public(r) for r in rows]
            out.sort(key=lambda r: (r["kind"] != "background", -int(r["startedAt"] or 0)))
            return self._send(200, {"sessions": out, "error": AGENTS.err})
        if len(parts) >= 3 and parts[0] == "s":
            r = self._session(parts[1], read=parts[2] in ("history", "stream"))
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
        if len(parts) >= 4 and parts[0] == "h":
            kind, sid, act = parts[1], parts[2], "/".join(parts[3:])
        elif len(parts) >= 3 and parts[0] == "s":
            kind, sid, act = "claude", parts[1], "/".join(parts[2:])
        else:
            return self._send(404, {"error": "no such route"})
        if kind not in ("claude", *READERS) or not re.match(r"^[A-Za-z0-9_-]{1,80}$", sid):
            return self._send(404, {"error": "no such session"})
        body = self._body()
        if body is None or not isinstance(body, dict):
            return self._send(400, {"error": "a JSON object, please"})
        e = LIVE.get(0.5).get(f"{kind}:{sid}")
        if e and e["how"] == "tmux":
            t = TmuxTerm(e["pane"])  # open in a terminal inside tmux: both ways
        elif kind == "claude" and e and e["how"] == "bg":
            r = self._session(sid, fresh=0.5)
            if r is None:
                return
            if not SHORT.match(str(r.get("id", ""))):
                return self._send(403, {"error": "this background session has no short id to attach to"})
            t = TERMS.get(r)
            if not t.ready():
                return self._send(503, {"error": "the session's screen did not come up (claude attach)"})
        else:
            return self._send(403, {"error": "open in a terminal (not inside tmux): watch only here — type there, or continue it in a new session"
                                    if e else "not open anywhere: continue it here through bifrost"})
        if act in ("term", "term/size") and not isinstance(t, Term):
            return self._send(404, {"error": "the raw terminal is for background sessions"})
        t.used = time.time()
        if act == "input":
            text = body.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > 20000:
                return self._send(400, {"error": "text: 1–20000 characters"})
            pr = parse_prompt(t.lines()) if kind == "claude" else None
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
                    st = {"gone": cur is None, "live": live_of("claude", sid)}
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
                    e = LIVE.get().get(f"claude:{sid}")
                    st["canType"] = can_type("claude", sid, e)
                    if e and e["how"] == "tmux":  # its permission prompts, read off the tmux screen
                        st["prompt"] = parse_prompt(TmuxTerm(e["pane"]).lines())
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

    def _reader(self, kind, sid, what, qs):
        """history / stream of an agy or opencode conversation (watch, or continue via the brain)."""
        mod = READERS[kind]
        limit = max(1, min(400, int(qs.get("limit", ["200"])[0] or 200)))
        meta = next((dict(r, kind=kind) for r in mod.recent(200) if r["id"] == sid), None)
        if meta is None:
            return self._send(404, {"error": f"no {kind} conversation {sid} on this box", "code": "gone"})
        if what == "history":
            before = qs.get("before", [None])[0]
            pg = mod.page(sid, before=before if before not in (None, "") else None, want=limit)
            return self._send(200, {"items": pg["items"], "cursor": pg["cursor"]})
        self._sse_open()
        try:
            how = live_of(kind, sid)
            self._ev("hello", {"sessionId": sid, "short": "", "name": kind, "kind": "", "cwd": meta.get("cwd", ""),
                               "title": meta.get("title", ""), "canType": can_type(kind, sid), "harness": kind, "live": how})
            tail = mod.Tail(sid)
            pg = mod.page(sid, want=limit)
            self._ev("history", {"items": pg["items"], "cursor": pg["cursor"]})
            last = None
            t_status = t_ping = 0.0
            while True:
                new = tail.read()
                if new:
                    self._ev("items", {"items": T.merge(new)})
                now = time.time()
                if now - t_status > 1.5:
                    t_status = now
                    st = {"gone": False, "live": live_of(kind, sid), "canType": can_type(kind, sid)}
                    if st != last:
                        self._ev("status", st)
                        last = st
                if now - t_ping > 15:
                    t_ping = now
                    self._ev("ping", {"t": int(now)})
                time.sleep(0.5)
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
    global CLAUDE, TOKEN, PROJECTS, LIVE_FILE, CWD_PREFIX
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=4320)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--claude", default="claude")
    ap.add_argument("--projects", default=PROJECTS)
    ap.add_argument("--live-file", default="", help="where to write what is open in a terminal (for the brain)")
    ap.add_argument("--cwd-prefix", default="", help="only conversations in this folder (a sim's helper)")
    a = ap.parse_args()
    if a.host not in ("127.0.0.1", "::1", "localhost"):
        sys.exit("cc-live listens on loopback only")
    CLAUDE, PROJECTS, CWD_PREFIX = a.claude, a.projects, os.path.expanduser(a.cwd_prefix) if a.cwd_prefix else ""
    tf = os.path.expanduser(a.token_file)
    if not os.path.exists(tf):
        fd = os.open(tf, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, secrets.token_hex(24).encode())
        os.close(fd)
    TOKEN = open(tf).read().strip()
    if len(TOKEN) < 16:
        sys.exit("token file: at least 16 characters")
    srv = Server((a.host, a.port), H)
    if a.live_file:
        LIVE_FILE = os.path.expanduser(a.live_file)
        threading.Thread(target=LIVE.write_loop, daemon=True).start()
    log(f"cc-live on {a.host}:{a.port} · claude {CLAUDE} · readers {sorted(READERS)} · live file {LIVE_FILE or '-'}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
