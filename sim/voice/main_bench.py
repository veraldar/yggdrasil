#!/usr/bin/env python3
"""main_bench.py — where MAIN's time goes on a voice turn, repeatably (no phone, no persona).

A scratch brain (../brain-up.sh, the real upstream) behind upstream_tap.py; a fresh [MAIN]; the
same spoken turns (`modality: voice`, as the agent sends them) in rounds: a quick question, a
piece of work to start, a status question. Per turn: the brain's own LAT line (total, time to
first token, upstream calls, tool steps) and, per upstream call, the tap's line (input tokens,
cache hits, time to first text / tool call, output tokens).

    main_bench.py --bin root/target/release/yggdrasil --name bench-a [--rounds 3] [--port 4290]

Prints one row per turn and the medians; writes them as JSON next to the tap log.
"""
import argparse, json, os, re, statistics, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.dirname(HERE)
UPSTREAM = "https://api.z.ai/api/anthropic"

TURNS = [
    ("question", "Hey, quick one, what's the capital of Australia, and roughly how many people live there?"),
    ("dispatch", "Can you make me a tiny Python script in a folder called hello {n} that prints hello world, with one pytest test for it?"),
    ("status", "How is that hello script coming along?"),
]


def req(port, method, path, body=None, timeout=300):
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode() if body is not None else None,
                               method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def settle(port, main, secs=180):
    """MAIN idle and no wake pending: the next turn starts clean (children may still work)"""
    end = time.time() + secs
    quiet = 0
    while time.time() < end:
        busy = any(r["id"] == main and r.get("busy") for r in req(port, "GET", "/tree"))
        quiet = 0 if busy else quiet + 1
        if quiet >= 8:  # 8 s idle: a debounced wake would have started
            return
        time.sleep(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--port", type=int, default=4290)
    a = ap.parse_args()
    tap_port = a.port + 1
    root = os.path.expanduser(f"~/.cache/root-sim/{a.name}")
    subprocess.run([os.path.join(SIM, "brain-up.sh"), a.name, "down"], capture_output=True)
    subprocess.run(["rm", "-rf", root])
    os.makedirs(root)
    tlog = os.path.join(root, "tap.jsonl")
    tap = subprocess.Popen([sys.executable, os.path.join(HERE, "upstream_tap.py"), "--upstream", UPSTREAM, "--port", str(tap_port), "--log", tlog])
    try:
        env = dict(os.environ, SIM_UPSTREAM_BASE_URL=f"http://127.0.0.1:{tap_port}", SIM_DEBOUNCE="2000")
        up = subprocess.run([os.path.join(SIM, "brain-up.sh"), a.name, str(a.port), a.bin], env=env, capture_output=True, text=True)
        if up.returncode:
            sys.exit(f"brain: {up.stdout} {up.stderr}")
        mid = req(a.port, "POST", "/session", {"title": "[MAIN]"})["id"]
        rows = []
        for n in range(a.rounds):
            for kind, text in TURNS:
                settle(a.port, mid)
                t0 = time.time()
                m = req(a.port, "POST", f"/session/{mid}/message", {"parts": [{"type": "text", "text": text.format(n=n + 1)}], "modality": "voice"})
                wall = time.time() - t0
                reply = " ".join(p.get("text", "") for p in m.get("parts", []) if p.get("type") == "text").strip()
                lat = (m.get("info", {}).get("time") or {}).get("latency") or {}
                calls = [json.loads(x) for x in open(tlog)] if os.path.exists(tlog) else []
                mine = [c for c in calls if t0 - 0.5 <= c["t"] <= t0 + wall]
                rows.append({"round": n + 1, "kind": kind, "wall_s": round(wall, 2), "ttfb_ms": lat.get("ttfb_ms"), "upstream_calls": lat.get("upstream_calls"),
                             "tools": [p.get("tool") for p in m.get("parts", []) if p.get("type") == "tool"], "words": len(reply.split()),
                             "reply": reply[:160], "calls": [{k: c.get(k) for k in ("input_tokens", "cache_read", "head_ms", "first_think_ms", "first_text_ms",
                                                                                    "first_tool_ms", "total_ms", "output_tokens", "think", "system_chars", "tools_chars", "tool_names")} for c in mine]})
                r = rows[-1]
                print(f"{kind:9} r{n + 1} wall {r['wall_s']:5.1f}s ttfb {r['ttfb_ms']} calls {r['upstream_calls']} tools {r['tools']} words {r['words']} | "
                      + " ; ".join(f"in {c['input_tokens']} cache {c['cache_read']} text@{c['first_text_ms']} tool@{c['first_tool_ms']} end {c['total_ms']} out {c['output_tokens']}" for c in r["calls"]),
                      flush=True)
        print("\nmedians (s):")
        for kind, _ in TURNS:
            ws = [r["wall_s"] for r in rows if r["kind"] == kind]
            ins = [c["input_tokens"] or 0 for r in rows if r["kind"] == kind for c in r["calls"]]
            print(f"  {kind:9} wall p50 {statistics.median(ws):.2f}  (n={len(ws)}, upstream calls {sum(len(r['calls']) for r in rows if r['kind'] == kind)}, input tokens p50 {statistics.median(ins) if ins else '-'})")
        allw = [r["wall_s"] for r in rows]
        print(f"  all       wall p50 {statistics.median(allw):.2f}")
        json.dump(rows, open(os.path.join(root, "bench.json"), "w"), indent=1)
        print(os.path.join(root, "bench.json"))
    finally:
        subprocess.run([os.path.join(SIM, "brain-up.sh"), a.name, "down"], capture_output=True)
        tap.terminate()


if __name__ == "__main__":
    main()
