#!/usr/bin/env bash
# join-test.sh — run join-test.py (join.sh against a fake hub + trunk) here, or in a clean container.
#
#   ./join-test.sh [--brain-bin PATH]                       on this machine (python3, openssl, zbarimg)
#   ./join-test.sh --docker [IMAGE] [--brain-bin PATH]      in a fresh IMAGE (default ubuntu:24.04): the repo is
#                                                           mounted read-only, the brain binary too; apt installs
#                                                           what join.sh needs + the test's own tools
# The brain binary defaults to root/target/release/yggdrasil (cargo build --release in root/); the node's two builds
# are taken from trunk/target (cargo build --release · … --no-default-features --target-dir target/root).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
BRAIN=$REPO/root/target/release/yggdrasil IMAGE=
while [ $# -gt 0 ]; do
  case $1 in
    --brain-bin) BRAIN=$2; shift ;;
    --docker) IMAGE=ubuntu:24.04; case ${2:-} in ''|--*) ;; *) IMAGE=$2; shift ;; esac ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done
[ -x "$BRAIN" ] || { echo "no brain binary at $BRAIN (cargo build --release in root/, or --brain-bin)" >&2; exit 1; }
# the node's two builds, where join.sh looks in a checkout (without them it would fetch the published release's)
for b in "$REPO/trunk/target/release/bifrost-net" "$REPO/trunk/target/root/release/bifrost-net"; do
  [ -x "$b" ] || { echo "no bifrost-net at $b — in trunk/: cargo build --release, and
  cargo build --release --no-default-features --target-dir target/root" >&2; exit 1; }
done
BRAIN=$(cd "$(dirname "$BRAIN")" && pwd)/$(basename "$BRAIN")
for f in "$HERE/join.sh" "$HERE/join-test.sh" "$REPO/win/wsl-bootstrap.sh"; do bash -n "$f"; done

if [ -z "$IMAGE" ]; then
  exec python3 "$HERE/join-test.py" --brain-bin "$BRAIN"
fi
# RUNTIME = what join.sh needs on a minimal Ubuntu (libopus0: the full bifrost-net links it; curl + openssh-client:
# the signed release is fetched and its signature checked), WSL = + what win/wsl-bootstrap.sh needs (nothing more:
# perl-base and util-linux's setsid are in every Ubuntu); TEST = the referee's own tools
RUNTIME="python3 ca-certificates libopus0 curl openssh-client" WSL="" TEST="openssl zbar-tools"
exec docker run --rm -v "$REPO:/repo:ro" -v "$BRAIN:/opt/brain/yggdrasil:ro" "$IMAGE" bash -c "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends $RUNTIME $WSL $TEST >/dev/null
  echo \"image $IMAGE: \$(. /etc/os-release; echo \$PRETTY_NAME) · apt-installed: runtime [$RUNTIME] wsl-bootstrap [$WSL] test [$TEST] · qrencode: \$(command -v qrencode || echo absent)\"
  id ubuntu >/dev/null 2>&1 || useradd -m ubuntu
  exec runuser -u ubuntu -- python3 /repo/root/install/join-test.py --brain-bin /opt/brain/yggdrasil
"
