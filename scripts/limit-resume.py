#!/usr/bin/env python3
"""A session stopped by the harness's usage limit goes on by itself once the limit has reset.

Claude Code ends a turn with "You've hit your 5-hour limit · resets 11:30pm (Europe/Paris)".
The session then sits there until somebody sends it a message. This looks, every few minutes,
at the sessions of one brain: where the LAST message is that error (younger than a day), no
turn is running, and the reset time is past, it sends one line. The brain keeps the
conversation id of a failed turn, so the session goes on in the same conversation.

It never sends before the reset time (a refused attempt is one more failed message and one more
report to MAIN). An error whose reset time cannot be read is tried once an hour.

  limit-resume.py [brain-url]        default http://127.0.0.1:4101
  DRY=1 limit-resume.py              say what it would do

To be moved into the brain itself (a retry at the reset time, owned by the run).
"""
import datetime, json, os, re, sys, urllib.request
from zoneinfo import ZoneInfo

B = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4101").rstrip("/")
DRY = os.environ.get("DRY") == "1"
LIMIT = re.compile(r"hit your .{0,40}limit|usage limit", re.I)
RESET = re.compile(r"resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([\w/+-]+)\)", re.I)
LINE = ("The usage limit that stopped you has reset. Go on where you stopped: this is the same "
        "conversation. Look first at your worktree (git status, your notes) — a command may have "
        "been cut half way.")


def call(method, path, body=None):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or b"null")


def reset_time(text, failed_at):
    """The first moment at or after `failed_at` that the wall clock in the named zone shows the reset hour."""
    m = RESET.search(text)
    if not m:
        return failed_at + datetime.timedelta(hours=1)
    h, mi, ap, zone = int(m[1]) % 12 + (12 if m[3].lower() == "pm" else 0), int(m[2] or 0), m[3], m[4]
    try:
        tz = ZoneInfo(zone)
    except Exception:
        return failed_at + datetime.timedelta(hours=1)
    local = failed_at.astimezone(tz)
    at = local.replace(hour=h, minute=mi, second=0, microsecond=0)
    if at < local:
        at += datetime.timedelta(days=1)
    return at + datetime.timedelta(minutes=2)


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    busy = call("GET", "/session/status") or {}
    for s in call("GET", "/session"):
        sid = s["id"]
        if sid in busy or not isinstance(s.get("model"), dict) or s["model"].get("providerID") == "yggdrasil":
            continue
        updated = (s.get("time") or {}).get("updated") or 0
        if now.timestamp() - updated / 1000 > 86400:
            continue
        msgs = call("GET", f"/session/{sid}/message")
        if not msgs:
            continue
        info = msgs[-1].get("info", {})
        err = ((info.get("error") or {}).get("data") or {}).get("message") or ""
        if info.get("role") != "assistant" or not LIMIT.search(err):
            continue
        failed = datetime.datetime.fromtimestamp(((info.get("time") or {}).get("completed") or updated) / 1000, datetime.timezone.utc)
        at = reset_time(err, failed)
        title = (s.get("title") or "")[:40]
        if now < at:
            print(f"{sid[:14]} {title!r}: limited, resets {at.astimezone().strftime('%H:%M')} — waiting")
            continue
        print(f"{sid[:14]} {title!r}: limit reset at {at.astimezone().strftime('%H:%M')} — {'would send' if DRY else 'sending'} it on")
        if not DRY:
            call("POST", f"/session/{sid}/message?async=1", {"parts": [{"type": "text", "text": LINE}]})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # the brain is restarting, or down: the next run looks again
        print(f"limit-resume: {e}", file=sys.stderr)
