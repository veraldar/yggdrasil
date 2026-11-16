#!/usr/bin/env bash
# release.sh — build, stage and SIGN a yggdrasil release in dist/VERSION/ (what goes on the GitHub release).
#
#   scripts/release.sh 0.9.0             build from HEAD (the tree must be clean), stage, sign
#   scripts/release.sh 0.9.0 --no-build  re-stage + re-sign from the last build of this very HEAD
#
# TEST releases: YGG_RELEASE_KEY=<a throwaway key> (any key that is not RELEASE-KEY.pub's). Only then are
# --dirty (the working tree as it is), --no-build of another tree and X.Y.Z-tag versions allowed, and the
# installers are stamped YGG_RELEASE_TEST=1: they trust the signers in YGG_RELEASE_TEST_SIGNERS (a release
# signed with the real key never does). The real key never signs a test release: it refuses all three.
#
# dist/VERSION/
#   yggdrasil-VERSION-linux-x86_64.tar.gz   everything a home computer or another root needs, prebuilt (glibc 2.31+):
#       bin/ yggdrasil · bifrost-net (full) · bifrost-net-root (root build: no WebRTC/audio, no libopus)
#            livekit-server (install.sh's LIVEKIT_VERSION, sha256-checked) · node (official Node 24, sha256-checked)
#       branch/ the BUILT app (Next standalone + server.mjs) · branch/voice/ the voice agent's source + uv.lock
#       edge/ the local speech server · root/install/ · trunk/install/trunk.sh · trunk/deploy/sni-443.py
#       trunk/scripts/root-dial.py · RELEASE (what is inside) · RELEASE-KEY.pub · allowed_signers
#   install.sh · join.sh · trunk.sh         the three entry points, standalone (each pinned to VERSION)
#   bifrost-net-VERSION-linux-x86_64        the trunk's binary (trunk.sh on the VPS fetches only this)
#   bifrost-net-root-VERSION-linux-x86_64   the root build (older join.sh fetch it alone)
#   sni-443.py                              the :443 router trunk.sh --behind-proxy installs
#   SHA256SUMS · SHA256SUMS.sig             an OpenSSH signature (ssh-keygen -Y sign -n yggdrasil-release)
#
# Every installer embeds the release key's allowed_signers line (YGG_SIGNER=…) and refuses a release whose
# SHA256SUMS is not signed by it; this script refuses to sign when an installer's line differs from
# allowed_signers in the repo root.
#
# Env: YGG_RELEASE_KEY (default ~/.config/yggdrasil-release/release_ed25519: made here if absent — no passphrase,
#      mode 600; its public half goes in RELEASE-KEY.pub + allowed_signers, commit those). A passphrase-protected
#      key works too: loaded in ssh-agent (SSH_AUTH_SOCK) it signs through the agent, else ssh-keygen asks.
#      YGG_RELEASE_CACHE (~/.cache/yggdrasil-release: sources, cargo + npm caches, build dirs, downloads)
#      NODE_VERSION (default: the newest v24.x on nodejs.org) · LIVEKIT_VERSION (default: install.sh's)
#      DIST (default <repo>/dist)
# Needs: docker, git, curl, ssh-keygen, sha256sum, tar, xz.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

VERSION='' DIRTY=0 BUILD=1
while [ $# -gt 0 ]; do
  case $1 in
    --dirty) DIRTY=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) VERSION=${1#v} ;;
  esac
  shift
done
[ -n "$VERSION" ] || die "which version? scripts/release.sh 0.9.0"
printf '%s' "$VERSION" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' || die "version '$VERSION': X.Y.Z or X.Y.Z-tag"
for t in docker git curl ssh-keygen sha256sum tar xz; do command -v $t >/dev/null || die "needs $t"; done

KEY=${YGG_RELEASE_KEY:-$HOME/.config/yggdrasil-release/release_ed25519}
CACHE=${YGG_RELEASE_CACHE:-$HOME/.cache/yggdrasil-release}
DIST=${DIST:-$ROOT/dist}
OUT=$DIST/$VERSION
STAGE=$CACHE/stage/yggdrasil-$VERSION
SRC=$CACHE/src
UIDGID="$(id -u):$(id -g)"
mkdir -p "$CACHE"/{cargo,npm,target-bullseye,dl,app} "$DIST"
export TMPDIR=${TMPDIR:-$HOME/.cache/tmp}; mkdir -p "$TMPDIR"

# ------------------------------------------------------------------------------- the signing key
PROD_KEY=$HOME/.config/yggdrasil-release/release_ed25519
if [ ! -f "$KEY" ]; then
  [ "$KEY" = "$PROD_KEY" ] || die "no key at YGG_RELEASE_KEY=$KEY"
  [ -f "$ROOT/RELEASE-KEY.pub" ] && die "no release key at $KEY, but the repo's RELEASE-KEY.pub names one —
    copy that key here (YGG_RELEASE_KEY=…), or replace RELEASE-KEY.pub + allowed_signers + every YGG_SIGNER line on purpose"
  say "no release key yet: making $KEY (ed25519, no passphrase, mode 600 — decide where it lives)"
  mkdir -p "$(dirname "$KEY")"; chmod 700 "$(dirname "$KEY")"
  ssh-keygen -q -t ed25519 -N '' -C release@yggdrasil -f "$KEY"
fi
chmod 600 "$KEY"
# the public half: KEY.pub when it is there (no passphrase asked), else derived from the key
if [ -f "$KEY.pub" ]; then PUB=$(cut -d' ' -f1-2 "$KEY.pub"); else PUB=$(ssh-keygen -y -f "$KEY" | cut -d' ' -f1-2); fi
SIGNER="release@yggdrasil namespaces=\"yggdrasil-release\" $PUB"
if [ ! -f "$ROOT/RELEASE-KEY.pub" ]; then
  printf '%s release@yggdrasil\n' "$PUB" >"$ROOT/RELEASE-KEY.pub"; printf '%s\n' "$SIGNER" >"$ROOT/allowed_signers"
  say "wrote RELEASE-KEY.pub + allowed_signers — commit them, and set YGG_SIGNER in the installers to:"
  printf '    %s\n' "$SIGNER"
fi
REAL_SIGNER=$(cat "$ROOT/allowed_signers")
INSTALLERS=(root/install/install.sh root/install/join.sh trunk/install/trunk.sh root/install/rootjoin.py)
for f in "${INSTALLERS[@]}"; do   # every installer embeds the REAL key, whatever signs this release
  got=$(sed -n "s/^YGG_SIGNER *= *'\(.*\)'\$/\1/p" "$ROOT/$f" | head -1)
  [ "$got" = "$REAL_SIGNER" ] || die "$f embeds another release key (YGG_SIGNER) than allowed_signers — refusing to sign"
done
TEST=0
if [ "$(cut -d' ' -f1-2 "$ROOT/RELEASE-KEY.pub")" = "$PUB" ]; then
  [ "$SIGNER" = "$REAL_SIGNER" ] || die "allowed_signers does not hold: $SIGNER"
  # the real key signs real releases only: from a clean HEAD, a plain X.Y.Z
  [ $DIRTY = 0 ] || die "--dirty is for TEST releases: the release key never signs one (YGG_RELEASE_KEY=<a throwaway key>)"
  case $VERSION in *-*) die "$VERSION is a pre-release/test version: the release key never signs one (YGG_RELEASE_KEY=<a throwaway key>)" ;; esac
  [ -z "$(git -C "$ROOT" status --porcelain)" ] || die "the tree has changes: the release key signs a clean HEAD only (commit them)"
  if [ $BUILD = 0 ] && [ "$(cat "$CACHE/describe" 2>/dev/null)" != "$(git -C "$ROOT" describe --tags --always)" ]; then
    die "--no-build: the last build ($(cat "$CACHE/describe" 2>/dev/null || echo none)) is not this HEAD — build it (no --no-build)"
  fi
else
  TEST=1
  printf '\033[1;33m!!\033[0m  %s\n' "TEST release: signed by $KEY, not the release key — its installers are marked YGG_RELEASE_TEST=1 and trust" \
    "    only YGG_RELEASE_TEST_SIGNERS. Never publish it." >&2
fi
sign() { # FILE → FILE.sig: through ssh-agent when it holds the key (a passphrase-protected key), else the key file
  local pubfile
  if [ -n "${SSH_AUTH_SOCK:-}" ] && ssh-add -L 2>/dev/null | cut -d' ' -f1-2 | grep -qxF "$PUB"; then
    pubfile=$(mktemp); printf '%s release@yggdrasil\n' "$PUB" >"$pubfile"
    ssh-keygen -q -Y sign -f "$pubfile" -n yggdrasil-release "$1"; rm -f "$pubfile"
  else
    ssh-keygen -q -Y sign -f "$KEY" -n yggdrasil-release "$1"
  fi
}

# ------------------------------------------------------------------------------------- sources
if [ $BUILD = 1 ]; then
  if [ $DIRTY = 0 ]; then
    [ -z "$(git -C "$ROOT" status --porcelain)" ] || die "the tree has changes: commit them (or --dirty, for a TEST release)"
    DESCRIBE=$(git -C "$ROOT" describe --tags --always)
    say "sources: HEAD ($DESCRIBE)"
    rm -rf "$SRC"; mkdir -p "$SRC"
    git -C "$ROOT" archive --format=tar HEAD | tar -xf - -C "$SRC"
  else
    DESCRIBE="$(git -C "$ROOT" describe --tags --always)-dirty"
    say "sources: the working tree as it is ($DESCRIBE)"
    rm -rf "$SRC"; mkdir -p "$SRC"
    (cd "$ROOT" && git ls-files -co --exclude-standard -z | tar --null -cf - -T -) | tar -xf - -C "$SRC"
  fi
  printf '%s\n' "$DESCRIBE" >"$CACHE/describe"
  EPOCH=$(git -C "$ROOT" log -1 --format=%ct); printf '%s\n' "$EPOCH" >"$CACHE/epoch"
else
  [ -d "$SRC" ] && [ -x "$CACHE/target-bullseye/root/release/yggdrasil" ] && [ -d "$CACHE/app/standalone" ] || die "--no-build: nothing built yet"
  DESCRIBE=$(cat "$CACHE/describe"); EPOCH=$(cat "$CACHE/epoch")
  say "--no-build: the last build ($DESCRIBE); scripts and docs from the working tree"
fi

# --------------------------------------------------------------------------------- the binaries
if [ $BUILD = 1 ]; then
  # built on Debian 11 (glibc 2.31): the binaries then run on Debian 11+ / Ubuntu 20.04+ (the installers check it)
  say "rust: yggdrasil, bifrost-net (full), bifrost-net (root build) — docker rust:1-bullseye (glibc 2.31)"
  printf 'FROM rust:1-bullseye\nRUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libopus-dev pkg-config >/dev/null && rm -rf /var/lib/apt/lists/*\n' |
    docker build -q -t ygg-release-build:bullseye - >/dev/null
  docker run --rm -v "$SRC:/src" -v "$CACHE/cargo:/usr/local/cargo/registry" -v "$CACHE/target-bullseye:/target" \
    ygg-release-build:bullseye bash -c "
      set -e; rc=0
      (cd /src/root && cargo build --release --locked -q --target-dir /target/root) &&
      (cd /src/trunk && cargo build --release --locked -q --target-dir /target/trunk) &&
      (cd /src/trunk && cargo build --release --locked -q --no-default-features --target-dir /target/trunk-root) || rc=\$?
      chown -R $UIDGID /target /usr/local/cargo/registry; exit \$rc" || die "cargo build failed"

  say "app: npm ci + next build (standalone) — docker node:24-bookworm"
  rm -rf "$CACHE/app"; mkdir -p "$CACHE/app"
  docker run --rm -v "$SRC:/src" -v "$CACHE/npm:/root/.npm" -v "$CACHE/app:/out" -w /src/branch \
    -e NEXT_TELEMETRY_DISABLED=1 node:24-bookworm bash -c "
      set -e; rc=0
      { npm ci --no-audit --no-fund --loglevel=error &&
        npm version --no-git-tag-version --allow-same-version '$VERSION' >/dev/null &&
        NEXT_OUTPUT=standalone npx next build >/out/build.log 2>&1 &&
        cp -a .next/standalone /out/standalone && cp -a .next/static /out/standalone/.next/static &&
        cp -a public artifacts-builtin server.mjs /out/standalone/; } || rc=\$?
      chown -R $UIDGID /src /root/.npm /out; exit \$rc" || { tail -30 "$CACHE/app/build.log" 2>/dev/null; die "app build failed"; }
fi

# node: the newest 24.x (or NODE_VERSION), checked against nodejs.org's SHASUMS256.txt
NODE_VERSION=${NODE_VERSION:-$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c \
  'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["version"].startswith("v24.")))')}
NODE_VERSION=v${NODE_VERSION#v}
NTAR=node-$NODE_VERSION-linux-x64.tar.xz
if [ ! -s "$CACHE/dl/$NTAR.ok" ]; then
  say "node $NODE_VERSION from nodejs.org (sha256 against SHASUMS256.txt)"
  curl -fsSL -o "$CACHE/dl/node-SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  curl -fsSL -o "$CACHE/dl/$NTAR" "https://nodejs.org/dist/$NODE_VERSION/$NTAR"
  want=$(grep "  $NTAR\$" "$CACHE/dl/node-SHASUMS256-$NODE_VERSION.txt" | cut -c1-64)
  [ -n "$want" ] && [ "$(sha256sum <"$CACHE/dl/$NTAR" | cut -c1-64)" = "$want" ] || die "$NTAR does not match nodejs.org's SHASUMS256.txt"
  echo "$want" >"$CACHE/dl/$NTAR.ok"
fi
# livekit-server: the version install.sh pins, checked against the release's checksums.txt
# shellcheck disable=SC2016  # the ${…} is install.sh's text, matched literally
LIVEKIT_VERSION=${LIVEKIT_VERSION:-$(sed -n 's/^LIVEKIT_VERSION=\${LIVEKIT_VERSION:-\(.*\)}$/\1/p' "$ROOT/root/install/install.sh")}
[ -n "$LIVEKIT_VERSION" ] || die "no LIVEKIT_VERSION in root/install/install.sh"
LTGZ=livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz
if [ ! -s "$CACHE/dl/$LTGZ.ok" ]; then
  say "livekit-server $LIVEKIT_VERSION from github.com/livekit/livekit (sha256 against checksums.txt)"
  LREL=https://github.com/livekit/livekit/releases/download/v$LIVEKIT_VERSION
  curl -fsSL -o "$CACHE/dl/livekit-checksums-$LIVEKIT_VERSION.txt" "$LREL/checksums.txt"
  curl -fsSL -o "$CACHE/dl/$LTGZ" "$LREL/$LTGZ"
  want=$(grep " $LTGZ\$" "$CACHE/dl/livekit-checksums-$LIVEKIT_VERSION.txt" | cut -c1-64)
  [ -n "$want" ] && [ "$(sha256sum <"$CACHE/dl/$LTGZ" | cut -c1-64)" = "$want" ] || die "$LTGZ does not match its checksums.txt"
  echo "$want" >"$CACHE/dl/$LTGZ.ok"
fi

# ------------------------------------------------------------------------------------- the stage
stamp() { # FILE — this release's version into an installer (YGG_RELEASE='' → YGG_RELEASE='VERSION'); a test release
  #          is marked too (YGG_RELEASE_TEST='' → '1': only then does it trust YGG_RELEASE_TEST_SIGNERS)
  sed -i "s/^YGG_RELEASE=''/YGG_RELEASE='$VERSION'/" "$1"
  grep -q "^YGG_RELEASE='$VERSION'" "$1" || die "could not stamp the version into $1"
  grep -q "^YGG_RELEASE_TEST=''" "$1" || die "$1 has no YGG_RELEASE_TEST line"
  if [ $TEST = 1 ]; then sed -i "s/^YGG_RELEASE_TEST=''/YGG_RELEASE_TEST='1'/" "$1"; fi
}
say "stage $STAGE"
rm -rf "$STAGE"; mkdir -p "$STAGE"/{bin,branch,edge,root/install,trunk/install,trunk/deploy,trunk/scripts}
T=$CACHE/target-bullseye
install -m 755 "$T/root/release/yggdrasil" "$STAGE/bin/yggdrasil"
install -m 755 "$T/trunk/release/bifrost-net" "$STAGE/bin/bifrost-net"
install -m 755 "$T/trunk-root/release/bifrost-net" "$STAGE/bin/bifrost-net-root"
tar -xJf "$CACHE/dl/$NTAR" -C "$TMPDIR" "node-$NODE_VERSION-linux-x64/bin/node" "node-$NODE_VERSION-linux-x64/LICENSE"
install -m 755 "$TMPDIR/node-$NODE_VERSION-linux-x64/bin/node" "$STAGE/bin/node"
install -m 644 "$TMPDIR/node-$NODE_VERSION-linux-x64/LICENSE" "$STAGE/bin/node.LICENSE"
rm -rf "$TMPDIR/node-$NODE_VERSION-linux-x64"
tar -xzf "$CACHE/dl/$LTGZ" -C "$STAGE/bin" livekit-server && chmod 755 "$STAGE/bin/livekit-server"
cp -a "$CACHE/app/standalone/." "$STAGE/branch/"
rm -f "$STAGE/branch/server.js"   # Next's own entry: ours is server.mjs (peer-stamped, see its header)
# the voice agent's source + lock (its venv is made at install time, as before)
(cd "$SRC/branch/voice" && find . -path ./.venv -prune -o -name __pycache__ -prune -o -path ./tests -prune -o -type f -print0 |
  tar --null -cf - -T -) | tar -xf - -C "$STAGE/branch" --one-top-level=voice
for f in voice_server.py get_models.sh requirements.txt; do install -m 644 "$SRC/edge/$f" "$STAGE/edge/$f"; done
chmod 755 "$STAGE/edge/get_models.sh"
# installers and scripts: from the working tree (--no-build re-stages edited scripts), same as HEAD otherwise
for f in "$ROOT"/root/install/*; do
  [ -f "$f" ] || continue
  case $(basename "$f") in join-test.*|PKGBUILD) continue ;; esac
  install -m "$( [ -x "$f" ] && echo 755 || echo 644 )" "$f" "$STAGE/root/install/"
done
install -m 755 "$ROOT/trunk/install/trunk.sh" "$STAGE/trunk/install/trunk.sh"
install -m 755 "$ROOT/trunk/deploy/sni-443.py" "$STAGE/trunk/deploy/sni-443.py"
install -m 755 "$ROOT/trunk/scripts/root-dial.py" "$STAGE/trunk/scripts/root-dial.py"
install -m 644 "$ROOT/LICENSE" "$ROOT/RELEASE-KEY.pub" "$ROOT/allowed_signers" "$STAGE/"
for f in "${INSTALLERS[@]}"; do stamp "$STAGE/$f"; done
cat >"$STAGE/RELEASE" <<EOF
yggdrasil $VERSION
source $DESCRIBE
node $NODE_VERSION (nodejs.org, sha256 checked)
livekit-server $LIVEKIT_VERSION (github.com/livekit/livekit, sha256 checked)
built rust:1-bullseye (glibc 2.31: Debian 11+, Ubuntu 20.04+) · node:24-bookworm (Next standalone)
EOF
# what runs must run: the binaries start, node runs the app's server module far enough to load Next
"$STAGE/bin/yggdrasil" --version >/dev/null 2>&1 || "$STAGE/bin/yggdrasil" --help >/dev/null 2>&1 || true
"$STAGE/bin/node" --version | grep -q "^$NODE_VERSION\$" || die "bin/node is not $NODE_VERSION"
"$STAGE/bin/livekit-server" --version | grep -q "$LIVEKIT_VERSION" || die "bin/livekit-server is not $LIVEKIT_VERSION"
[ -f "$STAGE/branch/.next/BUILD_ID" ] && [ -d "$STAGE/branch/node_modules/next" ] || die "the app build is incomplete"
# nothing in the release may need a newer glibc than the installers promise (MIN_GLIBC: Debian 11, Ubuntu 20.04)
MIN_GLIBC=$(sed -n 's/^MIN_GLIBC=\([0-9.]*\).*/\1/p' "$ROOT/root/install/install.sh")
if command -v objdump >/dev/null; then
  while IFS= read -r -d '' f; do
    g=$(objdump -T "$f" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -Vu | tail -1 || true)
    [ -z "$g" ] || [ "$(printf '%s\n%s\n' "$g" "$MIN_GLIBC" | sort -V | tail -1)" = "$MIN_GLIBC" ] ||
      die "${f#"$STAGE"/} needs glibc $g, newer than the $MIN_GLIBC the installers promise"
  done < <(find "$STAGE/bin" "$STAGE/branch/node_modules" -type f \( -perm -u+x -o -name '*.node' -o -name '*.so*' \) -print0)
else
  printf '\033[1;33m!!\033[0m  %s\n' "no objdump here: the glibc needs of the binaries are not checked (binutils)" >&2
fi
for f in root/install/install.sh root/install/join.sh trunk/install/trunk.sh root/install/pair.sh; do bash -n "$STAGE/$f" || die "$f: syntax"; done
python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$STAGE/root/install/rootjoin.py" || die "rootjoin.py: syntax"

# ------------------------------------------------------------------------------- dist/VERSION
say "dist $OUT"
rm -rf "$OUT"; mkdir -p "$OUT"
TGZ=yggdrasil-$VERSION-linux-x86_64.tar.gz
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$EPOCH" -C "$(dirname "$STAGE")" -cf - "yggdrasil-$VERSION" |
  gzip -n -6 >"$OUT/$TGZ"
install -m 755 "$STAGE/root/install/install.sh" "$OUT/install.sh"
install -m 755 "$STAGE/root/install/join.sh" "$OUT/join.sh"
install -m 755 "$STAGE/trunk/install/trunk.sh" "$OUT/trunk.sh"
install -m 755 "$STAGE/bin/bifrost-net" "$OUT/bifrost-net-$VERSION-linux-x86_64"
install -m 755 "$STAGE/bin/bifrost-net-root" "$OUT/bifrost-net-root-$VERSION-linux-x86_64"
install -m 644 "$STAGE/trunk/deploy/sni-443.py" "$OUT/sni-443.py"
(cd "$OUT" && sha256sum -- * | LC_ALL=C sort -k2 >SHA256SUMS)
sign "$OUT/SHA256SUMS"   # → SHA256SUMS.sig
VERIFY_SIGNERS=$ROOT/allowed_signers
if [ $TEST = 1 ]; then VERIFY_SIGNERS=$(mktemp); printf '%s\n' "$SIGNER" >"$VERIFY_SIGNERS"; fi
ssh-keygen -Y verify -f "$VERIFY_SIGNERS" -I release@yggdrasil -n yggdrasil-release -s "$OUT/SHA256SUMS.sig" \
  <"$OUT/SHA256SUMS" >/dev/null || die "the fresh signature does not verify (signer: $SIGNER)"
(cd "$OUT" && sha256sum -c --quiet SHA256SUMS) || die "SHA256SUMS does not match dist"
echo
(cd "$OUT" && for f in *; do printf '    %8s  %s\n' "$(du -k "$f" | cut -f1)K" "$f"; done)
# the lay guides name the release in their download lines: say so when they name another one
for d in docs/own-trunk.md root/install/README.md; do
  other=$(grep -o 'releases/download/v[0-9][0-9A-Za-z.+-]*/' "$ROOT/$d" | grep -v "/v$VERSION/" | sort -u | tr '\n' ' ' || true)
  [ -z "$other" ] || printf '\033[1;33m!!\033[0m  %s still downloads from %s— point it at v%s before publishing\n' "$d" "$other" "$VERSION"
done
if [ $TEST = 1 ]; then
  printf '\n  dist/%s is a TEST release, signed by %s (a throwaway key). NEVER publish it.\n' "$VERSION" "$KEY"
  exit 0
fi
cat <<EOF

  dist/$VERSION is signed (SHA256SUMS.sig, key $(ssh-keygen -lf "$KEY" | awk '{print $2}')).
  Publish: create the GitHub release v$VERSION and upload EVERY file above.
  Check one:  ssh-keygen -Y verify -f allowed_signers -I release@yggdrasil -n yggdrasil-release \\
                -s SHA256SUMS.sig < SHA256SUMS && sha256sum -c SHA256SUMS
EOF
