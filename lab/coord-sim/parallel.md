# parallel-vs-sequential (addendum 1) — the three scheduling arms

Same tasks, same model mix; only the SCHEDULING varies. All arms run on the coordinator
seam (profile session decides; runner executes).

| arm | what happens |
|---|---|
| `sequential` | tasks run one at a time, in arrival order; each waits for the previous |
| `parallel` | all independent tasks launched simultaneously (t1-t4 together, t5 after) |
| `adaptive` | the COORDINATOR is shown the dependency graph and decides per task: launch now or wait for dependencies |

## The hypothesis under test (owner's)

Parallel beats sequential on wall-time without hurting quality or user-visible
experience. The REVERSE RISK is measured, not assumed away: quota burn (tokens),
context-switch noise, and worse coherence on dependent tasks (t5's fused deliverable).

## New metric: coherence-of-merged-results (`coherence`)

Defined for the t5 fused note (the deliverable that depends on t1+t2+t4 outputs):
- facts present: the 4 expected facts (fizz.py, A-1183, 11,012.50, 16:00) — from `contains`
- INTERNAL consistency: the note's total matches the t4 answer the worker actually
  produced (not the gold answer — the arm's own t4), the module name matches the t2
  deliverable path
- coherence = (facts present / 4) weighted with the consistency checks
Scored identically in every scheduling arm. The parallel arm's danger: t5 fuses
paraphrases of un-synced parallel outputs.

## User-visible experience (measured, not vibe)

- `ttfa_ms` per task arrival (same as always) PLUS:
- `arrival_response_ms`: arrival-turn → the user has a REPLY THAT NAMES THE TASK'S PLAN
  (coord arms: the COORD: ack; flat: the work itself). Parallel should WIN here if the
  ack arrives while other tasks still run.
- `interleave_penalty`: for parallel, how many worker replies arrived after a LATER
  task's user turn — the "my task got worse because others ran" signal.

## Where each arm should win (predictions to check — pre-registered)

- wall_ms: parallel < sequential (the hypothesis)
- quality: ≈ equal (independent tasks don't care)
- coherence on t5: sequential ≥ parallel (the reverse risk) — if parallel also wins
  coherence, the coordinator's sync choice did its job
- tokens: parallel ≥ sequential (more concurrent context) — the quota-burn risk
