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
