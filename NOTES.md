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

## Half done
- p3-app: WIP commit c3adaa1c (sheet, routes, tag) — sub-agent cut by the usage limit; resumed

## Next
4. merge p3-app when its agent reports; npm run build; sim/trunk-full-e2e.sh green
5. S10 + S18 in the trunk-full rig (new spec steps), Pixel-7 screenshots
6. independent review of the diff (sub-agent), then report to MAIN
7. omarchy-lab (old public brain) only after P1 reports stage B done (home renamed `omarchy`)
