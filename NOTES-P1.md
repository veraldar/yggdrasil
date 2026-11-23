# P1 notes (integrator) — keep current

## Done
- e4f74fbc C5 fix (cut wake rebuilt from inbox, brief resend keeps sender, queued msg behind cut, drain runs out). 117/117 cargo test, tree-e2e 95/95 (one flaky agy-models check on first run).
- Merged tree-next 4a5f7244 into p1-hub.
- Built: branch/.next/standalone (NEXT_OUTPUT=standalone), trunk/target/release/bifrost-net, root/target/release/yggdrasil.

## Stage A plan (facts from survey)
- New public app: `node server.mjs` from frozen folder, PORT 4502, BIFROST_AUTH=devices, BIFROST_TRUST_PROXY=1,
  BIFROST_DEVICES_FILE, BIFROST_PUBLIC_URL=https://ap.veraldar.org, BIFROST_BRIDGE_URL=http://127.0.0.1:4503,
  BIFROST_ADMIN_TOKEN, OPENCODE_URL=:4101, ARTIFACTS_DIR, LIVEKIT_URL=wss://ap.veraldar.org, LIVEKIT_API_KEY/SECRET,
  LIVEKIT_API_URL=http://127.0.0.1:7880, BIFROST_TRUNK_ICE=auto, AGENT_NAME=bifrost-preview, VOICE_ROOM_BY_ID=1, SPEACHES/TTS.
- Bridge: copy old ST bridge.toml shape; add dtls_cert_file; [ap] livekit="127.0.0.1:7880", tcp={livekit-ice="192.168.50.2:7881"}; ice_tcp unset.
- AP keeps ONE bridge link: stop trunk-preview-bridge (+app) before starting new bridge. Old ST files untouched = way back (hub-up.sh).
- VPS: backup tgz (AP-3 step 1) FIRST, then vps-end-design.sh (files staged in VPS /tmp), verify / 200 HSTS, /ap 401, /rootlink 426, veraldar.org.

## Next
- Assemble frozen release ~/.local/share/yggdrasil/hub/releases/<id>/

## 2026-11-19 ~23:50 stage A progress
- Release ~/.local/share/yggdrasil/hub/releases/20261119-2343-1e94b361, `current` → it.
- Config: ~/.config/yggdrasil/hub/{app-public.env,bridge-public.toml,admin-token,peer-token}; state ~/.local/share/yggdrasil/hub/state/devices.json (copy of old ST).
- `scripts/hub-units.sh public-up` DONE: hub-app :4502 + hub-bridge active, AP channel up. Old trunk-preview-{app,bridge} stopped. Way back: `hub-units.sh public-back`.
- NEXT: VPS backup tgz → vps-end-design.sh → verify. Then pair a test device + Playwright proof.
- TODO C5 review (6 defects, see reviewer): (1) retire/fold/refile BEFORE any submit; (2) cut reply with finished tool parts → don't refile its reports (or don't fold); (3) `ended` must count only real run replies (parentID, not folded/inbox stub/summary); (4) retire only if created(W) > last_end, else just wake; (5) handled only if a wake really submits / non-wake autos → report via recover; wake budget; (6) boot id per placeholder (meta.boot) instead of wall clock; still report leftovers.
- VPS 23:45 CET: backup /root/pre-end-design-2026-11-19.tgz (22:45 UTC) → vps-end-design.sh applied 23:45:43 → verified (/ 200 HSTS, /ap 401, /rootlink 426, site 200) → sni-443 enabled, turn-dispatcher disabled. Undo: `bash ~/.local/state/trunk-preview/vps-end-design.sh undo` (+ re-enable turn-dispatcher).
- 23:56 STAGE A PROVEN: trunk-rtc-e2e GREEN on build; live-door.spec.ts PASS on real ap.veraldar.org (pair 1.6 s, pinned, typed 5.6 s, hold→talk 1.7 s, spoken STT ok, answer spoken 4.9 s after release, same turns on :8447). Screens in artifacts ap-door-*.png. Test devices removed from state/devices.json.
- Found: voice agent refuses calls when the box is busy (cgroup load = whole login). Public door got its own agent hub-voice-agent (AGENT_NAME=bifrost-hub, AGENT_LOAD=off). :8447's rc-preview-agent still has the flaw → fix in stage B (one agent, AGENT_LOAD=off, both apps).
- Owner's phone dev_ad128180 is in devices.json but must re-pair (new bridge DTLS key, pinned channel).
- 23:59 :8447 checked the same way (PW_DOOR=tailnet): PASS (typed 7.4 s, hold→talk 1.1 s, spoken answer 5.3 s).
- Owner pairing artifact: artifacts/ap-pair.html (one-use code, exp extended to 01:59). DELETE it once used (check state/devices.json codes[].used for the code created at /tmp/p1-owner-code-created) or at expiry.

## NEXT (in order)
1. Fix the 6 C5 review defects (see TODO above), tests for each, cargo test + tree-e2e.
2. Twin check of the C5 fix: a deploy cuts sessions' turns; each gets its turn sent again in its own conversation (sim/acceptance/twin-up.sh).
3. Stage B: hub-units.sh grows brain/librarian/cclive/tailnet app units; one voice agent (AGENT_LOAD=off) for both apps; YGG_ROOT_NAME=omarchy + YGG_PEERS_FROM=http://127.0.0.1:4503/_roots + YGG_PEER_TOKEN; switch script with health check + auto-rollback; linger (decided L12); deploy brain with C5 fix as part of it, when no owner turn runs.

## 11-20 (after the 12 h stop)
- ap-pair.html deleted 11:50; owner's phone had NOT paired (code unused). New link goes in the next report.
- C5 review: 6 faults fixed (4592b809), tests per fault, cargo test 123/123.
- sim/restart-e2e.py GREEN 22/22; HARNESS=1 GREEN 28/28 (real Claude Code haiku session cut mid-Bash: same conversation id, resent once, answered).
- NEXT: merge tree-next(be8134ae) ← p1-hub, p2-reach(03a8b7eb), p3-tree(d13e6c66), ui-main-no-who-filter(b003241c); add `fable` to harness models (first, strongest). Then cargo test + tree-e2e + restart-e2e, deploy via preview-up.sh, S14 both doors + mic, move P1–P5 to fable, send P2 its lead-next.md message.
- 12:20 merged into p1-hub: tree-next be8134ae, p2-reach 03a8b7eb, p3-tree d13e6c66 (conflicts peers/tree/main/sim resolved), ui-main-no-who-filter b003241c, fable first. Green: cargo 146/146, tree-e2e 131/131, restart-e2e 22/22, trunk-full full + s17 (probe now sends the peer token), trunk-rtc, who-wrote on twin p1m (Pixel 7). tree-next fast-forwarded to p1-hub.
- NEXT: release folder from p1-hub build → preview-up.sh <binary> (cuts my turn; read ~/.cache/root-sim/preview/preview-up.log) → app :8101 + public app from new release → S14 both doors + mic → P1–P5 to fable → P2 message from lead-next.md (pacing: max 2 running).
- 12:3x DEPLOY of tree-next 5edbb05c, release R2 = 20261120-1214-7c3eff7c (~/.local/share/yggdrasil/hub/releases/). Steps:
  1. ~/Work/tree-next/scripts/preview-up.sh ~/.local/share/yggdrasil/hub/releases/20261120-1214-7c3eff7c/bin/yggdrasil   ← CUTS THIS TURN; log ~/.cache/root-sim/preview/preview-up.log
  2. scripts/hub-units.sh deploy 20261120-1214-7c3eff7c   (public app, bridge, voice agent)
  3. scripts/hub-units.sh tailnet-up   (:8101 from the release; way back: tailnet-back) — tested on :8109 OK
  4. S14: /api/build both doors = x9449bAf62qkHlr_B9inB; MAIN context summary 200; test session smoke; live-door spec AP + PW_DOOR=tailnet (mic)
  5. P1–P5 → fable (POST /api/session/<id>/model {"model":{"id":"fable","providerID":"claude"}})
  6. P2 message from lead-next.md (if ≤1 other package session running)
- 12:20 steps 1–3 done: brain R2 live (4 cut turns resent once), hub-units deploy R2, tailnet-up (:8101 = hub-app-tailnet; rc-preview-pwa gone, way back tailnet-back). Both doors build x9449bAf62qkHlr_B9inB.
- 12:25 S14 both doors PASS (mic); P1–P5 → fable; P2 message WAITING (P1+P4 running); owner pair link ap-pair.html until 15:20 (delete when used/expired); milestone posted to MAIN inbox. NEXT: stage B.

## STAGE B (11-20 12:45)
- L14 withdrawn (owner 12:19): no run cap. Lead sent P2, P5 itself; P3's stage-B message (lead-next.md "To P3") is MINE to send after stage B.
- scripts/hub-units.sh: units hub-brain (drain in ExecStop, Restart=always), hub-librarian, hub-cclive, + existing hub-voice-agent/app/app-tailnet/bridge; `switch` (backup → drain → stop rootsim-preview + rc-preview-{librarian,cclive,agent} → enable+start hub units → health → linger; on failure stageb_back puts the transient units back), `stageb-back`, `health`, `deploy <id>` (brain too, health-based rollback).
- ~/.config/yggdrasil/hub/brain.env = preview brain.env + YGG_ROOT_NAME=omarchy, YGG_PEERS_FROM=http://127.0.0.1:4503/_roots, YGG_PEER_TOKEN.
- Tested: unit shape on a scratch copy (drain → restart → resend once; kill -9 → back in 2 s). Old root name only in message text (no stored links).
- preview-up.sh refuses once hub-brain is enabled (says: hub-units.sh deploy).
- RUN: ~/Work/tree-next/scripts/hub-units.sh switch   ← CUTS MY TURN. Log: ~/.local/share/yggdrasil/hub/logs/switch.log
- AFTER (when resent): read switch.log; hub-units.sh health + status; loginctl show-user dweeb_xyz -p Linger; live-door spec both doors (mic); S14; update work/AGENTS.md rule 2 (deploy = hub-units.sh deploy); send P3 its message; report to MAIN: stage B done + reboot window question + pairing link (ap-pair.html valid until 15:20).
- 13:0x review (agy) fixes in; tree-next at 25e1e32b. RUNNING: ~/Work/tree-next/scripts/hub-units.sh switch
- 12:43 STAGE B SWITCHED, healthy (switch.log). Linger=yes. All 7 hub units active+enabled. NEXT: live-door both doors, S14, AGENTS.md rule 2, P3 message, report + reboot window + pairing.

## 11-20 23:02 (after two more limit stops: 12:45→18:02, 18:09→23:01)
- Stage B is DONE and verified (switch.log 12:43, health all ok at 18:02). Deploys: scripts/hub-units.sh deploy <id>.
- FOUND 12:44 + 18:06: voice agent "mutual yield": two agent jobs in one room each wait for the other ("previous agent draining…"), both shut down after 20 s → room without agent, spoken turn lost. Seen when both doors are used back to back (same session = same room) and jobs double-dispatch. Fix idea: waiting agents mark themselves (participant attribute); among waiting ones the smallest identity serves, the others leave. In branch/voice/agent.py ~L530-566.
- 18:06/18:08: live-door AP run FAILED twice at low load (tailnet passed) — NOT yet looked at (/tmp/ld-a).
- ORDER NOW (owner via MAIN 23:01, I work alone): merge p2-spoken (d378eb14; strict L16 default: typed turns answered in writing only — say so in the report) → merge p5-site (bffd6ea3) → deploy → restart voice agent with P2's code → voice checks → report with commit hashes. Then P3/P4/timeline resume one at a time (MAIN does that after my report). P3's stage-B message from lead-next.md is still mine to send (or already sent? check P3's session).
- Owner pairing link ap-pair.html expired 15:20 → check devices.json, new link in report, delete old artifact.
- 23:3x merged p2-spoken (d378eb14) + strict L16 (answersTyped, typed turns written even hands-free) + p5-site (bffd6ea3, rig only) + voice agent fixes (repeat words = new turn; waiting jobs: first identity takes the room). Green: cargo 147, tree-e2e 131, restart-e2e, trunk-rtc rtc + s16, held-reply 12, test_repeat_turn 9, test_no_resend, voice_commands 12.
- DEPLOY: scripts/hub-units.sh release → R3 id in /tmp/p1-release-id → ~/Work/tree-next/scripts/hub-units.sh deploy <R3> (CUTS MY TURN; log ~/.local/share/yggdrasil/hub/logs/switch.log)
- AFTER: health; voice checks: live-door AP + tailnet back to back TWICE (the case that failed); remove test devices from state/devices.json; pairing link for the owner (check devices.json first; delete old ap-pair.html); work/AGENTS.md rule 2 → hub-units.sh deploy; P3's stage-B message (lead-next.md) if not sent; report to MAIN with commit hashes + strict-L16 default noted + reboot window question.
- 23:15 DEPLOYED R3 20261120-2314-e05a27d9 (tree-next e05a27d9), health ok, build QmdTZgxcB-002AbLbBbuq. NEXT: voice checks ×2 both doors.
- 23:41 voice fixes round 2 (presence by sid, serving/draining marks, app calls the serving agent) deployed: release 20261120-2341-a8b73cbf, units voice-agent+apps only. NEXT: live-door ×3 both doors.
- 23:45 VOICE GREEN LIVE: live-door AP+tailnet back to back ×3 = 6/6 (same sentence each time; answers 1.8–3.9 s after release). Release 20261120-2341-a8b73cbf (agent + apps; brain from R3 e05a27d9, same source). Agent log since deploy: 1 job took the room, 6 turns sent, 17 duplicates left at once, 0 timeouts.
- Test devices/codes removed from state/devices.json. Owner pair link: artifacts/ap-pair.html valid until 12:43 on 21 Nov (owner's phone still unpaired on ap; they use :8447 voice with MAIN).
- work/AGENTS.md rules updated for stage B (backup AGENTS.md.pre-stageb-1120.bak).
- P3 stage-B message: sending now (lead-next.md, as written). MAIN resumes the others one at a time.
- OPEN: reboot window (owner picks); memory file preview-brain-layout is out of date (update).

## 11-20 23:55 P3 asks: root ↔ root leg (WireGuard node) is off on the home root → merged p3-wg-hub (tree-next 95a7a836), reviewed (matches sim/trunk-full-e2e.sh config), dry run ok.
- RUN: ~/Work/tree-next/scripts/hub-units.sh wg-on   ← restarts bridge, hub-wg (new), brain (CUTS MY TURN), apps. Log: ~/.local/share/yggdrasil/hub/logs/switch.log. Way back: automatic on failed health; by hand `hub-units.sh wg-off`.
- AFTER: read switch.log; health (now with the node); curl 127.0.0.1:4506/_wg → []; brain.log "learning linked roots from …4506"; live-door both doors once (mic); tell P3 (POST /session/ses_f35ae2c967344628b6ff6c26adfa297a/message?async=1): done, go on with the joins. Then report to MAIN.
- Coming from P3: branch p3-model (home side of "Same as the home root") — merge+deploy when P3 reports it green.
- 23:52 wg-on DONE (switch.log): hub-wg active+enabled, node :4506, health 11/11, home node key fingerprint 415c-c41b-20a9. NEXT: live-door both doors; tell P3's line (new session 'P3 whole tree contd' per MAIN — the old P3 conversation is locked); report MAIN.
- 23:58 wg-on verified (node [] on both routes, brain learns from :4506, live-door AP + tailnet PASS 23:53–23:54). Told 'P3 whole tree contd' (ses_f30935277fc5…) — it owns P3's line; old P3 conversation is locked. Reported to MAIN.
- WAITING ON: p3-model (P3 reports green → merge + deploy brain/app), P4's branch (p4-release; P4 reports after rehearsal 2) and later the v0.9.1 draft (then send P5 its lead-next.md message if not sent), the owner: reboot window + phone pairing (ap-pair.html until 21 Nov 12:43; delete once used or expired). After the owner's phone passes voice on ap: retire coturn on the VPS (AP-7).

## 11-21 09:20 P4 reported p4-release (1ff95912, now e6e48eea notes); p3-model (8bf92ebf) never reported by P3 (its new session is locked too) — reviewed it myself (GET /root/model gated: via=wg set by the door, peer token, share list, removed roots; doors overwrite x-ygg-via/x-ygg-from, trunk test with forged headers) and merged both.
- Green on the merge: cargo 148, trunk 42, tree-e2e 131, restart-e2e, trunk-full full (3m model:home + 8a L15 PASS), s17, trunk-rtc. Code tree identical to P4's tested p4-release+p3-model (own-trunk OT_JOIN_MODEL=home 33+12 green, P4's proof).
- DEPLOY: release → ~/Work/tree-next/scripts/hub-units.sh deploy <id> (all units incl. hub-wg; CUTS MY TURN). AFTER: health 11/11, live-door both doors, curl :4101/root/model without door → 403, tell P4 (ses_e1eb880ac9a44c97bdd868805208795b): p3-model + p4-release merged and live → it builds the v0.9.1 draft; report MAIN.
- release 20261121-0927-8fc5d3b2
- 09:27 deploy 20261121-0927-8fc5d3b2 DONE (health 11/11; :4101/root/model no-door → 403). 09:29 live-door AP + tailnet PASS. Test device removed.
- P4 (11:20 its clock): v0.9.1 DRAFT from 8fc5d3b2, 11 signed files, not public; proofs on the draft running; tag local only until they pass. Sent P5 on at 10:30 (draft news; publish only after public + my word). Reported MAIN 10:31.
- WAITING: P4 → "v0.9.1 public" (then give P5 the word to publish, check live pages); P3's line (locked; joins wait for owner approvals); owner: pairing (ap-pair.html until 12:43 today — delete after), reboot window. After owner's phone passes voice on ap: retire coturn (AP-7).
- 10:40 v0.9.1 PUBLIC (P4). Verified as a stranger: latest, 11 files, signature good (-I release@yggdrasil -n yggdrasil-release), sha256 ok, tag^{} = 8fc5d3b2, latest/download/join.sh = v0.9.1. Gave P5 the word to publish (10:41, queued behind its running turn). origin/main still at v0.9.0's commit: left to the lead (not in my orders).
- NEXT: P5 reports the live site → check veraldar.org pages myself (curl+grep, phone-width screenshot). Then: retire coturn after the owner's phone passes voice on ap (AP-7); reboot proof when the owner picks a time.
- 14:40 P5: veraldar.org live with v0.9.1 (site-v091 27ff703, deploys 10:51 + 14:35, backups on VPS ~/site-backups/, undo scripts/site-deploy.sh --undo). Verified by me 14:4x: 11 pages 200, v0.9.1 download links (6 files, exe 200), 0 visible stale text (2 hits are HTML comments), marks Linux tested / Mac beta / Windows beta, Pixel 7: 3 videos, 0 overflow, 0 errors. ap.veraldar.org 200, /rootlink 426. Merged p5-site notes (a83c10f4).
- P5's brain session is blocked by "conversation open in a terminal" since 10:48: my 10:41 word and the owner's 14:37 follow-up (redo the films) failed there. P5 works from the terminal. Told MAIN.
- 14:39 CORRECTION (MAIN): P5's session takes messages again — a message at 14:37:47 ran, P5 is running the owner's film redo and reports when live. My "unreachable" line was true until 14:37:13, stale since. Verify step closed.
- WAITING ONLY ON: P5's new films (check them live when reported), P3 contd joins (owner approvals), owner: reboot time, phone pairing (new link on request), Windows run. Then: coturn off (AP-7) after the owner's phone voice on ap.
- 15:21 P5 third deploy (veraldar-site dbfd45b, live 15:20): new main film films/yggdrasil.mp4 (73 s). Checked by me: mp4/webm 200, range 206, plays on Pixel 7 (4 s in, 0 errors), download lines unchanged. Merged p5-site (sim/films/movie/ only).
- 17:2x P5 fourth deploy (veraldar-site 118de97, live 17:18): films with voice-over (owner 17:02: "no sound"). Checked by me: 8 served films each carry audio (aac/opus), 0 muted attributes, Pixel 7 tap on play → playing, unmuted, audio decoding (19.7 kB in 3.8 s), others paused, 0 errors; download lines unchanged. Merged p5-site (sim/films/ only).
- 19:5x p5-pair-quiet (d4e7b1a9) merged (ff) + deployed: release 20261121-1953-d4e7b1a9, units hub-app + hub-app-tailnet only (no brain restart). Green before: cargo 148, v09-ladder 10 passed/1 skipped, tree-e2e 131, trunk-rtc (R1 console QR pairing). Health 11/11.
- Live 19:5x: unpaired Pixel 7 on ap → /pair?unpaired=1, whole text "not paired", 0 links, 0 headings (artifacts/ap-unpaired-phone-1121.png); :8447 /pair console still shows QR + box key. Console errors there = 401/403 of background fetches + one icon path error ("base") — not visible, pre-existing.
- FIXED: app-tailnet.env had no BIFROST_DEVICES_FILE → the :8447 console wrote .devices.json INTO the release folder. Now BIFROST_DEVICES_FILE=state/devices-tailnet.json (backup app-tailnet.env.pre-devfile-1121), stray file removed, hub-app-tailnet redeployed. Live-door AP + tailnet PASS after.

## 11-22 21:4x roles-rework (owner 21:40 "we should not have agy and claude as role…", 19:51 "ask someone to do the rework")
- p1-hub reset to 70c8e102 (dropped my ff of c67b7852 = p5-pair-noflash: page-gate rewrite through the trunk → Next proxies to https://localhost → TLS error → 500 "Internal Server Error" for unpaired/revoked visitors; trunk-full steps 6 + 7b failed. NOT live; live 1328b639 doesn't contain it. Must be told to whoever owns noflash now).
- Rollback fix edbb0db1: deploy backs up first (no backup → no brain deploy), a failed brain deploy restores data/session + agents.json from that backup before the old release starts; `hub-units.sh rollback <id> <backup>` by hand. Proven on a copy of 61 live sessions: new brain migrates (0 claude/agy roles), restore byte-identical, live release reads them as today.
- Merged roles-rework 0d179319 (merge c7225857). Green: cargo 153, tree-e2e 141, restart-e2e, app build.
- DEPLOY (cuts my turn): release from p1-hub → ~/Work/tree-next/scripts/hub-units.sh deploy <id> (all units). Log switch.log; it prints "-- the way back for the data: <backup>". AFTER: health; GET /session → no agent claude/agy, engines set; live-door both doors; Pixel-7 session list screenshot (role badge + engine word); report MAIN with release id + backup path + way back command.
- release 20261122-2146-111f06ee
- 21:46 DEPLOYED 20261122-2146-111f06ee (tree-next 111f06ee = 70c8e102 + rollback fix edbb0db1 + roles-rework 0d179319). Backup first: ~/.cache/root-sim/backups/20261122-214629. Health 11/11. Live: 61 sessions, 0 with role claude/agy/AGI, 24 migrated (agent_was), models + Claude Code conversation ids unchanged for all 61 (compared with the backup). agents.json migrated (migrations [roles-1122]), .pre-roles-1122 kept. Live-door AP + tailnet PASS 21:48–21:49. List on :8447 (Pixel 7): badges BUI/LEA/RES/FIX/REV + engine word, no CLA/AGY (artifacts/roles-live-list-1122.png).
- Way back by hand: ~/Work/tree-next/scripts/hub-units.sh rollback 20261122-1747-1328b639 ~/.cache/root-sim/backups/20261122-214629 (loses what was written since 21:46; the migrated copy is kept as data/session.undone-<time>).
- Seen: first /api/session after the restart took 10 s (cold: resends + reindex), then 2.8 s / cached 0.004 s. bridge.log: root-link dials refused "link-token: expired (>6h old)" — a joined root's tokens (P3's line).
- Do NOT hand-edit state/devices.json while hub-app runs (memory note): test devices stay as revoked entries.

## 11-23 14:1x badge fix (owner 13:13 "overlap with the end to end … does not match the design", 13:34 "was it pushed")
- tree-next ff → 8e23d0dd (= 81ebc091 + hide-station-user-r1 83f31d2a (was live, not in tree-next) + fix-badge-overlap). Diff vs live: 4 app files. Fix session's gates on 8e23d0dd: cargo 153, tree-e2e 141, restart-e2e 22, pin-state-place 20/20×5. Mine: next build, trunk-rtc GREEN (P1 pinned PASS).
- Deployed 20261123-1410-8e23d0dd, hub-app + hub-app-tailnet only, health 11/11.
- live-door on ap: run 1 — every step passed incl. 360 px (pin t704–722 vs MAIN name t741), then Chromium "Target crashed" on the final :8447 screenshot (test browser); run 2 — 1 passed, all steps. Artifacts: 1b-home-end-to-end-360.png, live-door-1123-steps.txt.

## 11-23 14:35 trunk meter (owner 13:48 "…trunk-observability-proposal-v2.html accepted")
- tree-next ff → f127796a (trunk-obs). Rigs on the candidate: trunk-rtc GREEN, trunk-full GREEN (sender's list lacked both). agy review: no auth regression, no secrets/content; findings for the trunk-obs session (before the VPS step): (1) STATS from the VPS written with blocking I/O on the ap-dialer runtime + no allowlist/bounds on proc_/ts; (2) obs files 0644 (dir is 0700 → fine now), report dir/files default umask; (3) kv_rows leaves values unescaped in trunk-day HTML (VPS strings); (4) on a rollback to a pre-meter release the timers stay and fail every 5 min, transient release check not cancelled; (5) obs.ts flush re-entry, poisoned-mutex unwraps on hot paths, UTF-8 slicing. Also: post_main "never a model turn" is inaccurate (external_report = a digest call; non-routine wakes MAIN) — fine for alerts, which are posted once per incident.
- Deployed 20261123-1435-f127796a: hub-bridge hub-wg hub-app hub-app-tailnet (no brain restart). Health 11/11. obs/ 0700, bridge-min + wg-min within 15 s, /_obs 200, first probe event 14:39, timers watch 5 min / report 07:00 / release check 14:51; secret scan of obs/ clean. live-door AP PASS 14:40.
