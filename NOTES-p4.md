# P4 — installers and release v0.9.1 (branch p4-release)

RULE: long runs (rigs, release builds) run from the frozen worktree ~/Work/p4-run (git -C ~/Work/p4-run checkout --detach <commit>),
never from this one — bash reads scripts as it goes, an edit here breaks a running job.

## Done (committed)
- release.sh: tag guard AP-30 (makes vX at HEAD; stops on a local/origin tag elsewhere), private-key guard AP-21
  (file:line only), --mac-host (cargo on the Mac in ~/.cache/yggdrasil-release-mac, own CARGO_HOME; Mach-O check;
  yggdrasil-VER-macos-aarch64.tar.gz), build-win.sh hook before signing, notes line for v0.9.0's tag
- join.sh: PLAT linux-x86_64|macos-aarch64, shasum fallback, no glibc check on macOS
- trunk.sh --adopt /etc/trunk-ap (key/pin, token hash, LE cert + webroot, port/PROXY, ICE, sni conf; stops+disables
  trunk-ap only once ours answers; puts it back if not; folder left as is; firewall untouched)
- sim/own-trunk-e2e.sh OT_JOINER=deb443; sim/own-trunk/adopt-test.sh
- Mac M1/M2 looked (see below); trial build on the Mac: brain 30 s, node 14 s, both Mach-O arm64

## Mac facts (23:45, read-only)
- macOS 26.6.2 arm64, Xcode CLT, rustc 1.99, python3 3.9.6 (/usr/bin), shasum, no sha256sum, 58 GB free
- 4180/4181 free; no org.veraldar.* agents; listeners noted in the turn log
- COLLISION: ~/.local/share/yggdrasil-root EXISTS (Nov 14, a stalled join.sh run: NAME=mac, hub ap.veraldar.org,
  brain.env with a model upstream, bin/yggdrasil, never joined: no root.json, no bifrost-net, no agents).
  join.sh's default --dir. Not touched. Reported; M4 waits for a decision.

## Proven 11-20 ~00:30 (artifact p4-proofs-1120.md)
- S11 Linux in the rig: deb443 joiner, rc release, OWN-TRUNK GREEN 32/0 (state ~/.cache/p4-rig/s11-linux)
- adopt-test.sh 10/10 (found + fixed trunk.sh behind-proxy probe bug: -w took --haproxy-protocol)
- Mac pre-test: join.sh bootstrap on the real Mac with a test release incl. macos archive — up to the hub ask
- tree-next 4060a9fb merged

## Review (independent sub-agent, 01:00): 5 real bugs + 4 small — all fixed, commit "p4: fixes from the independent review"
- retested: adopt-test 11/11 (+ PROXY mismatch refused, backup timer left alone); key guard unit test; tag guard
  (local tag elsewhere, origin tag elsewhere) stops before any build, in a scratch clone with a stand-in key
- not yet re-run after the fixes: the full S11 rig (join.sh change is macOS/Rosetta + one message only)
- make_tag (after signing) is exercised only by a full real-path run: do the dress rehearsal (scratch clone, stand-in
  key, --mac-host, Windows exe) once p4-win is merged

## Morning 11-20 (after the usage limit)
- p4-win: installer + build-win.sh + tests done (bootstrap-test 30/30, launcher-test 30/30 under wine, screenshots in
  /tmp/p4win-shots); agent resumed for: join-test rerun, review, merge of p4-release, copy screenshots to artifacts
- rig: OT_DIST=DIR [OT_DIST_KEY] runs against a finished release (draft/rehearsal); SKIP rows for re-signed steps
- sim/release-rehearsal.sh (real path, stand-in key, version 0.8.99 because the rig serves 0.9.1-test as "newer")
- sim/mac-bootstrap-check.sh HOST DIST (the Mac pre-check, reusable for the draft)
- docs/release-notes-v0.9.1.md (installer part)
- rehearsal 1 running on a TEMP merge (p4-run2 detached: p4-release + p4-win)

## 11-20 12:50 — L15 REVISED (the lead, 12:36): one model step on every system + "Same as the home root"
CONTRACT WITH P3 (the home root's route): ~/Work/root-coord-pwa/artifacts/p4-model-route.md
  GET /root/model via the joiner's own WG node (http://127.0.0.1:<peer port>/_wg/local/root/model), x-ygg-peer;
  200 {base_url, style, model, api_key} · 401 · 403 · 404 (older home) · 409 (home's model is on loopback);
  join request body gains "model":"home". P3 says in its NOTES when the route is on a branch.
State at 12:50: rehearsal 2 on the real merge 968382f3 GREEN (r1-r7 7/7; Linux rig OT_DIST 32+12; Mac check 11/11;
  wine 32/33 = a test stand-in bug, fixed in p4-release). tree-next 5edbb05c merged (0b0d86df); notes file is now
  NOTES-p4.md. p4-win is merged: Windows work continues in p4-release.
TO BUILD (order): 1 root/install/model-step.sh (providers: same|zai|openrouter|anthropic|openai|other) sourced by
  install.sh + join.sh · 2 joiner side (rootjoin.py model-fetch, run-brain waits, exit 6) · 3 Windows page with
  the same choices · 4 tests: join-test (fake route), wine, GLM job: a container per provider path with a fake
  HTTPS upstream · 5 agy review · 6 rehearsal 3 → report the branch to P1.
Engines (L18): agy for reviews/self-contained code, GLM sessions for test matrices; builds under nice -n 10.

## 11-21 10:45 — BRANCH HANDED TO P1: p4-release @ 48f0c61a (merges cleanly into tree-next 0d31a764, also over p3-model)
Evidence: ~/Work/root-coord-pwa/artifacts/p4-proofs-1121.md (chain ~/.cache/p4-rig/chain.out):
  same-home rig (temp merge + p3-model) GREEN 33+12 incl. m2 · rehearsal 3 r1-r7 7/7 · Linux rig on its dist 32+12 ·
  Mac check 11/11 · wine 38/38 · model matrix 10/10 · join-test 78/78 · model-fetch 18/18 · model-step-check in step
AFTER THE HANDOVER: one docs commit more (ddbb39d8: guides → v0.9.1 + the model step words) — P1 merging the branch
  by name gets it; if tree-next lacks it at draft time, cherry-pick it there via P1 (release.sh warns about v0.9.0 links).
PREREQUISITES CHECKED 11-21 10:55: release key present, NO passphrase, = RELEASE-KEY.pub; gh logged in with push;
  no v0.9.1 tag on origin. origin/main is far behind tree-next: I push ONLY the tag (its commit comes with it);
  moving main is P1's/the lead's call.
MAC STALE FOLDER: the owner's own words 11-21 ("you decide — I never used it, delete the folder if needed") →
  looked again (unchanged since Nov 14, no root.json, nothing running, no org.veraldar agents) and DELETED
  ~/.local/share/yggdrasil-root on the Mac. 4180/4181 free. M4 can run as a new person would.
WAITING ON P1: merge p3-model + p4-release, deploy → P1 says "merged and live" → I build the v0.9.1 DRAFT:
  1. worktree at tree-next HEAD (clean), docs/own-trunk.md + root/install/README.md → v0.9.1 download lines
  2. scripts/release.sh 0.9.1 --mac-host mac   (the REAL key ~/.config/yggdrasil-release/release_ed25519; if it asks
     for anything only the owner can type: ask word for word, wait)
  3. git push origin v0.9.1 (the tag release.sh made) ; gh release create v0.9.1 --draft --verify-tag dist/0.9.1/*
     with docs/release-notes-v0.9.1.md as the body (fill the proof table from the runs)
  4. S11 vs the draft: OT_DIST=dist/0.9.1 (no key: re-signed steps SKIP) OT_STAGES=a OT_JOINER=deb443
     [OT_JOIN_MODEL=home]; sim/mac-bootstrap-check.sh mac dist/0.9.1; wine on its exe
  5. report the draft to P1 AT ONCE (P1 sends P5 on); un-draft after the proofs; then Mac M4–M8 (owner approves on
     the phone; the stale ~/.local/share/yggdrasil-root on the Mac: owner's yes/no still open), Windows checklist.

## 11-21 09:40 — back after 14 h on the usage limit; the owner asks why v0.9.1 is not public
DONE + committed since 08:45 (HEAD f40df837+):
  - tree-next 0d31a764 merged
  - agy's review (5 findings) + GLM's 2 observations FIXED (commit "the model step: fixes from agy's review…"):
    key never inherited by children, temp key file gone before the phone wait, restart on a model change, 01 choice,
    retry on broken responses, flag precedence, stray key refused
  - GLM's matrix script merged: sim/model-step-e2e.sh (MSM_DIST/MSM_STATE); re-run on the fixes 10/10
  - join-test.sh --docker 78/78; model-fetch-test.py 18/18 (now also YGG_MODELS / YGG_VISION_MODELS, P3 contract v1)
  - Windows page with the provider list (same table: win/model-step-check.sh "in step"); wsl-bootstrap: exit 6 → W-MODEL
  - rig: OT_JOIN_MODEL=home + check m2
P3's side EXISTS: branch p3-model (8bf92ebf), contract ~/Work/root-coord-pwa/artifacts/p3-model-share-contract.md —
  matches mine (GET /root/model via /_wg/local, x-ygg-peer; 200 has also models + vision). NOT in tree-next yet.
RUNNING (background, frozen worktrees):
  - p4-run2: win/launcher-test.sh --shots /tmp/p4win-shots3 → ~/.cache/p4-rig/win-wine.out
  - p4-run (TEMP merge p4-release + p3-model, 5502da67): sim/own-trunk-e2e.sh OT_STAGES=a OT_JOINER=deb443
    OT_JOIN_MODEL=home OT_VERSION=0.9.1-rc.3 → ~/.cache/p4-rig/same-home.out (state ~/.cache/p4-rig/same-home)
NEXT: read both results → fix → copy screenshots to artifacts → rehearsal 3 on p4-release HEAD (release-rehearsal.sh
  --mac-host mac 0.8.99; then OT_DIST rig, mac-bootstrap-check, wine on its exe) → REPORT THE BRANCH TO P1
  (POST http://127.0.0.1:4101/session/ses_82772a463f1a495791a851d1d3386d4c/message?async=1&origin=<me>).
  Then: draft only after P1 says p3-model + mine are merged and live.

## 11-20 18:10 — after the limit (reset 17:30)
DONE + committed: root/install/model-step.sh; join.sh + install.sh use it; rootjoin.py model-fetch / --model home /
  --no-upstream-ok; run-brain waits for a model; exit 6. Tests green: model-fetch-test.py 16/16; join-test.sh --docker
  78/78 (needs trunk/ + root/ builds in the checkout: p4-run2 has copies from ~/.cache/p4-release-cache).
  tree-next 25e1e32b merged (90c218b5).
HANDED OFF (L18):
  - GLM session ses_5c40c8dd82e04a848daacf6ee48a1293 "P4 · model step matrix (GLM)": worktree ~/Work/p4-msmatrix
    (branch p4-msmatrix), brief BRIEF-msmatrix.md there; builds sim/model-step-e2e.sh (a container per provider, fake
    HTTPS upstream); uses the TEST dist ~/.cache/p4-rig/ms-dist/0.9.1-rc.2 (key ~/.cache/p4-rig/ms-key/k). The
    brain wakes me with its report. Then: read the report, merge p4-msmatrix if good.
  - agy review of the model-step diff: folder ~/Work/p4-agy-review (brief.md, model-step.diff) → REVIEW.md there.
MINE NOW: the Windows page with the same choices (win/veraldar.nsi: provider drop-down, fields per provider;
  "Same as the home root" default → no upstream.env → join.sh's default; wsl-bootstrap: join.sh exit 6 → W-MODEL,
  login entry still installed) + wine test + win/model-step-check.sh (words/addresses equal to model-step.sh).
THEN: P3's route (watch ~/Work/p3-tree/NOTES.md) → rig run "same as home"; Mac check with the model step;
  rehearsal 3 on the final merge; report the branch to P1.
Model defaults I chose (the lead may change, one line each in model-step.sh): Anthropic claude-fable-5-2
  (or opus/sonnet/haiku 5.5), OpenAI gpt-4o-mini, OpenRouter openai/gpt-4o-mini.

## 11-20 noon — lead's instructions (L13–L17; the owner left decisions to the lead)
- the Windows helper is gone; I finish p4-win myself. L15: the model page done in p4-win.
- independent review of p4-win: 9 findings (2 high: non-ASCII user name / wsl notices broke the wslpath round
  trip) — all fixed in p4-win ("win + join.sh: fixes from the independent review"), incl. join.sh bin/start|stop
  stale pid after reboot (shared file: Linux + Mac too). bootstrap-test 32/32; stale-pid test /tmp/p4-holdtest.sh ok
- brain restart ~12:xx cut the wine rerun; leftover wine container removed by id; rerun started
- p4-win merged into p4-release (968382f3); rehearsal 2 running from p4-run2 (detached at that merge)
- after: Linux rig OT_DIST + Mac check + wine on the rehearsal exe → report the branch to P1
- then: merge p4-win → p4-release, rehearsal 2 on the real merge (+ Linux rig OT_DIST, Mac check, wine on its exe),
  report the branch to P1 (P1 merges + deploys)
- v0.9.1 DRAFT only after P1 says packages 2 and 3 are merged and live; then S11 vs the draft, Mac M4–M8 (real Mac,
  touch nothing there), un-draft; report the draft to P1 when it exists (P1 sends P5 on)
- pacing L14: only P1 and me run; a usage-limit stop lasts until someone sends me on — commit every step

## Rehearsal 1 (temp merge 78757b05 = p4-release + p4-win 80be65b2), 11-20 morning
- sim/release-rehearsal.sh --mac-host mac 0.8.99: r1-r7 7/7 (real path, all 11 assets, signature, tag after signing,
  local only; macOS archive Mach-O arm64; real stamps + stand-in key; exe embeds the stamped join.sh)
- Linux rig OT_DIST=rehearsal dist + OT_DIST_KEY: GREEN 32/32 + phone 12/12 (after fixing the rig's test-signers
  drop-in for real-stamped releases)  · state ~/.cache/p4-rig/reh-linux
- Mac: sim/mac-bootstrap-check.sh mac <dist>: 11/11, real-stamped (embedded key, no override)
- wine launcher-test on the rehearsal exe: 27/30 — the 3 are the test's hard-codes (0.9.1, tree join.sh); sent to
  the Windows agent to fix
- NEXT: Windows agent's review + merge → rehearsal 2 on the real merge → the three checks again → report + artifact

## Rehearsal, then
1. OT_DIST=~/.cache/p4-rehearsal/dist/0.8.99 OT_DIST_KEY=~/.cache/p4-rehearsal/standin OT_STAGES=a OT_JOINER=deb443
   sim/own-trunk-e2e.sh  (from p4-run, the real tree: its RELEASE-KEY.pub is the real key)
2. sim/mac-bootstrap-check.sh mac ~/.cache/p4-rehearsal/dist/0.8.99
3. win/launcher-test.sh against the rehearsal's exe (if it takes an exe path)
4. after p4-win's final merge: rehearsal 2 on the real merge

## Half done
- Windows installer: sub-agent in ~/Work/p4-win (branch p4-win)

## Asked the owner (00:30)
- model for new computers: same as omarchy (z.ai glm-5.3-flash, handed over on approval) or paste a key per installer
- Mac: may the stale ~/.local/share/yggdrasil-root (Nov 14, never joined) be removed before M4

## Next
- Mac pre-test: test release with --mac-host, join.sh bootstrap on the Mac in an isolated XDG_DATA_HOME/--dir, --no-start
- the model question (Windows/Mac need an upstream) — asked the owner
- release itself: waits for the integrator
