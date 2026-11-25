# Trunk v1 — WIRE notes (what the other streams call; M2)

Binding shapes stay in `CONTRACTS.md` (lead-owned). This file records what WIRE built on top of
them, so INSTALL, APP, IDP and OPS can call it. Items marked **contract?** are listed in WIRE's
report as wanted contract changes.

## Proto 2 details (C4)
- The upgrade: `GET /t/root` with `Upgrade: websocket` and **`X-Ygg-Proto: 2`**. No header (a v0.9
  bridge) or another value → `426 update this computer`. **contract?** (C4 says 426 for proto ≠ 2
  but not how the proto is named before the handshake.)
- `directory` CTRL = `{"t":"directory","directory":{seq,issued_at,roots,sig},"sig"}`: the inner
  object carries its own signature (that is what `trunk-state.json` stores and `bifrost-net wg`
  verifies), the outer one is C4's message signature.
- `keys` CTRL = `{"t":"keys","seq","keys":[…],"sig"}`; a lower `seq` than the one held is ignored
  (replay). **contract?** (`seq` added.)
- The welcome's `keys`/`kill_epoch`/`deny` are not covered by any signature in C4 (its `sig` binds
  only the ids and nonces), so the root takes authority only from the **signed** `keys`, `kill` and
  `revoke` messages the trunk sends right after the welcome; the welcome's own kill epoch and
  deny-list may only tighten (max / union), its keys are ignored. **contract?**
- A refused root gets `{"t":"refused","why":"revoked"|"unknown"|"bad-signature"|"protocol","root_id","nonce","sig"}`
  (signed, bound to the root's nonce). Only a verified `revoked` makes the bridge stop for good
  ("this root was REVOKED by trunk"). **contract?** (new message.)
- `ice.register {ufrags[], ttl_s}` → `ice.ack {ufrags[]}` (the ufrags taken), `ice.release {ufrags[]}`.
  The bridge registers its str0m ufrag at `/offer` and waits ≤ 500 ms for the ack; it renews every
  60 s and releases gone ones within 1 s. Routes die with the link. M5 adds LiveKit's from `/rtc`.
- `probe {id}` → the root echoes `probe {id}`; `stats {lines[]}` → ingested like v0.9 STATS.

## Root side
- `bridge.toml [trunk]` (C5) plus the operational keys the v0.9 `[ap]` had: `upstream` (default
  `127.0.0.1:8090`), `livekit`, `tcp` (`{ livekit-ice = "…" }`), `ice_tcp` (absent = the url host
  :443, `[]` = off), `wg_relay` + `wg_local` (the loopback UDP pair with the root's wg node).
  `[ap]` and `[trunk]` together are refused. `url` = `https://host[:port]` (TLS: `pin` or the web
  PKI) or `http://host:port` (rigs). **contract?** (extra keys.)
- The device gate in trunk mode: PASETO offline against `trunk-state.json` (C3 order and words,
  `reauth` = `login` where v0.9 says `pair`); `devices.json` is not read. The join exemptions of
  v0.9 do not apply.
- `bifrost-net root-key FILE` makes the root's Ed25519 key (b64url seed, 0600; prints
  `public_key`, `kid`) — what the installer sends as `root_pub`.
- `bifrost-net wg` config: `trunk_state = "<trunk-state.json>"` (+ optional `trunk_key`): the peers
  are the other roots of the signed directory (re-read on change, checked 5×/s); the node's own
  address is its directory entry's `wg_addr` (/24 unless `address` gives a prefix). `/_wg/_roots`
  entries gain `name` and `peer_token_sha256`. **contract?** (keys.)
- Brain (`root/src/peers.rs`): a peer call is accepted when sha256(`x-ygg-peer`) equals the
  `peer_token_sha256` of the root the WireGuard door names (`x-ygg-from`); the shared token rule
  stays. Each v1 root's `YGG_PEER_TOKEN` is **its own** token (from the enrollment result) and
  `YGG_ROOT_NAME` must be **its root id** (`rt_…`): brains name peers by the ids `/_wg/_roots`
  lists, and a report goes back to the name the caller gave. The display name is the directory's
  `name` (APP: map id → name where the UI shows a root).

## Enrollment API (F3/F4; for INSTALL's `root.sh` / `root.exe`)
- `POST /t/roots/enroll` (no cookie) `{hostname, os, arch, version?, build_id?, name?, root_pub (b64url
  Ed25519), wg_pub (base64 x25519), dtls_fp? ("sha-256 AB:…"), has_app, has_voice}` →
  `200 {id, poll_secret, poll_every_s: 2, approve_url (/auth/root?e=<id>), code, code_expires_in, expires_in, wg_fp}`.
  `409` a key already enrolled (revoked roots included) or waiting; `429` 5 per 10 min per
  address, or 32 waiting. A machine that asks again with the same keys replaces its waiting one.
- `POST /t/roots/enroll/:id/poll {secret}` every 2 s → `{status:"pending", code, code_expires_in, expires_in}`
  (the headless code rotates every 300 s; print the new one) · `{status:"approved", root_id, name,
  wg_addr, wg_net, trunk:{url, trunk_id, trunk_key}, peer_token, directory}` **once** (sealed in
  trunk.db until then) · `410 {status:"delivered"}` after · `{status:"refused"|"expired"}`.
  Headless: show `approve_url` + `#c=<code>` as the QR.
- Desktop card / headless approval (admin device; writes need `Origin` = the trunk):
  `GET /t/roots/enroll/:id` (card: hostname, name, os, arch, `wg_fp`, `needs_code` when the
  browser's region differs from the installer's) · `POST /t/roots/enroll/:id/approve {code?, name?}`
  (admin + fresh step-up: `403 {step_up:true}` otherwise; a wrong code `403 {left}`, the 5th ends
  the enrollment `410`) · `POST /t/roots/enroll/:id/refuse` · `POST /t/roots/enroll/by-code {code}`
  (finds the card; 10 wrong per account per hour → `429` for 1 h).
- Pages: `/auth/root?e=<id>[#c=<code>]` (the 1-tap card) and `/add-root` (enter the code), the
  shell's look, script `/t/roots/ui.js`. Served from WIRE's route until the shell takes them.

## Devices and roots (C6)
- `GET /t/me/roots` → `[{id,name,online,has_app,has_voice,dtls_fp,door}]` (also records `pins_seen`).
- `PUT /t/me/door {root_id}` (a root with the app) · `GET /t/roots` (any device: hostname, os, arch,
  version, build_id, wg_addr, dtls_fp, online, since, door, enrolled_at, last_seen) ·
  `GET /t/roots/pending` (the cards) · `PATCH /t/roots/:id {name}` (admin) ·
  `DELETE /t/roots/:id` (admin): revoked for good, link cut, directory pushed (P13 ≤ 1.5 s).
- Door: the device's `door_root` when online with the app, else the first such root (enrollment
  order), else `/offline` (page) / 503.
- `GET /t/ice/owner?u=<ufrag>` → 200 / 404, only to `ice_owner_from` (the socket peer).

## Hooks for the IDP (one call each)
- `relay::device_revoked(&st, did, until_ms)`, `relay::killed(&st, epoch, lockdown)`,
  `relay::keys_changed(&st)`: the signed pushes to every root (≤ 200 ms).
- `roots::admin` / `roots::admin_fresh` read `devices` directly (role, `last_2fa_at` + 600 s) until
  `idp::session::Who` is merged; `roots::audit` prints until `idp::audit` is merged.
- Rigs: `bifrost-net trunk-rig seed-admin|mint -c trunk.toml --device …` (refused unless
  `TRUNK_TEST_FAST=1`) — a claimed trunk with an admin device and its token, before sign-in exists.
