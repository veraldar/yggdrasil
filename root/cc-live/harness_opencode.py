"""harness_opencode — opencode conversations as chat items (transcript.py's schema). Read only.

opencode (1.18) keeps everything in one SQLite file, $XDG_DATA_HOME/opencode/opencode.db (WAL;
opened here read-only, `mode=ro`, never written):
  session  (id ses_…, directory, title, parent_id — a subagent's —, time_updated, time_archived)
  message  (id, session_id, time_created, data: {role, time: {created, completed}, finish, …})
  part     (id, message_id, session_id, time_created, time_updated, data: {type, …}) —
           text (synthetic = the CLI's own echo), reasoning, tool {tool, callID, state: {status,
           input, output | error}}, file, step-start, step-finish …
A part is rewritten as it streams (text grows, a tool goes running → completed): Tail re-sends a
part whenever its time_updated moves, under the same id (the page replaces its copy).

live(): opencode has no lock per conversation, so it is read from the processes: an `opencode`
TUI or `opencode run` with `-s/--session <id>` names its conversation exactly; a TUI without one
(new, or `-c`) is on the newest conversation of its folder updated since that process started —
right for one TUI per folder, a guess beyond that. `opencode serve` (a server, no terminal) is
never "open".
"""
import json
import os
import sqlite3

import transcript as T

KIND = "opencode"
SKIP_CWD = (os.path.expanduser("~/.cache/"), os.path.expanduser("~/.local/state/"), "/tmp/", "/dev/shm/")  # brains' and sims' own work
NOT_TUI = {"serve", "acp", "mcp", "debug", "upgrade", "uninstall", "providers", "auth", "agent", "completion", "models", "stats", "export", "import", "github", "web", "session"}


def db_path():
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(base, "opencode", "opencode.db")


def _db():
    c = sqlite3.connect(f"file:{db_path()}?mode=ro", uri=True, timeout=2)
    c.execute("PRAGMA query_only = 1")
    return c


def _j(s):
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return {}


def recent(n=20):
    try:
        c = _db()
        rows = c.execute(
            "SELECT id, directory, title, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL "
            "ORDER BY time_updated DESC LIMIT ?", (n * 3,)).fetchall()
        c.close()
    except sqlite3.Error:
        return []
    out = []
    for sid, cwd, title, upd in rows:
        if not cwd or (cwd.rstrip("/") + "/").startswith(SKIP_CWD):
            continue
        out.append({"kind": KIND, "id": sid, "cwd": cwd, "title": (title or "opencode session")[:80], "modified": int(upd or 0)})
        if len(out) >= n:
            break
    return out


def _part_items(pid, mid, role, t, d):
    typ = d.get("type")
    if typ == "text" and not d.get("synthetic") and (d.get("text") or "").strip():
        return [{"k": "user" if role == "user" else "assistant", "id": pid, "t": t, "text": d["text"].strip()}]
    if typ == "tool":
        st = d.get("state") or {}
        inp = st.get("input") or {}
        name = d.get("tool") or "tool"
        what = inp.get("description") or inp.get("command") or inp.get("filePath") or inp.get("pattern") or inp.get("url") or ""
        title = f"{name} · {str(what).splitlines()[0][:120]}" if what else name
        out = [{"k": "tool", "id": d.get("callID") or pid, "t": t, "name": name, "title": title,
                "detail": T.clip(json.dumps(inp, ensure_ascii=False, indent=1), T.DETAIL_MAX)}]
        if st.get("status") in ("completed", "error"):
            err = st.get("status") == "error"
            text = st.get("error") if err else st.get("output")
            out.append({"k": "result", "id": d.get("callID") or pid, "t": t, "text": T.clip(str(text or ""), T.RESULT_MAX), "error": err})
        return out
    return []


def _msg_items(c, rows):
    """Items for messages [(id, time_created, data)], oldest first."""
    if not rows:
        return []
    ids = [r[0] for r in rows]
    parts = {}
    q = f"SELECT id, message_id, time_created, data FROM part WHERE message_id IN ({','.join('?' * len(ids))}) ORDER BY time_created, id"
    for pid, mid, pt, data in c.execute(q, ids):
        parts.setdefault(mid, []).append((pid, pt, _j(data)))
    out = []
    for mid, mt, data in rows:
        m = _j(data)
        role = m.get("role")
        for pid, pt, d in parts.get(mid, []):
            out += _part_items(pid, mid, role, pt, d)
        tm = m.get("time") or {}
        if role == "assistant" and tm.get("completed") and m.get("finish") not in (None, "tool-calls"):
            out.append({"k": "turn", "id": f"turn-{mid}", "t": tm["completed"], "ms": max(0, tm["completed"] - (tm.get("created") or tm["completed"]))})
    return out


def page(sid, before=None, want=200):
    """The newest messages before the cursor (`time_created:id` of the oldest one shown), ~want items."""
    msgs = max(10, want // 4)
    try:
        c = _db()
        if before in (None, ""):
            rows = c.execute("SELECT id, time_created, data FROM message WHERE session_id=? ORDER BY time_created DESC, id DESC LIMIT ?", (sid, msgs)).fetchall()
        else:
            bt, _, bid = str(before).partition(":")
            rows = c.execute(
                "SELECT id, time_created, data FROM message WHERE session_id=? AND (time_created < ? OR (time_created = ? AND id < ?)) "
                "ORDER BY time_created DESC, id DESC LIMIT ?", (sid, int(bt), int(bt), bid, msgs)).fetchall()
        rows.reverse()
        its = T.merge(_msg_items(c, rows))
        c.close()
    except (sqlite3.Error, ValueError):
        return {"items": [], "cursor": None}
    cursor = f"{rows[0][1]}:{rows[0][0]}" if len(rows) >= msgs else None
    return {"items": its, "cursor": cursor}


class Tail:
    """Parts and messages written or rewritten since the last read (same ids: a re-sent part
    replaces its copy). It re-reads a short window behind the newest time it has seen — a part
    stamped a little earlier than one already read (written later, stamped first) is not lost —
    and sends each (part, update) once."""

    WINDOW = 5000  # ms

    def __init__(self, sid):
        self.sid = sid
        self.at = 0
        self.sent = {}  # part id → the time_updated last sent
        try:
            c = _db()
            self.at = c.execute("SELECT MAX(time_updated) FROM part WHERE session_id=?", (sid,)).fetchone()[0] or 0
            for pid, pu in c.execute("SELECT id, time_updated FROM part WHERE session_id=? AND time_updated > ?", (sid, self.at - self.WINDOW)):
                self.sent[pid] = pu
            c.close()
        except sqlite3.Error:
            pass

    def read(self):
        try:
            c = _db()
            rows = c.execute(
                "SELECT p.id, p.message_id, p.time_created, p.time_updated, p.data, m.data FROM part p JOIN message m ON m.id = p.message_id "
                "WHERE p.session_id=? AND p.time_updated > ? ORDER BY p.time_updated, p.id", (self.sid, self.at - self.WINDOW)).fetchall()
            c.close()
        except sqlite3.Error:
            return []
        out = []
        for pid, mid, pt, pu, data, mdata in rows:
            self.at = max(self.at, pu)
            if self.sent.get(pid) == pu:
                continue
            self.sent[pid] = pu
            out += _part_items(pid, mid, _j(mdata).get("role"), pt, _j(data))
        if len(self.sent) > 4000:  # only recent parts can come back
            self.sent = {k: v for k, v in self.sent.items() if v > self.at - self.WINDOW}
        return out


def _procs():
    """(pid, argv, cwd, started ms) of every opencode process."""
    try:
        with open("/proc/stat") as f:
            boot = next(int(ln.split()[1]) for ln in f if ln.startswith("btime "))
        hz = os.sysconf("SC_CLK_TCK")
    except (OSError, StopIteration, ValueError):
        boot, hz = 0, 100
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            with open(f"/proc/{d}/cmdline", "rb") as f:
                argv = [a.decode(errors="replace") for a in f.read().split(b"\0") if a]
            if not argv or os.path.basename(argv[0]) != "opencode":
                continue
            with open(f"/proc/{d}/stat") as f:
                started = boot * 1000 + int(f.read().rsplit(")", 1)[1].split()[19]) * 1000 // hz
            yield int(d), argv, os.readlink(f"/proc/{d}/cwd"), started
        except (OSError, IndexError, ValueError):
            continue


def live():
    out = {}
    guess = []
    for pid, argv, cwd, started in _procs():
        args = argv[1:]
        sub = next((a for a in args if not a.startswith("-")), "")
        if sub in NOT_TUI:
            continue
        sid = next((args[i + 1] for i, a in enumerate(args[:-1]) if a in ("-s", "--session")), None)
        if sid:
            out[sid] = {"pid": pid, "cwd": cwd}
        elif sub != "run":
            folder = sub if sub and os.path.isabs(sub) else (os.path.join(cwd, sub) if sub else cwd)
            guess.append((pid, os.path.realpath(folder), started))
    if guess:
        try:
            c = _db()
            for pid, folder, started in guess:
                r = c.execute("SELECT id FROM session WHERE directory=? AND parent_id IS NULL AND time_updated >= ? "
                              "ORDER BY time_updated DESC LIMIT 1", (folder, started)).fetchone()
                if r and r[0] not in out:
                    out[r[0]] = {"pid": pid, "cwd": folder}
            c.close()
        except sqlite3.Error:
            pass
    return out
