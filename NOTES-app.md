# P2 app notes (branch/ half of package 2) — keep current

## Done (code written, WIP acb05226)
- lib/file-ref.ts (REF, urls, part shape), lib/file-upload.ts (pieces, 409 resume), lib/brain-files.ts
- routes: POST /api/file/upload, PUT /api/file/upload/[upload] (≤1 MiB+16 KiB, 413), GET /api/file/[hash]
- /api/artifact/[name]?root=<r> (r ≠ brain's GET /root name) → POST /file/artifact + stream /file/<hash>
- buildParts refs → stored part; queue carries refs; GET messages: images (ref → /api/file url), files chips
- composer: any file, ≤8, upload at pick, breathing chip, send disabled while sending, 413 text as error,
  paste of files; message chips (name + size) open the file in a new tab
- e2e/files-reach.spec.ts + playwright.files.config.ts (Pixel 7) + e2e/fixtures/files-brain.mjs (fake)

## Next
1. merge p2-reach (done 6054a626), build brain, run fake + real brain specs, fix
2. npm run build, tsc; screenshots → root-coord-pwa/artifacts/p2-files-*.png
3. report
