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

- 11-20 morning: scripts/site-deploy.sh (AP-20) + site-deploy-test.sh: 9/9 against a stand-in container
  (refuses until the release is out, dry run, backup in ~/site-backups outside the web root, byte-for-byte live
  check, undo identical, auto-undo on a failed check, data/ untouched). NOT run against the real VPS.
- independent review (sub-agent) → 13 findings, the confirmed ones fixed in the copy (veraldar-site 652f061)
- scripts/check-commands.py: page commands run as written in fresh debian:12 / ubuntu:24.04 / ubuntu:22.04
  containers (against v0.9.0 until v0.9.1 exists) + every option checked against the installer source

## Half done / open
- films section: 3 slots with placeholder posters; old October films linked under them (swap only after
  the owner has seen both)
- dropped from the first page: the old voice door ("hold to start", ends in the docker install), the
  "products" card (bifrost v0.6.1, git clone, docker), the funding box (accounts pending). In git history.
- phone.html describes packages 2+3 (roots sheet, files): publish only after they merge; stills from twin
- for P4: Setup.exe pre-fills https://ap.veraldar.org (W4) — right for the owner only; a new user types
  their own trunk. Site says so. Asset names assumed: Veraldar-Setup-0.9.1.exe, join.sh, install.sh, trunk.sh
- sw.js: bump CACHE to v12, add site.css/site.js to CORE, drop door mp3 from CORE — at publish
- FOR THE LEAD: Windows cannot finish today: no way to give the PC a model (p4-win NOTES: every real run
  ends at W-MODEL). The page carries a GATE comment; it is not published until that is decided.
- add-mac waits for p4-release (tree-next join.sh:156 refuses macOS); "hold to remove" waits for package 3
- MAIN asked twice to "verify on the VPS preview": not done — no such preview exists and anything on
  veraldar.org is public; my orders publish only after the release + the integrator's word.

## Next
1. scripts/check-commands.sh: every command on the pages run as written in a clean container (needs the
   v0.9.1 assets: a local mirror via YGG_RELEASES until the draft exists)
2. sim/films/: Playwright film scripts on a twin (talk first: real voice via sim/voice rigs)
3. scripts/site-deploy.sh (AP-20): back up on VPS, copy, curl+grep, undo. Publish only on the integrator's word.
