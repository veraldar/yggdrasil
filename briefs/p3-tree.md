# P3 · the whole tree — working notes (package 3 of lead-review.md)

Orders: `~/Work/root-coord-pwa/artifacts/lead-review.md` §3 (L4–L8), §4 package 3; plan E2, B7b, S10; new S18.
Branches: `p3-tree` (brain + merge), `p3-app` (app, sub-agent), `p3-search` (B7b, sub-agent).

## Brain contract (home brain, what the app calls through its own routes)

- `GET /root` — as before, plus
  - `main`: this root's own `[MAIN]` id (null if none), `home`: the home root's name as this root knows it (null = this is home)
  - `roots`: `[{name, reachable, seen, os, arch, cpus, mem_gb, running, sessions, models:[id], main, main_proxy}]`
    (`main` = that root's MAIN id there, `main_proxy` = the local proxy of it)
- `GET /root/{name}/sessions` → `{root, reachable, main:{id,proxy,title}|null, sessions:[{id,title,agent,status,headline,updated,busy,proxy}]}`
  - `id` = the id on that root; `proxy` = the local proxy id or null. Proxies on that root and test sessions are left out.
  - name = this root: the local sessions (proxy = id). Unreachable: `reachable:false`, the local proxies of that root.
- `POST /root/{name}/adopt {id}` → `{proxy, title}` (idempotent; the session's `report_to` there is untouched)
- `POST /session {title, agent?, root}` — root ≠ this one: the session is made there, a top-level proxy here (card.root)
- `DELETE /root/peers/{name}` (loopback, not from a peer) → `{removed, archived}`: forgets the root, its proxies say "root removed"
- `POST /tree/placed` (peer) — root A placed work on root B: the home root makes a proxy for it (card.root = B, card.by = A)
- Proxies: `info.remote = {root, id}`, `card.root`; a root's MAIN proxy has `card.kind = "root-main"`, title `MAIN · <root>`

## Rules
- Every root's MAIN keeps `[roots]` and `root=` (L6). `info.hops` / `meta.from.hops` ride with the work; a placement
  past 2 hops is refused with a plain sentence. Proxied `session_send`/`session_start` refuse a relayed approval.
- L8: a call that came through the trunk (`x-ygg-via`, set by the trunk's door in `switch::perform`) or carries
  `x-ygg-peer` must carry the right peer token — every route (one middleware). No token configured = refused.
- `YGG_ROOT_MAIN=1`: the brain makes its own `[MAIN]` at start (a joined root runs no app). `YGG_HOME_ROOT=<hub>`:
  where placements between two other roots are told. Both written by `rootjoin.py brain-env`.
- Learned peers: dropped when the list no longer names them (proxies kept); an explicit DELETE also archives the
  proxies and keeps the name from being learned again.
