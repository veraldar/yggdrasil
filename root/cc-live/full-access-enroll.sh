#!/usr/bin/env bash
# full-access-enroll.sh — mint the owner's full-access key, AT THE COMPUTER (owner 11-17).
#
# The key is what turns a signed request from the phone into a grant (full_access.py): it lives
# here, outside every sandbox, so nothing running inside one (MAIN, an agent, a request inside a
# message) can mint or change it. A PERSON runs this, at a real terminal: it refuses without one
# and writes the code to that terminal only — never to a pipe, a log or an agent's tool output.
# (11-18: an agent minted a key "on the owner's say-so" and the code ended up in MAIN's transcript,
# readable from inside the sandbox — so no agent runs this, whoever asks.)
#
#   full-access-enroll.sh                    the key for the box you open (default dir, below)
#   full-access-enroll.sh /some/dir          a key somewhere else (cc-live's --access-dir must match)
#
# It prints the code ONCE: type it into the phone (session settings › full access). The phone
# keeps it and signs grants with it; the box keeps only owner.key (0600) and verifies.
#
# Again on an enrolled box: a NEW key replaces the old one — every phone holding the old code
# stops granting until it types the new one (turning full access off needs no key, ever).
set -euo pipefail
if ! { [ -t 0 ] && [ -t 1 ] && [ -w /dev/tty ]; }; then
  echo "full-access-enroll.sh: run it yourself, at a real terminal (no agent, no pipe): the code must reach only you" >&2
  exit 2
fi
DIR=${1:-${FULL_ACCESS_DIR:-$HOME/.cache/root-sim/full-access}}
HERE=$(cd "$(dirname "$0")" && pwd)

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
CODE=$(python3 - <<'PY'
import secrets
a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"  # the alphabet the phone's signature uses (code_bytes)
print("-".join("".join(secrets.choice(a) for _ in range(4)) for _ in range(8)))
PY
)
printf '%s\n' "$CODE" > "$DIR/owner.key"
chmod 600 "$DIR/owner.key"

# the key must work as the helper will read it: long enough after its reading-normalization
python3 - "$HERE" "$DIR/owner.key" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import full_access as fa
k = fa.code_bytes(open(sys.argv[2]).read())
assert len(k) >= 16, f"key too short after normalization ({len(k)} chars)"
print(f"key checks out: {len(k)} signing characters")
PY

echo "enrolled: $DIR/owner.key (0600, outside every sandbox)"
echo "type this code into the phone ONCE — a Claude Code / Antigravity session's settings › full access."
echo "never paste it into a chat or a session: anything that reads it can grant itself full access."
printf '%s\n' "$CODE" > /dev/tty
