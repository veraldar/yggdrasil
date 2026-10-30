#!/usr/bin/env bash
# boot-arm.sh — boot one coord-sim scratch root: the SAME release binary as the live
# root, own data/proj dirs on :414x, never touching :4096/:4100/:8090. Pattern from
# lab/tool-policy/boot.sh (proven 10-28). Usage: boot-arm.sh <tag> <port> [model]
#   model: default glm-5.3-flash; the roots' DEFAULT model is what a plain session gets.
set -euo pipefail
TAG="${1:?tag}"; PORT="${2:?port}"; MODEL="${3:-glm-5.3-flash}"
LAB="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${WORLD_BIN:-$HOME/Work/bifrost/lab/yggdrasil/target/release/yggdrasil}"
DIR="/tmp/coordsim/$TAG"
mkdir -p "$DIR/data/session" "$DIR/proj"
PIDF="/tmp/coordsim/$TAG.pid"
[ -x "$BIN" ] || { echo "boot-arm: no binary at $BIN" >&2; exit 1; }
OLDPID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "${OLDPID:-}" ]; then kill "$OLDPID" 2>/dev/null || true; sleep 0.5; fi
UP="https://api.z.ai/api/anthropic"; STYLE=anthropic
KEY="$(cat "$HOME/Work/bifrost/lab/tool-policy/upstream.key")"
PROV="${YGG_PROVIDERS_FILE:-$LAB/arms/providers.json}"
env YGG_UPSTREAM_BASE_URL="$UP" \
    YGG_UPSTREAM_STYLE="$STYLE" \
    YGG_UPSTREAM_API_KEY="$KEY" \
    YGG_UPSTREAM_MODEL="$MODEL" \
    YGG_PROVIDERS="$PROV" \
    YGG_PROFILES="$LAB/arms/profiles.json" \
    YGG_LISTEN="127.0.0.1:$PORT" \
    YGG_MAX_TOKENS=16384 \
    YGG_DATA_DIR="$DIR/data" \
    YGG_PROJECT_DIR="$DIR/proj" \
    YGG_ROLLUP_TOKENS="${YGG_ROLLUP_TOKENS:-6000}" \
    YGG_MAX_STEPS="${YGG_MAX_STEPS:-24}" \
    ${YGG_CONTEXT:+YGG_CONTEXT_FILES="$DIR/proj/$YGG_CONTEXT"} \
    "$BIN" >> "/tmp/coordsim/$TAG.log" 2>&1 &
echo $! > "$PIDF"
for i in $(seq 1 60); do
  kill -0 "$(cat "$PIDF")" 2>/dev/null || { echo "arm $TAG died on boot"; tail -5 "/tmp/coordsim/$TAG.log"; exit 1; }
  if curl -s -m 2 "http://127.0.0.1:$PORT/session/status" >/dev/null 2>&1; then
    echo "arm $TAG up on :$PORT (pid $(cat "$PIDF"), default model $MODEL)"; exit 0
  fi
  sleep 0.25
done
echo "arm $TAG: health check never answered"; tail -5 "/tmp/coordsim/$TAG.log"; exit 1
