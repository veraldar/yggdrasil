"""transcript — a Claude Code transcript (~/.claude/projects/<cwd>/<session>.jsonl) as chat items.

Each JSONL line is one event; `items(event)` turns it into what a person reads in the terminal:

  {"k": "user", "id", "t", "text", "queued"?}         what the owner typed (also mid-turn)
  {"k": "assistant", "id", "t", "text", "error"?}     the assistant's words
  {"k": "tool", "id", "t", "name", "title", "detail", "agent"?}
                                                      a tool call (id = the tool_use id)
  {"k": "result", "id", "t", "text", "error", "agent"?}
                                                      its result (same id as the call)
  {"k": "note", "id", "t", "kind", "text", "more"?, "agent"?}
                                                      a one-line system note: a background task
                                                      finished, a subagent reported, the
                                                      conversation was compacted, a /command…
  {"k": "turn", "id", "t", "ms"}                      a turn ended (how long it took)

Thinking, hook/IDE context, file snapshots and the rest of Claude Code's bookkeeping are left out.
`page()` reads backwards from a byte offset (history, scroll back), `Tail` follows the file as
it grows (live). Standard library only.
"""
import json
import os
import re

RESULT_MAX = 6000  # chars of a tool result kept (head + tail)
DETAIL_MAX = 2400  # chars of a tool call's input shown


def clip(s, n):
    s = s or ""
    if len(s) <= n:
        return s
    head = int(n * 0.7)
    tail = n - head
    return f"{s[:head]}\n… {len(s) - n} more characters …\n{s[-tail:]}"


def _blocks_text(content):
    """The text of a tool_result's content (a string, or a list of blocks)."""
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            out.append(b.get("text") or "")
        elif b.get("type") == "image":
            out.append("[image]")
        elif b.get("type") == "tool_reference":
            out.append(f"[tool {b.get('tool_name', '')}]")
    return "\n".join(out)


def _tag(s, name):
    m = re.search(rf"<{name}>(.*?)</{name}>", s, re.S)
    return m.group(1).strip() if m else ""


def tool_title(name, inp):
    """One line saying what the call does (the command, the file, the description)."""
    inp = inp if isinstance(inp, dict) else {}
    g = lambda *ks: next((str(inp[k]) for k in ks if inp.get(k)), "")  # noqa: E731
    if name == "Bash":
        return g("description", "command")
    if name in ("Read", "Write", "Edit", "MultiEdit", "NotebookEdit"):
        return g("file_path", "notebook_path")
    if name in ("Glob", "Grep"):
        p = g("pattern")
        return f"{p} in {inp['path']}" if inp.get("path") else p
    if name == "WebFetch":
        return g("url")
    if name == "WebSearch":
        return g("query")
    if name in ("Agent", "Task"):
        d = g("description")
        t = inp.get("subagent_type")
        return f"{d} ({t})" if t else d
    if name == "SendMessage":
        return f"to {inp.get('to', '?')}: {g('summary', 'message')[:120]}"
    if name == "TodoWrite":
        todos = inp.get("todos") or []
        return f"{len(todos)} todos"
    if name in ("Monitor", "ToolSearch", "Skill"):
        return g("description", "query", "skill", "command")
    for v in inp.values():  # anything else: its first short string
        if isinstance(v, str) and v.strip():
            return v.strip().splitlines()[0][:200]
    return ""


def tool_detail(name, inp):
    inp = inp if isinstance(inp, dict) else {}
    if name == "Bash":
        d = inp.get("command", "")
    elif name == "Write":
        d = inp.get("content", "")
    elif name == "Edit":
        d = f"- {inp.get('old_string', '')}\n+ {inp.get('new_string', '')}"
    elif name in ("Agent", "Task"):
        d = inp.get("prompt", "")
    elif name == "TodoWrite":
        d = "\n".join(f"[{'x' if t.get('status') == 'completed' else ' '}] {t.get('content', '')}" for t in inp.get("todos") or [])
    elif name == "SendMessage":
        d = inp.get("message", "")
    else:
        d = json.dumps(inp, ensure_ascii=False, indent=1) if inp else ""
    return clip(d, DETAIL_MAX)


HANDBACK = re.compile(r'<agent-message from="([^"]+)">', re.S)


def _peer_note(s, base):
    """A subagent's hand-back (or another session's message): who, and the report itself."""
    m = HANDBACK.search(s)
    agent = m.group(1) if m else ""
    body = s
    if "The report follows:\n" in s:
        body = s.split("The report follows:\n", 1)[1]
    elif m:
        body = s[m.end():]
    body = body.split("</agent-message>", 1)[0]
    body = "\n".join(line[2:] if line.startswith("  ") else line for line in body.splitlines()).strip()
    first = next((ln for ln in body.splitlines() if ln.strip()), "")[:200]
    note = dict(base, k="note", kind="agent", text=first or "a subagent reported", more=clip(body, RESULT_MAX))
    if agent:
        note["agent"] = agent
    return note


def _task_note(s, base):
    summary = _tag(s, "summary") or "a background task changed"
    status = _tag(s, "status")
    ev = _tag(s, "event")
    text = f"{summary} — {status}" if status else summary
    n = dict(base, k="note", kind="task", text=text[:300])
    if ev or _tag(s, "result"):
        n["more"] = clip(ev or _tag(s, "result"), RESULT_MAX)
    return n


def _user_text(s, base, queued=False):
    if s.startswith("<task-notification>"):
        return [_task_note(s, base)]
    if "<agent-message from=" in s:
        return [_peer_note(s, base)]
    if s.startswith("<local-command-caveat>") or s.startswith("<command-name>"):
        return []  # the /command itself comes as a system local_command event
    if s.startswith("<local-command-stdout>"):
        out = _tag(s, "local-command-stdout")
        return [dict(base, k="note", kind="command", text=out[:300])] if out else []
    if s.startswith("<bash-input>"):
        return [dict(base, k="user", text="! " + _tag(s, "bash-input"))]
    if s.startswith("<bash-stdout>"):
        out = (_tag(s, "bash-stdout") + "\n" + _tag(s, "bash-stderr")).strip()
        return [dict(base, k="note", kind="shell", text=(out.splitlines() or ["(no output)"])[0][:200], more=clip(out, RESULT_MAX))]
    if s.startswith("This session is being continued from a previous conversation"):
        return [dict(base, k="note", kind="compact", text="continued from a compacted conversation", more=clip(s, RESULT_MAX))]
    if s.startswith("[Request interrupted"):
        return [dict(base, k="note", kind="interrupted", text="interrupted")]
    it = dict(base, k="user", text=s)
    if queued:
        it["queued"] = True
    return [it]


def items(e, sidechain=False):
    """The chat items one transcript event carries ([] for bookkeeping). A subagent's own
    transcript is all sidechain events: read with sidechain=True."""
    if not isinstance(e, dict) or (e.get("isSidechain") and not sidechain):
        return []
    t = e.get("type")
    uid = e.get("uuid") or ""
    base = {"id": uid, "t": e.get("timestamp", "")}
    if t == "user":
        if e.get("isMeta"):
            return []
        c = (e.get("message") or {}).get("content")
        if isinstance(c, str):
            return _user_text(c, base)
        out = []
        texts = []
        for i, b in enumerate(c or []):
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "tool_result":
                tur = e.get("toolUseResult")
                r = {"k": "result", "id": b.get("tool_use_id", ""), "t": base["t"], "text": clip(_blocks_text(b.get("content")), RESULT_MAX), "error": bool(b.get("is_error"))}
                if isinstance(tur, dict) and tur.get("agentId"):
                    r["agent"] = tur["agentId"]
                    if tur.get("status") == "async_launched":
                        r["text"] = "started in the background"
                out.append(r)
            elif bt == "text":
                texts.append(b.get("text") or "")
            elif bt == "image":
                texts.append("[image]")
        s = "\n".join(x for x in texts if x)
        if s:
            out[:0] = [dict(it, id=f"{uid}:t") for it in _user_text(s, base)]
        return out
    if t == "assistant":
        msg = e.get("message") or {}
        out = []
        for i, b in enumerate(msg.get("content") or []):
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text" and (b.get("text") or "").strip():
                it = dict(base, k="assistant", id=f"{uid}:{i}", text=b["text"])
                if e.get("isApiErrorMessage") or e.get("error"):
                    it["error"] = True
                out.append(it)
            elif bt == "tool_use":
                name = b.get("name") or "tool"
                out.append({"k": "tool", "id": b.get("id", ""), "t": base["t"], "name": name,
                            "title": tool_title(name, b.get("input"))[:300], "detail": tool_detail(name, b.get("input"))})
        return out
    if t == "attachment":
        a = e.get("attachment") or {}
        at = a.get("type")
        if at == "queued_command":
            p = a.get("prompt")
            p = p if isinstance(p, str) else _blocks_text(p)
            mode = a.get("commandMode")
            if mode == "task-notification" or p.startswith("<task-notification>"):
                return [_task_note(p, base)]
            if "<agent-message from=" in p:
                return [_peer_note(p, base)]
            if (a.get("origin") or {}).get("kind", "human") == "human":
                return _user_text(p, base, queued=True)
            return []
        if at == "task_status":
            d = a.get("description") or "background task"
            st = a.get("status") or ""
            prog = a.get("deltaSummary") or ""
            n = dict(base, k="note", kind="task", text=f"{d} — {st}" + (f": {prog}" if prog else ""))
            if a.get("taskId"):
                n["agent"] = a["taskId"]
            return [n]
        return []
    if t == "system":
        st = e.get("subtype")
        if st == "turn_duration":
            return [dict(base, k="turn", ms=e.get("durationMs") or 0)]
        if st == "away_summary":
            txt = re.sub(r"\s*\(disable recaps in /config\)\s*$", "", e.get("content") or "")
            return [dict(base, k="note", kind="recap", text=txt)] if txt else []
        if st == "compact_boundary":
            return [dict(base, k="note", kind="compact", text="conversation compacted")]
        if st == "local_command":
            c = e.get("content") or ""
            name = _tag(c, "command-name")
            args = _tag(c, "command-args")
            if name:
                return [dict(base, k="note", kind="command", text=f"{name} {args}".strip())]
            out = _tag(c, "local-command-stdout")
            return [dict(base, k="note", kind="command", text=out[:300])] if out else []
        if e.get("level") == "error" and e.get("content"):
            return [dict(base, k="note", kind="error", text=str(e["content"])[:300])]
        return []
    return []


def shown(items_):
    """How many of these count as one thing a person sees (results fold into their call)."""
    return sum(1 for it in items_ if it["k"] != "result")


def _parse(line):
    try:
        return json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return None


CHUNK = 256 * 1024


def page(path, before=None, want=200):
    """The last `want` shown items before byte offset `before` (None: the end of the file).
    Returns {items (oldest first), cursor (offset to pass as `before` for older ones, 0 = the
    start), tail (offset of the first byte not yet read: where a Tail starts)}."""
    size = os.path.getsize(path)
    end = size if before is None else max(0, min(int(before), size))
    with open(path, "rb") as f:
        tail = end
        if before is None and end > 0:
            # the writer may be mid-line: stop at the last newline
            f.seek(max(0, end - 1))
            if f.read(1) != b"\n":
                f.seek(max(0, end - CHUNK))
                blob = f.read(end - max(0, end - CHUNK))
                nl = blob.rfind(b"\n")
                tail = end = (max(0, end - CHUNK) + nl + 1) if nl >= 0 else 0
        got = []  # newest first
        count = 0
        pos = end
        carry = b""
        cursor = end
        while pos > 0 and count < want:
            start = max(0, pos - CHUNK)
            f.seek(start)
            blob = f.read(pos - start) + carry
            parts = blob.split(b"\n")
            if start > 0:
                carry = parts[0]
                parts = parts[1:]
                off = start + len(carry) + 1
            else:
                carry = b""
                off = 0
            starts = []
            for p in parts:
                starts.append(off)
                off += len(p) + 1
            for p, s in zip(reversed(parts), reversed(starts)):
                if not p.strip():
                    continue
                its = items(_parse(p))
                cursor = s
                if its:
                    got.append(its)
                    count += shown(its)
                    if count >= want:
                        break
            pos = start
        if pos == 0 and count < want:
            cursor = 0
    out = [it for its in reversed(got) for it in its]
    return {"items": merge(out), "cursor": cursor, "tail": tail}


def merge(its):
    """Fold each result into its call when both are here; a result whose call is older stays."""
    calls = {it["id"]: it for it in its if it["k"] == "tool"}
    out = []
    for it in its:
        if it["k"] == "result" and it["id"] in calls:
            c = calls[it["id"]]
            c["result"] = {"text": it["text"], "error": it["error"]}
            if it.get("agent"):
                c["agent"] = it["agent"]
            continue
        out.append(it)
    return out


class Tail:
    """Follows a transcript from byte offset `pos`: `read()` → the new items since the last call
    (complete lines only; a line still being written waits for the next read)."""

    def __init__(self, path, pos):
        self.path, self.pos, self.buf = path, pos, b""

    def read(self):
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return []
        if size < self.pos:  # rewritten from scratch
            self.pos, self.buf = 0, b""
        if size == self.pos:
            return []
        with open(self.path, "rb") as f:
            f.seek(self.pos)
            blob = f.read(size - self.pos)
        self.pos = size
        blob = self.buf + blob
        lines = blob.split(b"\n")
        self.buf = lines.pop()
        out = []
        for ln in lines:
            if ln.strip():
                out.extend(items(_parse(ln)))
        return out


def mangle(cwd):
    """Claude Code's folder name for a cwd under ~/.claude/projects."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def path_for(projects, cwd, sid):
    p = os.path.join(projects, mangle(cwd), f"{sid}.jsonl")
    if os.path.exists(p):
        return p
    try:  # a session that changed folder: look for it by id
        for d in os.listdir(projects):
            q = os.path.join(projects, d, f"{sid}.jsonl")
            if os.path.exists(q):
                return q
    except OSError:
        pass
    return None


def subagent_stats(transcript, agent):
    """What a subagent has done so far: {tools, last, size} from its own transcript."""
    p = os.path.join(transcript[:-len(".jsonl")], "subagents", f"agent-{agent}.jsonl")
    try:
        size = os.path.getsize(p)
        with open(p, "rb") as f:
            blob = f.read()
    except OSError:
        return None
    tools = blob.count(b'"type":"tool_use"')
    last = ""
    for ln in reversed(blob.split(b"\n")[-80:]):
        for it in reversed(items(_parse(ln), sidechain=True) if ln.strip() else []):
            if it["k"] == "tool":
                last = f"{it['name']}: {it['title']}"[:160]
            elif it["k"] == "assistant":
                last = it["text"].strip().splitlines()[0][:160] if it["text"].strip() else ""
            if last:
                break
        if last:
            break
    return {"tools": tools, "last": last, "size": size}
