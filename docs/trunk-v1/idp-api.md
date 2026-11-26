# Trunk v1 — IDP API as built (M1)

What `bifrost-net trunk` answers itself after M1, for the streams that call it (APP: device-auth,
INSTALL: the claim in `trunk.sh`, LADDER: G3.6 steps 1–3). Spec §7 is the plan; this is the shape.
Code: `trunk/src/v1/idp/api.rs`. Contract shapes (tokens, cookies, `why`) are C3 and unchanged.

## Rules for every call
- Every write (POST/PATCH/PUT/DELETE) needs `Origin` = `public_url` (or `https://<extra_name>`),
  browsers and scripts alike → else `403 {"why":"origin"}`. JSON object bodies, ≤ 64 KiB.
- P12 on everything: one request per connection, `Connection: close`, chunked → 411, conflicting
  `Content-Length` → 400.
- Signed-in calls carry the `bifrost_device` cookie (or `Authorization: Bearer <paseto>`). A refusal is
  `401 {"why","reauth"}` exactly as C3 (`expired`/`region` → `refresh`, else `login`).
- Fresh = a second factor on this device within 600 s; a change that needs it answers
  `403 {"why":"step-up","step_up":true}`.
- Lockouts answer `429 {"error","why":"locked","retry_after":s}` + `Retry-After`.

## Anyone
| Call | Body → answer |
|---|---|
| `GET /t/state` | → `{claimed, has_roots, lockdown, providers[]}` |

## F1 · Claim (410 `{"why":"claimed"}` once claimed)
| Call | Body → answer |
|---|---|
| `POST /t/claim/begin` | `{code}` → `{ticket, url: "<public_url>/claim#t=<ticket>", expires_in}`; wrong → `401 {"why":"wrong","left"}`; the 5th wrong in total → `423 {"why":"locked"}` (until `trunk-ctl claim-reset`) |
| `POST /t/claim/ticket` | `{ticket}` → `{state: "begun"\|"approved", code: "482-917"\|null, via: "agent"\|"console", host, expires_in, pending_email, providers}` (what `/claim` shows) |
| `POST /t/claim/approve` · `/t/claim/refuse` | `{ticket}` → `{ok}` (refuse burns the ticket and rotates the code) |
| `POST /t/auth/signup` | `{ticket, email, password}` (ticket approved) → `{totp_uri, qr_svg, secret}`; rules: 12–128 chars, not in the top-100k, not the email |
| `POST /t/auth/totp/confirm` | `{ticket, code}` → `{recovery_codes[10], device, next:"/"}` + cookies; the trunk is claimed |

The agent's side, in a script: `trunk-ctl claim-code --json` → `{code, display, expires_in, rotated_at,
url, begin, attempts_left}`; then `POST /t/claim/begin` with `Origin: <url>`; open the returned `url`.
`sim/trunk-v1/claim-admin.py` does the whole claim for rigs (TOTP computed from `secret`).

## F2 · Sign in
| Call | Body → answer |
|---|---|
| `POST /t/auth/login` | `{email, password}` → `{mfa_ticket, mfa:["totp","recovery"]}`, or after a console 2FA reset `{mfa_ticket, mfa:["totp"], enroll:{totp_uri, qr_svg, secret}}`; wrong email or password → `401 {"error":"email or password is not right","why":"credentials"}` (same body, same argon2 time) |
| `POST /t/auth/mfa` | `{mfa_ticket, totp}` or `{mfa_ticket, recovery}` → `{ok, device, next:"/"}` + cookies (+ `recovery_left` / `recovery_codes` when enrolling); bad ticket → `401 {"why":"ticket"}`; bad code → `401 {"why":"code"}` |
| `POST /t/auth/refresh` | (cookie `bifrost_refresh`, path `/t/auth`) → `{ok, exp}` + both cookies rotated; dead token → `401 {"why","reauth":"login"}` + cookies cleared; a replaced token past the 30 s grace revokes the device |
| `POST /t/auth/step-up` | `{totp}` or `{recovery}` → `{ok, fresh_until, recovery_left}` |
| `POST /t/auth/logout` | → `{ok, next:"/login"}`, device revoked (`signed out`), cookies cleared |
| `GET /t/me` | → `{account:{id,email,role}, device:{id,name,role,created_via,created_at,last_2fa_at,fresh,fresh_until}, trunk:{id,host,url}, token:{exp,rgn}, has_roots}` |

Cookies: `bifrost_device` (PASETO, path `/`) and `bifrost_refresh` (`bfnr-…`, path `/t/auth`), both
`HttpOnly; Secure; SameSite=Strict`, `Max-Age` = the refresh life (30 d) so an expired access token is
still presented (→ `expired` → refresh) instead of vanishing.

## 2FA management (signed in; changes need fresh)
`GET /t/account` → `{account, device, password:true, totp:{enrolled,enrolled_at}, recovery:{left,total},
passkeys:[], passkeys_ready:false, fresh_s}` · `POST /t/account/password {current,new}` ·
`POST /t/account/totp/reset` → `{totp_uri, qr_svg, secret}` then `POST /t/account/totp/confirm {code}`
(the old authenticator works until then) · `POST /t/account/recovery/regenerate` → `{recovery_codes[10]}`.

## Pages (shell, CSP of §8)
`/claim` (410 once claimed), `/login` (tries the refresh cookie first, then the form; `?next=` same-origin
path), `/account`, `/offline`, and `/` = the empty-trunk page while signed in with no root. A door page
without a valid token → `302 /login?next=<path>` (`/` → `/login`); an API call → `401` C3 body. Assets
under `/t/s/`. `/install/root.sh|.exe` are 503 placeholders until INSTALL.

## Console (`trunk-ctl`, root-only socket)
`state` · `claim-code [--json]` · `claim-link` · `claim-reset` · `account list | reset-2fa [EMAIL] |
reset-password [EMAIL] | unlock [EMAIL]` · `unlock` · `audit tail [N] | verify` · `backup [DIR]` ·
`backup check FILE`.

## Rig timers (`TRUNK_TEST_FAST=1`, never in production; counts never change)
claim rotation 300 s → 5 s (overlap 15 s → 1 s), claim ticket 10 min → 60 s, access 15 min → 20 s,
refresh grace 30 s → 3 s, fresh 600 s → 10 s, password lock 1 min…1 h → 1 s…60 s, TOTP lock 15 min →
15 s, per-/24 window 1 h → 60 s. argon2 cost and the TOTP step are never shortened.

## M4 · OAuth and passkeys (as built)
Code: `trunk/src/v1/idp/oauth.rs`, `passkey.rs`, `challenge.rs` (+ migration `002_auth_challenges.sql`).
Every ceremony is one-use and short-lived in `auth_challenges` (the handle's sha256 + the state sealed
under trunk-kek; OAuth 600 s, passkeys 120 s; rig: 60 s / 30 s); at most 16 live per /24 (/48) and
4096 in total → `429 {"why":"busy"}`.

**Origins.** A write's `Origin` may be `public_url`, `https://<extra name>` or any of `origins`
(spec §11 step 6 adds `ap.` there); passkeys accept the same list.

**Config (C2 + optional keys).** `[oauth.google]` and `[oauth.github]` are presets (`client_id` +
`client_secret_file` only). Any other `[oauth.<id>]` is a generic OpenID Connect provider and needs
`issuer` (discovery at `<issuer>/.well-known/openid-configuration`). Optional: `display` (button
label), `kind` = `oidc` | `github`, `scopes`, `authorize_url` / `token_url` / `api_url` (providers
without discovery, rigs). URLs are https (plain http only to loopback). A provider whose secret file
is missing from `cred_dir` is off (no button; logged at start). Register the redirect URI
`<public_url>/t/auth/oauth/<id>/callback` (and the same on each extra name) at the provider.
Passkeys: `rp_id` (default: the public host) must be that host or a parent of every origin in
`public_url` + `extra_names` + `origins` — checked at start.

| Call | Body → answer |
|---|---|
| `GET /t/state` | `providers` is now `[{id, name}]` (configured and with their secret) |
| `GET /t/auth/oauth/:p/start?intent=login[&next=/path]` | → `302` to the provider + cookie `bifrost_oauth` (`Path=/t/auth/oauth; HttpOnly; Secure; SameSite=Lax`) binding the flow to this browser; refusal → `302 /login#e=oauth` (`intent=claim` is POST only; a GET → `302 /claim`) |
| `POST /t/auth/oauth/:p/start` | `{intent:"login"\|"claim", ticket?, next?}` → `{url}` + the binding cookie (claim: the ticket must be approved) |
| `GET /t/auth/oauth/:p/callback` | login, known identity → `302 /login[?next=…]#mfa=<ticket>&via=<p>` (no device yet); claim → `302 /claim#t=<ticket>&via=<p>` (admin made, TOTP owed); anything refused → `302 /login#e=oauth` (or `/claim#t=…&e=oauth`, only in the browser holding the binding cookie) + audit `auth.oauth_fail {provider, intent, why}`, why ∈ state, denied, exchange, malformed, alg, kid, signature, iss, aud, exp, nonce, email_unverified, unknown_identity, disabled, claim, lockdown, provider |
| `POST /t/claim/totp` | `{ticket}` → `{totp_uri, qr_svg, secret}` of the OAuth claim's pending authenticator; then `POST /t/auth/totp/confirm` as before |
| `POST /t/claim/ticket` | adds `pending_via: "password" \| "oauth:<p>" \| null` |
| `POST /t/auth/mfa/options` | `{mfa_ticket}` → `{mfa:[…], via?, enroll?}` (the OAuth path's second step asks here) |
| `POST /t/auth/login` | `mfa` gains `"passkey"` when the account has one |
| `POST /t/auth/passkey/begin` (`/t/passkey/options`) | `{intent:"login"\|"step-up"\|"mfa", mfa_ticket?}` → `{challenge, options:{publicKey}}` (WebAuthn JSON, binary as base64url); no passkey → `409 {"why":"no-passkey"}`; locked → 429 |
| `POST /t/auth/passkey/finish` (`/t/passkey/verify`) | `{intent, challenge, credential, mfa_ticket?}` → login/mfa: `{ok, device, next, passkey}` + cookies (an **admin** device); step-up: `{ok, fresh_until, recovery_left}`; refused → `401 {"why":"passkey"}` (audit `auth.passkey_fail {intent, why}`: origin, rp_id, uv, counter, signature, challenge, …), a used/expired/wrong-kind handle → `401 {"why":"challenge"}`. Every failure counts toward the network's lock; `mfa` and `step-up` failures also toward the TOTP lockout (5 → 15 min) — an anonymous `login` never does (it must not be able to lock the owner out). The sign counter must move past the **stored** one (not just the copy sealed at begin) |
| `GET /t/account` | `passkeys:[{id,name,created_at,last_used,sign_count}]`, `passkeys_ready:true`, `password:false` for an OAuth-only account, `oauth:[{provider,name,issuer,email,created_at}]` |
| `GET /t/account/passkeys` | `{passkeys:[…]}` |
| `POST /t/account/passkeys/begin` (`…/options`) · `…/finish` (`POST /t/account/passkeys`) | admin device + fresh; `{name?}` → `{challenge, options}`; `{challenge, credential, name?}` → `{ok, passkey}`; at most 16 |
| `DELETE /t/account/passkeys/:id` | admin device + fresh → `{ok}` |

Audit actions added: `auth.oauth`, `auth.oauth_fail`, `oauth.link`, `account.create {via:"oauth"}`,
`passkey.add`, `passkey.add_fail`, `passkey.remove`, `auth.passkey_fail`; `auth.login` detail now
`{first, second[, provider]}` with first ∈ password, oauth, passkey and second ∈ totp, recovery, passkey.
