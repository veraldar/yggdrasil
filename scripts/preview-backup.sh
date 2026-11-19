#!/usr/bin/env bash
# preview-backup.sh — the preview brain's data, before every brain deploy (plan §6.1).
# Session JSONs + librarian.db + agents.json → ~/.cache/root-sim/backups/<ts>/
# Kept: the newest 12 (about a month at the phase-5+ deploy pace); older ones pruned.
set -euo pipefail
SRC="$HOME/.cache/root-sim/preview"
DEST="$HOME/.cache/root-sim/backups/$(date +%Y%m%d-%H%M%S)"
[ -d "$SRC/data/session" ] || { echo "no preview data at $SRC"; exit 1; }
mkdir -p "$DEST"
tar -C "$SRC" -czf "$DEST/sessions.tgz" data/session
[ -f "$SRC/librarian.db" ] && tar -C "$SRC" -czf "$DEST/librarian.tgz" librarian.db
[ -f "$SRC/agents.json" ] && cp "$SRC/agents.json" "$DEST/agents.json"
echo "backup: $DEST ($(tar -tzf "$DEST/sessions.tgz" | grep -c '\.json$') sessions, $(du -sh "$DEST" | cut -f1))"
ls -1dt "$HOME/.cache/root-sim/backups"/20* 2>/dev/null | tail -n +13 | xargs -r rm -rf
