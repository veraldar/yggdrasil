#!/usr/bin/env python3
"""stack.py — a self-contained voice stack for the voice persona sim, on free loopback ports.

Per run: ONE LiveKit server (docker, host network, its own keys, loopback only) and, per root,
a sandboxed brain (../brain-up.sh, real upstream), the app (`next start` of this worktree's
branch build, BIFROST_AUTH=tailnet — the tailnet-mode voice path) and the voice agent
(branch/voice/agent.py, its own AGENT_NAME, STT on the speech server the preview uses, its TTS
off: the app speaks). Rooms are named by session id (VOICE_ROOM_BY_ID=1), so several roots
share the LiveKit without colliding. Nothing here touches the live or preview units.

    stack.py up NAME [--roots home,lab] [--port 4170]   # prints the stack as JSON
    stack.py down NAME

Ports for base P (default 4170), root i: brain P+i · app P+4000+i · agent http P+14000+i ·
LiveKit P+3800 (rtc tcp +1, udp P+47930..+47990).
Env: VSIM_SPEACHES_URL (agent STT + app TTS; default: the preview agent's SPEACHES_URL),
VSIM_STT_MODEL, VSIM_BRAIN_BIN, VSIM_APP_DIR (a built branch/), VSIM_VOICE_DIR (the agent's dir, with
its .venv — an A/B against a snapshot), SIM_* passed to brain-up.sh.
"""
import argparse, json, os, re, secrets, shutil, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.dirname(HERE)
REPO = os.path.dirname(SIM)
CACHE = os.path.expanduser("~/.cache/voice-sim")
NODE = shutil.which("node") or "node"


def log(*a):
    print(time.strftime("%H:%M:%S"), "[stack]", *a, file=sys.stderr, flush=True)


def env_file(path):
    out = {}
    try:
        for line in open(os.path.expanduser(path)):
            m = re.match(r"\s*([A-Z_][A-Z0-9_]*)=(.*)$", line)
            if m:
                out[m.group(1)] = m.group(2).split(" #")[0].strip().strip('"')
    except OSError:
        pass
    return out


def speaches_url():
    return os.environ.get("VSIM_SPEACHES_URL") or env_file("~/.cache/root-sim/preview-agent.env").get("SPEACHES_URL") \
        or env_file("~/.cache/root-sim/preview.env").get("SPEACHES_URL") or "http://127.0.0.1:8000/v1"


def stt_model():
    return os.environ.get("VSIM_STT_MODEL") or env_file("~/.cache/root-sim/preview-agent.env").get("STT_MODEL") \
        or "Systran/faster-whisper-small"


def brain_bin():
    for b in (os.environ.get("VSIM_BRAIN_BIN"), os.path.join(REPO, "root/target/release/yggdrasil"),
              os.path.expanduser("~/Work/tree-release/root/target/release/yggdrasil")):
        if b and os.path.isfile(b):
            return b
    sys.exit("no yggdrasil binary: build root/ or set VSIM_BRAIN_BIN")


def app_dir():
    d = os.environ.get("VSIM_APP_DIR") or os.path.join(REPO, "branch")
    if not os.path.isfile(os.path.join(d, ".next", "BUILD_ID")):
        sys.exit(f"no app build in {d}: cd branch && npm run build (or VSIM_APP_DIR=<a built branch/>)")
    return d


def wait_http(url, secs=60, ok=(200,)):
    end = time.time() + secs
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status in ok:
                    return True
        except urllib.error.HTTPError as e:
            if e.code in ok:
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
    return False


def unit(name, cmd, cwd, env, logf):
    """a transient user unit (stopped by `down`, never the live/preview ones)"""
    subprocess.run(["systemctl", "--user", "stop", name], capture_output=True)
    subprocess.run(["systemctl", "--user", "reset-failed", name], capture_output=True)
    props = ["-p", "TimeoutStopSec=8", "-p", f"WorkingDirectory={cwd}", "-p", f"StandardOutput=append:{logf}", "-p", f"StandardError=append:{logf}"]
    envs = [f"--setenv={k}={v}" for k, v in env.items()]
    r = subprocess.run(["systemd-run", "--user", f"--unit={name}", "--collect", "-q", *props, *envs, *cmd], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"{name}: {r.stderr.strip()}")


def up(name, roots, port=4170, brain_env=None, peers_net=True, auth="tailnet"):
    """roots: [{"name","note","seed":{path: content},"env":{...}}] — the first is home."""
    st_dir = os.path.join(CACHE, name)
    os.makedirs(st_dir, exist_ok=True)
    lk_port = port + 3800
    key, secret = "vsim", secrets.token_hex(24)
    lk_cfg = (f"port: {lk_port}\nbind_addresses: [127.0.0.1]\n"
              f"rtc:\n  tcp_port: {lk_port + 1}\n  port_range_start: {port + 47930}\n  port_range_end: {port + 47990}\n"
              f"  use_external_ip: false\n  node_ip: 127.0.0.1\n  enable_loopback_candidate: true\n"
              f"keys:\n  {key}: {secret}\nlogging:\n  level: info\n")
    lk_name = f"vsim-lk-{name}"
    subprocess.run(["docker", "rm", "-f", lk_name], capture_output=True)
    r = subprocess.run(["docker", "run", "-d", "--name", lk_name, "--network", "host", "livekit/livekit-server:latest",
                        "--config-body", lk_cfg], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"livekit: {r.stderr.strip()}")
    if not wait_http(f"http://127.0.0.1:{lk_port}/", 30):
        raise RuntimeError("livekit did not come up")
    log(f"livekit {lk_name} on :{lk_port}")
    upstream, stt = speaches_url(), stt_model()
    gate_port = port + 10
    unit(f"vsim-gate-{name}", [sys.executable, os.path.join(HERE, "speech_gate.py"), "--upstream", upstream, "--port", str(gate_port)],
         HERE, {"PATH": os.environ.get("PATH", "")}, os.path.join(st_dir, "gate.log"))
    spe = f"http://127.0.0.1:{gate_port}/v1"
    if not wait_http(spe.rsplit("/v1", 1)[0] + "/health", 20):
        raise RuntimeError(f"speech server unreachable through the gate ({upstream})")
    bbin, adir = brain_bin(), app_dir()
    vdir = os.environ.get("VSIM_VOICE_DIR") or os.path.join(REPO, "branch", "voice")
    vpy = os.path.join(vdir, ".venv", "bin", "python")
    if not os.path.isfile(vpy):
        subprocess.run(["uv", "sync"], cwd=vdir, check=True)
    out = {"name": name, "livekit": {"container": lk_name, "port": lk_port}, "roots": [],
           "speech": {"upstream": upstream, "gate": spe, "box_stt": stt, "box_tts_en": os.environ.get("TTS_MODEL_EN", "mlx-community/Kokoro-82M-bf16")}}
    sims = sims_of(name, roots)
    token = secrets.token_hex(12)
    for i, r in enumerate(roots):
        sim = sims[i]
        rdir = os.path.expanduser(f"~/.cache/root-sim/{sim}")
        for path, content in (r.get("seed") or {}).items():
            fp = os.path.join(rdir, "work", path)
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            open(fp, "w").write(content)
        bport, aport, hport = port + i, port + 4000 + i, port + 14000 + i
        env = dict(os.environ, **{k: str(v) for k, v in (brain_env or {}).items()}, **(r.get("env") or {}))
        env.setdefault("SIM_PROFILES", os.path.join(SIM, "profiles.sim.json"))
        if len(roots) > 1 and peers_net:
            env.update(YGG_ROOT_NAME=r["name"], YGG_PEER_TOKEN=token, YGG_ROOT_NOTE=r.get("note", ""),
                       YGG_PEERS=",".join(f"{o['name']}=http://127.0.0.1:{port + j}" for j, o in enumerate(roots) if o is not r))
        upb = subprocess.run([os.path.join(SIM, "brain-up.sh"), sim, str(bport), bbin], env=env, capture_output=True, text=True)
        if upb.returncode:
            raise RuntimeError(f"brain {sim}: {upb.stdout} {upb.stderr}")
        log(upb.stdout.strip())
        agent = f"vsim-{name}-{r['name']}"
        app_env = {"NODE_ENV": "production", "PORT": str(aport), "HOST": "127.0.0.1", "BIFROST_AUTH": "tailnet",
                   "OPENCODE_URL": f"http://127.0.0.1:{bport}", "LIVEKIT_URL": f"ws://127.0.0.1:{lk_port}",
                   "LIVEKIT_API_URL": f"http://127.0.0.1:{lk_port}", "LIVEKIT_API_KEY": key, "LIVEKIT_API_SECRET": secret,
                   "AGENT_NAME": agent, "VOICE_ROOM_BY_ID": "1", "SPEACHES_URL": spe,
                   "ARTIFACTS_DIR": os.path.join(rdir, "work", "artifacts"), "YGG_PROFILES": env["SIM_PROFILES"],
                   "PATH": os.environ.get("PATH", "")}
        if auth == "devices":
            # devices mode (pairing): served by server.mjs (it stamps the peer address), its own registry
            app_env.update(BIFROST_AUTH="devices", BIFROST_DEVICES_FILE=os.path.join(st_dir, f"devices-{r['name']}.json"),
                           BIFROST_MAIN_TITLE="[MAIN]")
            cmd = [NODE, "server.mjs"]
        else:
            cmd = [NODE, "node_modules/next/dist/bin/next", "start", "-p", str(aport), "-H", "127.0.0.1"]
        unit(f"vsim-app-{name}-{r['name']}", cmd, adir, app_env, os.path.join(st_dir, f"app-{r['name']}.log"))
        ag_env = {"OPENCODE_URL": f"http://127.0.0.1:{bport}", "AGENT_NAME": agent, "LIVEKIT_URL": f"ws://127.0.0.1:{lk_port}",
                  "LIVEKIT_API_KEY": key, "LIVEKIT_API_SECRET": secret, "SPEACHES_URL": spe, "STT_MODEL": stt,
                  "AGENT_TTS": "off", "AGENT_HTTP_PORT": str(hport),
                  # one room per worker here: a loaded box (CPU TTS/STT, Chromium, other builds) must never
                  # mark it 'at full capacity' — that left a room agent-less in the full run
                  "AGENT_LOAD_THRESHOLD": "1.5", "AGENT_STREAM_TTS": "1",
                  "VOICE_MODEL": "yggdrasil/" + os.environ.get("SIM_MODEL", "glm-5.3-flash"), "PATH": os.environ.get("PATH", "")}
        alog = os.path.join(st_dir, f"agent-{r['name']}.log")
        unit(f"vsim-agent-{name}-{r['name']}", [vpy, "agent.py", "start"], vdir, ag_env, alog)
        out["roots"].append({"name": r["name"], "sim": sim, "brain": f"http://127.0.0.1:{bport}", "app": f"http://127.0.0.1:{aport}",
                             "agent": agent, "agent_log": alog, "work": os.path.join(rdir, "work")})
    for r in out["roots"]:
        if not wait_http(r["app"] + "/api/token", 90, ok=(200, 503)):
            raise RuntimeError(f"app for {r['name']} did not come up")
        end = time.time() + 60
        while time.time() < end and "registered worker" not in open(r["agent_log"], errors="replace").read():
            time.sleep(1)
        log(f"root {r['name']}: app {r['app']} · brain {r['brain']} · agent {r['agent']}")
    warm(out["roots"][0]["app"], spe, stt)
    json.dump(out, open(os.path.join(st_dir, "stack.json"), "w"), indent=1)
    return out


def warm(app, spe, stt):
    """the box's speech models answer before the first turn (a cold TTS model ate the first
    replies of the probe: 'no first audio after 20000ms')"""
    t = time.time()
    for _ in range(4):
        try:
            r = urllib.request.Request(app + "/api/tts/stream", data=json.dumps({"text": "Ready.", "lang": "en"}).encode(),
                                       headers={"content-type": "application/json"})
            with urllib.request.urlopen(r, timeout=120) as resp:
                if len(resp.read()) > 1000:
                    break
        except Exception as e:  # noqa: BLE001
            log(f"tts warm-up: {e}")
            time.sleep(5)
    log(f"box TTS warm in {time.time() - t:.1f}s")
    sys.path.insert(0, HERE)
    import speech  # noqa: E402
    w = os.path.join(CACHE, "warm.wav")
    try:
        speech.tts("Ready when you are.", w)
        t = time.time()
        b = "vsimwarm"
        body = (f"--{b}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{stt}\r\n"
                f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"w.wav\"\r\nContent-Type: audio/wav\r\n\r\n").encode() \
            + open(w, "rb").read() + f"\r\n--{b}--\r\n".encode()
        r = urllib.request.Request(spe + "/audio/transcriptions", data=body, headers={"content-type": f"multipart/form-data; boundary={b}"})
        with urllib.request.urlopen(r, timeout=120) as resp:
            log(f"box STT warm in {time.time() - t:.1f}s: {resp.read()[:80]!r}")
    except Exception as e:  # noqa: BLE001
        log(f"stt warm-up: {e}")


def sims_of(name, roots):
    return [name] + [f"{name}-{r['name']}" for r in roots[1:]]


def wipe(name, roots):
    """a fresh start: any earlier state of these roots (brains stopped, dirs gone)"""
    for sim in sims_of(name, roots):
        d = os.path.expanduser(f"~/.cache/root-sim/{sim}")
        if os.path.isdir(d):
            subprocess.run([os.path.join(SIM, "brain-up.sh"), sim, "down"], capture_output=True)
            shutil.rmtree(d, ignore_errors=True)


def down(name, keep_state=False):
    st = os.path.join(CACHE, name, "stack.json")
    roots = []
    try:
        roots = json.load(open(st))["roots"]
    except (OSError, ValueError):
        pass
    for r in roots:
        subprocess.run(["systemctl", "--user", "stop", f"vsim-agent-{name}-{r['name']}", f"vsim-app-{name}-{r['name']}"], capture_output=True)
        subprocess.run([os.path.join(SIM, "brain-up.sh"), r["sim"], "down"], capture_output=True)
    subprocess.run(["docker", "rm", "-f", f"vsim-lk-{name}"], capture_output=True)
    subprocess.run(["systemctl", "--user", "stop", f"vsim-gate-{name}"], capture_output=True)
    if not keep_state:
        for r in roots:
            shutil.rmtree(os.path.expanduser(f"~/.cache/root-sim/{r['sim']}"), ignore_errors=True)
    log(f"stack {name} down")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("op", choices=["up", "down"])
    ap.add_argument("name")
    ap.add_argument("--roots", default="home")
    ap.add_argument("--port", type=int, default=4170)
    ap.add_argument("--keep-state", action="store_true")
    a = ap.parse_args()
    if a.op == "up":
        print(json.dumps(up(a.name, [{"name": n} for n in a.roots.split(",")], a.port), indent=1))
    else:
        down(a.name, a.keep_state)
