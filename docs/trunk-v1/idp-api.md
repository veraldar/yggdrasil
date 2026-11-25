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
