#!/usr/bin/env bash
# root.sh — make THIS computer (Linux, WSL2, macOS) a root of your tree: the brain, the bridge, the
# app, cc-live, the librarian — no admin rights on Linux (systemd --user; macOS: launchd).
#
# Download it from YOUR trunk (it carries the trunk's address):
#     curl -fsSL https://your.truck/install/root.sh | bash
# …or the copy you saved: bash root.sh
#
# What happens: the SIGNED release is fetched and checked (SHA256SUMS signed by the yggdrasil release
# key, embedded below as YGG_SIGNER — never fetched), unpacked, and this root key + WireGuard key +
# DTLS identity are made here. The trunk then asks your phone (or your admin browser) to approve
# this computer. After approval: the root's services start and dial OUT to the trunk; the brain is
# reachable through it from anywhere. Nothing here opens a port.
#
#   bash root.sh                  join the trunk this script came from (approve on your phone)
#   bash root.sh --trunk URL      another trunk (https://trunk.example.org)
#   bash root.sh                  re-run: refresh files, make sure it all runs (the join is kept)
#   bash root.sh --model-provider P    the brain's model: zai | openrouter | anthropic | openai | other
#                                     (asked in the terminal when not given; the key is never shown)
#   bash root.sh --update         the newest signed 1.x release (a major needs --major), then re-join
#   bash root.sh --stop           stop this root's services (the join is kept)
#   bash root.sh --uninstall      stop and remove it all (lists what goes, asks first; -y)
#
#   --trunk URL             the trunk to join (default: the one baked into this copy, or root.conf)
#   --name NAME             this root's display name (default: the hostname)
#   --dir DIR               everything this root keeps (default ~/.local/share/yggdrasil-root)
#   --upstream-env FILE     the model as YGG_UPSTREAM_BASE_URL/_API_KEY/_MODEL/_STYLE lines
#   --model M               with --model-provider: another model than the provider's default
#   --skip brain|app|bridge|livekit|voice|agent|cclive|librarian    leave components out (default: all in)
#   --no-start              write everything, start nothing
#   --brain-port P / --app-port P / --bridge-port P    loopback ports (defaults: first free of 4180/4182/4190)
#   --project-dir DIR       where the brain's tools work (default: your home)
#   --version vX.Y.Z        another release than this script's own
#   --yes / -y              do not ask (approval on the phone is still needed)
#
# Exit: 0 joined and running · 3 refused · 4 expired · 64 usage · 1 anything else.
set -euo pipefail
umask 077

# ------------------------------------------------------------------------------ the release key
# scripts/release.sh stamps YGG_RELEASE with the release this file belongs to ('' = from a checkout:
# the latest release). YGG_SIGNER is the release key's allowed_signers line (RELEASE-KEY.pub in the repo).
YGG_RELEASE=''
YGG_RELEASE_TEST=''
YGG_SIGNER='release@yggdrasil namespaces="yggdrasil-release" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJyKwTSmRf3Cy1cHpzKHl3teRvCQtgK8/dcFRvlNCDJg'
# A test release (signed by a throwaway key) is marked YGG_RELEASE_TEST=1 by scripts/release.sh: only it,
# or an unstamped script from a checkout, may be pointed at other signers. A real release's script refuses.
if [ -n "${YGG_RELEASE_TEST_SIGNERS:-}" ] && [ -n "$YGG_RELEASE" ] && [ "$YGG_RELEASE_TEST" != 1 ]; then
  printf '\033[1;31mxx\033[0m  %s\n' "YGG_RELEASE_TEST_SIGNERS is set, but this is the v$YGG_RELEASE release's installer: it trusts only the yggdrasil release key. Unset it — it is for tests, from a checkout." >&2
  exit 64
fi
# baked by the trunk that serves this copy: its own address (empty in a checkout)
TRUNK_URL_BAKED='@TRUNK_URL@'
TRUNK_KEY_BAKED='@TRUNK_KEY@'

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$1" >&2; exit "${2:-1}"; }
usage() { sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; }

ARGS=("$@")
TRUNK='' PIN='' NAME='' DIR='' SKIP='' WANT_VERSION='' UPSTREAM_FILE='' QR_PNG='' MODEL_PROVIDER_ARG='' MODEL_ARG=''
BRAIN_PORT='' APP_PORT='' BRIDGE_PORT='' PROJECT_DIR='' START=1 YES=0 UPDATE=0 STOP=0 UNINSTALL=0 MAJOR=0
need() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" 64; }
while [ $# -gt 0 ]; do
  case $1 in
    --trunk) need "$@"; TRUNK=$2; shift ;;
    --pin) need "$@"; PIN=$2; shift ;;
    --name) need "$@"; NAME=$2; shift ;;
    --dir) need "$@"; DIR=$2; shift ;;
    --upstream-env) need "$@"; UPSTREAM_FILE=$2; shift ;;
    --qr-png) need "$@"; QR_PNG=$2; shift ;;
    --model-provider) need "$@"; MODEL_PROVIDER_ARG=$2; shift ;;
    --model) need "$@"; MODEL_ARG=$2; shift ;;
    --skip) need "$@"; SKIP="$SKIP$2,"; shift ;;
    --brain-port) need "$@"; BRAIN_PORT=$2; shift ;;
    --app-port) need "$@"; APP_PORT=$2; shift ;;
    --bridge-port) need "$@"; BRIDGE_PORT=$2; shift ;;
    --project-dir) need "$@"; PROJECT_DIR=$2; shift ;;
    --version) need "$@"; WANT_VERSION=${2#v}; shift ;;
    --major) MAJOR=1 ;;
    --update) UPDATE=1 ;;
    --no-start) START=0 ;;
    --stop) STOP=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -y|--yes) YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" 64 ;;
  esac
  shift
done

# ------------------------------------------------------------------------------- the machine
case $(uname -s) in
  Darwin) OS=macos ;;
  Linux) if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then OS=wsl; else OS=linux; fi ;;
  *) die "unsupported system $(uname -s): Linux, WSL2 or macOS" ;;
esac
pkg_hint() {
  if [ $OS = macos ]; then echo "xcode-select --install   (or: brew install $*)"
  elif command -v apt-get >/dev/null; then echo "sudo apt-get update && sudo apt-get install -y $*"
  elif command -v dnf >/dev/null; then echo "sudo dnf install -y $*"
  elif command -v pacman >/dev/null; then echo "sudo pacman -S --needed $*"
  else echo "install: $*"; fi
}
MIN_GLIBC=2.31
if [ $OS != macos ] && [ $UNINSTALL = 0 ] && [ $STOP = 0 ]; then
  _g=$(ldd --version 2>&1 | head -1 | grep -o '[0-9][0-9]*\.[0-9][0-9]*$' || true)
  [ -n "$_g" ] || die "this Linux has no glibc (musl?): the release needs glibc $MIN_GLIBC or newer (Debian 11+, Ubuntu 20.04+). Nothing was downloaded."
  [ "$(printf '%s\n%s\n' "$MIN_GLIBC" "$_g" | sort -V | head -1)" = "$MIN_GLIBC" ] ||
    die "this Linux's C library is glibc $_g: the release needs $MIN_GLIBC or newer. Nothing was downloaded."
fi
PY=$(command -v python3 || true)
[ -n "$PY" ] || die "python3 is needed — $(pkg_hint python3 ca-certificates)"
"$PY" -c 'import ssl, json, urllib.request, zlib' 2>/dev/null || die "python3 (with ssl) is needed — $(pkg_hint python3 ca-certificates)"
ARCH=$(uname -m); case $ARCH in amd64) ARCH=x86_64 ;; arm64) ARCH=aarch64 ;; esac
[ $OS = macos ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && ARCH=aarch64
case $OS/$ARCH in
  linux/x86_64|wsl/x86_64) PLAT=linux-x86_64 ;;
  macos/aarch64) PLAT=macos-aarch64 ;;
  *) PLAT='' ;;
esac
sha256() { if command -v sha256sum >/dev/null; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }
RELEASES=${YGG_RELEASES:-https://github.com/veraldar/yggdrasil/releases}
REL_HOME=${XDG_DATA_HOME:-$HOME/.local/share}/yggdrasil/release

# ------------------------------------------------------------------ the release: signed, checked
fetch() { curl -fsSL --retry 3 --proto '=https,http' -o "$2" "$1"; }
REL_DIR=''
release_sums() { # BASE — BASE/SHA256SUMS into $REL_DIR, verified: signed by YGG_SIGNER, else stop here
  local base=$1 signers
  [ -n "$REL_DIR" ] || { REL_DIR=$(mktemp -d); trap 'rm -rf "$REL_DIR"' EXIT; }
  say "release: $base/SHA256SUMS (+ its signature)"
  fetch "$base/SHA256SUMS" "$REL_DIR/SHA256SUMS" || die "cannot download $base/SHA256SUMS — check the network and that the release exists"
  fetch "$base/SHA256SUMS.sig" "$REL_DIR/SHA256SUMS.sig" || die "the release at $base has no signature (SHA256SUMS.sig) — refusing it"
  signers=$REL_DIR/allowed_signers
  printf '%s\n' "$YGG_SIGNER" >"$signers"
  if [ -n "${YGG_RELEASE_TEST_SIGNERS:-}" ]; then
    warn "TEST ONLY: trusting the release signers in $YGG_RELEASE_TEST_SIGNERS, not the built-in key"
    cat "$YGG_RELEASE_TEST_SIGNERS" >"$signers"
  fi
  ssh-keygen -Y verify -f "$signers" -I release@yggdrasil -n yggdrasil-release -s "$REL_DIR/SHA256SUMS.sig" \
    <"$REL_DIR/SHA256SUMS" >/dev/null 2>&1 \
    || die "the SHA256SUMS at $base is NOT signed by the yggdrasil release key — refusing it (a tampered or foreign release)"
  say "release: signature OK (the yggdrasil release key)"
}
sum_of() { sed -n "s/^\([0-9a-f]\{64\}\)  $1\$/\1/p" "$REL_DIR/SHA256SUMS" | head -1; }
release_base() { if [ -n "$1" ]; then echo "$RELEASES/download/v${1#v}"; else echo "$RELEASES/latest/download"; fi; }
newer() { # A B — is version A newer than B? A pre-release is OLDER than its release
  [ "$1" = "$2" ] && return 1
  local a=${1%%-*} b=${2%%-*}
  if [ "$a" != "$b" ]; then [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -1)" = "$a" ]; return; fi
  case $1/$2 in
    *-*/*-*) [ "$(printf '%s\n%s\n' "${1#*-}" "${2#*-}" | sort -V | tail -1)" = "${1#*-}" ] ;;
    *-*/*) return 1 ;;
    *) return 0 ;;
  esac
}
major_of() { printf '%s' "${1%%-*}" | cut -d. -f1; }
unpacked() { local d; for d in "$REL_HOME"/*/.verified; do if [ -f "$d" ]; then basename "$(dirname "$d")"; fi; done | sort -V; }
bootstrap() { # WHY — the signed release (--version, else max(this script's, the newest unpacked)), unpacked,
  #             then THAT release's root.sh runs with our arguments: prebuilt everything, nothing to compile
  local want base tgz newest
  [ -n "$PLAT" ] || die "$1, and there is no prebuilt release for $OS $ARCH — use a Linux x86_64 box, an Apple-silicon Mac, or build from a git checkout"
  local g need=() d free_mb
  if [ $OS != macos ]; then
    g=$(ldd --version 2>&1 | head -1 | grep -o '[0-9][0-9]*\.[0-9][0-9]*$' || true)
    [ -n "$g" ] || die "$1, and this Linux has no glibc (musl?): the release needs glibc $MIN_GLIBC or newer (Debian 11+, Ubuntu 20.04+)"
    [ "$(printf '%s\n%s\n' "$MIN_GLIBC" "$g" | sort -V | head -1)" = "$MIN_GLIBC" ] ||
      die "$1, and this Linux's C library is glibc $g: the release needs $MIN_GLIBC or newer. Nothing was downloaded."
  fi
  command -v curl >/dev/null || need+=(curl ca-certificates)
  command -v ssh-keygen >/dev/null || need+=(openssh-client)
  { command -v sha256sum || command -v shasum; } >/dev/null && command -v tar >/dev/null || need+=(coreutils tar)
  [ ${#need[@]} = 0 ] || die "$1; fetching and checking the release needs: ${need[*]} — first: $(pkg_hint "${need[@]}"). Nothing was downloaded."
  d=${XDG_DATA_HOME:-$HOME/.local/share}; while [ ! -d "$d" ]; do d=$(dirname "$d"); done
  free_mb=$(( $(df -Pk "$d" | awk 'NR==2 {print $4}') / 1024 ))
  [ "$free_mb" -ge 700 ] || die "$1, and only $free_mb MB are free in $d: the release needs about 700 MB. Nothing was downloaded."
  newest=$(unpacked | tail -1)
  want=$WANT_VERSION
  if [ -z "$want" ] && [ $UPDATE = 0 ]; then
    want=$YGG_RELEASE
    if [ -n "$newest" ] && { [ -z "$want" ] || newer "$newest" "$want"; }; then want=$newest; fi
  fi
  if [ -z "$want" ] || [ ! -f "$REL_HOME/$want/.verified" ]; then
    base=$(release_base "$want")
    release_sums "$base"
    [ -n "$want" ] || want=$(sed -n "s/^[0-9a-f]\{64\}  yggdrasil-\([0-9][0-9A-Za-z.+-]*\)-$PLAT\.tar\.gz\$/\1/p" "$REL_DIR/SHA256SUMS" | head -1)
    tgz=yggdrasil-$want-$PLAT.tar.gz
    [ -n "$want" ] && [ -n "$(sum_of "$tgz")" ] || die "the release${want:+ v$want} has no build for $OS $ARCH ($tgz)"
    # this very script, when it belongs to that release: the one the release signed, or stop here
    if [ -n "$YGG_RELEASE" ] && [ "$want" = "$YGG_RELEASE" ] && [ -f "$0" ] && [ -n "$(sum_of root.sh)" ] &&
       [ "$(sha256 <"$0")" != "$(sum_of root.sh)" ]; then
      die "this root.sh is not the one release v$YGG_RELEASE signed — download it again: $base/root.sh"
    fi
  fi
  if [ ! -f "$REL_HOME/$want/.verified" ]; then
    say "$1: the signed release $want ($base/$tgz)"
    fetch "$base/$tgz" "$REL_DIR/$tgz" || die "cannot download $base/$tgz"
    [ "$(sha256 <"$REL_DIR/$tgz")" = "$(sum_of "$tgz")" ] || die "$tgz does not match SHA256SUMS — refusing to install it"
    mkdir -p "$REL_HOME"; rm -rf "$REL_HOME/.$want.new"; mkdir -p "$REL_HOME/.$want.new"
    tar -xzf "$REL_DIR/$tgz" -C "$REL_HOME/.$want.new" --strip-components=1 --no-same-owner || die "could not unpack $tgz"
    grep -qx "yggdrasil $want" "$REL_HOME/.$want.new/RELEASE" 2>/dev/null || die "$tgz holds another release than $want — refusing it"
    sum_of "$tgz" >"$REL_HOME/.$want.new/.verified"
    rm -rf "${REL_HOME:?}/$want"; mv "$REL_HOME/.$want.new" "$REL_HOME/$want"
    say "release: $want unpacked in $REL_HOME/$want (signature + sha256 checked)"
  fi
  [ -n "$REL_DIR" ] && rm -rf "$REL_DIR"
  [ -n "$TRUNK_URL_BAKED" ] && [ "$TRUNK_URL_BAKED" != '@TRUNK_URL@' ] && export YGG_TRUNK_URL_BAKED="$TRUNK_URL_BAKED"
  [ -n "$TRUNK_KEY_BAKED" ] && [ "$TRUNK_KEY_BAKED" != '@TRUNK_KEY@' ] && export YGG_TRUNK_KEY_BAKED="$TRUNK_KEY_BAKED"
  exec bash "$REL_HOME/$want/root/install/root.sh" ${ARGS[@]+"${ARGS[@]}"}
}
# alone (downloaded, or from a checkout with no binaries): the release first; --version names another
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
IN_CHECKOUT=0; [ -f "$HERE/model-step.sh" ] && IN_CHECKOUT=1
if [ $UNINSTALL = 0 ] && [ $STOP = 0 ] && [ $UPDATE = 0 ]; then
  if [ $IN_CHECKOUT = 0 ] || { [ -n "$WANT_VERSION" ] && [ "$(sed -n '1s/^yggdrasil //p' "$REPO/RELEASE" 2>/dev/null)" != "$WANT_VERSION" ]; }; then
    bootstrap "this root.sh came alone"
  fi
fi

# ------------------------------------------------------------------------------ where things go
DIR=${DIR:-$HOME/.local/share/yggdrasil-root}
case $DIR in /*) ;; *) DIR=$PWD/$DIR ;; esac
CONF=$DIR/root.conf
BIN=$DIR/bin
LOG=$DIR/log
RUN=$DIR/run
STATEF=$DIR/trunk-state.json
confget() { [ -f "$CONF" ] && sed -n "s/^$1=//p" "$CONF" | tail -1 || true; }
CHANGED=0
put() { # put FILE MODE < content — replace only when the content differs; sets CHANGED
  local tmp; tmp=$(mktemp "$1.XXXXXX"); cat >"$tmp"; chmod "$2" "$tmp"
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then rm -f "$tmp"; else mv -f "$tmp" "$1"; CHANGED=1; fi
}
copy() { # copy SRC DEST MODE
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 0; fi
  cp "$1" "$2.new.$$"; chmod "$3" "$2.new.$$"; mv -f "$2.new.$$" "$2"; CHANGED=1
}
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
proc_args() { if [ -r "/proc/$1/cmdline" ]; then tr '\0' ' ' <"/proc/$1/cmdline"; else ps -p "$1" -o args= 2>/dev/null; fi; }

# ------------------------------------------------------------------------------------ --update
if [ $UPDATE = 1 ]; then
  [ -f "$CONF" ] || die "no root here (no $CONF) — nothing to update"
  release_sums "$(release_base '')"
  NEWV=$(sed -n 's/^[0-9a-f]\{64\}  bifrost-net-\([0-9][0-9A-Za-z.+-]*\)-linux-[a-z0-9_]*$/\1/p' "$REL_DIR/SHA256SUMS" | head -1)
  [ -n "$NEWV" ] || die "the release names no bifrost-net version"
  HAVE=$(confget VERSION); HAVE=${HAVE:-$(unpacked | tail -1)}
  if [ -n "$HAVE" ] && ! newer "$NEWV" "$HAVE"; then
    if [ "$NEWV" = "$HAVE" ]; then say "update: $HAVE is the newest release"
    else warn "update: $NEWV is OLDER than $HAVE — keeping $HAVE"; fi
    NEWV=$HAVE
  fi
  if [ -n "$HAVE" ] && [ "$(major_of "$NEWV")" != "$(major_of "$HAVE")" ] && [ $MAJOR = 0 ]; then
    die "update: v$HAVE → v$NEWV crosses a MAJOR version (v$(major_of "$HAVE") → v$(major_of "$NEWV")).
    Read the new release notes, then: bash root.sh --update --major" 64
  fi
  rm -rf "$REL_DIR"
  WANT_VERSION=$NEWV exec bash "$0" --version "v$NEWV" ${ARGS[@]+"${ARGS[@]}"}
fi

# ------------------------------------------------------------------------ --stop / --uninstall
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
AGENT_DIR=$HOME/Library/LaunchAgents
LABEL=org.veraldar.yggdrasil-root
UNITS=(yggdrasil-root-brain.service yggdrasil-root-bridge.service yggdrasil-root-app.service)
UNITS+=(yggdrasil-root-wg.service yggdrasil-root-librarian.service yggdrasil-root-cclive.service)
systemd_sees() {
  local real; real=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6 || true); real=${real:-$HOME}
  [ "$UNIT_DIR" = "$real/.config/systemd/user" ] && command -v systemctl >/dev/null \
    && systemctl --user show-environment >/dev/null 2>&1
}
pick_supervisor() {
  if [ $OS = macos ]; then echo launchd; elif systemd_sees; then echo systemd; else echo nohup; fi
}
stop_services() {
  local sup p u; sup=$(confget SUPERVISOR)
  case $sup in
    systemd) systemctl --user disable --now ${UNITS[@]+"${UNITS[@]}"} >/dev/null 2>&1 || true ;;
    launchd) for s in brain bridge app wg librarian cclive; do launchctl bootout "gui/$(id -u)/$LABEL.$s" 2>/dev/null || true; done ;;
  esac
  p=$(cat "$RUN/supervise.pid" 2>/dev/null || true)
  if pid_alive "$p" && proc_args "$p" | grep -q "$BIN/supervise"; then
    kill -TERM "$p" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do pid_alive "$p" || break; sleep 0.5; done
  fi
  say "stopped${sup:+ ($sup)}"
}
if [ $STOP = 1 ]; then
  [ -f "$CONF" ] || die "nothing here to stop: $CONF missing"
  stop_services
  exit 0
fi
if [ $UNINSTALL = 1 ]; then
  GONE=()
  for u in ${UNITS[@]+"${UNITS[@]}"}; do [ -e "$UNIT_DIR/$u" ] && GONE+=("$UNIT_DIR/$u  (unit)"); done
  for s in brain bridge app wg librarian cclive; do [ -e "$AGENT_DIR/$LABEL.$s.plist" ] && GONE+=("$AGENT_DIR/$LABEL.$s.plist"); done
  [ -e "$DIR" ] && GONE+=("$DIR/  (this root: its join, keys, model key, brain data, logs)")
  OWN_REL=0
  [ -d "$REL_HOME" ] && [ ! -d "${XDG_CONFIG_HOME:-$HOME/.config}/bifrost" ] && OWN_REL=1 && GONE+=("$REL_HOME/  (the unpacked releases)")
  if [ ${#GONE[@]} = 0 ]; then say "no root here — nothing to remove"; exit 0; fi
  echo "This removes this root from this computer (the tree keeps the others; revoke it on your phone if you like):"
  printf '    %s\n' "${GONE[@]}"
  if [ $YES = 0 ]; then
    [ -t 0 ] || die "--uninstall asks first: add -y to remove without a question" 64
    read -r -p "remove all of this? [y/N] " a
    case $a in y|Y|yes|YES) ;; *) die "nothing removed" ;; esac
  fi
  [ -f "$CONF" ] && stop_services
  for u in ${UNITS[@]+"${UNITS[@]}"}; do rm -f "$UNIT_DIR/$u"; done
  systemd_sees && systemctl --user daemon-reload
  for s in brain bridge app wg librarian cclive; do rm -f "$AGENT_DIR/$LABEL.$s.plist"; done
  rm -rf "$DIR"
  if [ $OWN_REL = 1 ]; then rm -rf "$REL_HOME"; rmdir "$(dirname "$REL_HOME")" 2>/dev/null || true; fi
  say "removed. On your trunk: revoke this root from a device (/roots, hold to remove) if it should not come back."
  exit 0
fi

# ---------------------------------------------------------------------- the trunk we join
mkdir -p "$DIR" "$BIN" "$LOG" "$RUN" "$DIR/data"
chmod 700 "$DIR"
JOINED=0; [ -f "$DIR/root.json" ] && JOINED=1
TRUNK=${TRUNK:-$(confget TRUNK)}
if [ -z "$TRUNK" ]; then
  if [ -n "$TRUNK_URL_BAKED" ] && [ "$TRUNK_URL_BAKED" != '@TRUNK_URL@' ]; then TRUNK=$TRUNK_URL_BAKED
  elif [ -n "${YGG_TRUNK_URL_BAKED:-}" ]; then TRUNK=$YGG_TRUNK_URL_BAKED; fi
fi
TRUNK=${TRUNK%/}
if [ "$TRUNK" = '@TRUNK_URL@' ] || [ -z "$TRUNK" ]; then TRUNK=''; fi   # an un-baked checkout copy
if [ -z "$TRUNK" ] && [ $JOINED = 1 ]; then TRUNK=$(confget TRUNK); fi
case $TRUNK in
  '') die "which trunk? bash root.sh --trunk https://<your trunk>  (the address your phone uses)" 64 ;;
  https://*|http://*) ;;
  *) die "--trunk must start with https:// (got '$TRUNK')" 64 ;;
esac
case $TRUNK in *[!A-Za-z0-9:/._~%@+-]*) die "--trunk: unexpected characters in $TRUNK" 64 ;; esac
if [ $JOINED = 1 ] && [ "$TRUNK" != "$(confget TRUNK)" ]; then
  die "this root belongs to $(confget TRUNK) — to join $TRUNK instead, first: bash root.sh --uninstall" 64
fi
HOSTN=${HOSTNAME:-$(uname -n)}; HOSTN=${HOSTN%%.*}
[ -n "$NAME" ] || NAME=$(confget NAME)
[ -n "$NAME" ] || NAME=$(printf '%s' "$HOSTN" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-48)
[ -n "$PROJECT_DIR" ] || PROJECT_DIR=$(confget PROJECT_DIR); PROJECT_DIR=${PROJECT_DIR:-$HOME}
[ -d "$PROJECT_DIR" ] || die "--project-dir $PROJECT_DIR: not a directory"

# --------------------------------------------------------------------------------- the model
# model-step.sh: the same choices and words as install.sh and the Windows installer (E8).
# shellcheck source=root/install/model-step.sh
. "$HERE/model-step.sh"
if [ -n "$UPSTREAM_FILE" ]; then
  [ -r "$UPSTREAM_FILE" ] || die "--upstream-env $UPSTREAM_FILE: not readable"
  while IFS= read -r l || [ -n "$l" ]; do
    l=${l%$'\r'}; l=${l#export }
    case $l in YGG_UPSTREAM_*=*|YGG_MAX_TOKENS=*) ;; *) continue ;; esac
    k=${l%%=*} v=${l#*=}
    case $v in \"*\") v=${v#\"}; v=${v%\"} ;; \'*\') v=${v#\'}; v=${v%\'} ;; esac
    printf -v "$k" '%s' "$v"
  done <"$UPSTREAM_FILE"
fi
if [ "$MODEL_PROVIDER_ARG" = same ]; then
  die "--model-provider same was a v0.9 idea: pick zai, openrouter, anthropic, openai or other" 64
elif [ -n "$MODEL_PROVIDER_ARG" ]; then
  model_from_provider "$MODEL_PROVIDER_ARG" "$MODEL_ARG" || die "$MODEL_ERR" 64
elif [ -n "$MODEL_ARG" ]; then
  die "--model goes with --model-provider" 64
elif [ -z "${YGG_UPSTREAM_BASE_URL:-}" ] && ! grep -q '^YGG_UPSTREAM_BASE_URL=.' "$DIR/brain.env" 2>/dev/null; then
  if [ -t 0 ]; then
    model_step home || die "no model chosen" 64   # asked before any download of the release archive
  elif [ -n "${YGG_UPSTREAM_API_KEY:-}" ]; then
    die "YGG_UPSTREAM_API_KEY is set, but not whose it is: add --model-provider zai|openrouter|anthropic|openai (or --upstream-env FILE)" 64
  fi
fi
unset YGG_UPSTREAM_API_KEY   # from here on it lives only in $DIR/brain.env (600)

# ------------------------------------------------------------------- ports (loopback, first free)
port_free() { "$PY" -c 'import socket,sys; s=socket.socket(); s.bind(("127.0.0.1", int(sys.argv[1])))' "$1" 2>/dev/null; }
next_free() { local p=$1; while ! port_free "$p"; do p=$((p + 2)); done; echo "$p"; }
[ -n "$BRAIN_PORT" ] || BRAIN_PORT=$(confget BRAIN_PORT)
[ -n "$APP_PORT" ] || APP_PORT=$(confget APP_PORT)
[ -n "$BRIDGE_PORT" ] || BRIDGE_PORT=$(confget BRIDGE_PORT)
: "${BRAIN_PORT:=$(next_free 4180)}"
: "${APP_PORT:=$(next_free 4182)}"
: "${BRIDGE_PORT:=$(next_free 4190)}"
WG_UDP=$((BRIDGE_PORT + 1))    # the wg node's own udp; the bridge's relay is its +2
WG_RELAY=$((BRIDGE_PORT + 2))
WG_HTTP=$((BRIDGE_PORT + 3))

# --------------------------------------------------------------------------- the binaries
REL_BIN=/nonexistent; [ -f "$REPO/RELEASE" ] && [ -d "$REPO/bin" ] && REL_BIN=$REPO/bin   # an unpacked release
have() { case ",$SKIP," in *",$1,"*) return 1 ;; esac; return 0; }
need_brain=1; have brain || need_brain=0
if [ $IN_CHECKOUT = 1 ] && [ ! -x "$REL_BIN/yggdrasil" ]; then
  # a checkout with no release: use its build if there is one, else say what to do
  if [ -x "$REPO/root/target/release/yggdrasil" ]; then REL_BIN=$REPO/root/target/release; fi
fi
[ -x "$REL_BIN/yggdrasil" ] || [ $need_brain = 0 ] || bootstrap "no prebuilt yggdrasil here"
[ -x "$REL_BIN/bifrost-net" ] || bootstrap "no prebuilt bifrost-net here"
[ -x "$REL_BIN/node" ] || bootstrap "no prebuilt node here"
for b in yggdrasil bifrost-net; do copy "$REL_BIN/$b" "$BIN/$b" 755; done
have brain && copy "$REL_BIN/yggdrasil" "$BIN/yggdrasil" 755
MISSING=$(ldd "$BIN/bifrost-net" 2>/dev/null | sed -n 's/^[[:space:]]*\([^ ]*\) => not found.*/\1/p' | tr '\n' ' ' || true)
if [ -n "$MISSING" ] && [ $OS != macos ]; then
  case $MISSING in *libopus*) die "bifrost-net needs libopus — $(pkg_hint libopus0)" ;; esac
  die "bifrost-net needs libraries this machine lacks: $MISSING"
fi
NET_OUT=$("$BIN/bifrost-net" 2>&1 || true)
case $NET_OUT in
  *'error while loading shared libraries'*) die "bifrost-net cannot start: ${NET_OUT%%$'\n'*} — $(pkg_hint libopus0)" ;;
esac
copy "$REPO/root/install/model-step.sh" "$BIN/model-step.sh" 644

# --------------------------------------------------------------------------- 1. the keys
# The root key (Ed25519, 0600): this root's identity, enrolled once, pinned at the trunk. The
# WireGuard key: root-to-root tunnels. The DTLS identity: made by the bridge on first start (its
# fingerprint is what your phone pins). Only public halves ever leave this machine.
ROOT_KEY=$DIR/root.key
ROOT_PUB=$("$BIN/bifrost-net" root-key "$ROOT_KEY" | sed -n 's/^public_key = "\(.*\)"$/\1/p')
[ -n "$ROOT_PUB" ] || die "bifrost-net root-key made no key ($ROOT_KEY)"
WG_KEY=$DIR/wg.key
WG_PUB=$("$BIN/bifrost-net" wg-key "$WG_KEY" | sed -n 's/^public_key = "\(.*\)"$/\1/p')
[ -n "$WG_PUB" ] || die "bifrost-net wg-key made no key ($WG_KEY)"

# --------------------------------------------------------- 2. enroll: POST /t/roots/enroll
# The enrollment helper (python, no deps): makes the DTLS identity, calls the trunk, shows the code
# and the QR, polls every 2 s, writes root.json + bridge.toml + brain.env when approved.
HELPER=$BIN/rootjoin-v1.py
copy "$HERE/rootjoin-v1.py" "$HELPER" 755

if [ $JOINED = 1 ]; then
  say "already joined: root $(confget ROOT_ID) of $TRUNK (no new enrollment; --uninstall to leave)"
else
  say "asking $TRUNK to let this computer join as \"$NAME\" ($OS, host $HOSTN)"
  "$PY" "$HELPER" enroll --state "$DIR" --trunk "$TRUNK" --name "$NAME" --os "$OS" --host "$HOSTN" \
    --arch "$ARCH" --root-pub "$ROOT_PUB" --wg-pub "$WG_PUB" --brain-port "$BRAIN_PORT" \
    --app-port "$APP_PORT" --bridge-port "$BRIDGE_PORT" ${QR_PNG:+--qr-png "$QR_PNG"} \
    || exit $?
fi
[ -f "$DIR/root.json" ] || die "no root.json — the enrollment did not complete"

# root.json (written by the helper on approval): root_id, peer_token, trunk url + key, wg addr…
ROOT_ID=$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["root_id"])' "$DIR/root.json")
PEER_TOKEN=$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("peer_token",""))' "$DIR/root.json")
TRUNK_KEY=$("$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); t=d.get("trunk"); print(d.get("trunk_key") or (t.get("trunk_key","") if isinstance(t,dict) else ""))' "$DIR/root.json")
[ "$TRUNK_KEY_BAKED" = '@TRUNK_KEY@' ] && TRUNK_KEY_BAKED=${YGG_TRUNK_KEY_BAKED:-}
[ -n "$TRUNK_KEY_BAKED" ] && [ -z "$TRUNK_KEY" ] && TRUNK_KEY=$TRUNK_KEY_BAKED
[ -n "$TRUNK_KEY" ] || die "root.json has no trunk key — run root.sh again (the enrollment will resume)"

# ------------------------------------------------- 3. the config: bridge.toml, brain.env, app.env
PIN=${PIN:-$(confget PIN)}
PIN=${PIN:-${YGG_TRUNK_PIN:-}}
PIN_TOML=''
[ -n "$PIN" ] && PIN_TOML="pin = \"$PIN\""
cat >"$DIR/bridge.toml.new" <<TOML
# GENERATED by root.sh — the bridge: dials the trunk as root $ROOT_ID. Mode 600 (the node key).
[node]
name = "$HOSTN"
private_key = "$(sed -n '1p' "$WG_KEY")"

[bridge]
http = "127.0.0.1:$BRIDGE_PORT"
media = "127.0.0.1:$((BRIDGE_PORT + 4))"
tokens_file = "$DIR/devices.json"
opencode_url = "http://127.0.0.1:$BRAIN_PORT"
dtls_cert_file = "$DIR/bridge-dtls.json"
public_url = "http://127.0.0.1:$BRIDGE_PORT"

[trunk]
url = "$TRUNK"
trunk_key = "$TRUNK_KEY"
root_key_file = "$ROOT_KEY"
root_id = "$ROOT_ID"
state_file = "$STATEF"
$PIN_TOML
upstream = "127.0.0.1:$APP_PORT"
wg_relay = "127.0.0.1:$WG_RELAY"
wg_local = "127.0.0.1:$WG_UDP"
TOML
chmod 600 "$DIR/bridge.toml.new"
if [ -f "$DIR/bridge.toml" ] && cmp -s "$DIR/bridge.toml.new" "$DIR/bridge.toml"; then rm -f "$DIR/bridge.toml.new"
else mv -f "$DIR/bridge.toml.new" "$DIR/bridge.toml"; CHANGED=1; fi

cat >"$DIR/wg.toml.new" <<TOML
# GENERATED by root.sh — this root's WireGuard node (peers: the trunk's signed directory).
[wg]
key_file = "$WG_KEY"
udp = "127.0.0.1:$WG_UDP"
relay = "127.0.0.1:$WG_RELAY"
http = "127.0.0.1:$WG_HTTP"
brain = "http://127.0.0.1:$BRAIN_PORT"
trunk_state = "$STATEF"
TOML
chmod 600 "$DIR/wg.toml.new"
if [ -f "$DIR/wg.toml" ] && cmp -s "$DIR/wg.toml.new" "$DIR/wg.toml"; then rm -f "$DIR/wg.toml.new"
else mv -f "$DIR/wg.toml.new" "$DIR/wg.toml"; CHANGED=1; fi

# brain.env (600): the model + the tree's lines (A5: YGG_ROOT_NAME is the root id, YGG_PEER_TOKEN its own)
{
  echo "# yggdrasil-root brain — written by root.sh. The model lines are kept; the rest is regenerated."
  [ -n "${YGG_UPSTREAM_BASE_URL:-}" ] && printf 'YGG_UPSTREAM_BASE_URL=%s\n' "$YGG_UPSTREAM_BASE_URL"
  [ -n "${YGG_UPSTREAM_STYLE:-}" ] && printf 'YGG_UPSTREAM_STYLE=%s\n' "$YGG_UPSTREAM_STYLE"
  [ -n "${YGG_UPSTREAM_MODEL:-}" ] && printf 'YGG_UPSTREAM_MODEL=%s\n' "$YGG_UPSTREAM_MODEL"
  [ -n "${YGG_UPSTREAM_API_KEY:-}" ] && printf 'YGG_UPSTREAM_API_KEY=%s\n' "$YGG_UPSTREAM_API_KEY"
  [ -n "${YGG_MAX_TOKENS:-}" ] && printf 'YGG_MAX_TOKENS=%s\n' "$YGG_MAX_TOKENS"
  echo ""
  echo "YGG_LISTEN=127.0.0.1:$BRAIN_PORT"
  echo "YGG_DATA_DIR=$DIR/data"
  echo "YGG_PROJECT_DIR=$PROJECT_DIR"
  echo "YGG_ROOT_NAME=$ROOT_ID"
  echo "YGG_ROOT_MAIN=1"
  echo "YGG_PEER_TOKEN=$PEER_TOKEN"
  echo "YGG_PEERS_FROM=http://127.0.0.1:$WG_HTTP/_wg/_roots"
  echo "YGG_PEERS_VIA=http://127.0.0.1:$WG_HTTP/_wg/{id}"
  echo "YGG_EXTENSIONS=librarian=http://127.0.0.1:$((BRAIN_PORT + 1))"
  echo "YGG_ARTIFACTS_DIR=$HOME/artifacts"
  echo "YGG_HARNESS_LIVE=$RUN/harness-live.json"
  echo "YGG_HARNESS_HELPER=http://127.0.0.1:$((BRAIN_PORT + 2))"
  echo "YGG_HARNESS_HELPER_TOKEN_FILE=$RUN/cclive.token"
} >"$DIR/brain.env.new"
chmod 600 "$DIR/brain.env.new"
if [ -f "$DIR/brain.env" ]; then
  # keep the model lines the owner set, replace the managed ones
  "$PY" - "$DIR/brain.env" "$DIR/brain.env.new" <<'PYEOF'
import sys, re
old, new = open(sys.argv[1]).read().split("\n\n", 1)[0], open(sys.argv[2]).read()
head, tail = new.split("\n\n", 1)
kept = [l for l in old.splitlines() if l.startswith("YGG_UPSTREAM") or l.startswith("YGG_MAX_TOKENS")]
merged = head + ("\n" + "\n".join(kept) if kept else "") + "\n\n" + tail
open(sys.argv[1], "w").write(merged + "\n" if not merged.endswith("\n") else merged)
PYEOF
  rm -f "$DIR/brain.env.new"
else
  mv -f "$DIR/brain.env.new" "$DIR/brain.env"; CHANGED=1
fi
# cc-live's token (fresh each install; the brain and the app read the file)
if [ ! -s "$RUN/cclive.token" ]; then
  (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$RUN/cclive.token")
fi
LIB_PORT=$((BRAIN_PORT + 1)); CCLIVE_PORT=$((BRAIN_PORT + 2))

# ------------------------------------------------------------------- 4. the app (optional)
APP_DIR=$DIR/app
if have app; then
  rm -rf "$APP_DIR.new"; mkdir -p "$APP_DIR.new"
  cp -a "$REPO/branch/." "$APP_DIR.new/" 2>/dev/null || die "no built app in the release ($REPO/branch)"
  [ -d "$APP_DIR.new/.next" ] || die "the release's app is not built"
  if [ -d "$APP_DIR" ] && [ -f "$APP_DIR/.next/BUILD_ID" ] && [ "$(cat "$APP_DIR/.next/BUILD_ID" 2>/dev/null)" = "$(cat "$APP_DIR.new/.next/BUILD_ID" 2>/dev/null)" ]; then
    rm -rf "$APP_DIR.new"
  else
    rm -rf "$APP_DIR"; mv "$APP_DIR.new" "$APP_DIR"; CHANGED=1
  fi
  NODE=$DIR/bin/node; copy "$REL_BIN/node" "$NODE" 755
  copy "$REPO/branch/server.mjs" "$APP_DIR/server.mjs" 644 2>/dev/null || true
  cat >"$DIR/app.env.new" <<EOF
PORT=$APP_PORT
HOST=127.0.0.1
NODE_ENV=production
OPENCODE_URL=http://127.0.0.1:$BRAIN_PORT
BIFROST_AUTH=trunk
BIFROST_TRUNK_STATE=$STATEF
BIFROST_TRUNK_URL=$TRUNK
BIFROST_TRUST_PROXY=1
BIFROST_BRIDGE_URL=http://127.0.0.1:$BRIDGE_PORT
CC_LIVE_URL=http://127.0.0.1:$CCLIVE_PORT
CC_LIVE_TOKEN_FILE=$RUN/cclive.token
ARTIFACTS_DIR=$HOME/artifacts
EOF
  chmod 600 "$DIR/app.env.new"
  if [ -f "$DIR/app.env" ] && cmp -s "$DIR/app.env.new" "$DIR/app.env"; then rm -f "$DIR/app.env.new"
  else mv -f "$DIR/app.env.new" "$DIR/app.env"; CHANGED=1; fi
else
  rm -rf "$APP_DIR"
fi

# ------------------------------------------------------------ 5. the run scripts (supervisor-agnostic)
put "$BIN/run-brain" 755 <<EOF
#!/bin/sh
# yggdrasil-root: the brain, with $DIR/brain.env (generated by root.sh)
while IFS= read -r l || [ -n "\$l" ]; do
  # shellcheck disable=SC2163
  case \$l in ''|'#'*) ;; *=*) export "\$l" ;; esac
done < '$DIR/brain.env'
cd "\$YGG_PROJECT_DIR" 2>/dev/null || cd || exit 1
exec '$BIN/yggdrasil'
EOF
put "$BIN/run-bridge" 755 <<EOF
#!/bin/sh
# yggdrasil-root: the bridge — dials the trunk as root $ROOT_ID (proto 2) (generated by root.sh)
exec '$BIN/bifrost-net' bridge -c '$DIR/bridge.toml'
EOF
put "$BIN/run-wg" 755 <<EOF
#!/bin/sh
# yggdrasil-root: this root's WireGuard node — its key never leaves $DIR/wg.key (generated by root.sh)
exec '$BIN/bifrost-net' wg -c '$DIR/wg.toml'
EOF
put "$BIN/run-app" 755 <<EOF
#!/bin/sh
# yggdrasil-root: the app (this root as a door) (generated by root.sh)
while IFS= read -r l || [ -n "\$l" ]; do
  # shellcheck disable=SC2163
  case \$l in ''|'#'*) ;; *=*) export "\$l" ;; esac
done < '$DIR/app.env'
cd '$APP_DIR' || exit 1
exec '$BIN/node' '$APP_DIR/server.mjs'
EOF
put "$BIN/run-librarian" 755 <<EOF
#!/bin/sh
# yggdrasil-root: the librarian (memory: index, recent, facts) (generated by root.sh)
exec '$PY' '$DIR/librarian/librarian.py' --root http://127.0.0.1:$BRAIN_PORT --port $LIB_PORT --db '$DIR/librarian.db' --artifacts '$HOME/artifacts'
EOF
put "$BIN/run-cclive" 755 <<EOF
#!/bin/sh
# yggdrasil-root: cc-live (the owner's terminal sessions, live on the phone) (generated by root.sh)
exec '$PY' '$DIR/cclive/cc_live.py' --port $CCLIVE_PORT --token-file '$RUN/cclive.token' --live-file '$RUN/harness-live.json' --claude claude
EOF
# cc-live + librarian: from the release (E7 fix: they are part of every root install now)
if have librarian && [ -f "$REPO/root/extensions/librarian/librarian.py" ]; then
  mkdir -p "$DIR/librarian"
  copy "$REPO/root/extensions/librarian/librarian.py" "$DIR/librarian/librarian.py" 755
fi
if have cclive && [ -f "$REPO/root/cc-live/cc_live.py" ]; then
  mkdir -p "$DIR/cclive"
  copy "$REPO/root/cc-live/cc_live.py" "$DIR/cclive/cc_live.py" 755
  for f in harness_agy.py harness_opencode.py transcript.py vt.py; do
    [ -f "$REPO/root/cc-live/$f" ] && copy "$REPO/root/cc-live/$f" "$DIR/cclive/$f" 644
  done
fi

# the nohup supervisor (no systemd / launchd): restarts each piece 5 s after it exits
put "$BIN/supervise" 755 <<EOF
#!/bin/sh
# yggdrasil-root: keeps the brain, bridge, wg node, app, librarian, cc-live alive (generated by root.sh)
echo \$\$ > '$RUN/supervise.pid'
pids=
loop() { # loop NAME CMD... — restart CMD 5 s after it exits
  name=\$1; shift
  ( child=
    trap '[ -n "\$child" ] && kill "\$child" 2>/dev/null; exit 0' TERM INT HUP
    while :; do
      "\$@" >>"$LOG/\$name.log" 2>&1 &
      child=\$!; wait "\$child"; rc=\$?
      echo "\$(date '+%F %T') \$name exited (\$rc), restarting in 5 s" >>"$LOG/\$name.log"
      sleep 5 & child=\$!; wait "\$child"
    done ) &
  pids="\$pids \$!"
}
loop brain '$BIN/run-brain'
loop bridge '$BIN/run-bridge'
loop wg '$BIN/run-wg'
$(have app && echo "loop app '$BIN/run-app'")
$(have librarian && echo "loop librarian '$BIN/run-librarian'")
$(have cclive && echo "loop cclive '$BIN/run-cclive'")
trap 'kill \$pids 2>/dev/null; rm -f "$RUN/supervise.pid"; exit 0' TERM INT HUP
wait
EOF
put "$BIN/start" 755 <<EOF
#!/bin/sh
# yggdrasil-root: start the services if they are not running. --hold: stay alive (WSL keepalive).
ours() { [ -n "\$1" ] && [ "\$1" != "\$\$" ] && kill -0 "\$1" 2>/dev/null || return 1
  { tr '\\0' ' ' <"/proc/\$1/cmdline" 2>/dev/null || ps -p "\$1" -o args= 2>/dev/null; } | grep -q -e "\$2" -e "\${3:-\$2}"; }
$(case $(pick_supervisor 2>/dev/null || echo nohup) in
  systemd) echo "systemctl --user start ${UNITS[*]}" ;;
  launchd) echo "for s in brain bridge app wg librarian cclive; do launchctl kickstart gui/\$(id -u)/$LABEL.\$s; done" ;;
  *) echo "p=\$(cat '$RUN/supervise.pid' 2>/dev/null); ours \"\$p\" '$BIN/supervise' || { nohup $(command -v setsid || echo '') '$BIN/supervise' >/dev/null 2>&1 </dev/null & }" ;;
esac)
[ "\${1:-}" = --hold ] || exit 0
h=\$(cat '$RUN/hold.pid' 2>/dev/null)
if ours "\$h" 'sleep infinity' 'start --hold'; then exit 0; fi
echo \$\$ > '$RUN/hold.pid'
[ "\$(uname -s)" = Linux ] && exec sleep infinity
while :; do sleep 3600; done
EOF
put "$BIN/stop" 755 <<EOF
#!/bin/sh
# yggdrasil-root: stop the services and the WSL keepalive hold (generated by root.sh)
ours() { [ -n "\$1" ] && [ "\$1" != "\$\$" ] && kill -0 "\$1" 2>/dev/null || return 1
  { tr '\\0' ' ' <"/proc/\$1/cmdline" 2>/dev/null || ps -p "\$1" -o args= 2>/dev/null; } | grep -q -e "\$2" -e "\${3:-\$2}"; }
$(case $(pick_supervisor 2>/dev/null || echo nohup) in
  systemd) echo "systemctl --user stop ${UNITS[*]}" ;;
  launchd) echo "for s in brain bridge app wg librarian cclive; do launchctl bootout gui/\$(id -u)/$LABEL.\$s; done" ;;
  *) echo "p=\$(cat '$RUN/supervise.pid' 2>/dev/null); ours \"\$p\" '$BIN/supervise' && kill \"\$p\"" ;;
esac)
h=\$(cat '$RUN/hold.pid' 2>/dev/null); ours "\$h" 'sleep infinity' 'start --hold' && kill "\$h" 2>/dev/null; rm -f '$RUN/hold.pid'
exit 0
EOF

# ---------------------------------------------------------------- 6. supervisor units + start
SUP=$(pick_supervisor)
{
  echo "# yggdrasil-root — written by root.sh; re-runs read it (pass an option to change a value)"
  echo "TRUNK=$TRUNK"; echo "PIN=$PIN"; echo "NAME=$NAME"; echo "ROOT_ID=$ROOT_ID"; echo "BRAIN_PORT=$BRAIN_PORT"
  echo "APP_PORT=$APP_PORT"; echo "BRIDGE_PORT=$BRIDGE_PORT"; echo "PROJECT_DIR=$PROJECT_DIR"
  echo "SUPERVISOR=$SUP"; echo "VERSION=${YGG_RELEASE:-$(unpacked | tail -1)}"
} | put "$CONF" 600

unit() { # unit NAME SCRIPT DESC AFTER
  put "$UNIT_DIR/yggdrasil-root-$1.service" 644 <<EOF
# yggdrasil-root: $4 (generated by root.sh)
[Unit]
Description=yggdrasil root $1 ($ROOT_ID @ $TRUNK)
$([ -n "${4:-}" ] && echo "After=$4" && echo "Wants=$4")

[Service]
Type=exec
ExecStart=$BIN/$2
Restart=always
RestartSec=3
StartLimitIntervalSec=0
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
}
plist() { # plist NAME KEEPALIVE EXTRA-XML ARG...
  local name=$1 keep=$2 extra=$3 a; shift 3
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    printf '<!-- yggdrasil-root: generated by root.sh -->\n<plist version="1.0">\n<dict>\n'
    printf '  <key>Label</key><string>%s.%s</string>\n  <key>ProgramArguments</key>\n<array>\n' "$LABEL" "$name"
    for a in "$@"; do printf '    <string>%s</string>\n' "$a"; done
    printf '  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><%s/>\n%b' "$keep" "$extra"
    printf '  <key>ThrottleInterval</key><integer>10</integer>\n'
    printf '  <key>StandardOutPath</key><string>%s/%s.log</string>\n  <key>StandardErrorPath</key><string>%s/%s.log</string>\n' "$LOG" "$name" "$LOG" "$name"
    printf '</dict>\n</plist>\n'
  } | put "$AGENT_DIR/$LABEL.$name.plist" 644
}
if [ "$SUP" = systemd ]; then
  mkdir -p "$UNIT_DIR"
  unit brain run-brain "the brain" ""
  unit bridge run-bridge "the bridge (dials the trunk)" yggdrasil-root-brain.service
  unit wg run-wg "the WireGuard node" yggdrasil-root-bridge.service
  have app && unit app run-app "the app (door)" yggdrasil-root-brain.service
  have librarian && unit librarian run-librarian "the librarian" yggdrasil-root-brain.service
  have cclive && unit cclive run-cclive "cc-live" ""
elif [ "$SUP" = launchd ]; then
  mkdir -p "$AGENT_DIR"
  plist brain true '' "$BIN/run-brain"
  plist bridge true '' "$BIN/run-bridge"
  plist wg true '' "$BIN/run-wg"
  have app && plist app true '' "$BIN/run-app"
  have librarian && plist librarian true '' "$BIN/run-librarian"
  have cclive && plist cclive true '' "$BIN/run-cclive"
fi
start_all() {
  [ $START = 1 ] || return 0
  local s dom; dom="gui/$(id -u)"
  case $SUP in
    systemd)
      systemctl --user daemon-reload
      systemctl --user enable --quiet ${UNITS[@]+"${UNITS[@]}"}
      if [ $CHANGED = 1 ] || ! systemctl --user is-active --quiet yggdrasil-root-brain.service; then
        systemctl --user restart ${UNITS[@]+"${UNITS[@]}"}; say "started ${UNITS[*]}"
      else say "running (unchanged)"
      fi
      ;;
    launchd)
      for s in brain bridge wg $(have app && echo app) $(have librarian && echo librarian) $(have cclive && echo cclive); do
        if launchctl print "$dom/$LABEL.$s" >/dev/null 2>&1; then
          [ $CHANGED = 0 ] && continue
          launchctl bootout "$dom/$LABEL.$s" 2>/dev/null || true
        fi
        launchctl bootstrap "$dom" "$AGENT_DIR/$LABEL.$s.plist"
      done
      say "started (launchd)"
      ;;
    nohup)
      local p; p=$(cat "$RUN/supervise.pid" 2>/dev/null || true)
      if pid_alive "$p" && proc_args "$p" | grep -q "$BIN/supervise" && [ $CHANGED = 0 ]; then
        say "supervisor already running (pid $p)"
      else
        [ -n "$p" ] && kill -TERM "$p" 2>/dev/null || true
        nohup "$BIN/supervise" >/dev/null 2>&1 </dev/null &
        for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$RUN/supervise.pid" ] && break; sleep 0.2; done
        say "supervisor started (pid $(cat "$RUN/supervise.pid" 2>/dev/null || echo '?'), logs in $LOG)"
        [ $OS = wsl ] || warn "no systemd user session: after a reboot run $BIN/start (or root.sh again)"
      fi
      ;;
  esac
}
start_all

# ------------------------------------------------------------------------- 7. health
if [ $START = 1 ]; then
  say "health checks"
  wait_http() { local c=000 u=$1; for _ in $(seq "${2:-30}"); do c=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$u" 2>/dev/null || true); [ "$c" = 200 ] && break; sleep 1; done; echo "$c"; }
  if [ "$(wait_http "http://127.0.0.1:$BRAIN_PORT/root" 30)" = 200 ]; then say "  brain   http://127.0.0.1:$BRAIN_PORT/root → 200"
  else warn "  brain   not answering yet (model set? $DIR/brain.env)"; fi
  [ -f "$STATEF" ] && say "  trunk   link $(sed -n 's/.*"state": *"\([a-z]*\)".*/\1/p' "$STATEF" | head -1) (trunk-state.json)"
  if have app && [ "$(wait_http "http://127.0.0.1:$APP_PORT/pair" 40)" = 200 ]; then say "  app     http://127.0.0.1:$APP_PORT → 200"
  else warn "  app     not answering yet"; fi
fi

# ------------------------------------------------------------------------------- the end
line() { printf '%s\n' "────────────────────────────────────────────────────────────────────────────────"; }
line
cat <<EOF
 This computer is a root of your tree: $TRUNK

  root id:   $ROOT_ID (name: $NAME)
  model:     ${YGG_UPSTREAM_BASE_URL:-not set yet — edit $DIR/brain.env, then: $BIN/stop && $BIN/start}
  What runs: the brain (:$BRAIN_PORT), the bridge (dials the trunk), the wg node$( [ -d "$APP_DIR" ] && echo ", the app (:$APP_PORT)")$( have librarian && echo ", the librarian")$( have cclive && echo ", cc-live")
  Reach it from your phone at $TRUNK — sign in there, this root appears under roots.

 Stop / start / remove:   $BIN/stop · $BIN/start · bash "$0" --uninstall
 Update:                  bash "$0" --update    (a major: --update --major)
EOF
[ "$SUP" = nohup ] && [ $OS != wsl ] && echo " No systemd here: after a reboot, run $BIN/start"
line
exit 0
