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
- scripts/check-commands.py: ALL PASS 11-20 (v0.9.0 stand-in): every page command as written on fresh debian:12, ubuntu:24.04, ubuntu:22.04; 15 options checked against tree-next. Re-run with no --version once v0.9.1 exists.
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

## 11-20 afternoon (Fable 5.2) — films
- model step (L15 revised): veraldar-site src/_model.html, included by home / add-linux / add-mac / add-windows
  (d822a0f). ALIGN with P4's installer wording when its branch has it (grep 'Same as the home root' on p4-*).
- films: sim/films/ = script.json (the lines), film_upstream.py (scripted model on top of the mock),
  films.mjs (driver: talk, tree, file), cut.py (stage + captions + checks), record.sh (one command).
  The world: sim/trunk-rtc-e2e.sh --scenario films (my edit: two more roots studio + workshop, own MAINs).
  Builds in THIS worktree: root (done 12:39), branch/.next (done), trunk (unit p5-trunk-build → .build-trunk.log).
  Long jobs run as systemd --user units (p5-*): they survive a brain restart; background shells do not.
- NEXT: sim/films/record.sh → look at each <name>-sheet.jpg → fix selectors/timing → copy mp4/webm/jpg into
  veraldar-site/films/ and replace the placeholder posters in src/index.html with <video> → preview → report to P1.
- the first screen's words WAIT for the owner's pick (story propositions, GLM session ses_f24ba4a5…).

## 11-20 13:30 — films recorded (run 5), in the site
- `sim/films/record.sh [OUT]` = one command: world up (voice rig, scenario films) → pair → seed → record talk,
  tree, file → cut.py (1080x1920 stage, captions burned in, checks). Runs 2, 4, 5 green; ~4 min each.
  Run as a unit: systemd-run --user --unit p5-films-runN … (see git log of this file's neighbours for the line).
- lessons: Playwright's video and CDP screencast are 412 px wide → screenshot loop with clip.scale 2;
  a shot asked for across a page load never returns → 1.2 s limit + fresh CDP session; never await the loop.
- veraldar-site: films/ (talk/tree/file .mp4 .webm .jpg), scripts/films-in.sh RUN-DIR copies a passing run in;
  index has real <video preload=none>; the preview embeds the mp4s (artifact route serves no video).
  Checked: plays to the end at Pixel 7 + 1280, 0 media requests before play, plays in the sandboxed preview.
- RE-RECORD on the release build: rebuild root + trunk + branch in this worktree after merging tree-next,
  then record.sh, look at each *-sheet.jpg, films-in.sh, build.py --preview.
- still open: old October films stay linked until the owner has seen both; first screen's words wait for the
  owner's pick; model-step wording to align with P4's installers; mp4 is smaller than webm here (mp4 listed first).
