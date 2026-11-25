#!/usr/bin/env python3
"""v1-baseline.py <sha> [--out FILE] — the M0 baseline table: what the ladder measured on <sha> (as-is gates from
gates/<sha>.json, the v0.9 versions of port gates from gates/<sha>.partial.json) next to tree-next's last green
(the registry's last_green). Writes markdown (default ~/.cache/trunk-v1/baseline-<sha12>.md); notes are added by hand.
"""
import argparse, json, os, subprocess, sys

HOME = os.path.expanduser("~")
BASE = os.environ.get("V1_LADDER_HOME") or os.path.join(HOME, ".cache", "trunk-v1")
HERE = os.path.dirname(os.path.abspath(__file__))


def load(p):
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return None


def counts(g):
    runs = g.get("runs") or []
    out = []
    for r in runs:
        c = r.get("counts") or {}
        steps = r.get("steps") or []
        if len(steps) > 1:
            per = ", ".join(f"{s.get('name')} {s['counts']['pass']}/{s['counts']['pass'] + s['counts']['fail']}"
                            f"{' +' + str(s['counts']['skip']) + ' skip' if s['counts']['skip'] else ''}"
                            f"{'' if s.get('result') == 'GREEN' else ' ' + str(s.get('result'))}" for s in steps)
            out.append(f"run {r['n']}: {per}")
        else:
            out.append(f"run {r.get('n', 1)}: {c.get('pass', 0)} pass, {c.get('fail', 0)} fail, {c.get('skip', 0)} skip"
                       f"{' (exit ' + str(r.get('exit')) + ')' if r.get('exit') not in (0, None) else ''}")
    return "; ".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sha")
    ap.add_argument("--out")
    a = ap.parse_args()
    sha = subprocess.run(["git", "rev-parse", "--verify", a.sha + "^{commit}"], cwd=HERE, capture_output=True, text=True).stdout.strip()
    reg = json.load(open(os.path.join(HERE, "v1-gates.json")))
    full = load(os.path.join(BASE, "gates", f"{sha}.json")) or {}
    part = load(os.path.join(BASE, "gates", f"{sha}.partial.json")) or {}
    res = {}
    for src, d in (("full", full), ("partial", part)):
        for g in d.get("gates", []):
            res[(g["id"], g.get("variant", "v1"), src)] = g
    rows = ["| Gate | Status | Ran (variant · command) | Result on " + sha[:8] + " | Counts | tree-next last green | Same? |",
            "|---|---|---|---|---|---|---|"]
    for g in reg["gates"]:
        gid = g["id"]
        pick = res.get((gid, "v09", "partial")) if g["status"] == "port" else None
        pick = pick or res.get((gid, "v1", "full")) or res.get((gid, "v1", "partial"))
        if not pick:
            rows.append(f"| {gid} | {g['status']} | — | not run | | {g.get('last_green', '')} | |")
            continue
        cmd = pick.get("cmd", "").replace("|", "\\|")
        rows.append(f"| {gid} | {g['status']} | {pick.get('variant')} · `{cmd[:140]}` | **{pick['result']}**"
                    f"{' — ' + pick['reason'].replace('|', '/')[:160] if pick.get('reason') else ''} | {counts(pick)} | {g.get('last_green', '')} | |")
    head = [f"# Baseline of trunk-v1 head {sha[:12]} through sim/v1-ladder.sh (M0)", "",
            f"- full run: `gates/{sha}.json` — complete {full.get('complete')}, green {full.get('green')}, tree_clean {full.get('tree_clean')}, "
            f"{full.get('started')} → {full.get('ended')}, ladder {full.get('ladder_version')}",
            f"- v0.9 baseline of the port gates: `gates/{sha}.partial.json` — {part.get('started')} → {part.get('ended')}, ladder {part.get('ladder_version')}",
            f"- logs: `~/.cache/trunk-v1/gates/{sha}/<gate>/run<n>[-<step>].log`", ""]
    out = a.out or os.path.join(BASE, f"baseline-{sha[:12]}.md")
    open(out, "w").write("\n".join(head + rows) + "\n")
    print(out)


if __name__ == "__main__":
    sys.exit(main())
