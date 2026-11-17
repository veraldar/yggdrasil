#!/usr/bin/env bash
# release-v090.sh — for a shell OUTSIDE the :8447 sandbox (the :8443 opencode, or a terminal on omarchy):
# deploy :8447's app, then publish yggdrasil v0.9.0. Stops at the first failure; every step logs a line
# "== OK n" / "== FAIL n: why". Run it detached so the log survives:
#   setsid nohup bash ~/Work/root-coord/lab/root-sim/release-v090.sh > ~/Work/root-coord/lab/root-sim/release-v090.log 2>&1 &
# Not in here, on purpose: the VPS upgrade and the veraldar.org update (the owner runs those).
set -uo pipefail
# a shell outside the sandbox may start with a service's short PATH: the tools installed with mise
for d in "$HOME/.local/bin" "$HOME"/.local/share/mise/installs/gh/*/gh_*/bin "$HOME/.local/share/mise/installs/node/latest/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
T=$HOME/Work/tree-next
U=https://github.com/veraldar/yggdrasil/releases/download/v0.9.0
step() { echo "== STEP $1 $(date +%T): $2"; }
ok() { echo "== OK $1 $(date +%T)"; }
die() { echo "== FAIL $1: $2"; exit 1; }

step 0 "deploy :8447's app (the mic, tags on every row, the terminal key, newest message first)"
bash "$HOME/Work/root-coord/lab/root-sim/preview-app-up.sh" || die 0 "the app build/restart"
ok 0

step 1 "push tree-next (PR #6's branch)"
cd "$T" || die 1 "no $T"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die 1 "tree-next has uncommitted changes"
git push origin tree-next || die 1 "git push"
ok 1

step 2 "build + sign v0.9.0 from HEAD $(git -C "$T" rev-parse --short HEAD)"
[ -d dist/0.9.0 ] && mv dist/0.9.0 "dist/0.9.0.prev-$(date +%m%d%H%M)"
TMPDIR=$HOME/.cache/tmp bash scripts/release.sh 0.9.0 || die 2 "scripts/release.sh"
( cd dist/0.9.0 && ssh-keygen -Y verify -f ../../allowed_signers -I release@yggdrasil -n yggdrasil-release -s SHA256SUMS.sig < SHA256SUMS && sha256sum -c SHA256SUMS ) || die 2 "signature or checksums"
tar -xzOf dist/0.9.0/yggdrasil-0.9.0-linux-x86_64.tar.gz yggdrasil-0.9.0/RELEASE | head -2
ok 2

step 3 "merge PR #6 into main (the owner said go, 11-17)"
gh pr merge 6 --repo veraldar/yggdrasil --merge || die 3 "gh pr merge"
git fetch -q origin && git log -1 --format='main is now %h %s' origin/main
ok 3

step 4 "publish v0.9.0 with its signed files"
gh release create v0.9.0 dist/0.9.0/* --repo veraldar/yggdrasil --target main \
  --title "v0.9.0 — your own trunk end to end, one signed command to install" \
  --notes-file dist/RELEASE-NOTES-0.9.0.md || die 4 "gh release create"
ok 4

step 5 "check it as a user would: download, verify the signature, the checksums"
D=$(mktemp -d) && cd "$D" || die 5 "no temp dir"
for f in SHA256SUMS SHA256SUMS.sig install.sh trunk.sh join.sh; do curl -fsSLO "$U/$f" || die 5 "download $f"; done
ssh-keygen -Y verify -f "$T/allowed_signers" -I release@yggdrasil -n yggdrasil-release -s SHA256SUMS.sig < SHA256SUMS || die 5 "signature"
sha256sum -c --ignore-missing SHA256SUMS || die 5 "checksums"
ok 5
echo "== ALL DONE $(date +%T) — next, the owner: the VPS upgrade, then veraldar.org (site-v0.9.0.sh)"
