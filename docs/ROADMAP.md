# ROADMAP — one page

*Steward artifact, 11-02. Canon: `docs/CONSTRUCT.md` (10-30, binding).
Versions only at land events (`docs/RELEASES.md`); lanes/builds are
name + commit-hash. Trunk evolution is roadmap, not state: tailscale
today → webrtc → wireguard.*

## shipped

- **voice gates** — the reply-cut-off and herdr-triad checks
  (`a593015a`, frozen into v0.7.0 live)
- **mic self-heal, triple-GO** — norefresh watchdog series
  `dcd2f5db..e989425e` (QUIET-ALIVE/SILENT-DEAD, once-guard, re-review
  GO r1+r2+r3), claims closed `a0370608`
- **TURN-over-443 trunk** — the UDP blocker routed around, not fixed:
  byte-peek dispatcher on :443 (STUN→coturn, TLS→caddy), relay proven
  1000/1000 B 0% loss (RFC 6062, 11-02)
- **QR pairing** — /pair mints shown-once token + TURN creds; phone
  scans, lands in the branch (layman-qr-1600 GREEN)
- **frozen live stack** — v0.7.0 cut `a593015a` serving on the tailnet
  omarchy tree; serving == released
- **multi-root root-link v4c2** — bridge.rs root-link op (HMAC root
  tokens, ROOTS registry, `{root}` dispatch), health probes + per-root
  in-flight caps (`4909a2a6`) through the root-dial client
  (`ec088673`): lane `bifrost@lab/layman-deploy` → `dc9623fa`
  **serving on the VPS** (11-02 evening); rehearsal trunk armed on the
  tailnet. Serving ≠ released.

## in-flight

- **public-wss root-link ingress** — Mac join hit the tailnet ACL wall
  (11-02); the lane now goes public wss instead of tailnet membership
  (see `docs/RELEASES.md` evening log)
- **VPS speech models** — speaches stack on the veraldar VPS; off-LAN
  voice landed via the TURN transport above
- **infomaniak UDP ticket** — ingress dropped since the 11-01 edge
  maintenance window (8239/3478/5349 udp); ticket written
  (`artifacts/infomaniak-ticket.md`), TURN carries the traffic meanwhile

## poles (deliberately far)

- **mesh.rs replaces tailscale** — the sky-node spike: bifrost-net
  `mesh.rs`, de-risk via lab M0 (two nodes, lab-only)
- **the fleet decision** — how many roots on one box (1 root + agent /
  4 / 10): pending real-fleet signals
- **windows code-signing** — installer compiles and sim-GREENs; signing
  and a real-Windows double-click proof remain
