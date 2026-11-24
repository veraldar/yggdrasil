#!/usr/bin/env bash
# The root-part id of a commit: which build of the parts a joined root runs (brain, node, installer,
# dialer). The same as root/build.rs computes into the brain (root/src/build_id.rs — PATHS below must
# stay its PATHS; a cargo test checks it). An app-only commit keeps the id.
#   scripts/root-part-id.sh [COMMIT]        12 hex (default HEAD)
#   scripts/root-part-id.sh --env [COMMIT]  YGG_BUILD_ID/_COMMIT/_EPOCH/_DESCRIBE, one per line: what a
#       build without git needs (release.sh's Debian-11 container and macOS builds compile a
#       `git archive` copy), e.g. docker run --env-file <(scripts/root-part-id.sh --env <sha>) …
#   scripts/root-part-id.sh --paths         the paths it covers (word list)
# A commit is clean by definition: build a tree with changes in a checkout (build.rs gives it dirty-…).
set -euo pipefail
PATHS="root/build.rs root/src root/Cargo.toml root/Cargo.lock trunk/src trunk/Cargo.toml trunk/Cargo.lock root/install/join.sh root/install/rootjoin.py trunk/scripts/root-dial.py"
[ "${1:-}" = --paths ] && { echo "$PATHS"; exit 0; }
ENV=0
[ "${1:-}" = --env ] && { ENV=1; shift; }
REPO=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
C=$(git -C "$REPO" rev-parse --verify "${1:-HEAD}^{commit}")
# shellcheck disable=SC2086 # PATHS is a word list
ID=$(git -C "$REPO" -c core.quotePath=true ls-tree -r "$C" -- $PATHS | sha256sum | cut -c1-12)
if [ $ENV = 0 ]; then echo "$ID"; exit 0; fi
printf 'YGG_BUILD_ID=%s\nYGG_BUILD_COMMIT=%s\nYGG_BUILD_EPOCH=%s\nYGG_BUILD_DESCRIBE=%s\n' "$ID" "$C" \
  "$(git -C "$REPO" log -1 --format=%ct "$C")" "$(git -C "$REPO" describe --tags --always "$C")"
