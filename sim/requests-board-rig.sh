#!/usr/bin/env bash
# requests-board-rig.sh up|down — a scratch brain on a SANITIZED COPY of the live sessions, for the
# requests board (/asks). Nothing real can run in it: the unit has no home (ProtectHome=tmpfs), PATH is
# /usr/bin:/bin (no claude/agy/codex/opencode), no model upstream (a dead port), every copied session
# has its `harness` id dropped, engine "root", inbox marked delivered. Read-only on the live data.
#   RIG=~/.cache/requests-board-pwa/rig  PORT=19700  UNIT=rootsim-rb-brain
set -euo pipefail
RIG=${RIG:-$HOME/.cache/requests-board-pwa/rig}; PORT=${PORT:-19700}; UNIT=${UNIT:-rootsim-rb-brain}
LIVE=${LIVE_DATA:-$HOME/.cache/root-sim/preview/data}
HERE=$(cd "$(dirname "$0")" && pwd)
systemctl --user stop "$UNIT" 2>/dev/null || true; systemctl --user reset-failed "$UNIT" 2>/dev/null || true
[ "${1:-up}" = down ] && exit 0
rm -rf "$RIG/data" "$RIG/work"; mkdir -p "$RIG/data" "$RIG/work" "$RIG/bin"
cp -a "$LIVE/session" "$RIG/data/"
cp -f "$HERE/../root/target/release/yggdrasil" "$RIG/bin/yggdrasil"
python3 -I - "$RIG/data/session" <<'PY'
import glob, json, sys
for f in glob.glob(sys.argv[1] + "/*.json"):
    d = json.load(open(f)); i = d["info"]
    i.pop("harness", None)
    if i.get("engine") not in (None, "root"): i["engine"] = "root"
    for e in d.get("inbox", []): e["delivered"] = True
    json.dump(d, open(f, "w"))
PY
systemd-run --user --unit="$UNIT" --collect -q -p ProtectHome=tmpfs -p "BindPaths=$RIG" \
  -p StandardOutput="append:$RIG/brain.log" -p StandardError="append:$RIG/brain.log" \
  --setenv=HOME="$RIG/work" --setenv=PATH=/usr/bin:/bin --setenv=YGG_DATA_DIR="$RIG/data" --setenv=YGG_PROJECT_DIR="$RIG/work" \
  --setenv=YGG_LISTEN="127.0.0.1:$PORT" --setenv=YGG_UPSTREAM_BASE_URL=http://127.0.0.1:1/v1 --setenv=YGG_UPSTREAM_API_KEY=x \
  --setenv=YGG_UPSTREAM_MODEL=none --setenv=YGG_ROOT_NAME=rig-board "$RIG/bin/yggdrasil"
for _ in $(seq 1 60); do curl -sf -m 1 "http://127.0.0.1:$PORT/session" >/dev/null && break; sleep 0.25; done
PID=$(systemctl --user show -p MainPID --value "$UNIT")
if ps --ppid "$PID" -o cmd= | grep -Eq 'claude|agy|codex|opencode'; then echo "REFUSING: a harness child is running" >&2; systemctl --user stop "$UNIT"; exit 1; fi
# a few landed asks (branch + commit), so the Done group has cards (ids found by their words)
python3 -I - "$PORT" <<'PY'
import json, sys, urllib.request as u
B = f"http://127.0.0.1:{sys.argv[1]}"
g = lambda p: json.load(u.urlopen(B + p))
asks, ses = g("/asks?limit=2000"), {s["title"]: s["id"] for s in g("/session")}
for words, br, c, t in [("artifact-copy-proposal.html its goos", "artifact-copy-ui", "b37fe433", None),
                        ("can. you delwgat to build it", "engine-fallback-smart", "c961a3d0", "Build smarter engine fallback"),
                        ("on session list make the refrwsh btn", "fix-refresh-key-icon", "a283a2ec", "Refresh key icon + width")]:
    m = [a for a in asks if words in a["text"]]
    if not m: continue
    body = {"branch": br, "commit": c}
    if t in ses: body["session"] = ses[t]
    u.urlopen(u.Request(f"{B}/asks/{m[0]['id']}", json.dumps(body).encode(), {"Content-Type": "application/json"})).read()
PY
echo "rig brain up on :$PORT (unit $UNIT, pid $PID)"
