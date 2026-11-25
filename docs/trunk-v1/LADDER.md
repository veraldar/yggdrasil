# The v1 ladder: how R2 is checked (LADDER stream)

Spec rev 3, §2 ("How R2 is enforced mechanically") and §9. These files hold it:

| File | What it is |
|---|---|
| `sim/v1-gates.json` | Every §9 gate: id, steps (command, cwd, timeout, env, ports, units, containers, prerequisites), count parsers, the v0.9 steps of each port gate |
| `sim/v1-ladder.sh <sha>` (core in `sim/v1_ladder.py`) | Runs the ladder on a clean throwaway worktree `~/.cache/trunk-v1/wt/<sha>` and writes `~/.cache/trunk-v1/gates/<sha>.json` |
| `trunk/deploy/gate-check.sh` | `gate_check <sha> <worktree>`, sourceable and a CLI. Every VPS-step script runs it first |
| `trunk/deploy/ljoolq-up.sh`, `ljoolq-provision.sh` | M0: the gate check, then "not built yet (OPS stream, M6)", exit 3. They never contact the VPS |
| `sim/gate-check-test.sh`, `sim/v1-ladder-test.py` | G0.5: the refusal cases, plus the runner's own rules (flake rule, parsers, environment, worktree) |
| `sim/v1-baseline.py <sha>` | The baseline table, from the gate files |

## Running it

```
sim/v1-ladder.sh <sha>                       # the full ladder → gates/<sha>.json (the only file gate-check accepts)
sim/v1-ladder.sh <sha> --only G0,G3.7        # a milestone check → gates/<sha>.partial.json (merged by gate id)
sim/v1-ladder.sh <sha> --from G2.1           # the same, from one gate onward
sim/v1-ladder.sh <sha> --only G3 --v09       # the v0.9 steps of the port gates (the branch-point baseline)
sim/v1-ladder.sh --show <gate file>          # the table
```

- **One run at a time.** The runner holds `flock ~/.cache/trunk-v1/ladder.lock`. Twin gates also take `twin.lock`.
- **Builds.** `cargo build --release` in `root/` and `trunk/`, then `npm run build` in `branch/`. The build stamps the
  version into `package.json` and `package-lock.json`; both are put back afterwards. Build caches are reflinked in from
  `~/Work/trunk-v1` or another checkout.
- **Results.** A gate ends GREEN, RED, MISSING (the script is not in this commit, or `pending`), ERROR (a prerequisite
  is missing, or a port, unit or container is busy; nothing of anyone else's is stopped) or SKIPPED (only from `--skip`).
- **The flake rule.** A red gate is re-run at most 3 times, and every run is logged. Red twice means RED. A timing gate
  (G3.6) needs 5 green runs.
- **Environment.** Rigs get only an allowlisted environment (PATH, HOME, the locale, XDG, DBUS, …) plus their own `env`.
  Nothing named `YGG_*`, `BIFROST_*`, `CLAUDE*` or `ANTHROPIC*`, no keys, no `CARGO_TARGET_DIR` and no ssh agent reaches
  a rig. The runner may be a child of the live brain.
- **Where things go.** `TMPDIR` is `~/.cache/trunk-v1/tmp/ladder/<sha8>.<gate>.<n>/t`, and a rig's state dir is
  `…/s`. Both are kept when the run is red and removed when it is green. Logs go to `gates/<sha>/<gate>/`.
  The path is kept short because rigs put unix sockets there: about 45 characters are left under the 107 `SUN_LEN` allows.
- **Cleanup.** After every step the runner stops, by exact name, the transient units the step names and removes the
  docker containers and networks it names. That happens on failure too, and only for steps whose preflight passed.

## Making your gate count (IDP, WIRE, APP, OPS, INSTALL)

- **A `new` gate** is MISSING until its script exists at the path in `sim/v1-gates.json`. Write it there (e.g.
  `sim/trunk-v1-auth.py` for G3.7). Merged, it runs.
- **A `port` gate** stays MISSING while it has a `pending` field. The port's commit deletes that line and points `steps`
  at the v1 command. The `v09` steps stay, for baselines.
- **Exit status.** Exit 0 only when every check is green, and print checks the runner can count:
  - `ok   <name>` / `FAIL <name>` (ok-lines)
  - `PASS <name>` / `FAIL <name>` (pass-lines)
  - a `STEP RES WHAT` table (step-table)
  - Playwright's summary
  - `cargo test` / `node --test` summaries

  A run that exits 0 but counts no passing check is RED.
- **Ports.** Use your stream's range from CONTRACTS.md C7. List the fixed TCP ports in `ports` and the transient unit
  names in `units`, so a busy rig is refused instead of collided with.
- **Never** edit a §3 proof test to pass. Never shrink the gate list: `gate-check.sh` hard-codes the §9 ids, so a gate
  file without one is refused.

## What gate-check refuses (G0.5 proves each case)

- The worktree's HEAD is not `<sha>`, or the worktree is dirty (modified, staged, deleted or untracked; ignored build
  output is fine).
- `gates/<sha>.json` is missing (a `.partial.json` never counts), does not parse, or names another sha.
- The file has `partial`, `complete` is not `true`, `tree_clean` is not `true`, or `green` is not `true`.
- A gate is not GREEN or ran the v0.9 variant, or a §9 id is absent.

The only override is `V1_GATES_DIR`, which moves the gates folder for the refusal tests.
