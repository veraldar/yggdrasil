# P3 notes (resume from here after a cut)

Contract and rules: `briefs/p3-tree.md`. Branches: p3-tree (brain, merges), p3-app (app sub-agent), p3-search (B7b, merged).
Build with `TMPDIR=~/.cache/p3-tmp` (/tmp is a shared 16 GB tmpfs, near full). Rig ports: 185xx (app agent), 186xx (search), 187xx (mine).

## Done
- trunk: `switch::perform` + root-dial.py mark peer calls `x-ygg-via: trunk` (wg test asserts it, forged one replaced)
- brain: roots.rs — ensure_main (YGG_ROOT_MAIN=1), root-MAIN proxies (`[MAIN] <root>`, card.kind root-main, under local MAIN),
  GET /root {main, home, roots[] health}, GET /root/{name}/sessions, POST /root/{name}/adopt, POST /session {root},
  DELETE /root/peers/{name} (loopback, not from a peer; archives proxies "root removed"), POST /tree/placed + forward_home,
  hops (info.hops, meta.from.hops, MAX_HOPS 2), RELAY_REFUSED on remote send/start, root-main never closed remotely,
  peers::gate middleware (L8) on every route, learned peers dropped when unlisted (proxies kept), asker gets the answer
- B7b merged from p3-search (librarian_search roots:"all", POST /ext/{name}/call peer-only, fallback text search)
- tree-next 4a5f7244 merged

- installer: rootjoin.py brain-env writes YGG_ROOT_MAIN=1 + YGG_HOME_ROOT (checked by hand; join-test.sh is red BEFORE p3 too:
  join.sh downloads bifrost-net from GitHub, the test gives it none — P4's, reported)
- 10 roots tests; cargo test 126 green; sim/tree-e2e.py GREEN; sim/trunk-roots-e2e.py GREEN (its tunnel probes now send the token)

- p3-app merged (sheet, routes, tag, pending joins, remove; its own rig sim/roots-sheet-e2e.sh green; screenshots p3-roots-*.png)
- bridge refuses + cuts a removed root (rootlink.rs; it only checked the device); a root off at once on a failed call; polls 30 s
- independent review: 9 findings, all fixed (commit "review fixes"), 127 tests green, tree-e2e GREEN again
- rig spec: 7a-7i (S10 brain side, L8 through the tunnel, S18 incl. 3rd hop refused), 7s/7z (sheet taps, remove)

- sim/trunk-full-e2e.sh TRUNK-FULL: GREEN, 31/31 steps (13 new: 7a-7i, 7s, 7z); screenshots artifacts/p3-s10-*.png
- old public brain's data backed up: ~/.local/share/yggdrasil-backups/omarchy-lab-data-20261120-001112 (+ .sha256)

## Waiting
- omarchy-lab + a Linux container root on the REAL trunk: after P1 reports stage B (home renamed `omarchy`)

## Next
1. when P1 says stage B is done: join.sh --name omarchy-lab --dir ~/.local/share/yggdrasil-root-lab --no-start,
   check the data path in its brain.env, copy the backup in, start; the owner approves on the phone
