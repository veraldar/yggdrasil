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

## Half done
- p3-app: WIP commit c3adaa1c (sheet, routes, tag) — sub-agent cut by the usage limit; resumed

## Next
1. rootjoin.py brain-env: YGG_ROOT_MAIN=1 + YGG_HOME_ROOT=<hub>; trunk-full-joiner.py the same
2. Rust tests: ensure_main_creates_one_and_only_one, learned_root_gets_one_main_proxy, adopt_is_idempotent_and_keeps_report_to,
   removed_root_archives_its_proxies, gate_refuses_no_token_and_wrong_token, hops_past_two_refused, relay refused remote,
   owner_typing_into_root_main_is_an_owner_turn_but_session_send_is_not
3. cargo test green; trunk-full-e2e.sh + trunk-roots-e2e.py still green
4. S10 + S18 in the trunk-full rig (new spec steps), Pixel-7 screenshots
5. independent review of the diff (sub-agent), then report to MAIN
6. omarchy-lab (old public brain) only after P1 reports stage B done (home renamed `omarchy`)
