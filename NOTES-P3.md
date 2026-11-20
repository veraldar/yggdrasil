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

## 11-21 00:05 — session "P3 whole tree contd" (ses_f30935…; the old P3 conversation is locked)
- Post-merge check on tree-next e64a4527 (worktree ~/Work/p3-post-merge): cargo test 147/147, sim/tree-e2e.py GREEN 131/131
  (--port-base 18790). Live release 20261120-2341-a8b73cbf = a8b73cbf ⊃ 67074f36 (p2-spoken) + 029232f9 (p5-site). wg-on live 23:51 (P1).
- omarchy-lab: join.sh --hub https://ap.veraldar.org --name omarchy-lab --dir ~/.local/share/yggdrasil-root-lab
  --upstream-env DIR/upstream.env --brain-bin/--net-bin = the live release's bins --no-start, run under env -i (no session YGG_* leak).
  Ports 4180/4181. Old data (3 sessions) copied into DIR/data, sha256 OK. YGG_ROOT_NOTE fixed (was "the hub: omarchy").
  Request 1: code 5C5Q-P5HP, key a765-4ad6-f78e, expires 00:08:54 — owner asked through MAIN.
  AFTER approval: re-run the same join.sh without --no-start → systemd units yggdrasil-root-{brain,dial,wg}; check GET /root on home.
- Linux container: Debian 12 ON OMARCHY (plan line 742: "a Debian 12 container on omarchy with only TCP 443 out"), not on the VPS.
  Image p3-debian-root:12 (~/.cache/p3-ct/image; egress tcp/443+dns; user ygg; restart re-runs join.sh). Bins built in
  ygg-release-build:bullseye from e64a4527 into ~/.cache/p3-ct/target (own cargo registry copy; P4's cache untouched).

- 00:08:54 request 1 for the lab expired untapped (owner away). Since 00:09: WATCHER PID 2148002
  (~/.cache/p3-ct/watch/join-watch.sh, log ~/.cache/p3-tmp/join-watch.log) renews both requests whenever one expires,
  for 14 h (until ~14:10), and posts ONE "[watcher] … joined" message to this session per root when approved. The lab's renewals
  run WITHOUT --no-start (data already in place) → join.sh starts yggdrasil-root-{brain,dial,wg} itself after the tap.
  Stable tunnel keys: omarchy-lab a765-4ad6-f78e · debian-box 4467-10ae-2c1e (the codes change with each renewal).
- Container p3-debian-root (docker, --restart unless-stopped, hostname debian-box, NET_ADMIN for its own egress rules):
  egress checked: ap.veraldar.org:443 open, :80 and 1.1.1.1:22 refused. Debian 12.15. Supervisor nohup (no systemd inside).

## Next
1. lab approved → start it, see it in /root on home + its MAIN + 3 sessions.
2. container: docker run -d --name p3-debian-root --hostname debian-box --cap-add NET_ADMIN --restart unless-stopped
   -v ~/.cache/p3-ct/src:/src:ro -v <bins>:/bins:ro p3-debian-root:12 ; docker exec -u ygg … join.sh --hub https://ap.veraldar.org
   --upstream-env … ; owner approves; S10 on the phone.
