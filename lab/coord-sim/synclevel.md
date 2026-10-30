# sync arms — the three sync levels (definition, coord-sim v1)

The owner thesis says the coordinator's second-hardest job is choosing the sync level:
how much context a fresh sub-session gets from the day so far. Three levels, cheapest first:

| level | what the next sub-session gets | cost | risk it buys |
|---|---|---|---|
| **none** | only the task prompt | ~0 | the task flies blind: drift on any "earlier" fact |
| **recall** | a compressed summary of the day so far (the root's own roll-up mechanism, `YGG_ROLLUP_TOKENS`) | one extra upstream call, small | summary may drop the exact fact the task needs |
| **full** | the entire transcript so far pasted into the task context | linear in day length | cost grows with the day; attention dilution on long days |

The measurement: same tasks, same workers, only the sync level varies. The drift probe
(t5) is designed to punish `none` when a task needs earlier facts, and to punish `full`
on tokens/wall time. `recall` wins the thesis if it keeps t5 drift near `full` while
costing near `none`.

Implementation honesty (v1): the coordinator session asks the ROOT for the roll-up —
the roll-up is the root's existing mechanism (rollup.rs), not a lab-built summarizer.
In the `recall` arm the coordinator includes the roll-up text in the sub-session's task
prompt. In `full` it includes the raw transcript. The difference between arms is
therefore REAL and measurable at the token counter.

AGI-vs-plain choice: the sync-level choice generalized. `full`-sync on every hop is the
"AGI everything" posture; `none` is the "plain sessions" posture; `recall` is the
judgment call the coordinator is supposed to learn to make. The model-choice arms and
the sync arms are crossed in the scenario matrix, not merged.
