#!/usr/bin/env bash
# real-brains.sh up|down — two real brains for e2e/files-reach.spec.ts: home (:4262) and lab
# (:4263), peers of each other, on the mock upstream (:4264). Plain processes (no units), their
# PIDs in $BASE/pids; `down` stops exactly those. Everything lives under $BASE (never /tmp).
#   BIN=<yggdrasil> (default: the shared p2 target's release build, copied so a rebuild never
#   swaps a running brain).  Then:
#   E2E_OC_URL=http://127.0.0.1:4262 E2E_LAB_ARTIFACTS=$BASE/lab/work/artifacts \
#     npx playwright test -c playwright.files.config.ts
set -euo pipefail
BASE=${BASE:-$HOME/.cache/p2-reach/app-tmp/real}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT_SRC=$(cd "$HERE/../../../root" && pwd)
MOCK=4264 HOME_P=4262 LAB_P=4263
case "${1:-up}" in
down)
  [ -f "$BASE/pids" ] && while read -r pid; do kill "$pid" 2>/dev/null || true; done <"$BASE/pids"
  rm -f "$BASE/pids"
  exit 0
  ;;
esac
[ -f "$BASE/pids" ] && { echo "already up ($BASE/pids) — run down first"; exit 1; }
rm -rf "$BASE/home" "$BASE/lab"
mkdir -p "$BASE/bin" "$BASE/home/work/artifacts" "$BASE/lab/work/artifacts" "$BASE/home/data" "$BASE/lab/data"
cp -f "${BIN:-$HOME/.cache/p2-reach/target/release/yggdrasil}" "$BASE/bin/yggdrasil"
echo '{"agent":{}}' >"$BASE/agents.json"
export TMPDIR=$BASE
python3 "$ROOT_SRC/mock/mock_upstream.py" "$MOCK" >"$BASE/mock.log" 2>&1 &
echo $! >>"$BASE/pids"
start() { # name port other other_port
  env YGG_UPSTREAM_BASE_URL="http://127.0.0.1:$MOCK" YGG_UPSTREAM_STYLE=anthropic YGG_UPSTREAM_API_KEY=mock \
    YGG_UPSTREAM_MODEL=mock YGG_WAKE_DEBOUNCE_MS=400 YGG_PEER_TOKEN=e2e-token YGG_FILE_MAX_MB="${YGG_FILE_MAX_MB:-5}" \
    YGG_LISTEN="127.0.0.1:$2" YGG_DATA_DIR="$BASE/$1/data" YGG_PROJECT_DIR="$BASE/$1/work" YGG_PROFILES="$BASE/agents.json" \
    YGG_ROOT_NAME="$1" YGG_PEERS="$3=http://127.0.0.1:$4" CLAUDE_CONFIG_DIR="$BASE/$1/claude" \
    "$BASE/bin/yggdrasil" >"$BASE/$1.log" 2>&1 &
  echo $! >>"$BASE/pids"
}
start home "$HOME_P" lab "$LAB_P"
start lab "$LAB_P" home "$HOME_P"
for p in "$HOME_P" "$LAB_P"; do
  for _ in $(seq 1 40); do curl -sf -m 1 "http://127.0.0.1:$p/root" >/dev/null && break; sleep 0.25; done
  curl -sf -m 1 "http://127.0.0.1:$p/root" >/dev/null || { echo "brain on :$p did not come up"; tail -20 "$BASE"/*.log; exit 1; }
done
echo "home :$HOME_P, lab :$LAB_P (mock :$MOCK) — lab artifacts: $BASE/lab/work/artifacts"
