# Security model & threat statement

yggdrasil is built around **per-device credentials and pinned cryptographic keys**, not shared network membership. When you run your own trunk on a rented VPS, your home computer never opens an inbound internet port—it dials out to the VPS, and your phone and extra computers authenticate directly against keys and hashes held at home.

## Trust boundaries & what the VPS can and cannot see

| Component | Holds | Network exposure |
|---|---|---|
| **Home hub** (`yggdrasil`, `bifrost`, `bifrost-net`) | LLM API keys, sessions, files, `devices.json`, `roots.json`, `hub-wg.key`, `bridge-dtls.json` | Dials out to VPS (`wss://<trunk>/ap`); `yggdrasil` binds `127.0.0.1:4100` (unauthenticated); in trunk mode `bifrost-app` binds `127.0.0.1` |
| **Rented VPS** (`bifrost-net ap`) | Own TLS key (`key.pem`), TLS cert, `bridge_token_sha256` | Public TCP 443 (and port 80 for Let's Encrypt ACME); forwards bytes, holds no user/model secrets |
| **Joined root** (`yggdrasil`, `bifrost-net wg`) | Own `wg.key`, `root_secret`, 6 h link tokens, upstream LLM key | Dials out to `wss://<trunk>/rootlink`; brain binds loopback only |
| **Phone / browser** (`branch/`) | `bifrost_device` + `bifrost_refresh` cookies, `localStorage` bridge pin (`fp`) | Talks to `https://<trunk>` and WebRTC ICE-TCP `<vps>:443` |

### What the VPS cannot see (after pairing, with pinned channel active)
- **App data (`/api/*` except `/api/pair/*`, and `/rtc` LiveKit signaling):** Once paired, the phone's service worker and `branch/lib/pinned.ts` open a WebRTC data channel (`tun`) directly to the bridge at home. The phone verifies the bridge's DTLS fingerprint against the QR-pinned fingerprint **before** `RTCPeerConnection.setRemoteDescription`; a mismatch aborts before any app byte is sent (`"box key mismatch — nothing sent"`). The VPS relays encrypted WebRTC packets it cannot decrypt.
- **Voice media:** Audio rides ICE over TCP on port 443 (`livekit-ice`) to LiveKit at home using end-to-end DTLS-SRTP between phone and home LiveKit. The VPS forwards STUN/DTLS/SRTP bytes without keys.
- **Root-to-root brain traffic:** Brain calls between roots ride WireGuard (`bifrost-net wg`, `boringtun` Noise_IKpsk2 + `smoltcp` userspace TCP) inside binary WebSocket relay frames. Neither the VPS nor the hub's bridge holds root WireGuard private keys.
- **Secrets and files at rest:** Model API keys, sessions, project files, and credential registries stay at home.

### What the VPS can see
- **The web app shell:** HTML, JS, CSS, and the service worker are served through the VPS's TLS endpoint.
- **Initial pairing and signaling:** `/pair`, `/api/pair/*` claims, and WebRTC `POST /offer` signaling pass through the VPS's TLS termination (though the QR's `#v=1&code=…&fp=…` fragment stays client-side and is stripped from browser history before claiming).
- **Connection metadata:** Source IP addresses, timestamps, connection volumes, and root-link control ops (`root-link`, `ping`, `pong`).
- **First-contact fallback:** If a network blocks WebRTC on initial page load before the pinned channel comes up, traffic falls back to the trunk's TLS (`via the trunk's TLS`), which the VPS terminates. Once a page has pinned, losing the channel enters `reconnecting` (returning `503` instead of falling back to TLS).

## Pairing & the QR pin

1. **Admin-only minting:** Pairing codes can only be minted from the home console (`127.0.0.1`, behind `branch/server.mjs`), via `install.sh pair` / `pair.sh`, or using `BIFROST_ADMIN_TOKEN`. A paired phone can view devices, revoke devices, or trigger the kill-switch, but cannot mint a new device.
2. **Fragment-carried secret:** The QR URL puts the one-time pairing code (`bfnp-…`) and the bridge's persistent DTLS certificate SHA-256 fingerprint (`fp`) in the URL fragment (`#v=1&code=…&fp=…`), so they do not appear in HTTP request paths or server logs. `/pair` strips the fragment via `history.replaceState` before calling `/api/pair/claim`.
3. **Trust on first scan:** `bfnp-` codes expire in 5 minutes and are single-use (`410 used` on replay). Re-pairing from a browser holding a previous `bifrost_refresh` cookie automatically retires the prior device entry.

## Revoking a phone & the kill-switch

- **Revoke one device:** Run `./install.sh pair --revoke <name-or-id>` on the home machine, or click **revoke** in `/devices` from any paired phone or the home console.
  - `devices.json` is re-read without caching on every `/api/*` request (`branch/middleware.ts`), every 500 ms by `bifrost-net` bridge, and every 1 s by `bifrost-wg`.
  - The device's next HTTP request fails with `401`; its WebRTC data channel receives `{"op":"severed"}` and closes within ~1 s; its LiveKit voice participant is removed within ~1 s; and WireGuard tunnels to any roots that device approved are cut within ~1–2 s (the hub node pushes an empty directory update and drops the peer).
- **Kill-switch ("sever all bridges"):** Run `./install.sh pair --kill` or click **sever all bridges** in `/devices` (`POST /api/pair/kill`). Every device is marked revoked, every unused pairing code is deleted, `killEpoch` increments, and all live phone channels, voice rooms, and joined root tunnels are dropped. Recovery requires scanning a new QR code at home.

## WireGuard keys approved on the phone

When a new machine runs `join.sh`:
1. It generates its WireGuard keypair locally (`wg.key`, mode `600`; private key never leaves that machine) and sends `wg_pub` in `POST /api/roots/join`.
2. It displays a QR code, an 8-character comparison code (`XXXX-XXXX`), and the 48-bit key fingerprint (`xxxx-xxxx-xxxx`).
3. Opening that QR on an already-paired phone (`/join`) displays the machine metadata, comparison code, and key fingerprint. Tapping **Add to my tree** pins `wg_pub` and its assigned tunnel IP in `roots.json` on the home hub and adds that root to the approving device's `roots` allowlist in `devices.json`.
4. The bridge stamps every relayed frame with the authenticated link it arrived on; the hub node drops any datagram whose WireGuard key arrives on a different link (`wrong_link`), preventing key-copy spoofing across links.

## Tokens & where they live

All stored tokens in `devices.json` and `roots.json` are **SHA-256 hashes only** (128–256 bit CSPRNG values compared with `timingSafeEqual`); raw tokens leave the server once on mint/refresh.

| Location | Mode | Contents |
|---|---|---|
| `~/.local/state/bifrost/devices.json` | `600` | SHA-256 hashes of `bfnp-` pairing codes (5 min, 1-use), `bfnd-` access tokens (15 min, bound to network region), and `bfnr-` refresh tokens (30 d, rotated on every refresh with >30 s reuse theft revocation), plus `killEpoch` and per-device `roots` allowlists |
| Phone browser cookies (`HttpOnly; SameSite=Strict`) | — | `bifrost_device` (`bfnd-`) and path-scoped `/api/pair` `bifrost_refresh` (`bfnr-`); `localStorage` holds the pinned bridge DTLS fingerprint (`bifrost.pin`) and JS access token copy for WebRTC auth |
| `~/.local/state/bifrost/roots.json` | `600` | Joined root metadata, `sha256(root_secret)`, approving device ID (`dev`), pinned `wg_pub`, tunnel IP |
| `~/.local/state/bifrost/bridge-dtls.json` & `hub-wg.key` | `600` | Home bridge DTLS identity keypair and hub WireGuard private key |
| `~/.config/yggdrasil/yggdrasil.env` | `600` | LLM upstream URL, `YGG_UPSTREAM_API_KEY`, `YGG_PEER_TOKEN` |
| `~/.config/bifrost/{bifrost,app,agent,voice}.env`, `bridge.toml`, `livekit.yaml` | `600` | `BIFROST_ADMIN_TOKEN`, `BIFROST_TRUNK` (AP token + pin), `BIFROST_ROOTLINK_SECRET`, LiveKit API key/secret |
| Joined root `~/.local/share/yggdrasil-root/` | dir `700` | `wg.key`, `link-tokens` (20 single-use 6 h tokens), `brain.env` (`600`), `root.json` (`root_secret`, `hub_name`) |
| VPS `/etc/yggdrasil-trunk/key.pem` & `ap.toml` | `600` / `644` | VPS TLS private key (`root`-owned, copied into private systemd tmpfs `/run`) and `bridge_token_sha256` (no raw hub token on the VPS) |

## Honest limits

- **An untrusted or compromised VPS can serve malicious frontend code:** Because the VPS hosts the web origin (`https://<trunk>`), a malicious operator could alter the HTML/JS sent to your phone before requests reach the pinned WebRTC channel. Always run your own VPS under your own account, never someone else's.
- **Pairing and `/offer` traverse VPS TLS:** The initial pairing code claim and WebRTC SDP exchange pass through the VPS; first-contact WebRTC failure falls back to trunk TLS (never after pinning succeeds in that session).
- **Direct `/branch` phone turns:** Turns sent from the phone directly naming a joined root via `/branch` (`root.job`) ride the root-link as frames readable by the hub bridge, unlike root-to-root brain traffic which rides WireGuard.
- **Root-link token replay after bridge restart & active links on revoke:** Spent single-use link tokens are tracked in bridge memory (`trunk/src/rootlink.rs`). Restarting the home bridge allows an already-spent link token to be replayed within its 6-hour lifetime. Revoking an approving device blocks new root dials and cuts the root's WireGuard tunnel in ~1–2 s, though an already-open WebSocket root-link stays connected until dropped.
- **No individual root revocation UI or expiring `root_secret` yet:** Removing a single root without revoking its approving phone requires removing it or setting `"revoked": true` in `roots.json` (`docs/spec-join.md`).
- **Root-link mint secret in process args:** `bifrost-net rootlink mint --secret` briefly passes the secret in argv when minting tokens on the hub (visible in `/proc/<pid>/cmdline` on multi-user hosts unless `/proc` uses `hidepid=2`).
- **Running Next.js without `branch/server.mjs`:** In `BIFROST_AUTH=devices` mode, plain `next start` lacks the trusted `x-bifrost-peer` header stamped by `server.mjs` (or `BIFROST_TRUST_PROXY=1` behind a trusted proxy), collapsing client regions. `install.sh` always serves via `server.mjs`.
- **Legacy `BIFROST_AUTH=tailnet` mode:** Setting `BIFROST_AUTH=tailnet` disables `/api/*` device authentication and relies entirely on Tailscale isolation. Do not expose `tailnet` mode outside a private tailnet.
- **Shell access on the home hub:** `yggdrasil` (and harnesses like Claude Code and Antigravity) executes commands as your user on the home machine. Keep `YGG_LISTEN` on `127.0.0.1`.

## Reporting a vulnerability

If you find a security issue, please email **security@veraldar.org** with the affected component (`root/`, `trunk/`, `branch/`, or installers), steps to reproduce, and impact. Please do not disclose exploitable details publicly until a fix is available.
