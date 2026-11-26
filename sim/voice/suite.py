#!/usr/bin/env python3
"""suite.py — run several voice scenarios one after another and write one index of the results.

    suite.py [SCENARIO.json …] [--out DIR] [-- vsim args…]
    suite.py scenarios/v-keywords.json scenarios/v-two-roots.json -- --target https://host:8447 --brain http://127.0.0.1:4101

No scenario named = every scenarios/v-*.json except v-all-agents (70 min, harness logins).
Sequential on purpose: each run owns the box's speech server and the stack's ports.

    suite.py --dry-run [SCENARIO.json …] [-- vsim args…]   # no run, no tokens: validate every scenario the
                                                             # way vsim loads it and print the exact vsim commands
G5.3 (the v1 trunk): suite.py --out DIR -- --target http://127.0.0.1:18600 --brain http://127.0.0.1:4250 \
                       --pair-cmd "bifrost-net trunk-ctl --sock S pair-qr"
"""
import glob, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    argv = sys.argv[1:]
    extra = argv[argv.index("--") + 1:] if "--" in argv else []
    argv = argv[:argv.index("--")] if "--" in argv else argv
    out = os.path.expanduser("~/Work/bifrost/artifacts/voice-sim")
    if "--out" in argv:
        i = argv.index("--out")
        out = argv[i + 1]
        del argv[i:i + 2]
    dry = "--dry-run" in argv
    if dry:
        argv.remove("--dry-run")
    scen = argv or sorted(x for x in glob.glob(os.path.join(HERE, "scenarios", "v-*.json")) if "all-agents" not in x)
    if dry:
        sys.path.insert(0, HERE)
        sys.path.insert(0, os.path.dirname(HERE))
        import vsim  # noqa: E402
        bad = 0
        for sc in scen:
            try:
                d = vsim.load_scenario(sc)
                assert d["personas"] and d["roots"], "no personas/roots"
                assert "all-agents" not in os.path.basename(sc) or argv, "v-all-agents is not part of the default set"
                print(f"ok   {os.path.basename(sc)}: {len(d['personas'])} persona(s), roots {[r['name'] for r in d['roots']]}, max {d.get('max_minutes')} min")
                print("     " + " ".join([sys.executable, os.path.join(HERE, "vsim.py"), sc, "--out", out, *extra]))
            except Exception as e:  # noqa: BLE001
                bad += 1
                print(f"FAIL {os.path.basename(sc)}: {e}")
        print(f"suite dry-run: {len(scen) - bad} ok, {bad} fail ({'v-all-agents excluded' if not any('all-agents' in x for x in scen) else 'v-all-agents INCLUDED'})")
        sys.exit(1 if bad else 0)
    suite = time.strftime("%Y%m%dT%H%M%S") + "-suite"
    sdir = os.path.join(out, suite)
    os.makedirs(sdir, exist_ok=True)
    rows = []
    for sc in scen:
        t = time.time()
        log = os.path.join(sdir, os.path.basename(sc).replace(".json", ".log"))
        with open(log, "w") as f:
            rc = subprocess.run([sys.executable, os.path.join(HERE, "vsim.py"), sc, "--out", sdir, *extra], stdout=f, stderr=subprocess.STDOUT).returncode
        runs = sorted(glob.glob(os.path.join(sdir, f"*-{json.load(open(sc))['id']}", "report.json")))
        r = json.load(open(runs[-1])) if runs else None
        rows.append((sc, rc, r, round((time.time() - t) / 60, 1)))
        print(f"{os.path.basename(sc)}: exit {rc} in {rows[-1][3]} min", flush=True)
    with open(os.path.join(sdir, "index.md"), "w") as f:
        f.write(f"# Voice persona sim — suite {suite}\n\n| scenario | result | judge | checks | box WER | reply WER | first audio p50 / max | MAIN msgs read aloud | min | report |\n|---|---|---|---|---|---|---|---|---|---|\n")
        for sc, rc, r, mins in rows:
            if not r:
                f.write(f"| {os.path.basename(sc)} | {'RIG ERROR' if rc == 3 else f'exit {rc}'} | | | | | | | {mins} | |\n")
                continue
            v, j = r["voice"], r["judge"].get("scores") or {}
            bad = [c["name"] for c in r["checks"] if not c["ok"] and not c.get("advisory")]
            f.write(f"| {r['scenario']} | {'PASS' if r['pass'] else 'FAIL'} | {' '.join(f'{k[:4]} {x}' for k, x in j.items())} | "
                    f"{len(r['checks']) - len(bad)}/{len(r['checks'])}{' ✗ ' + '; '.join(bad)[:120] if bad else ''} | {v['box_wer_mean']} | {v['reply_wer_mean']} | "
                    f"{v['first_audio_p50']}s / {v['first_audio_max']}s | {v.get('main_msgs_spoken')}/{v.get('main_msgs')} | {mins} | [report]({r['run']}/report.md) |\n")
    print(os.path.join(sdir, "index.md"))


if __name__ == "__main__":
    main()
