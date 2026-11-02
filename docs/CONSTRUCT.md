# CONSTRUCT — the owner's canon, 10-30, binding

*Source: the owner, verbatim intent, 10-30. This file is the one-page canon.
Every surface (brand book, site, READMEs, glossaries) aligns to it. Where an
older doc disagrees, this file wins. Supersedes the 09-30 brand map
(`brand.md` §1: roots = network — DEAD) and matches the 10-22 public copy
(`naming-ladder.md`), which already followed the owner.*

## The construct

**VERALDAR = the organization.** It holds products. Products can be anything
— hardware or software.

**YGGDRASIL = one product of that org: the tree.** It contains:

- **ROOT — the brain.** Installable on any computer.
- **TRUNK — the private line** between roots and the end user.
  Today: Tailscale. Roadmap: WebRTC first, WireGuard after.
- **BRANCH — the end-user app.** The current branch is named **bifrost**;
  that name stays (fine, already in the app). Other representation names
  (Midgard, Asgard, …) are optional garnish, not structure.

```
veraldar              the org — holds the products
└── yggdrasil         one product: the tree
    ├── root          the brain — installable on any computer
    ├── trunk         the private line — tailscale today → webrtc → wireguard
    └── branch        the end-user app — current branch: bifrost
```

## The one sentence

> Veraldar is the organization; Yggdrasil is its tree — a root brain, a
> trunk private line, a branch app — and bifrost is the first branch.

## Release law (canon amendment 11-02)

- **Product versions are `v0.x.y`, minted only at a land event.** Owner-gated:
  a release exists when the owner says "land it" and the tree is cut,
  tagged, and serving. Last: **v0.7.0** (frozen live stack). Next mint:
  **v0.8.0** — validated mic self-heal + voice gates + TURN trunk when landed.
- **Lanes and builds never use "vN".** A lane iteration is a *name* (what it
  fixes) + its *commit hash* — e.g. `rootlink-d71f419`, binary
  `bifrost-net@0e58923`. A hash cannot masquerade as a release; a release is
  a hash the owner chose to land.
- **Serving ≠ released.** A deployed binary on a box is *provisional* until
  minted into a version. The morning report maps serving-hashes → release.

## Boundaries this settles

- **roots = the network is DEAD.** The 09-30 map that made "the roots" the
  tailnet is gone. The root is the tree's brain. The private line is the
  trunk. (Said publicly since 10-22 via `naming-ladder.md`; now canon.)
- **bifrost is a branch of the tree, a Veraldar product.** Never "the
  organization", never the whole system.
- **yggdrasil is the tree, never "the brain".** The brain is the root.
- **Midgard/Asgard are garnish** — lore copy at most, never structure, never
  UI, never behavior docs.
- **Trunk evolution is roadmap, not state:** Tailscale today, WebRTC next,
  WireGuard after. Say "today" with Tailscale; never present it as permanent.
- Products under the tree may be anything (hardware or software); the tree
  construct does not change to fit them.
- **The root's capability surface is fenced:** opencode parity is the ceiling;
  everything the Mac grew as extensions stays extensions (plugins added and
  removed at will, never root code); the coordinator is a profile, not new
  root functionality. Full law + accepted exceptions:
  `docs/reviews/root-contract.md` §5 (surface fence).
- **The root is the brain, the trunk is the line** — trunk evolution is
  roadmap, not state (Tailscale today, WebRTC next, WireGuard after).

## Where the canon lives

| Surface | Alignment |
|---|---|
| `docs/brand/brand.md` §1 lore | points here; no second map |
| `docs/brand/lore-page.md`, `narration.md` | old map marked superseded |
| `docs/brand/naming-ladder.md` | public teaching order, unchanged — now canon-backed |
| veraldar.org (`~/Work/veraldar-site`) | org → tree (root/trunk/branch) → products |
| `veraldar/yggdrasil` README | the product construct + trunk roadmap |
| `veraldar/bifrost` README | branch of the tree, a Veraldar product |
| `docs/reviews/root-contract.md` §5 | the root's surface fence: opencode parity ceiling, extensions stay plugins, coordinator = profile |
| glossaries (AGENTS.md files) | one line pointing here |
