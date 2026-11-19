# P5 · veraldar.org — notes (keep current: done / half done / next)

Site source: ~/Work/veraldar-site (git). `main` = live veraldar.org as of 2026-11-19 23:55 (523e27c).
Old uncommitted local work kept on branch `local-wip-1110` (not live). New pages: branch `site-v091`.
Build: `python3 -I scripts/build.py [--preview OUT]` — src/*.html → pages at the repo root; RELEASE holds the version.
This worktree (p5-site, from tree-next): films scripts (sim/films/), scripts/site-deploy.sh, NOTES.

## Done
- live pulled into veraldar-site main, byte-identical (data/ left on VPS: made by the pipeline)
- milestone 1: 11 pages (index, start, trunk, home, pair, add-linux/mac/windows, phone, server, keys),
  site.css (worlds copied from the 11-14 index), site.js (theme, copy, world-tree lead). Claims → scenarios in
  a comment at the top of each src page. Checked: Pixel 7 + 1280 desktop, no overflow, no console errors.
- preview artifact: /api/artifact/site-preview.html (one file, no scripts, :target pages; nav checked in a
  sandbox="" iframe). Screenshot: site-preview-first-screen.png

## Half done / open
- films section: 3 slots with placeholder posters; old October films linked under them (swap only after
  the owner has seen both)
- dropped from the first page: the old voice door ("hold to start", ends in the docker install), the
  "products" card (bifrost v0.6.1, git clone, docker), the funding box (accounts pending). In git history.
- phone.html describes packages 2+3 (roots sheet, files): publish only after they merge; stills from twin
- for P4: Setup.exe pre-fills https://ap.veraldar.org (W4) — right for the owner only; a new user types
  their own trunk. Site says so. Asset names assumed: Veraldar-Setup-0.9.1.exe, join.sh, install.sh, trunk.sh
- sw.js: bump CACHE to v12, add site.css/site.js to CORE, drop door mp3 from CORE — at publish
- independent review of the copy (sub-agent) before publish

## Next
1. scripts/check-commands.sh: every command on the pages run as written in a clean container (needs the
   v0.9.1 assets: a local mirror via YGG_RELEASES until the draft exists)
2. sim/films/: Playwright film scripts on a twin (talk first: real voice via sim/voice rigs)
3. scripts/site-deploy.sh (AP-20): back up on VPS, copy, curl+grep, undo. Publish only on the integrator's word.
