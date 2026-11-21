# P3 notes (resume from here after a cut) — 11-20 12:45

Two jobs from the lead (12:36). Branches: `p3-model` (job 1, worktree ~/Work/p3-model), `p3-verify` (job 2, ~/Work/p3-verify).
Temp: ~/.cache/p3-tmp (never /tmp). Builds/tests under `nice -n 10`.

## Job 1 — home root's side of "Same as the home root" (L15)
Contract for P4: ~/Work/root-coord-pwa/artifacts/p3-model-share-contract.md (written, v1).
Design: joiner sends `model:"home"` in POST /api/roots/join → approve page shows it → app tells the brain at approval
(`POST /root/peers/{id}/model {share:true}`, loopback) → brain keeps data_dir/model-shares.json → joined root asks
`GET /root/model` through its WireGuard node (/_wg/local/root/model, x-ygg-peer). Route answers only when:
x-ygg-via == wg (door mark), peer token ok, x-ygg-from (door: the tunnel's pinned peer) is in the shares and not removed.
- [x] trunk: door sets x-ygg-via: wg|trunk + x-ygg-from (commit 1a97a527, trunk tests 42 green)
- [ ] brain: Peers.shares, roots.rs get_model/post_share/load_shares, remove() drops the share, routes in main.rs, tests
- [ ] app: lib/roots.ts JoinReq.model, viewJoin, approveJoin → brain grant, RootRecord.share_model; join page line
- [ ] rig: trunk-full-joiner.py --model home (mac joins with it, brain started with ONLY what it fetched); spec steps:
      approve page shows the line; mac answers a turn; lab (no model:home) gets 403; no token 401; plaintext 403;
      the made-up key string appears in NO log and NOT in the tap
- [ ] report to P1 + tell P4 the contract

## Job 2 — check the P2×P3 merge on tree-next 5edbb05c
Chain runs in unit `p3-verify-run` (systemd --user): ~/.cache/p3-tmp/verify/run.sh → status.log, *.log there.
- [ ] app build · cargo test · trunk-full-e2e · trunk-roots-e2e · tree-e2e
- [ ] roots sheet on Pixel-7 against a two-brain rig + a session on the other root with live text and a file (P2)

## Waiting on P1 stage B
omarchy-lab + a Linux container on the real trunk. Backup of the old public brain's data:
~/.local/share/yggdrasil-backups/omarchy-lab-data-20261120-001112
