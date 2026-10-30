#!/usr/bin/env python3
"""coord-sim ledger — append rows, commit them to git (lab/coord-sim/ledger/).

The MISSION law: every scenario run appends rows to a versioned ledger IN GIT.
Rows land in ledger/coord-sim.jsonl (this lab's own history, VERSIONED IN GIT)
AND mirror to ~/.local/share/bifrost/bench/coord-sim.jsonl (the fleet bench dir,
LABS.md rule 2). The git copy is the versioned one; the bench copy is for
cross-lab readers (rule-eval reads the bench dir).

Row shape (one JSON object per line):
  {ts, lab: "coord-sim", run: <runid>, arm: <id>, matrix: {...}, metric fields..., extra}

Metric fields (the set, metrics-first law):
  success_rate quality wall_ms tokens ttfa_ms laziness drift coord_overhead
plus per-task detail in `tasks: [...]`.
"""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

LAB = Path(__file__).resolve().parent.parent / "coord-sim"
LEDGER = LAB / "ledger" / "coord-sim.jsonl"
BENCH = Path.home() / ".local/share/bifrost/bench/coord-sim.jsonl"
METRIC_FIELDS = ["success_rate", "quality", "wall_ms", "tokens", "ttfa_ms",
                 "laziness", "drift", "coord_overhead"]


def row(**d) -> dict:
    r = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "lab": "coord-sim", **d}
    for f in METRIC_FIELDS:
        r.setdefault(f, None)
    for p in (LEDGER, BENCH):
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a") as f:
            f.write(json.dumps(r, default=str) + "\n")
    return r


def commit(msg: str) -> str:
    """git add the ledger + commit. Returns the commit sha (empty = nothing to commit)."""
    root = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=str(LAB),
                          capture_output=True, text=True).stdout.strip()
    if not root:
        return ""
    rel = str(LEDGER.relative_to(root))
    subprocess.run(["git", "add", rel], cwd=root, check=False)
    r = subprocess.run(["git", "commit", "-m", msg, "--no-verify", "--", rel],
                       cwd=root, capture_output=True, text=True)
    if r.returncode == 0:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=root,
                              capture_output=True, text=True).stdout.strip()
    return ""


def tail(n: int = 50, arm: str | None = None) -> list[dict]:
    if not LEDGER.exists():
        return []
    out = []
    for line in LEDGER.read_text().strip().splitlines():
        r = json.loads(line)
        if arm is None or r.get("arm") == arm:
            out.append(r)
    return out[-n:]


if __name__ == "__main__":
    import sys
    for r in tail(int(sys.argv[1]) if len(sys.argv) > 1 else 20):
        print(json.dumps(r)[:240])
