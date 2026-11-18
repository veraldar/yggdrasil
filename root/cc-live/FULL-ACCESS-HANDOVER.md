# Full access — handover (11-18, from the :8447 "Where were we at" session)

State: work in progress, never deployed. Plan: root-coord-pwa/artifacts/full-access-plan.html.

On this branch (`full-access-wip`, on tree-next 47382b62):
- `full_access.py` — the helper's grant table (`--access-dir`): a grant names one conversation
  (`claude:<id>` / `antigravity:<id>`), lasts ≤ 4 h, needs an HMAC-SHA256 signature with the owner's
  key (`owner.key` in the access dir; the phone types the code once); turning off needs none; a used
  signature is refused. `allowed()` admits only the brain's exact guarded argv: Claude Code with
  `--permission-mode auto` (never `--dangerously-skip-permissions`, `--fork-session`, extra flags),
  agy without the skip flag; opencode/codex are refused (no own permission check headless).
- `cc_live.py` — `GET /access`, `POST /access/grant | /access/check | /access/run` (streams the
  turn as NDJSON `{o}|{e}|{x}`; kills the turn when the caller hangs up).
- `cc_run.py` — what the brain runs instead of the harness for a granted turn (in the sandbox; it
  only forwards — the helper decides).
- brain (`harness.rs` `via_argv`, `tree.rs` `full_access_until`, `main.rs` `harness_loop`): a
  granted, attached, non-fork Claude Code / agy turn runs via `YGG_HARNESS_RUNNER`; logged
  `FULL ACCESS …`, reply meta `full_access: true`. Brain unit tests added — NOT compiled yet.
- `test_full_access.py` — 9 tests pass (owner-only signature, expiry, replay, refused argv, run
  through the helper, abort kills).
- Branch `full-access-wip-lab` (root-coord): `cc-live-up.sh --access-dir ~/.cache/root-sim/full-access`
  + helper code from tree-next; `preview-up.sh` sets `YGG_HARNESS_RUNNER`.

Not built: the enrollment (the owner key), the app (session settings switch + confirm, the code
entry, header/list badge, `/api/session/[id]/access`), the phone e2e, the deploy.

Why a phone-held key: on :8447 (BIFROST_AUTH=tailnet) anything in the sandbox can call the app's
API like the phone, and the helper token is in the brain's env — an unsigned switch would let any
agent grant itself full access. The access dir must stay outside the brain's sandbox (it binds
only ~/.cache/root-sim/preview).
