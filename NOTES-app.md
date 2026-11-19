# P2 app notes (branch/ half of package 2) — keep current

## Done (all seen passing, Pixel 7 Playwright, fake brain AND real brains home+lab)
- lib/file-ref.ts (REF, urls, stored part), lib/file-upload.ts (pieces, 409 resume, empty file at start),
  lib/brain-files.ts (brain answers passed on as they are)
- routes: POST /api/file/upload, PUT /api/file/upload/[upload] (≤ 1 MiB + 16 KiB, else 413 — checked with
  a 2 MiB body, with and without content-length), GET /api/file/[hash] (stream, immutable cache, CSP sandbox
  except pdf); all behind the middleware gate (devices mode: 401 without a token, checked)
- /api/artifact/[name]?root=<r> (r ≠ brain's GET /root name) → POST /file/artifact + stream /file/<hash>,
  same headers as a local artifact; no root / home / a brain without a name → local, unchanged
- buildParts refs → stored part; queue carries refs; GET messages: images (ref → /api/file url), files chips
- composer: any file, ≤ 8, upload at pick, chip breathes while sending, send dimmed until all are in,
  413 text word for word, pasted files go the same way; message chips (name + size) open the file
- artifact links keep their ?root=&session= in the inline viewers (they 404'd at home before)
- e2e/files-reach.spec.ts (5 tests) + playwright.files.config.ts + e2e/fixtures/files-brain.mjs (fake) +
  e2e/fixtures/real-brains.sh (home :4262 + lab :4263 + mock :4264, PIDs, never /tmp)
- screenshots: ~/Work/root-coord-pwa/artifacts/p2-files-{composer,sent,over-limit}.png

## Run
- fake:  cd branch && npx playwright test -c playwright.files.config.ts
- real:  BIN=<yggdrasil> e2e/fixtures/real-brains.sh up; E2E_OC_URL=http://127.0.0.1:4262
         E2E_LAB_URL=http://127.0.0.1:4263 E2E_LAB_ARTIFACTS=~/.cache/p2-reach/app-tmp/real/lab/work/artifacts
         npx playwright test -c playwright.files.config.ts; e2e/fixtures/real-brains.sh down

## Left
- images are still downscaled (≤ 1568 px JPEG) before upload, as before (the model sees what it saw)
- not run: the general suite (it aims at live :8080 / main-tree artifacts by default)
