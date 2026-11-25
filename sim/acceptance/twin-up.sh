#!/usr/bin/env bash
# twin-up.sh <run> [bin] — the acceptance twin (plan §5.1): a full copy of the real system from
# the CANDIDATE build, beside the live one, never touching it.
#   brain :4250 (sim/brain-up.sh acc-<run>, real upstream, SIM_HARNESS=1 unless TWIN_HARNESS=0) · librarian :4251
#   app   :8250 (next start, the worktree build, OPENCODE_URL=:4250, BIFROST_AUTH=tailnet)
#   tap   :4252 (optional, TWIN_TAP=1: sim/voice/upstream_tap.py → <twin>/tap.jsonl)
# TWIN_AUTH=trunk (v1, spec §9 G2.4): the app runs `node server.mjs` with BIFROST_AUTH=trunk,
#   BIFROST_TRUST_PROXY=1, BIFROST_TRUNK_STATE=<twin>/trunk/trunk-state.json, behind a stand-in trunk
#   front on :$TWIN_FRONT_PORT (default 19050, sim/acceptance/trunk-seed.mjs: test keypair, C5 state,
#   C3 tokens; every cookie-less request is signed in as the twin's device, TWIN_SIGN_IN=cookie turns
#   that off). Drive the app through the front: PW_BASE_URL=http://127.0.0.1:19050. Default
#   TWIN_AUTH=tailnet: exactly the twin as before (next start, BIFROST_AUTH=tailnet, no front).
# TWIN_ARTIFACTS_DIR: the app's artifacts dir (default <twin>/artifacts); the worktree's artifacts/ for
#   specs that drop files there (artifacts, chat-files).
# Everything lives in ~/.cache/root-sim/acc-<run>/.   twin-up.sh <run> down  — stop the units.
# The runner deletes the twin's Claude Code conversations by recorded id (teardown): they land in
# ~/.claude/projects/<mangled twin cwd>/, a folder of their own.
set -euo pipefail
RUN=${1:?run name}; DO=${2:-}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
T="$HOME/.cache/root-sim/acc-$RUN"
BR="http://127.0.0.1:4250"
LIBP=4251 TAPP=4252
AUTH=${TWIN_AUTH:-tailnet} FRONT=${TWIN_FRONT_PORT:-19050}
case "$AUTH" in tailnet|trunk) ;; *) echo "TWIN_AUTH=$AUTH: tailnet or trunk"; exit 1 ;; esac
PORTS="4250 4251 4252 8250"; [ "$AUTH" = trunk ] && PORTS="$PORTS $FRONT"
if [ "$DO" != down ]; then
  for p in $PORTS; do
    if curl -sf -m 1 "http://127.0.0.1:$p/" >/dev/null 2>&1 || curl -sf -m 1 "http://127.0.0.1:$p/session" >/dev/null 2>&1; then
      echo "port $p is taken — the twin would collide with something live"; exit 1
    fi
  done
fi
if [ "$DO" = down ]; then
  systemctl --user stop rootsim-acc-$RUN-librarian rootsim-acc-$RUN-tap acc-$RUN-app acc-$RUN-trunk rootsim-acc-$RUN rootsim-acc-$RUN-secrets 2>/dev/null || true
  for u in rootsim-acc-$RUN-librarian rootsim-acc-$RUN-tap acc-$RUN-app acc-$RUN-trunk rootsim-acc-$RUN rootsim-acc-$RUN-secrets; do systemctl --user reset-failed "$u" 2>/dev/null || true; done
  echo "twin $RUN down"; exit 0
fi
BIN=${DO:-$ROOT/root/target/release/yggdrasil}
[ -x "$BIN" ] || { echo "no brain binary: $BIN (build it: (cd root && cargo build --release))"; exit 1; }
[ -f "$ROOT/branch/.next/BUILD_ID" ] || { echo "no app build: $ROOT/branch/.next (npm run build in the worktree first)"; exit 1; }
ART=${TWIN_ARTIFACTS_DIR:-$T/artifacts}
mkdir -p "$T/artifacts" "$T/report" "$ART"

# the tap (optional): every upstream request body dumped, for the byte-equality scenarios
if [ "${TWIN_TAP:-0}" = 1 ]; then
  set -a; . "$HOME/.config/yggdrasil/yggdrasil.env"; set +a
  UP=$(python3 -c 'import os;print(os.environ["YGG_UPSTREAM_BASE_URL"].rstrip("/"))')
  mkdir -p "$T/tap"
  systemd-run --user --unit rootsim-acc-$RUN-tap --collect -q \
    -p StandardOutput=append:"$T/tap.log" -p StandardError=append:"$T/tap.log" \
    python3 "$ROOT/sim/voice/upstream_tap.py" --upstream "$UP" --port "$TAPP" \
      --log "$T/tap.jsonl" --bodies "$T/tap/bodies" >/dev/null
  for _ in $(seq 1 40); do curl -sf -m 1 "http://127.0.0.1:$TAPP/" -X POST >/dev/null 2>&1 && break; sleep 0.25; done
  export SIM_UPSTREAM_BASE_URL="http://127.0.0.1:$TAPP"
fi

# 1. the brain: brain-up.sh's sandboxed scratch brain (real upstream key via SIM_UPSTREAM_BASE_URL),
#    harnesses live (SIM_HARNESS=1), the librarian wired as an extension.
#    TWIN_HARNESS=0: no harness binaries or logins in the sandbox — a twin seeded with a copy of the
#    live sessions can never resume one of the owner's real Claude Code / Antigravity conversations.
SIM_HARNESS=${TWIN_HARNESS:-1} SIM_EXTENSIONS="librarian=http://127.0.0.1:$LIBP" \
  bash "$ROOT/sim/brain-up.sh" "acc-$RUN" 4250 "$BIN"

# 2. the librarian: its own DB beside the twin's brain
systemctl --user stop rootsim-acc-$RUN-librarian 2>/dev/null || true; systemctl --user reset-failed rootsim-acc-$RUN-librarian 2>/dev/null || true
systemd-run --user --unit rootsim-acc-$RUN-librarian --collect -q \
  -p StandardOutput=append:"$T/librarian.log" -p StandardError=append:"$T/librarian.log" \
  python3 "$ROOT/root/extensions/librarian/librarian.py" --root "$BR" --port "$LIBP" \
    --db "$T/librarian.db" --artifacts "$ART" --poll 5 >/dev/null

# 3. the app: the worktree's build — tailnet mode (the twin is loopback-only), or trunk mode (v1)
systemctl --user stop acc-$RUN-app acc-$RUN-trunk 2>/dev/null || true
systemctl --user reset-failed acc-$RUN-app acc-$RUN-trunk 2>/dev/null || true
NODE=$(command -v node)
if [ "$AUTH" = tailnet ]; then
systemd-run --user --unit acc-$RUN-app --collect -q --working-directory="$ROOT/branch" \
  -E NODE_ENV=production -E PORT=8250 -E HOST=127.0.0.1 -E BIFROST_AUTH=tailnet \
  -E OPENCODE_URL="$BR" -E ARTIFACTS_DIR="$ART" -E BIFROST_MAIN_TITLE='[MAIN]' \
  -p StandardOutput=append:"$T/app.log" -p StandardError=append:"$T/app.log" \
  "$NODE" node_modules/next/dist/bin/next start -p 8250 -H 127.0.0.1 >/dev/null
for _ in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:8250/ >/dev/null && break; sleep 0.5; done
else
  # the stand-in trunk's key + trunk-state.json (C5), then the app as a v1 root behind it. server.mjs, not
  # next start: plain next start stamps no peer and fails closed under any device mode (B30).
  mkdir -p "$T/trunk"; chmod 700 "$T/trunk"
  "$NODE" --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$ROOT/sim/acceptance/trunk-seed.mjs" init "$T/trunk" --root-name "acc-$RUN" --trunk-url "http://127.0.0.1:$FRONT"
  systemd-run --user --unit acc-$RUN-app --collect -q --working-directory="$ROOT/branch" \
    -E NODE_ENV=production -E PORT=8250 -E HOST=127.0.0.1 -E BIFROST_AUTH=trunk -E BIFROST_TRUST_PROXY=1 \
    -E BIFROST_TRUNK_STATE="$T/trunk/trunk-state.json" -E BIFROST_TRUNK_URL="http://127.0.0.1:$FRONT" \
    -E BIFROST_OBS_DIR="$T/obs" \
    -E OPENCODE_URL="$BR" -E ARTIFACTS_DIR="$ART" -E BIFROST_MAIN_TITLE='[MAIN]' \
    -p StandardOutput=append:"$T/app.log" -p StandardError=append:"$T/app.log" \
    "$NODE" server.mjs >/dev/null
  systemd-run --user --unit acc-$RUN-trunk --collect -q --working-directory="$ROOT" \
    -p StandardOutput=append:"$T/trunk.log" -p StandardError=append:"$T/trunk.log" \
    "$NODE" --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$ROOT/sim/acceptance/trunk-seed.mjs" front "$T/trunk" --port "$FRONT" --app http://127.0.0.1:8250 \
      --client-ip "${TWIN_CLIENT_IP:-203.0.113.7}" --sign-in "${TWIN_SIGN_IN:-auto}" >/dev/null
  # ready = the app serves the console (loopback, nothing presented) and the front relays a signed-in page
  for _ in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:8250/ >/dev/null && break; sleep 0.5; done
  for _ in $(seq 1 40); do curl -sf -m 2 -o /dev/null "http://127.0.0.1:$FRONT/" && break; sleep 0.25; done
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'x-trunk-seed-anon: 1' "http://127.0.0.1:$FRONT/")
  [ "$code" = 302 ] || { echo "trunk mode: a stranger got $code from the app, not 302 /login"; exit 1; }
fi

# the door: MAIN exists before the specs run (the app's own rule, once per twin)
curl -sf -m 20 -X POST http://127.0.0.1:8250/api/onboard -H 'content-type: application/json' \
  -d '{"step":"main"}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("twin MAIN:", d.get("id"), d.get("slug"), "(created)" if d.get("created") else "(existing)")'
if [ "$AUTH" = trunk ]; then
  echo "twin $RUN up (trunk): brain :4250 · librarian :$LIBP · app :8250 (BIFROST_AUTH=trunk) · trunk front :$FRONT (drive this) · state $T"
else
echo "twin $RUN up: brain :4250 · librarian :$LIBP · app :8250 · state $T"
fi
[ "${TWIN_TAP:-0}" = 1 ] && echo "tap: :$TAPP → $T/tap.jsonl (+$T/tap/bodies/)"
exit 0  # (the line above is false without a tap: the twin is up all the same)
