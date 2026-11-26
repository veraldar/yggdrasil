#!/usr/bin/env bash
# ljoolq-up.sh — the ONLY way a candidate build reaches `trunk-ljoolq` on the VPS (spec §2 R2, §10 V1–V3).
# Run at HOME, from a clean worktree at <sha>: gate_check runs here first, then the steps run on the target
# as root (streamed as one tar over stdin, never writing temp files to the VPS on refusal).
#
#   ljoolq-up.sh [--target T] <sha> [options]
#
#   --target ssh:HOST         the VPS (default ssh:veraldar): `ssh HOST sudo bash`
#   --target docker:NAME      a rehearsal box: `docker exec -i NAME bash`
#   --binary FILE             bifrost-net binary to deploy (default trunk/target/release/bifrost-net)
#   --installer FILE          optional trunk.sh to run `--update` inside (if absent, swaps binary + restarts)
#   --check-url URL           health URL checked from the host after restart (default http://10.99.0.2:8080/t/state)
#   --caddy phase1|phase2|m7-acme   also merge the named Caddy block (trunk/deploy/caddy/caddy-merge.py),
#                             run `caddy validate`, and `systemctl reload caddy` (restores on failure)
#   --sni-v2                  also install trunk/deploy/sni-443.py (v2) to /usr/local/bin/sni-443.py
#   --sni-conf FILE           install FILE as /etc/trunk-ap/sni-443.conf (validated with --check) + SIGHUP reload
#   --no-snapshot             skip the pre-deploy `incus snapshot` (not recommended)
#
# Gate (spec R2): ALWAYS runs gate_check <sha> from trunk/deploy/gate-check.sh first.
# LJOOLQ_TEST_SKIP_GATE=1 skips ONLY the gate check, ONLY for a docker: target, and says so;
# with an ssh: target it is refused. LJOOLQ_SHOW=1 prints what would run without calling ssh/docker.
set -euo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
TREE=$(cd "$HERE/../.." && pwd)
CT=trunk-ljoolq
CT_IP=10.99.0.2
CADDYFILE=/etc/caddy/Caddyfile
SNI_BIN=/usr/local/bin/sni-443.py
SNI_CONF=/etc/trunk-ap/sni-443.conf
SNI_UNIT=yggdrasil-sni-443.service

say() { printf '==> %s\n' "$*"; }
die() { printf 'xx  ljoolq-up: %s\n' "$*" >&2; exit 1; }

# ════════════════════════════════════════════════════════════════════ on the target (root)
on_target() {
  local sha=$1 pay=$2 check_url=$3 do_snap=$4 caddy_mode=$5 do_sni_v2=$6 has_sni_conf=$7
  export DEBIAN_FRONTEND=noninteractive LC_ALL=C
  [ "$(id -u)" = 0 ] || die "on the target: not root"
  command -v incus >/dev/null && incus info "$CT" >/dev/null 2>&1 || die "no container $CT here"

  local snap=""
  if [ "$do_snap" = 1 ]; then
    snap="pre-up-${sha:0:8}-$(date -u +%Y%m%d-%H%M%S)"
    say "snapshot $CT/$snap"
    incus snapshot create "$CT" "$snap"
  fi

  restore_snap() {
    if [ -n "$snap" ]; then
      say "deploy failed — restoring $CT to snapshot $snap"
      incus snapshot restore "$CT" "$snap" || echo "!! snapshot restore $snap failed" >&2
      incus start "$CT" >/dev/null 2>&1 || true
    fi
  }

  # 1. Push candidate binary (and optional installer) into the container
  if [ -x "$pay/bifrost-net" ]; then
    say "pushing bifrost-net (${sha:0:12}) into $CT"
    incus exec "$CT" -- mkdir -p /root/ljoolq-up
    incus file push -p "$pay/bifrost-net" "$CT/root/ljoolq-up/bifrost-net" --mode 0755
    if [ -f "$pay/trunk.sh" ]; then
      incus file push -p "$pay/trunk.sh" "$CT/root/ljoolq-up/trunk.sh" --mode 0755
      if ! incus exec "$CT" -- bash /root/ljoolq-up/trunk.sh --update --binary /root/ljoolq-up/bifrost-net -y; then
        restore_snap; die "trunk.sh --update failed inside $CT"
      fi
    else
      if ! incus exec "$CT" -- bash -c '
        set -euo pipefail
        install -m 0755 /root/ljoolq-up/bifrost-net /usr/local/bin/bifrost-net.new
        mv -f /usr/local/bin/bifrost-net.new /usr/local/bin/bifrost-net
        ln -sfn /usr/local/bin/bifrost-net /usr/local/bin/trunk-ctl
        systemctl restart yggdrasil-trunk.service
      '; then
        restore_snap; die "binary swap / restart failed inside $CT"
      fi
    fi
    incus exec "$CT" -- rm -rf /root/ljoolq-up || true
  fi

  # 2. Health check against the container's HTTP endpoint
  say "health check: $check_url"
  local ok=0 code=000
  for _ in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$check_url" 2>/dev/null || echo 000)
    if [ "$code" = 200 ]; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" != 1 ]; then
    restore_snap
    die "health check $check_url failed (HTTP $code) — rolled back"
  fi
  say "health check OK ($check_url → 200)"

  # 3. Optional Caddy merge + validate + reload (restores previous Caddyfile on failure)
  if [ -n "$caddy_mode" ]; then
    local c_bak; c_bak="$CADDYFILE.bak.$(date -u +%Y%m%d-%H%M%S)"
    cp -p "$CADDYFILE" "$c_bak"
    say "caddy-merge.py ($caddy_mode) → $CADDYFILE"
    if ! python3 "$pay/caddy/caddy-merge.py" "$caddy_mode" "$CADDYFILE" --container-ip "$CT_IP" --in-place \
       || ! caddy validate --config "$CADDYFILE" --adapter caddyfile \
       || ! systemctl reload caddy; then
      cp -p "$c_bak" "$CADDYFILE"
      systemctl reload caddy >/dev/null 2>&1 || true
      die "Caddy $caddy_mode failed — restored $c_bak"
    fi
    say "Caddy reloaded ($caddy_mode)"
  fi

  # 4. Optional sni-443 v2 binary / conf update + check + reload
  if [ "$do_sni_v2" = 1 ]; then
    say "installing sni-443.py v2 → $SNI_BIN"
    install -m 0755 "$pay/sni-443.py" "$SNI_BIN.new"
    mv -f "$SNI_BIN.new" "$SNI_BIN"
  fi
  if [ "$has_sni_conf" = 1 ]; then
    local s_bak; s_bak="$SNI_CONF.bak.$(date -u +%Y%m%d-%H%M%S)"
    [ -f "$SNI_CONF" ] && cp -p "$SNI_CONF" "$s_bak"
    python3 "$SNI_BIN" -c "$pay/sni-443.conf" --check || die "sni-443 --check failed — nothing reloaded"
    install -m 0644 "$pay/sni-443.conf" "$SNI_CONF"
    if ! systemctl reload "$SNI_UNIT"; then
      [ -f "$s_bak" ] && cp -p "$s_bak" "$SNI_CONF" && systemctl reload "$SNI_UNIT" >/dev/null 2>&1 || true
      die "sni-443 reload failed — restored previous conf"
    fi
    say "sni-443 reloaded ($SNI_CONF)"
  fi

  say "ljoolq-up done (${sha:0:12})"
}

if [ "${1:-}" = --on-target ]; then shift; on_target "$@"; exit $?; fi

# ════════════════════════════════════════════════════════════════════ at home
TARGET=ssh:veraldar
BINARY=$TREE/trunk/target/release/bifrost-net
INSTALLER=''
CHECK_URL="http://$CT_IP:8080/t/state"
DO_SNAP=1
CADDY_MODE=''
DO_SNI_V2=0
SNI_CONF_LOCAL=''

[ "${1:-}" = --target ] && { TARGET=${2:?--target ssh:HOST|docker:NAME}; shift 2; }
if [ $# -lt 1 ] || [[ "${1:-}" == -* ]]; then
  echo "usage: $0 [--target ssh:HOST|docker:NAME] <sha> [--binary FILE] [--installer FILE] [--check-url URL] [--caddy phase1|phase2|m7-acme] [--sni-v2] [--sni-conf FILE] [--no-snapshot]" >&2
  exit 2
fi
SHA=$1; shift
while [ $# -gt 0 ]; do
  case $1 in
    --target) TARGET=${2:?--target ssh:HOST|docker:NAME}; shift ;;
    --binary) BINARY=${2:?--binary FILE}; shift ;;
    --installer) INSTALLER=${2:?--installer FILE}; shift ;;
    --check-url) CHECK_URL=${2:?--check-url URL}; shift ;;
    --caddy) CADDY_MODE=${2:?--caddy phase1|phase2|m7-acme}; shift ;;
    --sni-v2) DO_SNI_V2=1 ;;
    --sni-conf) SNI_CONF_LOCAL=${2:?--sni-conf FILE}; shift ;;
    --no-snapshot) DO_SNAP=0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

case $TARGET in ssh:?*|docker:?*) ;; *) die "--target ssh:HOST or docker:NAME, not '$TARGET'" ;; esac
case $CADDY_MODE in ''|phase1|phase2|m7-acme) ;; *) die "--caddy must be phase1, phase2 or m7-acme" ;; esac

run_on_target() {
  case $TARGET in
    ssh:*) ssh -o BatchMode=yes "${TARGET#ssh:}" "sudo bash -c $(printf '%q' "$1")" ;;
    docker:*) docker exec -i "${TARGET#docker:}" bash -c "$1" ;;
  esac
}

# ── the gate (R2): ALWAYS first, before anything reaches the target
if [ "${LJOOLQ_TEST_SKIP_GATE:-0}" = 1 ]; then
  case $TARGET in docker:*) ;; *) die "LJOOLQ_TEST_SKIP_GATE=1 is for a docker: rehearsal box only, never $TARGET — nothing was done" ;; esac
  say "TEST OVERRIDE: the gate check is SKIPPED (LJOOLQ_TEST_SKIP_GATE=1, rehearsal target $TARGET) — every other step runs as on the VPS"
else
  # shellcheck source=gate-check.sh
  . "$HERE/gate-check.sh"
  gate_check "$SHA" "$TREE" || exit 1
  say "gate check: $SHA is green"
fi

HAS_SNI_CONF=0
[ -n "$SNI_CONF_LOCAL" ] && HAS_SNI_CONF=1
q() { printf '%q ' "$@"; }
REMOTE_ARGS=$(q "$SHA" '$d' "$CHECK_URL" "$DO_SNAP" "$CADDY_MODE" "$DO_SNI_V2" "$HAS_SNI_CONF")
REMOTE_ARGS=${REMOTE_ARGS//\\\$d/\$d}
SCRIPT="set -e; d=\$(mktemp -d /root/ljoolq-up.XXXXXX); trap 'rm -rf \"\$d\"' EXIT; tar -xf - -C \"\$d\"; bash \"\$d/ljoolq-up.sh\" --on-target $REMOTE_ARGS"

if [ "${LJOOLQ_SHOW:-0}" = 1 ]; then
  printf 'would run on %s as root: %s\n' "$TARGET" "$SCRIPT"
  exit 0
fi

# ── pack payload and stream over stdin
[ -x "$BINARY" ] || die "no executable binary at $BINARY (build with: cd trunk && cargo build --release)"
[ -z "$INSTALLER" ] || [ -f "$INSTALLER" ] || die "no installer at $INSTALLER"
[ -z "$SNI_CONF_LOCAL" ] || [ -f "$SNI_CONF_LOCAL" ] || die "no sni-443.conf at $SNI_CONF_LOCAL"

export TMPDIR=${TMPDIR:-$HOME/.cache/trunk-v1/tmp/ops}
mkdir -p "$TMPDIR"
PAY=$(mktemp -d "$TMPDIR/ljoolq-up.XXXXXX")
trap 'rm -rf "$PAY"' EXIT
cp "$0" "$PAY/ljoolq-up.sh"
cp "$BINARY" "$PAY/bifrost-net"
chmod 755 "$PAY/bifrost-net"
[ -n "$INSTALLER" ] && cp "$INSTALLER" "$PAY/trunk.sh"
if [ -n "$CADDY_MODE" ]; then
  cp -r "$HERE/caddy" "$PAY/caddy"
fi
[ "$DO_SNI_V2" = 1 ] && cp "$HERE/sni-443.py" "$PAY/sni-443.py"
[ "$HAS_SNI_CONF" = 1 ] && cp "$SNI_CONF_LOCAL" "$PAY/sni-443.conf"

say "deploying ${SHA:0:12} on $TARGET"
tar -C "$PAY" -cf - . | run_on_target "$SCRIPT"
