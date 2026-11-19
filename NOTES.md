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

## Next
1. run two brains (home+lab) by hand: SSE through proxy, abort, link lost, file pull, artifact.
2. merge app helper + sim helper work (both cut by the usage limit at 21:27; WIP committed).
3. agent.py: no fallback re-post after the server accepted the turn.
4. S3 / S16 / S17 in the namespace rig; screenshots; independent review of the diff.
