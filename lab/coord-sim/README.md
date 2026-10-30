# coord-sim — the coordination quality lab

**Owner thesis under test (tier-3 sim, per docs/TESTING.md):** a coordinator MAIN managing
fresh profiled sub-sessions, synced by context-recall, beats an ad-hoc long session. And
the coordinator's hardest job is **model choice** (smart vs fast per turn/task) plus
**sync-level choice** (when AGI/summary recall, when a plain session).

This lab measures that thesis, it does not assume it. Every number lands in a versioned
ledger committed to git (`ledger/*.jsonl`). Every promotion claim about coordination is
judged by the rule-eval state machine (lab/rule-eval/protocol.md), not by vibes.

## Layout

    tasks.yaml        the workload: 5 tasks of mixed size (data, not code) + grading specs
    personas/         coordinator card + user card (the coordinator IS a profile — test 3)
    arms/             per-arm scratch-root boot scripts + the forced-policy prompts
    grader/           metric library (deterministic, no LLM judge): score + laziness + drift
    runner.py         one scenario run: boot roots → drive arms → append ledger rows
    report.py         ledger → trend report (markdown) + rule-eval verdict on any claim
    ledger/           *.jsonl — VERSIONED IN GIT (one row per arm per run)
    synclevel.md      definition of the 3 sync arms (full / recall-summary / none)

## The metric set (metrics first — the law)

| metric | id | how measured |
|---|---|---|
| task success rate | `success_rate` | fraction of tasks whose deterministic grade passed |
| quality score | `quality` | harness-bench grader methods (contains/code/word_cap), mean over tasks |
| total wall time | `wall_ms` | first user turn started → last task graded |
| tokens spent | `tokens` | upstream usage summed over all sessions in the arm |
| user-visible latency | `ttfa_ms` | mean ms from user turn sent → first visible text byte |
| laziness signals | `laziness` | truncated replies, unasked-for-short answers, "as an AI", refusals-to-finish |
| drift signals | `drift` | wrong-version artifacts, forgotten constraints from earlier turns |
| coordinator overhead | `coord_overhead` | coordinator tokens ÷ total tokens |

## The arms

- **flat**: one long session, no coordinator, does all 5 tasks in order (the ad-hoc baseline).
- **coord**: coordinator profile session + one fresh sub-session per task (thesis shape).
- **model arms** (same tasks, coordinator forced): `smart-always` (glm-5.3) vs
  `fast-always` (glm-5.3-flash) vs `choosing` (coordinator picks per task via its tool).
- **sync arms**: `full` (entire transcript handed to the next task) vs `recall` (roll-up
  summary only — the root's own YGG_ROLLUP mechanism) vs `none` (each task blind).

## Laws this lab obeys

- **Scope fence**: the coordinator is tested LITERALLY as `profile: "coordinator"`
  (session-verbs + read only). If the profile can't do something the scenario needs,
  that is a FINDING, never a root feature.
- **Ledger in git**: every run appends rows to `ledger/coord-sim.jsonl`, committed.
- **No promotion without trend**: any "coordinator beats flat" claim needs ≥3 points
  in the ledger (rule-eval §1c-d). Until then it is a hypothesis with a number.
- **Self-evolving**: each nightly run may propose ONE procedure tweak via a finding;
  it is applied next run only if it beats baseline twice.
