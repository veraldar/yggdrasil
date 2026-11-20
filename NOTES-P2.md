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

- review by agy (~/Work/p2-spoken-agy/review.md): real gaps fixed in 4bf34b57 (stopped run not said,
  empty hold ends after 45 s, two holds each answered, old turn never taken, text→free→text keeps it,
  walk + held path say once, agent re-asks a silent root, "over and out" stays written)

## Proven (13:15) — ~/.cache/p2-reach/spoken/final.status
- cargo test 147/147 · held-reply spec 10/10 · voice no-resend GREEN
- S16 extended GREEN 3 runs (20/20 steps): hold@home and hold@lab marked voice + answered aloud
  (real TTS, ~60 s of speech over the room, STT = the reply); typed turn after it: written, 0 bytes
  of speech; hands-free on lab as before
- trunk-rtc 10/10, trunk-full 19/19 on this build · tree-e2e 131/131 (one run had a flake in the
  Antigravity model-picker check: `agy models` was slow; green on the rerun)
- evidence: root-coord-pwa/artifacts/p2-spoken-{lab,home}.png, p2-spoken-lab-reply.mp3

## Open (said in the report)
- hands-free is unchanged: while it is on, a reply is said even when the turn was typed
- "over and out" keeps its old rule: that turn's answer comes in writing

## Next
- reported to MAIN for P1 (merge + deploy). After the deploy: the voice agent must be restarted
  with the new branch/voice/agent.py (it marks held turns voice) — P1's deploy does that.
Long jobs: `systemd-run --user --unit <name> --collect --nice=10` (a brain restart kills children).
