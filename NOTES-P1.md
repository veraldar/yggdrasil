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
