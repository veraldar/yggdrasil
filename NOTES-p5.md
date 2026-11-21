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

## 11-20 15:40 — the owner approved the preview
- owner's words (via MAIN, verbatim): "I guess …/api/artifact/site-preview.html is good is there an other
  design desision I have to make?" → the design, the first screen's words and the three films stand.
- decided by me after that: the first-screen words stay as approved; one identity line added above the tree
  map ("Yggdrasil is your own AI …", the gap the story propositions found); the tree map wraps on phones;
  the October films stay as one small line of links; the voice door, products card and funding box stay out.
- nothing left for the owner on design. Theirs only: funding accounts (if a support box is wanted back),
  their Windows run, and nothing else — publishing follows the plan (v0.9.1 public + the integrator's word).

## 11-21 — the owner's container question (decision only, no change on the VPS)
- owner (via MAIN, verbatim): separate lxc/incus containers for veraldar.org and the trunk "if better should do it",
  and maybe a root on the site's machine to improve the site from the phone.
- decision doc: ~/Work/root-coord-pwa/artifacts/vps-containers-decision.md (/api/artifact/vps-containers-decision.md).
  Call: Incus, ONE container for the site's workshop + its root; the trunk stays on the host (already
  DynamicUser + ProtectSystem=strict); not Docker. After v0.9.1; rehearsal on a throwaway Debian 13 first.
- found on the VPS (read-only survey 11-21): vps-boot-{app,brain,mock,trunk} run as root from
  /home/debian/vps-test since 10-31, enabled at boot (~270 MB); ufw still allows 8443/tcp (provider firewall
  blocks it: timed out from outside); veraldar-site has no git remote; speaches in Docker (152 MB, 2 GB image).
- waiting on the owner: "clean it" (step 1), which key the site's root gets, a go for the container.

## 11-21 11:50 — v0.9.1 is public; the site is READY, waiting for P1's word to publish
- merged tree-next 8fc5d3b2 (release tree); rebuilt root + trunk + branch here; films re-recorded on it
  (run rel1, ~/.cache/p5-films/rel1: talk 15.8 s, tree 17.0 s, file 15.6 s, all checks pass, sheets looked at).
- model step + Windows steps now in the installers' own words (model-step.sh, veraldar.nsi).
- check-commands.py: --dist (draft through a mirror container) ALL PASS, then with NO flags against the public
  release ALL PASS (33 runs: debian:12, ubuntu:24.04, ubuntu:22.04; the signature block verifies for real).
  Public SHA256SUMS == the draft's. v0.9.1 published 2026-11-21 09:39 UTC.
- site-deploy.sh --dry-run against the real server: "release v0.9.1: 6 linked files, all there", would change
  3 files (index, start, sw.js) and add 20; nothing touched. Stand-in test 10/10 (SITE_RELEASES simulates a
  missing release now).
- systemd-run gotcha: StandardOutput=file: does NOT truncate — use truncate: (stale tails fooled me twice).
- NEXT, only on P1's word: scripts/site-deploy.sh (no flags) → it backs up, copies, checks live byte for byte;
  then curl+grep the live pages and report. Undo: scripts/site-deploy.sh --undo.
- still beta on all three add-a-computer pages until P4 reports each PROVEN (one-word edit per page + deploy).

## 11-21 14:40 — PUBLISHED: veraldar.org is the v0.9.1 site
- the go: P1's own session, 10:39 ("I gave P5 the word to publish the v0.9.1 site"; its message to me was queued
  and never arrived — read from P1's transcript on the brain, not taken from MAIN's relay).
- deploy 1: 4f15e55, 23 files (3 changed, 20 new), backup ~/site-backups/20261121T095137Z-4f15e55 on the VPS.
- deploy 2: 27ff703, 13 files (desktop film layout: 215 px → 349 px wide), backup …T133543Z-27ff703.
  Undo of the last deploy: scripts/site-deploy.sh --undo (twice = back to the 11-14 site).
- marking (P4's report to P1, 10:39): Linux no beta tag, "tested end to end on a clean Debian 12"; Mac beta,
  "tested on a real Mac up to the point of joining"; Windows beta, "passed its checks on a stand-in for Windows".
- verified as a stranger (no cache, clean profile, service worker blocked): 23/23 fetch 200; every page walked
  by taps at Pixel 7 and 1280; 3 films play after one tap on play at both; 0 console errors, 0 failed requests;
  the signature check from the live trunk page's own key line: Good signature, trunk.sh OK.
- NEXT: flip Mac to tested when the Mac Studio's full join passes (M5–M8); Windows when the owner's PC run
  passes; Linux line when a join over the real trunk passes. Each = one line in src/add-*.html + deploy.
  The container plan for the VPS (vps-containers-decision.md) waits on the owner's three answers.
