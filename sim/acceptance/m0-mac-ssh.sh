#!/usr/bin/env bash
# m0-mac-ssh.sh — phase 0, plan §5.3 M0: prepare omarchy's side of the Mac Studio ssh.
# The owner's part (once, at the Mac): System Settings → General → Sharing → Remote Login: on,
# then paste the one line this script prints. This script:
#   1. prints the line (omarchy's public key → the Mac's authorized_keys — public key only);
#   2. checks ssh until it answers (then fixes ~/.ssh/config's stale Host mac entry);
#   3. verifies: ssh mac 'sw_vers -productVersion; uname -m; whoami'.
# Nothing is installed on the Mac by this script.
set -euo pipefail
PUBKEY="$HOME/.ssh/id_ed25519.pub"

# omarchy's keypair: make one if none exists (no passphrase: the AI uses it unattended)
if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
  ssh-keygen -t ed25519 -N '' -C "omarchy-ai" -f "$HOME/.ssh/id_ed25519" >/dev/null
  echo "made a new keypair: $HOME/.ssh/id_ed25519"
fi

# the Mac Studio on the tailnet (dweeb-xzys-mac-studio, 100.121.228.32); the ssh user on it is
# unknown until Remote Login answers — macOS defaults to the short user name of the logged-in
# user; try the tailnet hostname's suffix first (dweeb), then dweeb_xyz, then the old Host entry's.
MAC_HOST=$(tailscale status 2>/dev/null | awk '/dweeb-xzys-mac-studio/ {print $1; exit}')
[ -n "$MAC_HOST" ] || MAC_HOST=dweeb-xzys-mac-studio
MAC_IP=$(tailscale status 2>/dev/null | awk '/dweeb-xzys-mac-studio/ {print $2; exit}')

echo "────────────────────────────────────────────────────────────────"
echo "OWNER STEP (once, at the Mac Studio — about 2 minutes):"
echo "1. System Settings → General → Sharing → turn Remote Login ON."
echo "2. Open Terminal and paste this one line:"
echo ""
echo "mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\n' '$(cat "$PUBKEY")' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo added"
echo ""
echo "────────────────────────────────────────────────────────────────"
echo "then run: bash $0 --wait   (this box polls until ssh answers and finishes the setup)"

if [ "${1:-}" != "--wait" ]; then exit 0; fi

# wait for ssh to answer on the tailnet IP (Remote Login on): try the likely users
FOUND=""
for user in dweeb dweeb_xyz $(awk '/^Host mac$/{f=1;next} f&&/User/{print $2;exit}' "$HOME/.ssh/config" 2>/dev/null); do
  for host in "$MAC_IP" "$MAC_HOST"; do
    for _ in $(seq 1 6); do
      if ssh -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new \
             "$user@$host" 'true' 2>/dev/null; then FOUND="$user@$host"; break 2; fi
      sleep 5
    done
  done
done
[ -n "$FOUND" ] || { echo "ssh still refused on $MAC_IP — Remote Login not on yet, or the user is neither (tell me the Mac's username)"; exit 1; }

# fix the stale Host mac entry (192.168.50.1, refused)
python3 - "$FOUND" <<'PY'
import re, sys, pathlib
p = pathlib.Path.home() / '.ssh/config'
s = p.read_text() if p.exists() else ''
entry = f"\nHost mac\n  HostName {sys.argv[1].split('@')[1]}\n  User {sys.argv[1].split('@')[0]}\n  IdentityFile ~/.ssh/id_ed25519\n"
s = re.sub(r"\n?Host mac\n(  .*\n)+", "", s) + entry
p.write_text(s)
print(f"~/.ssh/config: Host mac → {sys.argv[1]}")
PY
ssh -o BatchMode=yes mac 'sw_vers -productVersion; uname -m; whoami'
echo "M0 PASS"
