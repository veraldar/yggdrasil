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
