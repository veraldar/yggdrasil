# Trunk v1 — build plan (lead: brain session "New trunk build lead", ses_2a2804110b824d92a679ae7f604f5704)

Spec rev 3 + binding review: `~/Work/root-coord-pwa/artifacts/trunk-onboarding-spec{,-review}.md`. Contracts: `CONTRACTS.md` here.
Owner rules: R2 (no VPS change of any kind before a complete green `~/.cache/trunk-v1/gates/<sha>.json`), no architect sessions,
test name `ljoolq.veraldar.org`.

## Branches
- `trunk-v1` (worktree `~/Work/trunk-v1`) — the v1 integration branch, cut from `tree-next` @ 764de9e5. **Only the lead merges into it.**
- One branch + worktree per stream, cut from `trunk-v1`: `git -C ~/Work/tree-next worktree add -b v1-<stream> ~/Work/v1-<stream> trunk-v1`.
- Streams pull `trunk-v1` into their branch with `git merge trunk-v1` (never rebase a branch the lead has merged; never `git stash`).
- `tree-next` is merged into `trunk-v1` by the lead (weekly, spec §11). `trunk-v1` merges into `tree-next` only at switchover (M7).

## Streams
| Stream | Branch | Milestones | Scope |
|---|---|---|---|
| LADDER | `v1-ladder` | M0, then rig ports | `sim/v1-ladder.sh` + gate file; `trunk/deploy/gate-check.sh` (the refusal logic every VPS-step script sources) + refusal tests; `ljoolq-up.sh` / `ljoolq-provision.sh` refusal shells; baseline ladder on the branch point. Later: port G2.1–G2.3, G3.1–G3.5 rigs to v1 flows, write G3.6 `sim/trunk-v1-e2e.sh`, wire G5 |
| IDP | `v1-idp` | M1, M3 (trunk side), M4 | `bifrost-net trunk` skeleton (server, config, db, crypto, paseto, ctl), claim, accounts + TOTP + recovery, login + step-up, limits, audit, devices, QR pairing, revoke, kill + lockdown, OAuth (generic + Google/GitHub), passkeys, shell pages, G3.7 `sim/trunk-v1-auth.py`, load test |
| WIRE | `v1-wire` | M2 (trunk relay + root side), M3 root revoke, M5 ufrags | proto 2 (`v1/proto.rs`), `/t/root`, relay to the door root, directory, WireGuard relay, enroll desktop + headless, root revoke, rebind + `import-v0`; bridge `[trunk]` + `trunk-state.json`; `wg` from the directory; brain `peers.rs` per-root tokens; §5.7 ufrag registration (incl. the `tun`-proxied `/rtc`, review watchpoint) |
| APP | `v1-app` | M2–M5 app side | `BIFROST_AUTH=trunk` (middleware, gate, `lib/trunk-auth.ts` PASETO verify), device-auth refresh + `reauth:"login"`, `pinned.ts` (pins from `/t/me/roots`, alarm, B25 fix), roots-sheet from `/t/roots/pending`, settings link, model form + brain `PUT /root/model`, account VAPID, D16 icons, `twin-up.sh TWIN_AUTH=trunk`, G2.4 on the twin |
| OPS | `v1-ops` | M5 router, M6 VPS-step scripts | sni-443 v2 (SIGHUP, ufrag ask) + G3.9; Caddy blocks + G4.5; `ljoolq-provision.sh` + G4.6 (nested Incus); `hub-units.sh` overrides + `switch-v1` / `rollback-v0` / v1 health profile + G4.4; G3.8 coexist rig (with WIRE) |
| INSTALL | `v1-install` | M6 installers (starts when IDP claim + WIRE enroll APIs exist) | `trunk.sh` v1 (claim, static user, `--webroot`, `--add-name`, `--major`), `/install/root.sh` + `root.exe`, G4.1 port, versions 1.0.0, `SKILL.md`, `own-trunk.md` |

## Hand-off rule (every stream, every milestone)
A report names: branch + commit sha; what was built (paths); every test command run with its counts; any contract change wanted;
anything left. The lead merges into `trunk-v1`, re-runs the tests (timing gates ×5), and only then calls a milestone done.

## Hard rules for every stream (from AGENTS.md and the spec)
- Never edit or build inside `~/Work/tree-next`. Never touch `hub-*` units, the live data, `~/.config/yggdrasil/hub`, or the live release folder.
- **No VPS change of any kind** (spec R2). `ssh veraldar` read-only commands only, and only when the brief says so.
- Never `pkill`/`killall`; stop only processes you started, by PID. Transient units you start: stop them by their exact name.
- Never `git stash` (the stash is shared by every worktree). Never push to any remote.
- `TMPDIR` under `~/.cache/trunk-v1/tmp/<stream>`; never `/tmp` for checkouts or builds.
- §3 MUST NOT CHANGE: a proof test is never edited to pass. If an item must change, stop and ask the lead.
- A secret never goes on a command line or into a log.
