#!/usr/bin/env bash
# bootstrap.sh — go-chain Lane A: ONE-command root install on a fresh Linux box.
#
#   bash scripts/go-chain/bootstrap.sh --as-root-box \
#        [--upstream-style anthropic|openai] [--upstream-url URL] [--upstream-key KEY] \
#        [--upstream-model NAME] [--dry-run] [--rollback]
#
# Provisions the ROOT on this box (the friend's box / the owner's computer):
#   1. prereqs checked (git, node not needed, cargo for the build, uv, openssl, ssh)
#   2. yggdrasil brain built + installed as a systemd USER unit (install.sh pattern:
#      created once, never overwritten — idempotent)
#   3. speech agent installed (uv sync, systemd user unit; started later by
#      trunk-deploy.sh once the VPS exists — it needs the LiveKit URL/keys)
#   4. health gates BEFORE anything is enabled: unit active + /session/status 200
#   5. receipt printed: what runs, where, the ONE next command. No secrets echoed.
#
# Idempotent: re-run = upgrade paths only. Rollback: `--rollback` removes exactly
# what a previous run installed (tracked in ~/.local/state/go-chain/bootstrap.manifest).
# The root is NOT public: yggdrasil binds 127.0.0.1 only.
# Spec: docs/reviews/layman-deploy-spec.md §2 Phase A.
set -uo pipefail

MODE=; DRY=0; DO_ROLLBACK=0
UP_STYLE=anthropic; UP_URL=; UP_KEY=; UP_MODEL=glm-5.3-flash
while [ $# -gt 0 ]; do
  case "$1" in
    --as-root-box) MODE=root-box ;;
    --upstream-style) UP_STYLE="$2"; shift ;;
    --upstream-url) UP_URL="$2"; shift ;;
    --upstream-key) UP_KEY="$2"; shift ;;
    --upstream-model) UP_MODEL="$2"; shift ;;
    --dry-run) DRY=1 ;;
    --rollback) DO_ROLLBACK=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "bootstrap: unknown arg: $1" >&2; exit 64 ;;
  esac; shift
done
[ "$MODE" = root-box ] || { echo "bootstrap: this is the ROOT-BOX installer. Usage:
  bash bootstrap.sh --as-root-box --upstream-style anthropic --upstream-url https://api.z.ai/api/anthropic --upstream-key sk-... --upstream-model glm-5.3-flash
(dry-run first if you want to look: add --dry-run)" >&2; exit 64; }

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)              # the cloned repo root
STATE="$HOME/.local/state/go-chain"
MANIFEST="$STATE/bootstrap.manifest"
LOG="$STATE/bootstrap.log"
mkdir -p "$STATE"
touch "$LOG"; chmod 600 "$LOG" 2>/dev/null
say() { printf '\033[1m[bootstrap]\033[0m %s\n' "$*"; }
OK=(); SKIP=(); FAIL=()
track() { grep -qxF "$1" "$MANIFEST" 2>/dev/null || echo "$1" >> "$MANIFEST"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- rollback ----------
if [ "$DO_ROLLBACK" = 1 ]; then
  [ -f "$MANIFEST" ] || { say "nothing to roll back (no manifest at $MANIFEST)"; exit 0; }
  say "rolling back everything this installer created:"
  tac "$MANIFEST" | while read -r f; do
    case "$f" in
      UNIT:*) u=${f#UNIT:}; systemctl --user disable --now "$u" 2>/dev/null; rm -f "$HOME/.config/systemd/user/$u"; echo "  removed unit $u" ;;
      FILE:*) rm -f "${f#FILE:}"; echo "  removed ${f#FILE:}" ;;
      DIR:*/*) rmdir "${f#DIR:}" 2>/dev/null ;;
    esac
  done
  systemctl --user daemon-reload 2>/dev/null
  rm -f "$MANIFEST"; say "rollback done (built binary + cloned repo kept — delete by hand if wanted)"
  exit 0
fi

# ---------- 0. prereqs (with exact fix commands) ----------
MISS=()
for b in git curl openssl ssh; do have "$b" || MISS+=("$b"); done
have cargo || { [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"; }
have cargo || MISS+=("cargo (install: curl https://sh.rustup.rs -sSf | sh -s -- -y)")
have uv     || MISS+=("uv (install: curl -LsSf https://astral.sh/uv/install.sh | sh)")
if [ ${#MISS[@]} -gt 0 ]; then
  say "MISSING: ${MISS[*]}"; say "install those, then re-run this command. Nothing was changed."; exit 1
fi
say "prereqs ok (git/cargo/uv/openssl/ssh)"

run() { # run <desc> <cmd...> — fail = abort BEFORE enabling anything (health-gated ordering)
  local desc="$1"; shift
  if [ "$DRY" = 1 ]; then SKIP+=("$desc (dry-run)"); say "DRY $desc"; return 0; fi
  say "$desc ..."
  if "$@" >>"$LOG" 2>&1; then OK+=("$desc"); else
    FAIL+=("$desc"); say "FAILED: $desc — see $LOG (nothing was enabled; fix and re-run, it is safe)"; exit 1
  fi
}

# ---------- 1. build the brain ----------
YGG_DIR="$REPO/lab/yggdrasil"
BIN="$HOME/.local/bin/yggdrasil"
if [ -x "$BIN" ] && [ "$BIN" -nt "$YGG_DIR/src" ] 2>/dev/null; then
  SKIP+=("brain build (binary current)"); say "brain binary already built: $BIN"
else
  run "build yggdrasil (cargo, 2-4 min)" cargo build --release --locked --manifest-path "$YGG_DIR/Cargo.toml"
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$YGG_DIR/target/release/yggdrasil" "$BIN.new" && mv -f "$BIN.new" "$BIN"
  track "FILE:$BIN"
  OK+=("install brain binary")
fi

# ---------- 2. brain env (created once, never overwritten) ----------
CONF="$HOME/.config/yggdrasil/yggdrasil.env"
mkdir -p "$HOME/.config/yggdrasil"; chmod 700 "$HOME/.config/yggdrasil"
if [ -e "$CONF" ]; then
  SKIP+=("brain env (kept)"); say "brain env kept: $CONF (re-run never overwrites your key)"
else
  umask 077
  {
    echo "YGG_UPSTREAM_BASE_URL=${UP_URL:?--upstream-url required (the friend's brain API)}"
    echo "YGG_UPSTREAM_STYLE=$UP_STYLE"
    echo "YGG_UPSTREAM_API_KEY=$UP_KEY"
    echo "YGG_UPSTREAM_MODEL=$UP_MODEL"
    echo "YGG_LISTEN=127.0.0.1:4100"
    echo "YGG_DATA_DIR=$HOME/.local/share/yggdrasil"
    echo "YGG_MAX_TOKENS=16384"
    echo "YGG_VOICE=1"
  } > "$CONF.new" && mv "$CONF.new" "$CONF"
  track "FILE:$CONF"
  OK+=("mint brain env (0600)")
fi

# ---------- 3. brain unit + start + health gate ----------
UNIT="$HOME/.config/systemd/user/yggdrasil.service"
sed -e "s|@BIN@|$BIN|" -e "s|@ENV@|$CONF|" "$YGG_DIR/install/yggdrasil.service" > "$UNIT.new"
if cmp -s "$UNIT.new" "$UNIT"; then rm -f "$UNIT.new"; SKIP+=("brain unit (unchanged)")
else mv "$UNIT.new" "$UNIT"; track "UNIT:yggdrasil.service"; OK+=("write brain unit"); fi
if [ "$DRY" = 0 ]; then
  systemctl --user daemon-reload
  systemctl --user enable --now yggdrasil.service >>"$LOG" 2>&1 || { FAIL+=("start brain"); say "FAILED to start yggdrasil — journalctl --user -u yggdrasil — nothing else was touched"; exit 1; }
  sleep 1
  curl -sf -m 5 http://127.0.0.1:4100/session/status >/dev/null || { FAIL+=("brain health"); say "brain did not answer on 127.0.0.1:4100/session/status — journalctl --user -u yggdrasil"; exit 1; }
  OK+=("brain health: /session/status 200")
fi

# ---------- 4. speech agent (installed now, started by trunk-deploy after the VPS exists) ----------
AGENT_DIR="$REPO/agent"
if [ -f "$AGENT_DIR/pyproject.toml" ]; then
  run "agent deps (uv sync)" bash -c "cd '$AGENT_DIR' && uv sync"
  AENV="$AGENT_DIR/.env"
  if [ ! -e "$AENV" ]; then
    umask 077
    { echo "# filled by trunk-deploy.sh after the trunk exists (LiveKit + speech endpoints)"
      echo "LIVEKIT_URL="; echo "LIVEKIT_API_KEY="; echo "LIVEKIT_API_SECRET="
      echo "OPENCODE_URL=http://127.0.0.1:4100"
      echo "# STT/TTS: your Mac Studio speech endpoint (SPEACHES_URL) — paste or leave empty to use deploy/speaches fallback"
      echo "SPEACHES_URL="; } > "$AENV"
    track "FILE:$AENV"
    OK+=("mint agent env (0600, placeholders)")
  else SKIP+=("agent env (kept)"); fi
fi

# ---------- 5. the private line ----------
TS_IP=""
if have tailscale && tailscale ip -4 >/dev/null 2>&1; then TS_IP=$(tailscale ip -4 | head -1); fi
[ -n "$TS_IP" ] || say "NOTE: no tailscale — the trunk-deploy step needs a private line to this box (tailscale recommended: curl -fsSL https://tailscale.com/install.sh | sh, then 'tailscale up')"

# ---------- receipt ----------
HOSTIP=$TS_IP
say "──────────────────────────────────────────────"
say "ROOT RECEIPT $(date '+%F %T')"
say "  brain    yggdrasil.service active on 127.0.0.1:4100 (model: $UP_MODEL)"
[ -f "$AGENT_DIR/pyproject.toml" ] && say "  speech   agent installed (starts once the trunk exists)"
[ -n "$HOSTIP" ] && say "  private  $HOSTIP (tailscale) — give this to trunk-deploy as --root-url http://$HOSTIP:4100"
say "  secrets  $CONF is 0600, created once, never overwritten"
say "  undo     bash $0 --as-root-box --rollback"
say "NEXT COMMAND → run trunk-deploy.sh (see the runbook) to bring up the trunk"
say "──────────────────────────────────────────────"
exit 0
