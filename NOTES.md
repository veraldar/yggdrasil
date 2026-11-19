# P2 notes (package 2: full sessions on other roots, files) — keep current

Contract: ~/.cache/p2-reach/contract.md. Worktrees: p2-reach (brain, mine), p2-reach-app (app helper),
p2-reach-sim (sim helper). Temp files: ~/.cache/p2-reach/tmp (NOT /tmp: shared quota).

## Done (brain, compiles, cargo test 120/120)
- relay.rs: event journal + POST /event/feed (long poll); home follower per root; proxy turns
  forwarded async with meta.key (run once), SSE / held POST / async answered like local; busy in
  running; abort forwarded via the running handle; link lost (45 s, YGG_RELAY_LOST_S) → error
  "no answer from <root>" + idle + card.
- files.rs: store files/blobs/<sha256>, upload in pieces, GET piece/whole (?root= pulls), info,
  /file/artifact (local or pulled from root), data-URL ingest, prepare() before a turn (pull, path,
  inline text), harness lines, brain-native model text, image resolve, artifact link pointing.
- main.rs: routes, publish → journal, post_message proxy path, key dedupe, list_messages proxy view +
  link pointing + ?from=, abort/delete/patch/get/model/agent for proxies.
- tree.rs/peers.rs: attach:true on session_start/send (local + remote), peers::send via relay,
  remote.made; coordinator prompt sentence for attach.

## Proven (00:20)
- cargo test 120/120; tree-e2e full 131/131 GREEN incl. 41 package-2 checks
  (log ~/.cache/p2-reach/tree-full-run1.log; `python3 sim/tree-e2e.py --only reach --port-base 4270`)
- voice agent: branch/voice/test_no_resend.py GREEN (old agent: 2 POSTs on a 502, new: 1)

- S3 GREEN (sim/reach/s3.py, scratch brain, real upstream; MAIN attach:true; Claude Code reads path)
- S17 real-model GREEN (sim/reach/s17_real.py: two scratch brains, real Claude Code haiku on lab)

- app merged (5/5 Pixel-7 specs on real brains; screenshots p2-files-*.png)
- independent review: 13 findings, all fixed (b948d5c4, +1); its 4 repros in sim/reach/regress pass;
  after the fixes: cargo test 120/120, tree-e2e 131/131 (~/.cache/p2-reach/tree-full-run2.log)

## In flight
- sim helper (p2-reach-sim): S16 (trunk-rtc --scenario s16), S17 (trunk-full --scenario s17)

## Next (me)
1. merge sim branch when S16/S17 ran; rerun S17 real once on the final build
2. report the branch to MAIN for P1 (integrator); tell P3 about peers::start/send signatures
