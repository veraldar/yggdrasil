#!/usr/bin/env bash
# preview-app-up.sh — rebuild :8447's app (~/Work/tree-next/branch, the v0.9.0 candidate) and restart it.
# 11-17: brings the mic back (.env.local copied from root-coord-pwa) and the three-letter tag on every row. ~2 min.
set -euo pipefail
cd "$HOME/Work/tree-next/branch"
TMPDIR=$HOME/.cache/tmp npm run build >/tmp/preview-app-build.log 2>&1 || { tail -20 /tmp/preview-app-build.log; exit 1; }
git -C .. checkout branch/package.json branch/package-lock.json 2>/dev/null || true   # the build stamps a version
systemctl --user restart rc-preview-pwa
for _ in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8101/ && break; sleep 1; done
echo "app:   $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8101/)"
echo "voice: $(curl -s http://127.0.0.1:8101/api/token | head -c 120)   (must NOT say voice-unavailable)"
echo "rows:  $(curl -s http://127.0.0.1:8101/api/session | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d), "sessions, harness on", sum(1 for s in d if s.get("harness")))')"
