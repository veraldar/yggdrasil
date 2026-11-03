# RELEASES — the release ledger

*Steward artifact, 11-02. Canon: `docs/CONSTRUCT.md` (10-30, binding) —
veraldar = the org; yggdrasil = the tree; root = the brain; trunk = the
private line; branch = the app. Release law (canon 11-02): `v0.x.y` is
minted only at a land event, owner-gated; lanes/builds are identified by
name + commit hash, never "vN"; **serving ≠ released**. This ledger is the
one place versions and their hashes meet.*

## v0.7.0 — FROZEN LIVE STACK — landed

- **Cut:** `bifrost` release line, freeze commit `a593015a` (voice-stab:
  room-scoped purge-stubs probe + e2e stage-drain waits) — the stack that
  passed the gate and was promoted to the live units (lk-pwa :8080 +
  lk-agent; brain = trunk yggdrasil :4100). Serving box: tailnet omarchy.
- **Tree:** `veraldar/yggdrasil` carries the cut — `root/` verified
  identical to `a593015a` (commit `c855b16`), alongside its `trunk/` and
  `branch/`.
- **Tag:** `yggdrasil/v0.7.0` (light, no message) → `9e26e7b` (master:
  scaffold + canon + release law). Minted 11-02. No force, no retag:
  veraldar/bifrost already holds a legacy `v0.7.0` tag (`a64514b8`, the
  10-27 phone-line cut) — superseded here by the product ledger; the
  `yggdrasil/` prefix keeps the namespaces apart.
- **Status: landed.** Serving == released for the first time.

## 11-02 evening — trunk-lane landings (deploy/incident log; serving ≠ released)

- **v4c2 trunk deployed to the VPS** — root-link v4c2 lane
  `bifrost@lab/layman-deploy` → `dc9623fa` (source `4909a2a6`, artifact
  `bifrost-net-v4c2` sha256 `0262c287…e58729`) — serving on the veraldar
  VPS. Serving, not minted: no version attached.
- **rehearsal trunk armed on the tailnet omarchy** — second trunk
  instance up as the rehearsal mirror of the VPS lane.
- **Mac join blocked by tailnet ACL → superseded by the public-wss
  plan** — the ACL wall stands; the plan is public wss ingress instead
  of pulling the Mac onto the tailnet. Logged as superseded, not fixed.
- **registry-sync incident (found by the owner)** — served
  `/api/profiles` showed the stale tree-config copy, not the brain
  registry; fixed by a brain restart with captured env (`YGG_PROFILES`
  now one source of truth at boot). One-line law echo: profiles are
  fixed at boot, never from the API.
- **profile enforcement proven live** — coordinator promoted to default
  profile on the brain; MAIN demoted live and the demotion held —
  enforcement proof, no code changed.

## next: v0.8.0 — candidates (not minted; canon: "validated mic self-heal + voice gates + TURN trunk when landed")

| # | candidate | repo → hash | status |
|---|---|---|---|
| 1 | mic self-heal / norefresh series — QUIET-ALIVE vs SILENT-DEAD watchdog, once-guard, re-review rounds 1–3 + S5 honesty scenarios | `bifrost@lab/sandbox` → `dcd2f5db..e989425e` (7 commits) | **landed-candidate** — reviewer GO (`a0370608`), claims closed |
| 2 | trunk v2c candidate hygiene — no loopback/CGNAT emission, learn-from-source, SDP strip (base: v2 room relay `d71f419e`) | `bifrost@lab/layman-deploy` → `49cbcffc` (+ test record `ad541dd4`) | **landed-candidate** (local-only: unpushed, not on a release line) |
| 3 | TURN seam — PWA reads token-carried, expiry-aware iceServers into the pc config | `bifrost@lab/layman-deploy` → `a048d9d6` | **landed-candidate** (local-only: unpushed); transport proven GREEN via coturn tcp/443, 11-02 |
| 4 | dispatch-storm guard — no dispatch when agent present, takeover latch | `bifrost@lab/layman-deploy` → `77ef4023` | **landed-candidate** (local-only: unpushed) |
| 5 | sandbox residue — voice-stab2 replace-semantics (one live job per room) in `agent/agent.py`, `sandbox-up.sh` unit rename, AGENTS.md glossary | `bifrost-sandbox` worktree → uncommitted diff | **provisional-uncommitted** |

Mint rule: v0.8.0 exists when the owner says "land it" over candidates 1–4
(the canon triple) — not before. Until then every build above is a name +
hash, serving or not.
