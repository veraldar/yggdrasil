"""harness_agy — Antigravity CLI (`agy`) conversations as chat items (transcript.py's schema). Read only.

Where agy keeps a conversation (~/.gemini/antigravity-cli, agy 1.5.9, seen 11-15):
  cache/conversation_metadata.json   {conversations: {id: {summary: {ID, Title, Preview, NumSteps,
                                     UpdatedAt, WorkspaceURIs}}}} — the ones an interactive agy
                                     opened (headless ones are missing: their workspace is in
                                     conversations/<id>.db, trajectory_metadata_blob)
  brain/<id>/.system_generated/logs/transcript.jsonl
                                     one event per line {step_index, source, type, status,
                                     created_at, content | tool_calls}:
                                       USER_INPUT        the request, in <USER_REQUEST>…</USER_REQUEST>
                                       PLANNER_RESPONSE  the model's words (content) + tool_calls
                                                         [{name, args}] (each arg JSON-encoded)
                                       GENERIC           one tool's output, in the order of the calls
                                       SYSTEM_MESSAGE    a notice to the model (a task finished…)
                                       CHECKPOINT        bookkeeping
  presence/<id>.lock                 flock'ed by the agy process that has the conversation open

live(): a presence lock HELD — its inode in /proc/locks, by a pid whose program is agy. Exact: the
CLI holds it while the conversation is open and the kernel drops it when the process ends (a
crashed agy leaves the file but no lock).
"""
import json
import os
import re
import sqlite3
from datetime import datetime

import transcript as T

KIND = "agy"
ROOT = os.path.expanduser("~/.gemini/antigravity-cli")
SKIP_CWD = (os.path.expanduser("~/.cache/"), os.path.expanduser("~/.local/state/"), "/tmp/", "/dev/shm/")  # brains' and sims' own work
ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _ms(iso):
    try:
        return int(datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp() * 1000)
    except (TypeError, ValueError):
        return 0


def _path(sid):
    return os.path.join(ROOT, "brain", sid, ".system_generated", "logs", "transcript.jsonl")


def _request(text):
    """What the owner typed: the <USER_REQUEST> body, without the CLI's metadata or the brain's
    <instructions> preamble."""
    text = text or ""
    m = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", text, re.S)
    if m:
        text = m.group(1)
    text = re.sub(r"^<instructions>.*?</instructions>\s*", "", text, flags=re.S)
    # a copy of a conversation (agy has no fork) opens with the earlier one: not what was asked
    text = re.sub(r"^<earlier_conversation>.*?</earlier_conversation>\s*", "", text, flags=re.S)
    return text.strip()


def _arg(v):
    """agy JSON-encodes each tool argument ("\"ls -la\""): the value itself."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


TITLE_KEYS = ("CommandLine", "Path", "AbsolutePath", "TargetFile", "Url", "Query", "SearchPath", "Pattern", "text", "title", "brief")
HIDE = ("WaitMsBeforeAsync", "Content", "Replacement")  # a file's whole new text stays out of the card


def _tool(name, args):
    args = {k: _arg(v) for k, v in (args or {}).items()}
    what = args.pop("toolSummary", "") or ""
    for k in TITLE_KEYS:
        if not what and isinstance(args.get(k), str):
            what = args[k]
    title = f"{name} · {str(what).splitlines()[0][:120]}" if what else name
    detail = "\n".join(f"{k}: {v}" for k, v in args.items() if k not in HIDE)
    if args.get("Replacement") or args.get("Content"):
        detail += "\n" + str(args.get("Replacement") or args.get("Content"))
    return title, T.clip(detail, T.DETAIL_MAX)


class Parser:
    """Events → items, in order. Holds the calls whose output hasn't come yet (GENERIC answers the
    oldest), so one Parser follows one conversation from its start."""

    def __init__(self):
        self.pending = []

    def items(self, e):
        if not isinstance(e, dict):
            return []
        step, typ, t = e.get("step_index"), e.get("type"), _ms(e.get("created_at"))
        out = []
        if typ == "USER_INPUT":
            text = _request(e.get("content"))
            if text:
                out.append({"k": "user", "id": f"u{step}", "t": t, "text": text})
        elif typ == "PLANNER_RESPONSE":
            text = (e.get("content") or "").strip()
            if text:
                out.append({"k": "assistant", "id": f"a{step}", "t": t, "text": text})
            for i, tc in enumerate(e.get("tool_calls") or []):
                cid = f"c{step}.{i}"
                title, detail = _tool(tc.get("name") or "tool", tc.get("args"))
                out.append({"k": "tool", "id": cid, "t": t, "name": tc.get("name") or "tool", "title": title, "detail": detail})
                self.pending.append(cid)
        elif typ == "GENERIC":
            text = re.sub(r"^((Created|Completed) At: [^\n]*\n)+\s*", "", e.get("content") or "")
            if self.pending:
                code = re.search(r"Command exited with code (\d+)", text)
                err = e.get("status") == "ERROR" or bool(code and code.group(1) != "0")
                out.append({"k": "result", "id": self.pending.pop(0), "t": t, "text": T.clip(text, T.RESULT_MAX), "error": err})
        elif typ == "SYSTEM_MESSAGE" and "MESSAGE_PRIORITY_LOW" not in (e.get("content") or ""):
            # (a low-priority notice — "tasks stopped due to server restart", which every headless
            # run adds — is the CLI's bookkeeping, not the conversation)
            text = re.sub(r"^The following is a <SYSTEM_MESSAGE>.*?\n+", "", e.get("content") or "", flags=re.S)
            text = re.sub(r"</?SYSTEM_MESSAGE>", "", text).strip()
            if text:
                out.append({"k": "note", "id": f"n{step}", "t": t, "kind": "system", "text": text.splitlines()[0][:200], "more": T.clip(text, 2000)})
        return out


def _events(path, start=0):
    """(events, end offset) from byte `start`; a half-written last line waits for the next read."""
    try:
        with open(path, "rb") as f:
            f.seek(start)
            data = f.read()
    except OSError:
        return [], start
    cut = data.rfind(b"\n") + 1
    evs = [T._parse(ln) for ln in data[:cut].split(b"\n") if ln.strip()]
    return [e for e in evs if e], start + cut


def _all(sid):
    p = Parser()
    evs, end = _events(_path(sid))
    return [it for e in evs for it in p.items(e)], end, p


def _meta():
    try:
        with open(os.path.join(ROOT, "cache", "conversation_metadata.json")) as f:
            return json.load(f).get("conversations") or {}
    except (OSError, ValueError):
        return {}


def _cwd(summary):
    for u in summary.get("WorkspaceURIs") or []:
        if str(u).startswith("file://"):
            return str(u)[7:].rstrip("/") or "/"
    return ""


def _title(summary, sid):
    title = (summary.get("Title") or "").strip()
    if not title:
        prev = (summary.get("Preview") or "").strip()
        title = _request(prev) if not prev.startswith("<") or "<USER_REQUEST>" in prev else ""
    if not title:
        evs, _ = _events(_path(sid))
        title = next((_request(e.get("content")) for e in evs if e.get("type") == "USER_INPUT"), "")
    return (title.splitlines()[0] if title else "")[:80]


def _db_cwd(sid):
    """The workspace from the conversation's own store (conversations/<id>.db, a protobuf blob
    holding `file:///…`): agy's metadata cache misses conversations run headless (`agy -p`, the
    brain's turns)."""
    try:
        c = sqlite3.connect(f"file:{os.path.join(ROOT, 'conversations', sid + '.db')}?mode=ro", uri=True, timeout=1)
        row = c.execute("SELECT data FROM trajectory_metadata_blob WHERE id='main'").fetchone()
        c.close()
    except sqlite3.Error:
        return ""
    m = re.search(rb"file://(/[^\x00-\x1f\"]*)", (row or [b""])[0] or b"")
    return m.group(1).decode(errors="replace").rstrip("/") if m else ""


def recent(n=20):
    """The newest conversations with a transcript, by its last write."""
    meta = _meta()
    rows = []
    try:
        dirs = [d.name for d in os.scandir(os.path.join(ROOT, "brain")) if ID.match(d.name)]
    except OSError:
        dirs = []
    for sid in dirs:
        try:
            mod = int(os.path.getmtime(_path(sid)) * 1000)
        except OSError:
            continue
        rows.append((mod, sid))
    rows.sort(reverse=True)
    out = []
    for mod, sid in rows:
        c = meta.get(sid)
        s = (c.get("summary") if isinstance(c, dict) else None) or {}
        cwd = _cwd(s) or _db_cwd(sid)
        if not cwd or (cwd + "/").startswith(SKIP_CWD):
            continue
        title = _title(s, sid)
        if not title:  # nothing was ever asked
            continue
        out.append({"kind": KIND, "id": sid, "cwd": cwd, "title": title, "modified": mod})
        if len(out) >= n:
            break
    return out


def _held():
    """inode → pid for every flock/POSIX lock on the box (/proc/locks)."""
    held = {}
    try:
        with open("/proc/locks") as f:
            for ln in f:
                parts = ln.split()
                # "22: FLOCK  ADVISORY  WRITE 2683049 00:1d:5397962 0 EOF" (a "->" marks a waiter)
                if len(parts) >= 6 and parts[1] != "->":
                    try:
                        held[int(parts[5].rsplit(":", 1)[1])] = int(parts[4])
                    except (IndexError, ValueError):
                        pass
    except OSError:
        pass
    return held


def _is_agy(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv0 = f.read().split(b"\0")[0].decode(errors="replace")
        return os.path.basename(argv0) == "agy" or "antigravity" in argv0
    except OSError:
        return False


def live():
    held = _held()
    out = {}
    try:
        locks = os.scandir(os.path.join(ROOT, "presence"))
    except OSError:
        return out
    for f in locks:
        sid = f.name[:-5] if f.name.endswith(".lock") else ""
        if not ID.match(sid):
            continue
        try:
            pid = held.get(f.stat().st_ino)
        except OSError:
            continue
        if pid and _is_agy(pid):
            try:
                cwd = os.readlink(f"/proc/{pid}/cwd")
            except OSError:
                cwd = ""
            out[sid] = {"pid": pid, "cwd": cwd}
    return out


def page(sid, before=None, want=200):
    its, _, _ = _all(sid)
    its = T.merge(its)
    end = len(its) if before in (None, "") else max(0, min(len(its), int(before)))
    start = max(0, end - want)
    return {"items": its[start:end], "cursor": start or None}


class Tail:
    """Follows the conversation from its current end."""

    def __init__(self, sid):
        self.sid = sid
        _, self.pos, self.parser = _all(sid)

    def read(self):
        evs, self.pos = _events(_path(self.sid), self.pos)
        return [it for e in evs for it in self.parser.items(e)]
