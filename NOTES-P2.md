# P2 notes — task L16 (branch p2-spoken off tree-next 5edbb05c) — keep current

Rule (lead-review L16): a turn you speak is answered aloud; a turn you type in writing — home screen
and every session, every root. Written answer stays on screen in full. Prove: Pixel-7, hold to talk
in a session on home and on the other root (rig), hear the answer (real TTS); S16 extended.
Report the branch to P1 (merges + deploys).

## Done (b32e8351, WIP)
- branch/voice/agent.py: every turn through the agent is `modality: voice` (held too) on a root
- branch/app/session/[slug]/page.tsx: heldRef + effect — a held turn's reply is spoken once (text
  mode; hands-free cycle and the first-turn walk keep their own); pttUp arms, abort clears
- root/src/main.rs: harness_prompt appends VOICE_TURN_NOTE on a spoken turn (+ unit test)

- lib/held-reply.ts + e2e/held-reply.spec.ts (8 tests, `npx playwright test -c playwright.held.config.ts`)
- sim/reach/s16.mjs: walks hold@home, hold@lab, free@lab (S16_WALKS) + step x8: a typed turn after
  the held one is answered in writing, nothing spoken

## In flight (12:50) — a brain restart at ~12:42 cut the first builds; now in their own units
- builds: unit p2-spoken-build (~/.cache/p2-reach/spoken/build.sh → build.status; brain, cargo test,
  trunk → ~/.cache/p2-reach/trunk-target, app)
- agy review: unit p2-spoken-agy (~/Work/p2-spoken-agy: brief.md, L16.diff → review.md, agy.log)

## Next
1. S16 rig: YGG_BIN=root/target/release/yggdrasil BIFROST_NET_BIN=~/.cache/p2-reach/trunk-target/release/bifrost-net
   TRUNK_RTC_STATE=~/.cache/p2-reach/sim-tmp/s16-spoken sim/trunk-rtc-e2e.sh --scenario s16
   (run it in a unit too: systemd-run --user --unit p2-spoken-s16 …)
2. read agy's review.md, fix what is real
3. flag: hands-free still speaks replies to turns typed while it is on (unchanged on purpose)
4. report the branch to P1 via MAIN
Long jobs: always `systemd-run --user --unit <name> --collect --nice=10` (a brain restart kills children).
Temp: ~/.cache/p2-reach/{tmp,sim-tmp,app-tmp}; never /tmp.
