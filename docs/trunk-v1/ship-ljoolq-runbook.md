# ljoolq ship runbook — V0 → V1 → V2 (trunk v1 @ 292d0f1f)

**Status: PREP ONLY. Nothing here has been run against the VPS.**
Everything below was verified read-only on 2026-11-26 (see the preflight
report). Commands are exact; each VPS-touching step is gated by
`trunk/deploy/gate-check.sh`, which refuses unless
`~/.cache/trunk-v1/gates/<sha>.json` is a complete green full-ladder file.

Worktrees: build from a **clean worktree at the sha** — `~/Work/trunk-v1`
(HEAD 292d0f1f) is the lead's tree; the ship session works in its own
(e.g. `~/Work/v1-ship-prep`, but a clean checkout of the exact sha is what the
gate check demands — `ljoolq-up.sh` itself checks the tree it runs from).

---

## 0. Preconditions (all must be true the day of V0)

1. **Complete green gate file for the exact sha.**
   `bash trunk/deploy/gate-check.sh <full-sha> ~/Work/<clean-worktree-at-sha>`
   must print `gate-check: OK …` (all of G0.1…G5.4 GREEN, v1 variants,
   `complete:true, green:true, tree_clean:true`).
   - Today (11-26): `~/.cache/trunk-v1/gates/292d0f1f….json` has 24/24 GREEN
     through G4.5 but `complete:false` — the final ladder run
     (`v1-lead-final-ladder-r3`) is still running (paused before G5.1). **V0
     must wait for it to finish.** A new sha (any new merge) needs its own
     full ladder run.
2. **Architect sign-off** (the lead's call — the review gate §8/M6).
3. **DNS** `ljoolq.veraldar.org → 179.237.67.146` — **already in place**
   (verified 11-26: A record resolves; no AAAA — fine).
4. §14 Q1 (test address) is answered yes by DNS existing; **Q2 (stop
   vps-boot-\*)** — the lead decides; not required (1.18 GiB available).
5. Google OAuth credentials **optional** — password+TOTP+passkey works fully
   without them. If the owner supplies them: see
   `/api/artifact/ljoolq-google-oauth-steps.md` and §3 below.
6. `live-door.spec.ts` (the ap.veraldar.org live-door proof, `PW_LIVE=1`)
   must pass **before** V0 and again **after** each VPS step (spec W7/V0).

Pre-flight verdict (read-only, 2026-11-26): **READY** — no blockers found.
Details: `/api/artifact/ljoolq-vps-preflight.md`.

---

## 1. V0 — provision (Incus + container + Caddy phase 1)

Run from a clean worktree at `<sha>` (= the sha of the green gate file):

```bash
export TMPDIR=~/.cache/trunk-v1/tmp/ship-prep
cd ~/Work/<clean-worktree-at-sha>
cargo build --release --manifest-path trunk/Cargo.toml    # bifrost-net
bash trunk/deploy/ljoolq-provision.sh up <sha> \
  --push trunk/target/release/bifrost-net \
  --installer-args "--name ljoolq.veraldar.org --rp-id veraldar.org --behind-proxy --bind 10.99.0.2 --trusted-proxy 10.99.0.1/32 --self-signed --binary /root/ljoolq-install/bifrost-net --no-firewall --no-auto-updates -y"
```
The `--push` + `--binary` pair is the exact shape G4.6 rehearsed (the container
has no GitHub access requirement: the signed-release default download path
also exists, but the local build is the candidate under test). Dry-run first
(no ssh at all): `LJOOLQ_SHOW=1 bash …` — prints the exact remote script;
verified today, and the script refuses (`gate-check: REFUSED the gate file is
not complete`) while the ladder is unfinished, **before any ssh connection** —
that is R2's order working as designed.

What it does on the VPS (each step idempotent, checked, nothing touched
outside its own names): apt `incus-base btrfs-progs dnsmasq-base apparmor
iptables curl`; btrfs pool `ljoolq` (6 GiB sparse loop); bridge `ljoolqbr0`
10.99.0.1/24 NAT; ufw in+routed on the bridge + DOCKER-USER rules via
`trunk-ljoolq-fw.service`; profile `trunk-ljoolq` (384 MiB / half CPU / 2 GiB /
unprivileged / nightly snapshots); container `trunk-ljoolq` (10.99.0.2) from
`images:debian/13`; then inside it, as a user would (the pushed binary): the
`--installer-args` above; health `http://10.99.0.2:8080/t/state → 200`.
Never touched: `trunk-ap`, `sni-443`, `caddy`, `coturn`, docker's own
containers, ufw's other rules.

**Then Caddy phase 1** (in the same V0 window, from the same worktree):

```bash
bash trunk/deploy/ljoolq-up.sh <sha> --caddy phase1 --no-snapshot
```

(No binary yet needed — `--caddy phase1` merges the block, runs
`caddy validate`, and `systemctl reload caddy`, restoring the previous
Caddyfile on failure. `--no-snapshot` because there is no binary swap; the
snapshot is pointless before the first deploy.) Alternative if you want the
gate to see one command per step: run `--caddy phase1` alone exactly as above.

Result: `https://ljoolq.veraldar.org` serves the trunk (sni-443's `default`
already hands unknown TLS names to Caddy :8443, which terminates TLS and
proxies to 10.99.0.2:8080; plain http redirects; Caddy answers its own ACME
http-01 for the name — cert arrives automatically). Unclaimed trunk: `/t/state`
→ `{"claimed":false}`.

**Check after V0:**
```bash
curl -s https://ljoolq.veraldar.org/t/state        # {"claimed":false,...}
PW_LIVE=1 npx playwright test -c playwright.live-door.config.ts   # ap. still fine
```

**Rollback V0 (any time).** Caddy phase 1 out (on the VPS, as root — the merge
tool is in the payload the deploy streamed; re-run it from the worktree and
pipe, or run it there and `scp`): the simplest exact undo is from the home
worktree:
```bash
ssh veraldar 'cat /etc/caddy/Caddyfile' > "$TMPDIR/caddy.in"
python3 trunk/deploy/caddy/caddy-merge.py remove "$TMPDIR/caddy.in" "$TMPDIR/caddy.out"
ssh veraldar "sudo tee /etc/caddy/Caddyfile.new" < "$TMPDIR/caddy.out" >/dev/null
ssh veraldar 'sudo caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile \
  && sudo mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile && sudo systemctl reload caddy'
```
(`caddy-merge.py remove` is the byte-identical restore — rehearsed locally on
today's live Caddyfile.) Then remove the container set (on the VPS, as root):
```bash
incus delete --force trunk-ljoolq
incus profile delete trunk-ljoolq
incus network delete ljoolqbr0
incus storage delete ljoolq
systemctl disable --now trunk-ljoolq-fw.service
rm -f /etc/systemd/system/trunk-ljoolq-fw.service /usr/local/lib/trunk-ljoolq/fw.sh
systemctl daemon-reload
```
(the apt packages can stay — harmless, and what G4.6's re-run expects).

---

## 2. V1 — first deploy of the build

```bash
cd ~/Work/<clean-worktree-at-sha>
cargo build --release --manifest-path trunk/Cargo.toml    # if not already built at V0
bash trunk/deploy/ljoolq-up.sh <sha> --caddy phase1
```

(Re-running `--caddy phase1` is the documented idempotent path — the block is
put back in its place; if phase 1 is already in the Caddyfile it is a no-op
byte-for-byte.) The script: gate check → `incus snapshot pre-up-<sha8>-<ts>` →
push `trunk/target/release/bifrost-net` into the container → (no `--installer`:
binary swap path) `install /root/ljoolq-up/bifrost-net /usr/local/bin/bifrost-net;
ln -sfn … trunk-ctl; systemctl restart yggdrasil-trunk.service` → health
`http://10.99.0.2:8080/t/state → 200` (30×1 s) → Caddy phase-1 merge +
`caddy validate` + `systemctl reload caddy` → done. **Any failure restores the
snapshot and the previous Caddyfile by itself.**

Dry-run now (verified 11-26 — shows the exact remote command, makes no
connection): `LJOOLQ_SHOW=1 LJOOLQ_TEST_SKIP_GATE=1 bash
trunk/deploy/ljoolq-up.sh <sha> --target docker:x` prints:
`set -e; d=$(mktemp -d /root/ljoolq-up.XXXXXX); … bash "$d/ljoolq-up.sh"
--on-target <sha> $d http://10.99.0.2:8080/t/state 1 '' 0 0`
(with `--caddy phase1`: `1 '' phase1 0 0`). On the real `ssh:veraldar` target
the gate cannot be skipped — refused up front.

**Check after V1:**
```bash
curl -s https://ljoolq.veraldar.org/t/state
PW_LIVE=1 npx playwright test -c playwright.live-door.config.ts   # ap. door unchanged
```

**Rollback V1:**
```bash
ssh veraldar sudo incus snapshot restore trunk-ljoolq pre-up-<sha8>-<ts>
ssh veraldar sudo incus start trunk-ljoolq    # if it came back stopped
```
Caddy phase 1 can stay (it points at the same container and the container's
old binary answers). Full undo: the V0 rollback above.

---

## 3. Google OAuth (optional, before or after the claim)

Owner guide: `/api/artifact/ljoolq-google-oauth-steps.md`. With client ID +
secret in hand, inside the container (as root on the VPS):

```bash
ssh veraldar sudo incus exec trunk-ljoolq -- bash -c '
  install -d -m 700 /etc/yggdrasil-trunk/cred
  # put the secret in a file, never on the command line:
  #   editor / heredoc from a safe channel → /etc/yggdrasil-trunk/cred/oauth-google (0400, one line)
  printf "\n[oauth.google]\nclient_id = \"<CLIENT_ID>\"\nclient_secret_file = \"oauth-google\"\n" >> /etc/yggdrasil-trunk/trunk.toml
  systemctl restart yggdrasil-trunk.service'
```
(Manual `--installer trunk.sh --update` re-runs would keep `trunk.toml` —
`trunk.sh` preserves an existing config; the oauth block is additive. The
secret file: `ExecStartPre=+` copies `$ETC/cred/*` into `/run/trunk/` at each
start.) Then verify `/t/state` shows `providers:[{"id":"google","name":"Google"}]`
and the sign-in/claim pages show the button.

**No real credentials are ever needed by any test or rig** (mock OIDC only).

---

## 4. V2 — claim + omarchy-lab + the owner's phone

### 4a. Claim the trunk (owner, once, from anywhere)

1. On the VPS (the lead or a session the lead names): `ssh veraldar sudo incus
   exec trunk-ljoolq -- trunk-ctl claim-code` → a 6-digit code (rotates every
   5 min; `claim-link` prints the full link with the code in it).
2. Owner on the phone: open `https://ljoolq.veraldar.org/claim`, enter the
   code, **Approve & create admin**, then either:
   - **password route**: email + password, then enrol TOTP (authenticator app
     QR) → recovery codes shown (save them) → done; or
   - **Google route** (if §3 was done): tap **Google** on the claim page,
     pick the account → the account is created with the Google identity and a
     pending TOTP enrolment (mandatory 2FA) → confirm a code from the
     authenticator app → recovery codes.
3. Optional right after (signed in, on the phone or any admin browser):
   **Account → passkeys → add** (Face/fingerprint or a hardware key;
   `rp_id = veraldar.org` so the same passkey later works on `ap.`).

### 4b. Enrol `omarchy-lab` as a v1 root of ljoolq (the V2 test root)

**Principle: never convert the existing v0.9 root in place.** The lab root
(`~/.local/share/yggdrasil-root-lab`, v0.9: `yggdrasil-root-brain/dial/wg`
units, 6 idle sessions, brain on its own data dir) keeps dialing
`ap.veraldar.org`. The v1 installer (`root/install/root.sh`) **refuses** to
join a dir that already has `root.json` of another trunk (`root.sh` line 351),
and v1's unit names (`yggdrasil-root-*` from root.sh) would collide with the
v0.9 lab units. So the safe V2 root is a **second v1 profile side by side**.

Two ways to get the installer (pick 1):
- **From the trunk** (as a user): `curl -fsSL
  https://ljoolq.veraldar.org/install/root.sh -o ~/ljoolq-root.sh` — it has
  the ljoolq origin + trunk identity key baked in, and then bootstrap-fetches
  the **signed release** from GitHub (the release must exist and carry a
  linux-x86_64 build — the lead's `scripts/release.sh` step; the sim's
  `own-trunk-e2e.sh` G4.1 rehearsed exactly this path).
- **From a checkout** (for a candidate that has no release yet): copy
  `root/install/root.sh` out of a clean worktree at the sha (it is then an
  "un-baked checkout copy": pass `--trunk` explicitly) — and the worktree must
  carry `root/target/release/yggdrasil`, `trunk/target/release/bifrost-net`
  and `branch/.next` (built), else it bootstraps the signed release instead
  (`root.sh` line 402-411). The V2 beta should use the release route.

```bash
# 1. get the baked installer from the test trunk itself:
curl -fsSL https://ljoolq.veraldar.org/install/root.sh -o ~/ljoolq-root.sh
# 2. join as a new root, its own dir, own ports, systemd --user units:
cp ~/.local/share/yggdrasil-root-lab/upstream.env ~/ljoolq-model.env   # the z.ai lines, key included (600)
bash ~/ljoolq-root.sh \
  --trunk https://ljoolq.veraldar.org \
  --name omarchy-lab-v1 \
  --dir ~/.local/share/yggdrasil-root-lab-v1 \
  --brain-port 4184 --app-port 4186 --bridge-port 4188 \
  --upstream-env ~/ljoolq-model.env
```
- Ports 4184/4186/4188: the v0.9 lab uses 4180/4181; the live hub brain is
  :4101 — no overlap. `--upstream-env` (a copy of the lab's upstream.env:
  only `YGG_UPSTREAM_*` lines, key included, kept 600) reuses the z.ai model
  config; with it, no model question is asked.
- The installer: makes new root/WG/DTLS keys, `POST /t/roots/enroll`, opens
  the browser at the **approve URL** (`https://ljoolq.veraldar.org/add-root`
  with the request), shows a rotating code + QR.
- **Approval:** the owner (signed-in admin on the phone) opens that URL,
  checks the code matches, taps **Approve**. (Headless alternative: the
  terminal shows the code; enter it at `/add-root`.)
- On approval the poll returns `root_id`, `wg_addr`, `trunk_key`, the bridge
  config is written and the units start: `systemctl --user list-units
  'yggdrasil-root-*'` shows the v1 set (`yggdrasil-root-brain/bridge/app/wg…`,
  ExecStart `…/yggdrasil-root-lab-v1/bin/run-*`).

**Unit-name collision, solved:** the v0.9 lab units are named exactly
`yggdrasil-root-{brain,dial,wg}.service` and v1's are
`yggdrasil-root-{brain,bridge,app,wg,librarian,cclive}.service` — same names!
`root.sh` writes into `~/.config/systemd/user/` and would **overwrite** the v0.9
lab brain unit. Two clean options (pick A unless the lead says otherwise):

- **A (recommended): park the v0.9 lab units first** (they are idle — 6
  sessions, none active; the lab root is a test rig):
  ```bash
  systemctl --user disable --now yggdrasil-root-brain.service yggdrasil-root-dial.service yggdrasil-root-wg.service yggdrasil-root-refill.timer
  ```
  (Nothing is deleted: the v0.9 join, keys and data stay in
  `~/.local/share/yggdrasil-root-lab/`; re-run its `join.sh` to bring them
  back — that is also the rollback.) Then run root.sh as above; it owns the
  names cleanly. The live `hub-*` units are never touched (different names,
  different dirs).
- **B: keep both live** — needs the unit prefix to differ, which root.sh
  hard-codes (`yggdrasil-root-`). Not possible without editing the installer
  (a §3-adjacent change to propose to the lead: `--unit-prefix` option). Until
  then, A.

**Rollback (back to ap.veraldar.org / v0.9 lab):**
```bash
systemctl --user disable --now yggdrasil-root-brain.service yggdrasil-root-bridge.service \
  yggdrasil-root-app.service yggdrasil-root-wg.service yggdrasil-root-librarian.service \
  yggdrasil-root-cclive.service 2>/dev/null
rm -rf ~/.local/share/yggdrasil-root-lab-v1
rm -f ~/.config/systemd/user/yggdrasil-root-*.service
systemctl --user daemon-reload
# bring the v0.9 lab back exactly as it was:
bash ~/.local/share/yggdrasil-root-lab/bin/start
```
Optionally revoke the test root at the trunk first (signed in as admin:
roots sheet → remove), or `trunk-ctl` (console) on the VPS. The v0.9 lab
itself never changed — `bin/start` (its own generated script) is the whole
rollback.

### 4c. The owner's phone on ljoolq (the beta)

- Add `https://ljoolq.veraldar.org` to the home screen (a second app beside
  ap.).
- Sign in as the admin (password+TOTP, Google, or passkey) — this makes the
  phone a **member device of the ljoolq trunk** (the admin's own 2FA on the
  phone makes it an admin device).
- The roots sheet shows `omarchy-lab-v1` online; tapping it opens its MAIN;
  typed/spoken turns route through the ljoolq trunk to that root
  (phase 1: no voice/pinned channel — phone runs "via the trunk's TLS").
- Daily use ≥ 3 days (spec V2); every fix is a new sha with its own full
  gate file and a fresh `ljoolq-up.sh <new-sha>` run.

---

## 5. What was verified today (read-only / dry-run)

- `bash -n` + `py_compile` on every script this runbook names (all parse).
- `LJOOLQ_SHOW=1` dry-runs of `ljoolq-provision.sh up` and `ljoolq-up.sh`
  (refused by the gate as expected with the ladder incomplete; payload shown
  with the docker rehearsal override).
- `caddy-merge.py` phase1 → phase2 → m7-acme → `remove` round-trip on a copy
  of **today's live VPS Caddyfile** (fetched read-only): final restore is
  **byte-identical**; the merge tool refuses unknown inputs by design.
- Gate file inspection: 292d0f1f partial (G0.1–G4.5, 24 GREEN, `complete:false`).
- VPS preflight (read-only, full list in the preflight artifact).
- omarchy-lab inspection: v0.9 root, 6 sessions all status None (idle), units
  active, own data dir, isolated from `hub-*`.

## 6. Left open (for the lead)

- The final gate file for 292d0f1f (ladder r3 running now) — or a later sha.
- Architect sign-off.
- §14 Q2 (vps-boot-* stop) — the lead's call, optional.
- Google OAuth credentials from the owner (optional; guide written).
- A `--unit-prefix` (or `--label`) option on root.sh for running v0.9 and v1
  roots side by side under systemd (contract-change proposal, not blocking:
  option A in 4b works without it).
