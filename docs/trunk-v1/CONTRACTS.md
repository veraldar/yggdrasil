# Trunk v1 — wire and file contracts (binding for every builder)

Lead-owned. The spec is `~/Work/root-coord-pwa/artifacts/trunk-onboarding-spec.md` (rev 3) plus the
binding review `trunk-onboarding-spec-review.md`. This file pins the shapes that two or more builders
must agree on, so they can work in parallel. **Change a shape here only through the lead** (message the
lead session; the lead edits this file on `trunk-v1` and tells every stream).

Name rule (owner, 11-25): the test trunk is **`ljoolq.veraldar.org`** (A → 179.237.67.146). Everywhere the
spec says `next.` use `ljoolq.`: scripts `trunk/deploy/ljoolq-up.sh`, `trunk/deploy/ljoolq-provision.sh`,
`sim/ljoolq-provision-e2e.sh`, Incus container `trunk-ljoolq`, `PW_DOOR=ljoolq`. Production stays `ap.veraldar.org`.

---

## C1 · Binaries and processes
- One crate, `trunk/` (`bifrost-net`). New subcommands: `bifrost-net trunk -c <trunk.toml>` (the v1 server) and
  `bifrost-net trunk-ctl [--sock <path>] <cmd…>` (console client; also installed as `/usr/local/bin/trunk-ctl`,
  dispatching on `argv[0]`). Existing `ap`, `bridge`, `wg` subcommands stay; `bridge` gains `[trunk]` (C5).
- New code lives under `trunk/src/v1/` (module tree below). Do not grow `ap.rs` further; lift what you need
  into `v1/` (copy, then the old path keeps working for v0.9 until switchover).

| Module | Owner stream | What |
|---|---|---|
| `v1/config.rs` | IDP | `trunk.toml` (C2) |
| `v1/db.rs` + `v1/migrations/NNN_name.sql` | IDP (runner); each stream adds its own numbered files | SQLite WAL, `rusqlite` (bundled), migrations embedded with `include_str!`. Numbers: IDP 001–099, WIRE 100–199, others ask the lead |
| `v1/crypto.rs` | IDP | kek (AES-256-GCM), Ed25519 keys, constant-time compare, b64url |
| `v1/paseto.rs` | IDP | PASETO v4.public sign + verify (C3). Must pass the official v4.public test vectors |
| `v1/idp/*` | IDP | accounts, TOTP, recovery, passkeys, OAuth, devices, pairing QR, claim, limits, audit |
| `v1/shell/*` + `v1/shell/assets/*` | IDP | embedded pages (C8) |
| `v1/ctl.rs` | IDP | root-only unix socket + `trunk-ctl` client |
| `v1/proto.rs` | WIRE | proto 2 frames + control messages (C4), shared by trunk and bridge |
| `v1/relay/*` | WIRE | `/t/root` server, stream relay to the door root, ICE-TCP by registered ufrag, WireGuard frame relay, directory |
| `v1/roots/*` | WIRE | enroll (desktop + headless), approve, revoke, rebind, `import-v0` |
| `v1/server.rs` | IDP (skeleton), both add routes | the listener: TLS or plain http (behind proxy), PROXY v1, P12 law, routing `/t/*` / shell / ACME / relay |
| `bridge*.rs`, `wg.rs`, `config.rs` (root side) | WIRE | `[trunk]` dial-out, `trunk-state.json` writer, directory → WireGuard peers, ufrag registration |

## C2 · `trunk.toml` (the v1 server)
```toml
public_url     = "https://ljoolq.veraldar.org"   # origin used for iss, Origin checks, links
extra_names    = []                               # e.g. ["ap.veraldar.org"] after --add-name
listen_http    = "0.0.0.0:8080"                   # phase 1: behind Caddy (plain http)
listen_tls     = ""                               # phase 2: "0.0.0.0:4443" (own TLS, SPKI pin)
listen_ice     = ""                               # phase 2: "0.0.0.0:4479" (framed STUN / ICE-TCP)
proxy_protocol = false
trusted_proxies = ["10.0.0.1/32"]                 # XFF / PROXY trusted only from these
db             = "/var/lib/yggdrasil-trunk/trunk.db"
state_dir      = "/var/lib/yggdrasil-trunk"
cred_dir       = "/run/trunk"                     # trunk-kek, oauth secrets (copied by ExecStartPre=+)
ctl_socket     = "/run/trunk/ctl.sock"
acme_webroot   = "/var/lib/yggdrasil-trunk/acme"
rp_id          = "veraldar.org"
origins        = ["https://ljoolq.veraldar.org"]
ice_owner_from = ["10.0.0.1/32"]                  # who may ask GET /t/ice/owner (the Incus bridge)
[auth]                                            # §8 numbers are defaults; rigs may shrink timings only via env TRUNK_TEST_FAST=1
region_policy = "refresh"
[oauth.google]                                    # absent = button hidden
issuer = "https://accounts.google.com"
client_id = "…"
client_secret_file = "oauth-google"               # name inside cred_dir
```
Unknown keys are an error (same rule as today's bridge config).

## C3 · Access token (PASETO v4.public, Ed25519)
- Token string `v4.public.<b64url(msg||sig)>.<b64url(footer)>`. Implicit assertion: empty.
- Payload (JSON, exactly these keys): `iss` (= `public_url` origin), `sub` (`acc_…`), `did` (`dev_…`),
  `role` (`admin`|`member`), `rgn` (region class, `trunk/src/region.rs` = `branch/lib/region.ts`), `kep` (u64 kill epoch),
  `iat`, `exp` (RFC 3339 UTC, second precision, `Z`), `jti` (b64url 16 B).
- Footer (JSON): `{"kid":"k_<first 16 b64url chars of sha256(public key)>"}`.
- Life 15 min. Cookie `bifrost_device` (HttpOnly; Secure; SameSite=Strict; Path=/).
- Refresh: `bfnr-` + b64url 32 B, stored as sha256; cookie `bifrost_refresh` (HttpOnly; Secure; SameSite=Strict; Path=/t/auth).
- **Every verifier** (trunk, root app `BIFROST_AUTH=trunk`, root bridge offline) runs the same checks in this order and
  answers the same `why`: signature with a non-retired `kid` from `keys[]` → `invalid`; `exp` passed → `expired`;
  `rgn` ≠ region of the request's real client address → `region`; `kep` < `kill_epoch` → `revoked`; `did` in `deny[]` → `revoked`;
  no token → `missing`. 401 body `{"why":<why>,"reauth":"refresh"|"login"}`: `expired`/`region` → `refresh`, everything else → `login`.
- Shared test vectors: `docs/trunk-v1/vectors/paseto.json` (written by IDP: keypair, claims, footer, token, plus one
  case per `why`). The Rust verifier and the TS verifier (`branch/lib/trunk-auth.ts`) both run it.

## C4 · Proto 2 on `WS /t/root`
- Websocket binary frames, one mux message per frame, today's layout: `[kind u8][stream u32 BE][payload]`.
  Kinds kept from v0.9 (`ap.rs:57-60`): `OPEN=1` (payload `"<client ip>\n" + request head`), `DATA=2`, `CLOSE=3`, `OPEN_RAW=4`
  (payload `"<client ip>\n<forward name>"`; ICE-TCP always arrives as `livekit-ice` and the root's own-vs-LiveKit split, `ap.rs:1856-1865`, stays as is). New: `CTRL=16` (stream 0, payload = one JSON object),
  `WG=17` (stream 0, payload = today's WireGuard relay frame `[n][addr][dgram]`, `wg.rs:330-363`).
  P12 law unchanged on every relayed HTTP stream.
- Handshake (first CTRL frames, before any mux traffic):
  1. trunk → root `{"t":"hello","proto":2,"trunk_id","trunk_key","nonce"}`
  2. root → trunk `{"t":"auth","proto":2,"root_id","nonce","sig"}` — `sig` = Ed25519(root key) over
     `"ygg-trunk-v1/root-auth\0" || trunk_id || "\0" || trunk.nonce || "\0" || root.nonce`.
  3. trunk → root `{"t":"welcome","sig","root":{…},"directory":{…},"keys":[…],"kill_epoch","deny":[…]}` — `sig` = Ed25519(trunk key)
     over `"ygg-trunk-v1/trunk-auth\0" || root_id || "\0" || root.nonce || "\0" || trunk.nonce`. The root checks it against the
     `trunk_key` it was enrolled with (`[trunk] trunk_key`), so a TLS-terminating front (Caddy, phase 1) cannot impersonate the trunk.
  - A v0.9 bridge dialing `/t/root`, or proto ≠ 2 → HTTP 426 `update this computer`. A v1 bridge reaching a v0.9 `/ap` → refuses (426 path).
- Control messages (`t`): `directory`, `keys`, `revoke {did, until}`, `kill {epoch, lockdown}`, `ice.register {ufrags[], ttl_s}`,
  `ice.ack {ufrags[]}`, `ice.release {ufrags[]}`, `stats`, `probe`, `root.revoked`. Every message that carries authority
  (`directory`, `keys`, `revoke`, `kill`, `root.revoked`) has `sig` = Ed25519(trunk key) over the canonical JSON of the message
  without `sig` (RFC 8785 JCS); the root ignores unsigned or badly signed ones (meter `ctrl.badsig`).
- Ufrag routing as spec §5.7 (ack ≤ 500 ms before forwarding the SDP frame; TTL 120 s, renew 60 s).

## C5 · Root side files
- Bridge config `[trunk]`: `url = "https://ljoolq.veraldar.org"`, `trunk_key = "<b64url ed25519 pub>"`, `root_key_file = "<path, 0600>"`,
  `root_id = "rt_…"`, `state_file = "<path>/trunk-state.json"`, optional `pin` (SPKI sha256, phase 2 only).
- **`trunk-state.json`** (bridge is the only writer; atomic rename; mode 0600; rewritten on every change **and at least every 10 s**):
```json
{ "version": 1,
  "trunk":  { "url": "https://ljoolq.veraldar.org", "trunk_id": "trk_…", "trunk_key": "<b64url>" },
  "root":   { "id": "rt_…", "name": "omarchy" },
  "link":   { "state": "up", "since": 1764100000000, "written": 1764100005000 },
  "keys":   [ { "kid": "k_…", "alg": "ed25519", "public": "<b64url 32 B>", "retired_at": null } ],
  "kill_epoch": 0, "lockdown": false,
  "deny":   [ { "did": "dev_…", "until": 1764100900000 } ],
  "directory": { "seq": 7, "issued_at": 1764100000000, "sig": "<b64url>",
                 "roots": [ { "id": "rt_…", "name": "omarchy", "wg_pub": "…", "wg_addr": "10.77.0.1", "dtls_fp": "sha-256 AB:…",
                              "has_app": true, "has_voice": true, "online": true, "peer_token_sha256": "<hex>" } ] },
  "vapid_public": null }
```
  Times are unix ms. Readers: the app (`BIFROST_TRUNK_STATE`), `bifrost-net wg` (directory → peers), the brain via `/_wg/_roots`
  (P6 per-root peer tokens: a peer request is accepted when sha256(token) = the claimed sender root's `peer_token_sha256`),
  `hub-units.sh` v1 health (`link.state == "up"` and `written` < 30 s old).
- v1 never writes the v0.9 files (`devices.json`, `roots.json`, `joins-pending.json`, `bridge-dtls.json`) — spec §11 data rule.

## C6 · App seam (`BIFROST_AUTH=trunk`)
- Env: `BIFROST_AUTH=trunk`, `BIFROST_TRUNK_STATE=<path>`, `BIFROST_TRUNK_URL=<public url>`, `BIFROST_TRUST_PROXY=1` (via `node server.mjs`).
- The trunk relays to the door root everything outside `/t/*`, the shell pages, `/install/*` and `/.well-known/acme-challenge/*`.
  The root's bridge and app both re-verify the token (C3). `tailnet` mode is untouched (W2); `devices` mode stays (rollback target).
- `/t/me/roots` → `[{id,name,online,has_app,has_voice,dtls_fp,door:bool}]` is the pin source for `branch/lib/pinned.ts`.

## C7 · Ports and rigs (so parallel streams never collide)
| Stream | Ports for its own rigs / test servers | Brain sims |
|---|---|---|
| LADDER (gate runner, rig ports) | 18700–18799 | `--port-base 18700` |
| IDP | 18800–18899 | — |
| WIRE | 18900–18999 | `--port-base 18900` |
| APP | 19000–19099 | `--port-base 19000` |
| OPS (VPS-step rehearsals) | 19100–19199 | — |
| INSTALL | 19200–19299 | — |
| G5.1 loopback trunk | 18600–18610 (spec) | twin :4250/:4251/:8250 |
- The acceptance twin (:4250/:4251/:4252/:8250) is machine-wide single: take `flock ~/.cache/trunk-v1/twin.lock` around any twin use.
- A full ladder run takes `flock ~/.cache/trunk-v1/ladder.lock`.
- Namespace rigs (`unshare`) have their own network; they still must not reuse a fixed host port.
- `TMPDIR=~/.cache/trunk-v1/tmp/<stream>` — never `/tmp` (tmpfs, often full).

## C8 · Shell pages look
- The trunk's pages wear the live app look: `branch/styles/tokens.css` + `branch/styles/brand.css` + the embedded Commit Mono,
  copied into `v1/shell/assets/` at build time by a script (no Node on the VPS: assets are embedded with `include_bytes!`).
- CSP as spec §8 "Web". No third-party request of any kind. Vanilla JS only (WebAuthn, QR render, countdown, polling).
- Every page is checked at 360 px (Pixel 7) by Playwright in G3.6.
