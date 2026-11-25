#!/usr/bin/env python3
"""v1-ladder-test.py — G0.5, part 2: the runner's own rules, without running any rig or build.

  * the registry (sim/v1-gates.json) lists exactly the gate ids trunk/deploy/gate-check.sh requires, every step is
    well formed, every parser it names exists, every fixed port is in the ladder range (18700-18799) or one of the
    fixed ports an as-is script hard-codes (restart-e2e 4189/18198, hsim 4150)
  * the count parsers on real-shaped output (cargo, node --test spec + tap, playwright, ok/PASS lines, step tables,
    the obs [PASS] lines, the rehearsal's coloured lines)
  * the flake rule (§9 rule 4): red then green = GREEN (the red logged), red twice = RED, timing gates need 5 greens,
    at most 3 re-runs, ERROR / MISSING are never retried into a pass
  * preflight: a script the commit lacks = MISSING; a missing prerequisite, a busy port = ERROR
  * the environment a rig gets: none of the caller's YGG_* / BIFROST_* / CLAUDE* / keys
  * --only / --from selection

    python3 sim/v1-ladder-test.py        exit 0 = all PASS
"""
import importlib.util, json, os, re, socket, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("v1_ladder", os.path.join(HERE, "v1_ladder.py"))
L = importlib.util.module_from_spec(spec)
spec.loader.exec_module(L)
L.say = lambda *a: None
FAILS = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" — {str(detail)[:300]}"), flush=True)
    if not ok:
        FAILS.append(name)


reg = json.load(open(os.path.join(HERE, "v1-gates.json")))
gc = open(os.path.join(HERE, "..", "trunk", "deploy", "gate-check.sh")).read()
required = re.search(r'GATE_CHECK_REQUIRED="([^"]+)"', gc).group(1).split()
ids = [g["id"] for g in reg["gates"]]

# ---------------------------------------------------------------- the registry
check("registry ids = gate-check.sh's required list, in order", ids == required, (ids, required))
check("31 gates (G0.1-G0.5, G1.1-G1.3, G2.1-G2.4, G3.1-G3.9, G4.1-G4.6, G5.1-G5.4)", len(ids) == 31 and len(set(ids)) == 31, len(ids))
FIXED = {4189, 18198, 4150}
bad_steps, bad_ports, bad_parsers, bad_status = [], [], [], []
for g in reg["gates"]:
    if g["status"] not in ("as-is", "port", "new", "as-is+new"):
        bad_status.append(g["id"])
    if g["status"] == "port" and not (g.get("pending") or g.get("ready")):
        bad_status.append(g["id"] + " (port gate neither pending nor ready)")
    if g["status"] == "port" and g["id"] in ("G2.1", "G2.2", "G2.3", "G3.1", "G3.2", "G3.3", "G3.4", "G3.5", "G4.1") and "v09" not in g:
        bad_status.append(g["id"] + " (no v0.9 variant for the baseline)")
    if "build" in g:
        if g["build"] not in reg["builds"]:
            bad_steps.append(g["id"])
        continue
    for st in g.get("steps", []) + g.get("v09", []):
        if not st.get("cmd") or not isinstance(st.get("timeout"), int) or st["timeout"] <= 0:
            bad_steps.append(g["id"])
        for p in st.get("counts", []):
            if p not in reg["parsers"]:
                bad_parsers.append(f"{g['id']}:{p}")
        for p in st.get("ports", []):
            if not (18700 <= p <= 18799 or p in FIXED):
                bad_ports.append(f"{g['id']}:{p}")
        for p in re.findall(r"--port-base\s+(\d+)|P3_PORT_BASE.\s*.(\d+)", json.dumps(st)):
            for v in p:
                if v and not 18700 <= int(v) <= 18799:
                    bad_ports.append(f"{g['id']}:base {v}")
check("every step has a command and a timeout", not bad_steps, bad_steps)
check("every parser a step names exists", not bad_parsers, bad_parsers)
check("every port is in 18700-18799 (or a fixed port of an as-is script)", not bad_ports, bad_ports)
check("statuses valid; port gates are pending or ready and carry their v0.9 steps", not bad_status, bad_status)
check("the timing gate is G3.6 (x5)", [g["id"] for g in reg["gates"] if g.get("timing")] == ["G3.6"])
check("twin gates take the twin lock", all("twin" in g.get("locks", []) for g in reg["gates"] if g["id"] in ("G2.4", "G5.1", "G5.3")))
check("no step writes to /tmp", "/tmp" not in json.dumps(reg["gates"]))

# ---------------------------------------------------------------- parsers
P = reg["parsers"]
cargo = ("running 120 tests\ntest result: ok. 118 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 9.1s\n"
         "running 53 tests\ntest result: FAILED. 51 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out\n")
check("cargo: sums every test binary", L.parse_counts(cargo, ["cargo"], P) == {"pass": 169, "fail": 2, "skip": 2})
spec_out = "ℹ tests 44\nℹ suites 0\nℹ pass 44\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\n"
tap_out = "# tests 10\n# pass 9\n# fail 1\n# skipped 0\n"
check("node --test: spec reporter", L.parse_counts(spec_out, ["node-test"], P) == {"pass": 44, "fail": 0, "skip": 0})
check("node --test: tap reporter", L.parse_counts(tap_out, ["node-test"], P) == {"pass": 9, "fail": 1, "skip": 0})
pw = "  ✓  1 [chromium] › e2e/auth.spec.ts:3:1 › x (2.1s)\n\n  1 skipped\n  10 passed (1.2m)\n"
check("playwright: passed / skipped", L.parse_counts(pw, ["playwright"], P) == {"pass": 10, "fail": 0, "skip": 1})
pw2 = "  2 failed\n    [chromium] › e2e/a.spec.ts:1:1 › a\n  1 flaky\n  7 passed (40s)\n"
check("playwright: failed, flaky counts as passed", L.parse_counts(pw2, ["playwright"], P) == {"pass": 8, "fail": 2, "skip": 0})
ok = "ok   brain up\nok   MAIN speaks\nFAIL lab report — timeout\nnot ok here\n"
check("ok-lines", L.parse_counts(ok, ["ok-lines"], P) == {"pass": 2, "fail": 1, "skip": 0})
table = ("STEP       WHAT\n1     PASS pair by QR\n1d    PASS a fresh phone\n4e    FAIL a third root\n           ↳ detail\n"
         "  ✓ 3 [chromium] PASS inside a test title\n")
check("step tables (trunk-full/rtc/e2e/own-trunk)", L.parse_counts(table, ["step-table"], P) == {"pass": 2, "fail": 1, "skip": 0})
own = "a1    PASS trunk.sh\nr     SKIP real release\n  phone (steps):\n    1     PASS paired\n"
check("own-trunk table with SKIP and the phone's sub-table", L.parse_counts(own, ["step-table"], P) == {"pass": 2, "fail": 0, "skip": 1})
obs = "  [PASS] records\n  [PASS] probes\n  [FAIL] backlog\nTRUNK-OBS E2E: 2/3 PASS\n"
check("obs [PASS] lines", L.parse_counts(obs, ["obs"], P) == {"pass": 2, "fail": 1, "skip": 0})
reh = "\x1b[32mPASS\x1b[0m r1  release.sh\n\x1b[31mFAIL\x1b[0m r2  assets\nPASS  r1  release.sh\nFAIL  r2  assets\n"
check("rehearsal: the coloured lines only (not the column -t echo)", L.parse_counts(reh, ["rehearsal"], P) == {"pass": 1, "fail": 1, "skip": 0})
check("ok-lines + playwright on one log add up", L.parse_counts(ok + pw, ["ok-lines", "playwright"], P)["pass"] == 12)

# ---------------------------------------------------------------- the flake rule
def fake_runs(seq):
    it = iter(seq)

    def one_run(gate, steps, n, ctx, parsers):
        r = next(it)
        return {"n": n, "result": r, "counts": {"pass": 1, "fail": 0, "skip": 0}, "reason": "x" if r not in ("GREEN", "RED") else ""}
    return one_run


def rule(seq, timing=False):
    L.one_run = fake_runs(seq)
    res, runs, _ = L.run_gate({"id": "Gx", "timing": timing}, [], {}, {})
    return res, len(runs)


check("green first time: GREEN, 1 run", rule(["GREEN"]) == ("GREEN", 1))
check("red then green: GREEN after 2 runs (the red is kept)", rule(["RED", "GREEN"]) == ("GREEN", 2))
check("red twice: RED after 2 runs", rule(["RED", "RED", "GREEN"]) == ("RED", 2))
check("an ERROR is never retried into a pass", rule(["ERROR", "GREEN"]) == ("ERROR", 1))
check("MISSING is not retried", rule(["MISSING"]) == ("MISSING", 1))
check("timing gate: 5 greens = GREEN, 5 runs", rule(["GREEN"] * 5, True) == ("GREEN", 5))
check("timing gate: one red among them = GREEN after 6 runs", rule(["GREEN", "RED", "GREEN", "GREEN", "GREEN", "GREEN"], True) == ("GREEN", 6))
check("timing gate: red twice = RED", rule(["GREEN", "RED", "GREEN", "RED", "GREEN", "GREEN"], True) == ("RED", 4))
L.STOP["flag"] = True
check("an interrupted ladder never passes a gate", rule(["GREEN"])[0] == "ERROR")
L.STOP["flag"] = False

# ---------------------------------------------------------------- preflight
with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as wt:
    os.makedirs(os.path.join(wt, "sim"))
    open(os.path.join(wt, "sim", "there.sh"), "w").close()
    ctx = {"wt": wt, "home": os.path.expanduser("~")}
    k, why = L.preflight({"cmd": "bash sim/not-yet.sh --x"}, ctx)
    check("a script this commit lacks: MISSING", k == "MISSING" and "sim/not-yet.sh" in why, (k, why))
    k, why = L.preflight({"cmd": "bash sim/there.sh", "requires": [os.path.join(wt, "no-such-cache")]}, ctx)
    check("a missing prerequisite: ERROR", k == "ERROR" and "prerequisite" in why, (k, why))
    s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1); port = s.getsockname()[1]
    k, why = L.preflight({"cmd": "bash sim/there.sh", "ports": [port]}, ctx)
    s.close()
    check("a busy port: ERROR, nothing stopped", k == "ERROR" and str(port) in why, (k, why))
    check("all there: runs", L.preflight({"cmd": "bash sim/there.sh"}, ctx) == (None, ""))
    check("absolute {wt} paths are not taken for repo paths", L.repo_paths("python3 x.py --app {wt}/branch sim/scenarios/a.json") == ["sim/scenarios/a.json"])

# ---------------------------------------------------------------- environment
os.environ.update(YGG_DATA_DIR="/live/data", YGG_LISTEN="127.0.0.1:4101", YGG_UPSTREAM_API_KEY="k", BIFROST_AUTH="devices",
                  CLAUDECODE="1", CLAUDE_CODE_SESSION_ID="s", ANTHROPIC_API_KEY="k", CARGO_TARGET_DIR="/elsewhere", SSH_AUTH_SOCK="/x")
e = L.clean_env({"HARNESS": "1"}, "/t")
leak = [k for k in e if k.startswith(("YGG_", "BIFROST_", "CLAUDE", "ANTHROPIC")) or k in ("CARGO_TARGET_DIR", "SSH_AUTH_SOCK")]
check("a rig never inherits the caller's YGG_*/BIFROST_*/CLAUDE*/keys/CARGO_TARGET_DIR/SSH agent", not leak, leak)
check("…but keeps PATH and HOME, sets TMPDIR and its own env", e.get("PATH") and e.get("HOME") and e["TMPDIR"] == "/t" and e["HARNESS"] == "1")

# ---------------------------------------------------------------- selection
gs = reg["gates"]
check("--only G0 = every G0 gate", L.select(gs, "G0", None) == ["G0.1", "G0.2", "G0.3", "G0.4", "G0.5"])
check("--only G1.2,G3.9", L.select(gs, "G1.2,G3.9", None) == ["G1.2", "G3.9"])
check("--from G5.2 = G5.2 … G5.4", L.select(gs, None, "G5.2") == ["G5.2", "G5.3", "G5.4"])
try:
    L.select(gs, "G9", None); check("--only of an unknown id is refused", False)
except SystemExit:
    check("--only of an unknown id is refused", True)

print(f"\n{'GREEN' if not FAILS else 'RED'}: {len(FAILS)} failure(s) {FAILS if FAILS else ''}")
sys.exit(1 if FAILS else 0)
