#!/usr/bin/env python3
"""cc_run.py — the brain's door to a full-access turn (full_access.py): the brain runs a granted
conversation's turn as `cc_run.py -- <the harness argv>` (prompt on stdin) instead of the harness
itself; this hands it to the live helper outside the sandbox and plays its output back as if the
harness ran here: stdout, stderr, exit code. The helper decides — it runs nothing for a
conversation without a live grant (exit 97, its reason on stderr). Killing this (an abort) hangs up,
and the helper kills the turn."""
import json
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    if "--" not in sys.argv:
        print("usage: cc_run.py -- <argv…>", file=sys.stderr)
        return 2
    argv = sys.argv[sys.argv.index("--") + 1 :]
    url = os.environ.get("YGG_HARNESS_HELPER", "").rstrip("/")
    tok = os.environ.get("YGG_HARNESS_HELPER_TOKEN", "")
    if not url or not tok:
        print("full access: no live helper here (YGG_HARNESS_HELPER)", file=sys.stderr)
        return 97
    data = "" if sys.stdin is None or sys.stdin.isatty() else sys.stdin.read()
    env = {k: os.environ[k] for k in ("GEMINI_API_KEY",) if os.environ.get(k)}
    body = json.dumps({"argv": argv, "cwd": os.getcwd(), "stdin": data, "env": env}).encode()
    req = urllib.request.Request(f"{url}/access/run", data=body, headers={"Content-Type": "application/json", "x-cc-live-token": tok})
    try:
        r = urllib.request.urlopen(req, timeout=None)
    except urllib.error.HTTPError as e:
        try:
            why = json.loads(e.read() or b"{}").get("error") or e.reason
        except ValueError:
            why = e.reason
        print(f"full access: {why}", file=sys.stderr)
        return 97
    except OSError as e:
        print(f"full access: the live helper did not answer ({e})", file=sys.stderr)
        return 97
    code = 98  # no exit frame: the helper went away mid-turn
    for raw in r:
        try:
            f = json.loads(raw)
        except ValueError:
            continue
        if "o" in f:
            sys.stdout.write(f["o"] + "\n")
            sys.stdout.flush()
        elif "e" in f:
            sys.stderr.write(f["e"] + "\n")
        elif "x" in f:
            code = int(f["x"])
    return code


if __name__ == "__main__":
    sys.exit(main())
