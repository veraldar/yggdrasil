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

## In flight
- builds (brain, trunk → ~/.cache/p2-reach/trunk-target, app) → ~/.cache/p2-reach/spoken/build.status
- agy review: ~/Work/p2-spoken-agy (brief.md, L16.diff → review.md; pid in agy.pid)

## Next
1. S16 rig: `--scenario s16` on lab and S16_ROOT=home; hold steps h5/h6 must pass now
2. app e2e for the held reply? (rig covers it with real TTS)
3. decision to flag: hands-free mode still speaks replies to turns typed while it is on (unchanged)
4. report to P1 via MAIN
Temp: ~/.cache/p2-reach/{tmp,sim-tmp,app-tmp}; never /tmp. Builds under nice -n 10.
