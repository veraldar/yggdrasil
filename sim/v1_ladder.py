#!/usr/bin/env python3
"""v1_ladder.py — the core of sim/v1-ladder.sh (trunk v1 spec rev 3, §2 "How R2 is enforced mechanically", §9).

    sim/v1-ladder.sh <sha> [--only G0.1,G1] [--from G2.1] [--skip G5.2] [--v09] [--fresh] [--no-wait]
    sim/v1-ladder.sh --show <gate file>

Runs the §9 ladder (registry: sim/v1-gates.json of THIS checkout) on a clean throwaway worktree of <sha>
(~/.cache/trunk-v1/wt/<sha>) and writes ~/.cache/trunk-v1/gates/<sha>.json, logs under gates/<sha>/.
Nothing is written inside any worktree (the build stamp branch/package.json gets is put back).

- --only / --from / --v09 runs write gates/<sha>.partial.json (merged by gate id), never the full name.
- --skip ids: recorded as SKIPPED (the full file then says complete: false). Never silent.
- --v09: a 'port' gate runs its v0.9 steps (the baseline of the branch point); recorded as variant v09.
- A gate whose v1 script does not exist (or is marked pending) is MISSING; a missing prerequisite or a busy
  port / unit / container is ERROR (nothing of anybody else's is stopped); a failed run is retried at most 3
  times, every run logged, red twice = RED; timing gates need 5 green runs.
- Every gate runs with an allowlisted environment: none of the caller's YGG_* / BIFROST_* / CLAUDE* / keys
  reach a rig (the caller may be a child of the live brain).
- One run at a time: flock ~/.cache/trunk-v1/ladder.lock; twin gates also flock twin.lock.
"""
import argparse, datetime, fcntl, hashlib, json, os, re, shlex, shutil, signal, socket, subprocess, sys, time

HOME = os.path.expanduser("~")
BASE = os.environ.get("V1_LADDER_HOME") or os.path.join(HOME, ".cache", "trunk-v1")
GATES = os.path.join(BASE, "gates")
WTS = os.path.join(BASE, "wt")
TMPROOT = os.path.join(BASE, "tmp", "ladder")
HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, "v1-gates.json")
LADDER_FILES = [REGISTRY, os.path.join(HERE, "v1-ladder.sh"), os.path.abspath(__file__)]
CACHE_DIRS = ["root/target", "trunk/target", "branch/node_modules"]
ENV_KEEP = {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
            "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
            "XDG_STATE_HOME", "DOCKER_HOST", "CARGO_HOME", "RUSTUP_HOME"}
RESULTS = ("GREEN", "RED", "MISSING", "ERROR", "SKIPPED")
STOP = {"flag": False}
CURRENT = {"proc": None}


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def say(*a):
    print(f"[ladder {time.strftime('%H:%M:%S')}]", *a, flush=True)


def git(*args, cwd=None, check=True):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout.strip()


def atomic_json(path, obj):
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def clean_env(extra=None, tmpdir=None):
    env = {k: v for k, v in os.environ.items() if k in ENV_KEEP or k.startswith("LC_")}
    if tmpdir:
        env["TMPDIR"] = tmpdir
    env.update(extra or {})
    return env


def tpl(s, ctx):
    return re.sub(r"\{(\w+)\}", lambda m: str(ctx[m.group(1)]) if m.group(1) in ctx else m.group(0), s)


def flock(path, wait=True, what="lock"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        if not wait:
            os.close(fd)
            return None
        say(f"waiting for {what} ({path}) …")
        fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


# ------------------------------------------------------------------------------------------------ counting
def parse_counts(text, names, parsers):
    c = {"pass": 0, "fail": 0, "skip": 0}
    plain = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
    for n in names or []:
        p = parsers[n]
        src = text if p.get("raw") else plain
        for rx in p.get("sum", []):
            r = re.compile(rx, re.M)
            for m in r.finditer(src):
                for k, v in m.groupdict().items():
                    if v is not None:
                        c[k] += int(v)
        for k, rx in p.get("count", {}).items():
            c[k] += len(re.findall(rx, src, re.M))
    return c


# ------------------------------------------------------------------------------------------------ preflight
def port_busy(p):
    """A listener holds p. SO_REUSEADDR as every server sets it: TIME_WAIT left by the previous rig is not 'busy'."""
    for host in ("127.0.0.1", "0.0.0.0"):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, p))
        except OSError:
            return True
        finally:
            s.close()
    return False


def unit_active(u):
    r = subprocess.run(["systemctl", "--user", "is-active", u], capture_output=True, text=True)
    return r.stdout.strip() in ("active", "activating", "deactivating", "reloading")


def docker_names(kind):
    cmd = ["docker", "ps", "-a", "--format", "{{.Names}}"] if kind == "container" else ["docker", "network", "ls", "--format", "{{.Name}}"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return set()
    return set(r.stdout.split())


def repo_paths(cmd):
    """Worktree paths a command runs (sim/x.py, scripts/y.sh …): a missing one makes the gate MISSING."""
    out = []
    for t in shlex.split(cmd):
        if re.match(r"^(sim|scripts|trunk|root|branch)/[\w./-]+$", t) and not t.endswith((".json",)) or \
           re.match(r"^sim/scenarios/[\w.-]+\.json$", t):
            out.append(t)
    return out


def preflight(step, ctx):
    """→ (kind, reason) with kind None (ok) | MISSING | ERROR."""
    wt = ctx["wt"]
    for p in repo_paths(step["cmd"]) + list(step.get("exists", [])):
        if not os.path.exists(os.path.join(wt, step.get("cwd", ""), p)) and not os.path.exists(os.path.join(wt, p)):
            return "MISSING", f"no {p} in this commit"
    for r in step.get("requires", []):
        r = tpl(r, ctx)
        ok = os.path.exists(r) if "/" in r else shutil.which(r) is not None
        if not ok:
            return "ERROR", f"prerequisite missing on this machine: {r}"
    for p in step.get("ports", []):
        if port_busy(p):
            return "ERROR", f"port {p} is taken (another rig or service) — nothing was stopped"
    for u in step.get("units", []):
        if unit_active(u):
            return "ERROR", f"unit {u} is already running (not started by this run) — nothing was stopped"
    if step.get("containers") or step.get("networks"):
        have = docker_names("container")
        busy = [c for c in step.get("containers", []) if c in have]
        if busy:
            return "ERROR", f"docker containers already exist, not made by this run: {' '.join(busy)} — nothing was removed"
        nets = docker_names("network")
        busy = [n for n in step.get("networks", []) if n in nets]
        if busy:
            return "ERROR", f"docker network already exists, not made by this run: {' '.join(busy)} — nothing was removed"
    return None, ""


def leftovers(step):
    """Stop what this step's rig may have left, by exact name (only called for steps whose preflight passed)."""
    done = []
    for u in step.get("units", []):
        if unit_active(u):
            subprocess.run(["systemctl", "--user", "stop", u], capture_output=True)
            done.append(u)
        subprocess.run(["systemctl", "--user", "reset-failed", u], capture_output=True)
    if step.get("containers"):
        have = docker_names("container")
        for c in step["containers"]:
            if c in have:
                subprocess.run(["docker", "rm", "-f", c], capture_output=True)
                done.append(c)
    if step.get("networks"):
        nets = docker_names("network")
        for n in step["networks"]:
            if n in nets:
                subprocess.run(["docker", "network", "rm", n], capture_output=True)
                done.append(n)
    return done


# ------------------------------------------------------------------------------------------------ running
def run_cmd(cmd, cwd, env, timeout, log):
    """bash -c cmd in its own session (process group = its pid); on timeout the group is killed. → (exit, timed_out)"""
    with open(log, "ab") as lf:
        lf.write(f"$ (cd {cwd} && {cmd})\n".encode())
        lf.flush()
        p = subprocess.Popen(["bash", "-c", cmd], cwd=cwd, env=env, stdout=lf, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        CURRENT["proc"] = p
        timed_out = False
        try:
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_group(p)
        finally:
            CURRENT["proc"] = None
        if STOP["flag"] and p.returncode is None:
            kill_group(p)
        rc = p.returncode
        lf.write(f"\n[ladder] exit {rc}{' (timeout after %ss)' % timeout if timed_out else ''}\n".encode())
    return rc, timed_out


def kill_group(p):
    for sig, wait in ((signal.SIGTERM, 20), (signal.SIGKILL, 10)):
        try:
            os.killpg(p.pid, sig)
        except ProcessLookupError:
            return
        try:
            p.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def one_run(gate, steps, n, ctx, parsers):
    gid = gate["id"]
    run_tmp = os.path.join(ctx["tmproot"], gid, f"run{n}")
    shutil.rmtree(run_tmp, ignore_errors=True)
    os.makedirs(os.path.join(run_tmp, "state"))
    os.makedirs(os.path.join(run_tmp, "tmp"))
    rctx = dict(ctx, state=os.path.join(run_tmp, "state"), tmp=os.path.join(run_tmp, "tmp"))
    run = {"n": n, "start": now(), "end": None, "exit": None, "counts": {"pass": 0, "fail": 0, "skip": 0},
           "log": None, "steps": [], "tmp": run_tmp}
    logs = []
    kind = None
    for i, st in enumerate(steps):
        name = st.get("name") or (str(i + 1) if len(steps) > 1 else "")
        log = os.path.join(ctx["logs"], gid.replace("/", "_"), f"run{n}{'-' + name if name else ''}.log")
        os.makedirs(os.path.dirname(log), exist_ok=True)
        open(log, "wb").close()
        logs.append(log)
        cmd = tpl(st["cmd"], rctx)
        srec = {"name": name, "cmd": cmd, "start": now(), "end": None, "exit": None, "log": log,
                "counts": {"pass": 0, "fail": 0, "skip": 0}}
        run["steps"].append(srec)
        k, why = preflight(st, rctx)
        if k:
            srec.update(end=now(), skipped=why, result=k)
            with open(log, "a") as f:
                f.write(f"[ladder] not run: {k}: {why}\n")
            kind = kind or k
            run["reason"] = why
            break
        env = clean_env({k2: tpl(v, rctx) for k2, v in st.get("env", {}).items()}, rctx["tmp"])
        cwd = os.path.join(ctx["wt"], st.get("cwd", ""))
        t0 = time.time()
        try:
            rc, to = run_cmd(cmd, cwd, env, st.get("timeout", 3600), log)
        finally:
            gone = leftovers(st)
            if gone:
                with open(log, "a") as f:
                    f.write(f"[ladder] stopped leftovers by exact name: {' '.join(gone)}\n")
                srec["leftovers_stopped"] = gone
        text = open(log, encoding="utf-8", errors="replace").read()
        c = parse_counts(text, st.get("counts"), parsers)
        green = rc == 0 and c["fail"] == 0 and (not st.get("counts") or c["pass"] > 0)
        srec.update(end=now(), exit=rc, counts=c, seconds=round(time.time() - t0), result="GREEN" if green else "RED")
        if to:
            srec["timeout"] = True
        if rc == 0 and st.get("counts") and c["pass"] == 0:
            srec["why"] = "exit 0 but no passing check was counted"
        if rc == 0 and c["fail"]:
            srec["why"] = "exit 0 but a failing check was counted"
        for k2 in c:
            run["counts"][k2] += c[k2]
        if run["exit"] in (None, 0):
            run["exit"] = rc
        if STOP["flag"]:
            kind = kind or "ERROR"
            run["reason"] = "the ladder run was interrupted"
            break
    run["end"] = now()
    run["log"] = logs[0] if len(logs) == 1 else os.path.dirname(logs[0]) if logs else None
    if kind:
        run["result"] = kind
    else:
        run["result"] = "GREEN" if all(s["result"] == "GREEN" for s in run["steps"]) else "RED"
    if run["result"] == "GREEN":
        shutil.rmtree(run_tmp, ignore_errors=True)
        run["tmp"] = None
    return run


def run_gate(gate, steps, ctx, parsers, first_run=None):
    """Flake rule (§9 rule 4): retry a red gate at most 3 times; red twice = RED; timing gates need 5 greens."""
    need = 5 if gate.get("timing") else 1
    runs = [first_run] if first_run else []
    while True:
        reds = sum(r["result"] == "RED" for r in runs)
        greens = sum(r["result"] == "GREEN" for r in runs)
        other = [r for r in runs if r["result"] not in ("GREEN", "RED")]
        if other:
            return other[-1]["result"], runs, other[-1].get("reason", "")
        if reds >= 2:
            return "RED", runs, f"red in {reds} of {len(runs)} runs"
        if greens >= need:
            return "GREEN", runs, (f"1 red run before {greens} green (a flake, logged)" if reds else "")
        if len(runs) - need >= 3:
            return "RED", runs, "re-runs exhausted"
        if STOP["flag"]:
            return "ERROR", runs, "the ladder run was interrupted"
        n = len(runs) + 1
        say(f"{gate['id']} run {n}{' (re-run)' if reds else ''} …")
        r = one_run(gate, steps, n, ctx, parsers)
        say(f"{gate['id']} run {n}: {r['result']} {fmt_counts(r['counts'])}{'  — ' + r['reason'] if r.get('reason') else ''}")
        runs.append(r)


def fmt_counts(c):
    return f"(pass {c['pass']} fail {c['fail']} skip {c['skip']})"


# ------------------------------------------------------------------------------------------------ worktree + builds
def worktree(repo, sha, fresh):
    wt = os.path.join(WTS, sha)
    if os.path.isdir(wt) and fresh:
        git("worktree", "remove", "--force", wt, cwd=repo, check=False)
        shutil.rmtree(wt, ignore_errors=True)
    if os.path.isdir(wt):
        if git("rev-parse", "--show-toplevel", cwd=wt, check=False) != wt:
            raise RuntimeError(f"{wt} exists and is not a worktree — remove it by hand")
        # our own throwaway checkout: put it back to exactly <sha> (ignored build caches stay)
        git("checkout", "-q", "--detach", sha, cwd=wt)
        git("reset", "-q", "--hard", sha, cwd=wt)
        git("clean", "-qfd", cwd=wt)
    else:
        os.makedirs(WTS, exist_ok=True)
        git("worktree", "prune", cwd=repo, check=False)
        git("worktree", "add", "-q", "--detach", wt, sha, cwd=repo)
    return wt


def tree_state(wt, sha):
    head = git("rev-parse", "HEAD", cwd=wt)
    st = git("status", "--porcelain", "--untracked-files=all", cwd=wt)
    return head, [l for l in st.splitlines() if l.strip()]


def cache_sources(sha):
    out = []
    for p in (os.environ.get("V1_LADDER_CACHE_FROM") or "").split(":"):
        if p:
            out.append(p)
    out.append(os.path.join(HOME, "Work", "trunk-v1"))
    try:
        others = sorted((os.path.join(WTS, d) for d in os.listdir(WTS) if d != sha), key=os.path.getmtime, reverse=True)
    except FileNotFoundError:
        others = []
    out += others
    out += [os.path.dirname(HERE), os.path.join(HOME, "Work", "tree-next")]
    return out


def reflink_caches(wt, sha, dirs=CACHE_DIRS):
    got = {}
    for d in dirs:
        dst = os.path.join(wt, d)
        if os.path.exists(dst):
            got[d] = "kept"
            continue
        for src in cache_sources(sha):
            s = os.path.join(src, d)
            if os.path.isdir(s) and os.path.realpath(s) != os.path.realpath(dst):
                r = subprocess.run(["cp", "-a", "--reflink=always", s, dst], capture_output=True, text=True)
                if r.returncode == 0:
                    got[d] = s
                    break
                shutil.rmtree(dst, ignore_errors=True)
        else:
            got[d] = "none (cold build)"
    return got


def build(name, spec, wt, logs, extra_ctx):
    log = os.path.join(logs, f"build-{name}.log")
    open(log, "wb").close()
    rec = {"name": name, "cmd": spec["cmd"], "cwd": spec["cwd"], "start": now(), "log": log}
    env = clean_env(None, extra_ctx["tmp"])
    cwd = os.path.join(wt, spec["cwd"])
    if name == "app":
        r = subprocess.run(["npm", "ls", "--depth=0"], cwd=cwd, env=env, capture_output=True)
        if r.returncode != 0:
            rc, _ = run_cmd("npm ci --no-audit --no-fund", cwd, env, 1800, log)
            rec["npm_ci"] = rc
    t0 = time.time()
    rc, to = run_cmd(spec["cmd"], cwd, env, spec.get("timeout", 3600), log)
    for f in spec.get("restore", []):
        git("checkout", "-q", "--", f, cwd=wt, check=False)
    art = os.path.join(wt, spec["artifact"]) if spec.get("artifact") else None
    ok = rc == 0 and (art is None or os.path.exists(art))
    rec.update(end=now(), exit=rc, seconds=round(time.time() - t0), ok=ok, timeout=to or None)
    say(f"build {name}: {'ok' if ok else 'FAILED'} ({rec['seconds']} s) — {log}")
    return rec


def build_old_brain(spec, repo, logs, ctx):
    full = git("rev-parse", "--verify", spec["commit"] + "^{commit}", cwd=repo)
    d = os.path.join(BASE, "old-brain", full)
    art = os.path.join(d, spec["artifact"])
    rec = {"name": "old-brain", "commit": full, "path": art, "start": now()}
    if os.path.exists(art):
        rec.update(end=now(), ok=True, reused=True)
        return rec
    if not os.path.isdir(d):
        os.makedirs(os.path.dirname(d), exist_ok=True)
        git("worktree", "add", "-q", "--detach", d, full, cwd=repo)
    reflink_caches(d, full, ["root/target"])
    r = build("old-brain", spec, d, logs, ctx)
    rec.update(r, path=art, commit=full, name="old-brain")
    return rec


# ------------------------------------------------------------------------------------------------ main
def select(gates, only, frm):
    ids = [g["id"] for g in gates]
    sel = ids
    if frm:
        if frm not in ids:
            raise SystemExit(f"--from {frm}: no such gate")
        sel = ids[ids.index(frm):]
    if only:
        want = [w.strip() for w in only.split(",") if w.strip()]
        bad = [w for w in want if not any(i == w or i.startswith(w + ".") for i in ids)]
        if bad:
            raise SystemExit(f"--only: no such gate(s): {', '.join(bad)}")
        sel = [i for i in sel if any(i == w or i.startswith(w + ".") for w in want)]
    return sel


def ladder_version(repo):
    h = hashlib.sha256()
    for f in LADDER_FILES:
        h.update(open(f, "rb").read())
    c = git("rev-parse", "--short=12", "HEAD", cwd=repo, check=False) or "?"
    dirty = git("status", "--porcelain", "--", *[os.path.relpath(f, repo) for f in LADDER_FILES], cwd=repo, check=False)
    return f"{c}{'+dirty' if dirty else ''}:{h.hexdigest()[:12]}"


def show(path):
    d = json.load(open(path))
    print(f"{os.path.basename(path)}: sha {d.get('sha')} · {'partial · ' if d.get('partial') else ''}complete {d.get('complete')} · "
          f"green {d.get('green')} · tree_clean {d.get('tree_clean')} · {d.get('started')} → {d.get('ended')} · ladder {d.get('ladder_version')}")
    for g in d.get("gates", []):
        runs = g.get("runs", [])
        c = runs[-1]["counts"] if runs else None
        rs = "".join({"GREEN": "g", "RED": "r"}.get(r.get("result"), "?") for r in runs)
        print(f"  {g['id']:<5} {g.get('variant', 'v1'):<4} {g['result']:<8} {('runs ' + rs) if runs else '':<10} "
              f"{fmt_counts(c) if c else '':<28} {g.get('reason', '')[:110]}")


def main():
    ap = argparse.ArgumentParser(prog="sim/v1-ladder.sh", description=__doc__.split("\n\n")[0])
    ap.add_argument("sha", nargs="?")
    ap.add_argument("--only")
    ap.add_argument("--from", dest="frm")
    ap.add_argument("--skip", default="")
    ap.add_argument("--v09", action="store_true", help="port gates run their v0.9 steps (baseline); always partial")
    ap.add_argument("--fresh", action="store_true", help="re-create the throwaway worktree")
    ap.add_argument("--no-wait", action="store_true", help="fail at once if another ladder run holds the lock")
    ap.add_argument("--show")
    a = ap.parse_args()
    if a.show:
        show(a.show)
        return 0
    if not a.sha:
        ap.error("a commit is needed")
    repo = git("rev-parse", "--show-toplevel", cwd=HERE)
    sha = git("rev-parse", "--verify", "--quiet", a.sha + "^{commit}", cwd=repo, check=False)
    if not re.fullmatch(r"[0-9a-f]{40}", sha or ""):
        print(f"v1-ladder: {a.sha!r} is not a commit of this repository", file=sys.stderr)
        return 2
    reg = json.load(open(REGISTRY))
    gates = reg["gates"]
    byid = {g["id"]: g for g in gates}
    sel = select(gates, a.only, a.frm)
    skip = {s.strip() for s in a.skip.split(",") if s.strip()}
    bad = [s for s in skip if s not in byid]
    if bad:
        raise SystemExit(f"--skip: no such gate(s): {', '.join(bad)}")
    partial = bool(a.only or a.frm or a.v09)
    os.makedirs(GATES, exist_ok=True)
    lock = flock(os.path.join(BASE, "ladder.lock"), wait=not a.no_wait, what="the ladder lock")
    if lock is None:
        print("v1-ladder: another ladder run holds ~/.cache/trunk-v1/ladder.lock", file=sys.stderr)
        return 75
    out = os.path.join(GATES, f"{sha}.partial.json" if partial else f"{sha}.json")
    logs = os.path.join(GATES, sha)
    os.makedirs(logs, exist_ok=True)
    tmproot = os.path.join(TMPROOT, sha[:12])
    os.makedirs(tmproot, exist_ok=True)

    def on_signal(signum, _):
        STOP["flag"] = True
        p = CURRENT["proc"]
        if p is not None:
            kill_group(p)
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGHUP, on_signal)

    doc = {"sha": sha, "tree_clean": False, "started": now(), "ended": None, "host": socket.gethostname(),
           "ladder_version": ladder_version(repo), "partial": partial, "mode": "v09-baseline" if a.v09 else "v1",
           "args": sys.argv[1:], "registry_version": reg.get("version"), "builds": {}, "gates": [],
           "complete": False, "green": False}
    prev = {}
    if partial and os.path.exists(out):
        try:
            old = json.load(open(out))
            if old.get("sha") == sha:
                prev = {(g["id"], g.get("variant", "v1")): g for g in old.get("gates", [])}
                doc["earlier_runs"] = old.get("earlier_runs", []) + [{k: old.get(k) for k in ("started", "ended", "args", "ladder_version", "mode")}]
        except (OSError, ValueError):
            pass

    def write():
        merged = dict(prev)
        for g in doc["gates"]:
            merged[(g["id"], g.get("variant", "v1"))] = g
        order = {g["id"]: i for i, g in enumerate(gates)}
        doc_out = dict(doc, gates=sorted(merged.values(), key=lambda g: (order.get(g["id"], 999), g.get("variant", "v1"))))
        atomic_json(out, doc_out)
        return doc_out

    say(f"{sha[:12]} → {out}{' (partial)' if partial else ''}; gates: {' '.join(sel)}")
    rc = 1
    try:
        wt = worktree(repo, sha, a.fresh)
        head, dirty = tree_state(wt, sha)
        doc["worktree"] = wt
        doc["tree_clean"] = head == sha and not dirty
        doc["tree_start"] = {"head": head, "dirty": dirty[:50]}
        write()
        if not doc["tree_clean"]:
            say(f"the throwaway worktree is not a clean {sha[:12]}: {dirty[:5]} — stopping")
            return 1
        ctx = {"wt": wt, "home": HOME, "sha": sha, "logs": logs, "tmproot": tmproot, "tmp": os.path.join(tmproot, "build-tmp"),
               "old_brain": ""}
        os.makedirs(ctx["tmp"], exist_ok=True)
        doc["caches"] = reflink_caches(wt, sha)
        # builds: the three every rig needs, then what the selected gates ask for
        for name in ("brain", "net", "app"):
            doc["builds"][name] = build(name, reg["builds"][name], wt, logs, ctx)
            write()
            if STOP["flag"]:
                raise KeyboardInterrupt
        needs = set()
        for gid in sel:
            g = byid[gid]
            if gid in skip:
                continue
            use_v09 = a.v09 and "v09" in g
            if use_v09 or not g.get("pending"):
                needs |= set(g.get("needs", []))
        if "net-root" in needs:
            doc["builds"]["net-root"] = build("net-root", reg["builds"]["net-root"], wt, logs, ctx)
        if "old-brain" in needs:
            ob = build_old_brain(reg["builds"]["old-brain"], repo, logs, ctx)
            doc["builds"]["old-brain"] = ob
            if ob.get("ok"):
                ctx["old_brain"] = ob["path"]
        write()

        for gid in sel:
            if STOP["flag"]:
                break
            g = byid[gid]
            use_v09 = a.v09 and "v09" in g
            steps = g["v09"] if use_v09 else g.get("steps", [])
            rec = {"id": gid, "title": g["title"], "status": g["status"], "variant": "v09" if use_v09 else "v1",
                   "cmd": " ; ".join(s["cmd"] for s in steps) if steps else reg["builds"][g["build"]]["cmd"],
                   "timing": bool(g.get("timing")), "runs": [], "result": None, "reason": ""}
            t0 = time.time()
            if gid in skip:
                rec.update(result="SKIPPED", reason="--skip on the command line (this file can never be complete)")
            elif not use_v09 and g.get("pending"):
                rec.update(result="MISSING", reason=g["pending"])
            elif g.get("build"):
                b = doc["builds"][g["build"]]
                first = {"n": 1, "start": b["start"], "end": b["end"], "exit": b["exit"], "counts": {"pass": 0, "fail": 0, "skip": 0},
                         "log": b["log"], "steps": [], "result": "GREEN" if b["ok"] else "RED", "from_build": g["build"]}
                spec = reg["builds"][g["build"]]
                bsteps = [{"cmd": spec["cmd"], "cwd": spec["cwd"], "timeout": spec.get("timeout", 3600)}]
                res, runs, why = run_gate(g, bsteps, ctx, reg["parsers"], first_run=first)
                for f in spec.get("restore", []):
                    git("checkout", "-q", "--", f, cwd=wt, check=False)
                rec.update(result=res, runs=runs, reason=why)
            else:
                needed = ["brain", "net", "app"] if not gid.startswith("G0.") else []
                needed += list(g.get("needs", []))
                broken = [n for n in needed if not (doc["builds"].get(n) or {}).get("ok")]
                if broken:
                    rec.update(result="ERROR", reason=f"build failed or absent: {', '.join(broken)}")
                else:
                    locks = []
                    try:
                        for l in g.get("locks", []):
                            locks.append(flock(os.path.join(BASE, f"{l}.lock"), what=f"the {l} lock"))
                        res, runs, why = run_gate(g, steps, ctx, reg["parsers"])
                    finally:
                        for fd in locks:
                            if fd is not None:
                                os.close(fd)
                    rec.update(result=res, runs=runs, reason=why)
            rec["seconds"] = round(time.time() - t0)
            doc["gates"].append(rec)
            say(f"{gid} → {rec['result']}{'  — ' + rec['reason'] if rec['reason'] else ''}")
            write()
        head, dirty = tree_state(wt, sha)
        modified = [l for l in dirty if not l.startswith("??")]
        doc["tree_end"] = {"head": head, "modified": modified[:50], "untracked": [l[3:] for l in dirty if l.startswith("??")][:50]}
        doc["tree_clean"] = doc["tree_clean"] and head == sha and not modified
        ids = {g["id"] for g in doc["gates"]}
        doc["complete"] = (not partial and not STOP["flag"] and all(g["id"] in ids for g in gates)
                           and all(g["result"] not in ("MISSING", "SKIPPED") for g in doc["gates"]))
        doc["green"] = doc["complete"] and doc["tree_clean"] and all(g["result"] == "GREEN" for g in doc["gates"])
        rc = 0 if (doc["green"] or (partial and doc["gates"] and all(g["result"] == "GREEN" for g in doc["gates"]))) else 1
    except KeyboardInterrupt:
        STOP["flag"] = True
    except Exception as e:  # recorded, never a pass
        doc["error"] = f"{type(e).__name__}: {e}"
        say(f"runner error: {doc['error']}")
    finally:
        if STOP["flag"]:
            doc["interrupted"] = True
            doc["complete"] = doc["green"] = False
        doc["ended"] = now()
        final = write()
        os.close(lock)
    print()
    show(out)
    print(f"gate file: {out}\nlogs: {logs}")
    _ = final
    return rc


if __name__ == "__main__":
    sys.exit(main())
