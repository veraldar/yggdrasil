#!/usr/bin/env bash
# setup.sh — what sim/trunk-rtc-e2e.sh needs besides the builds, made once into a cache directory
# (TRUNK_RTC_CACHE, default ~/.cache/trunk-rtc). Re-running skips what is there.
#   livekit-server   the release install.sh pins (LIVEKIT_VERSION), sha256-checked like install.sh
#   voice/           edge/voice_server.py + its venv + models (what install.sh installs as bifrost-voice)
#   agent-venv/      branch/voice's locked deps (uv sync --frozen) + the agent's model files
# Network: github.com (livekit + sherpa-onnx models), pypi.org, huggingface.co. Nothing is started.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CACHE=${TRUNK_RTC_CACHE:-$HOME/.cache/trunk-rtc}
LIVEKIT_VERSION=${LIVEKIT_VERSION:-$(sed -n 's/^LIVEKIT_VERSION=\${LIVEKIT_VERSION:-\(.*\)}$/\1/p' "$ROOT/root/install/install.sh")}
mkdir -p "$CACHE"
say() { printf '  %-8s %s\n' "$1" "$2"; }

if [ -x "$CACHE/livekit-server" ] && "$CACHE/livekit-server" --version 2>/dev/null | grep -q " $LIVEKIT_VERSION\$"; then
  say livekit "have v$LIVEKIT_VERSION"
else
  case $(uname -m) in x86_64|amd64) A=amd64 ;; aarch64|arm64) A=arm64 ;; *) echo "no livekit build for $(uname -m)"; exit 2 ;; esac
  T=$(mktemp -d)
  REL=https://github.com/livekit/livekit/releases/download/v$LIVEKIT_VERSION
  TGZ=livekit_${LIVEKIT_VERSION}_linux_$A.tar.gz
  say livekit "download $REL/$TGZ"
  curl -fsSL --retry 3 -o "$T/$TGZ" "$REL/$TGZ" && curl -fsSL --retry 3 -o "$T/checksums.txt" "$REL/checksums.txt"
  (cd "$T" && grep " $TGZ\$" checksums.txt | sha256sum -c --quiet -)
  tar -xzf "$T/$TGZ" -C "$T" livekit-server
  install -m 755 "$T/livekit-server" "$CACHE/livekit-server"
  rm -rf "$T"
fi

V=$CACHE/voice
mkdir -p "$V"
for f in voice_server.py get_models.sh requirements.txt; do install -m 644 "$ROOT/edge/$f" "$V/$f"; done
chmod 755 "$V/get_models.sh"
[ -x "$V/venv/bin/python" ] || python3 -m venv "$V/venv"
if ! cmp -s "$V/requirements.txt" "$V/venv/.installed-requirements"; then
  say voice "pip install -r edge/requirements.txt"
  "$V/venv/bin/pip" install --disable-pip-version-check -q -r "$V/requirements.txt"
  cp "$V/requirements.txt" "$V/venv/.installed-requirements"
fi
"$V/get_models.sh" >/dev/null && say voice "models ready: $(ls "$V/models" | tr "\n" " ")"

AV=$CACHE/agent-venv
if ! cmp -s "$ROOT/branch/voice/uv.lock" "$AV/.installed-lock" 2>/dev/null; then
  say agent "uv sync --frozen (branch/voice) + agent.py download-files"
  (cd "$ROOT/branch/voice" && UV_PROJECT_ENVIRONMENT=$AV uv sync --frozen --no-dev -q &&
    "$AV/bin/python" agent.py download-files >/dev/null)
  cp "$ROOT/branch/voice/uv.lock" "$AV/.installed-lock"
else
  say agent "venv current"
fi
echo "ready: LIVEKIT_BIN=$CACHE/livekit-server VOICE_DIR=$V AGENT_VENV=$AV (sim/trunk-rtc-e2e.sh reads $CACHE by default)"
