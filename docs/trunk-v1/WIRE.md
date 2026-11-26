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

## import-v0 + rebind (§11 steps 2 and 7, A6) — the switchover seam, done
- `trunk-ctl import-v0 --roots roots.json --dtls bridge-dtls.json (or --hub-dtls-fp PIN) --hub-name NAME --hub-wg-pub PUB --hub-root-pub PUB`: keeps every v0.9 root id and WireGuard address (a trunk that already has a different net is refused — never renumbers); the hub root is enrolled with its NEW key directly; every joined root keeps `rebind_secret_hash` = its v0.9 `secretHash` (`share_model` → `share_model_from` = the hub id). One audit entry per root. It runs once.
- `POST /t/roots/rebind {"root_id","old_secret","root_pub","sig"}` (no cookie): `sig` = Ed25519(root_pub) over `"ygg-trunk-v1/rebind\0" root_id "\0" old_secret`. On match the new key becomes the root's link key and the secret is burned (NULL; a second use → 410). After it, the root dials `/t/root` the normal way (its result carries the trunk url/key for the config).
- `trunk-ctl roots list | roots revoke ID [WHY..]`: the console sees every root (incl. `needs_rebind`), revoke cuts the link and pushes the directory.

## the trunk's own meter (A13/A14) — done
- The trunk meters itself as `ap` and keeps nothing on disk (the rig: `BIFROST_OBS_DIR=`): its minute lines go to the obs sink root (first online root with the app) as `{"t":"stats","lines":[…]}` CTRL; the root's bridge ingests them → `ap-min-*.jsonl` beside its own.
- Per-root channel probes: `{"t":"probe","id":N}` CTRL every `BIFROST_PROBE_EVERY_S` (default 300), the root echoes it; counted `edge.probe.ok/fail`, histogram `edge.probe.link`.
- `GET /_probe` on the trunk (public, no token): one CTRL probe to the door root → 204 + `X-Bifrost-Link-Us` µs / 503 no root online / 504 silent.

## G3.2 — voice over the v1 trunk (`sim/trunk-rtc-v1-e2e.sh`) — done
- The world (private namespaces, phone / VPS / home (+ lab), tcp 443 only, UDP dropped and counted):
  `bifrost-net trunk` with its OWN TLS (`listen_tls`, PROXY v1) behind `sni-443.py` and the eye
  (`sim/trunk-rtc/vps-eye.py`: the VPS's decrypted view; with `$STATE/mitm` an active man in the
  middle), its `listen_ice` behind sni-443's `ice` route and the byte tap. Claim (`claim-admin.py`),
  enrollment (`sim/trunk-v1/enroll-root.py`: the F4 path — enroll, by-code, approve with step-up,
  poll), bridge `[trunk]` with the trunk's SPKI `pin`, the app in `BIFROST_AUTH=trunk`, real
  LiveKit + agent + speech. Nothing stubbed. Ports 18900–18999 inside the namespaces only.
- `--scenario rtc` (`branch/e2e/trunk-rtc-v1.spec.ts`): R1 QR pairing (`/pair` → `/t/pair/redeem`,
  second scan 410), P1 pinned channel keyed by the directory pin, R2/R3 talk + spoken reply, R4
  media path, R5 opaque bytes + no root/call secret on the VPS, E1 the eye saw no app data after
  pairing (pairedAt before `goto`), U1 LiveKit ufrags registered on the pinned `tun` /rtc (acked,
  `/t/ice/owner` 200), R6 `/devices` remove → out of the room + pinned channel severed ≤ 1 s, U2 the
  plain /rtc path (a phone with no directory pin) registers too, R7 `trunk-ctl devices revoke` ≤ 1 s,
  M1 answer fingerprint swapped → refused, no fallback, M2 directory pin swapped too → D3 alarm.
- `--scenario s16` (`sim/reach/s16.mjs` with `PW_TRUNK_V1=1`): lab is a light v1 root (the root
  build), reached from home's brain over WireGuard relayed by the trunk (the only path the
  firewalls leave). `--scenario two-voice` (`sim/reach/two-voice-v1.mjs`) = G3.6 step 15; its hook
  for `sim/trunk-v1-e2e.sh` is `TRUNK_V1_S15_HELPER=sim/trunk-v1/s15-two-voice.sh` (it builds its
  own trunk world: the G3.6 one has no :443 ICE route and no LiveKit).
- `bifrost-net dtls-id FILE`: makes / loads the bridge's DTLS identity (its `dtls_cert_file`) and
  prints `fingerprint = "sha-256 …"` — what an installer must send as `dtls_fp` at enrollment. A root
  enrolled with `dtls_fp: ""` gets no directory pin, so phones never pin a channel to it: every
  /api and /rtc then goes through the trunk's TLS (U2 runs that way on purpose).
- Bridge log lines (evidence and diagnosis): `offer: pinned-channel ufrag U registered with the trunk —
  acked in N ms` and `rtc: LiveKit ufrag U registered with the trunk — acked in N ms (/rtc #k)`.
- App fixes the rig forced (APP files, listed for APP): `lib/gate.ts` marks trunk pages with the
  script-readable cookie `bifrost_mode=trunk`; `lib/pinned.ts` holds /api + /rtc at boot until the
  directory pin is known (before: 6 API calls per page load crossed the trunk's TLS — E1);
  `lib/voice-revoke.ts` sweeps the moment the deny-list or kill epoch moves (before: next 1 s tick).
