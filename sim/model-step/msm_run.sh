#!/bin/bash
# msm_run.sh — container side of typed(): run the pty driver under timeout (a stuck driver
# is killed by its own pid, its install.sh dies with the pty), then mark done.
cd "$HOME/yggdrasil-0.9.1-rc.2/root/install" || { echo 1 >"$DONEFILE"; exit 1; }
timeout 200 python3 -u /tmp/drive_install.py bash install.sh --brain-only --now
echo $? >"$DONEFILE"
