# model arms — how the coordinator's model choice is forced/allowed

| arm | coordinator may switch models? | rule |
|---|---|---|
| `smart-always` | no — every sub stays on the root default `glm-5.3` | the "AGI everything" posture: max quality per task, max cost |
| `fast-always` | no — every sub stays on `glm-5.3-flash` | the "cheap everything" posture: min cost, quality risk on L tasks |
| `choosing` | yes — coordinator picks per task and records the COORD: line | the thesis posture: judgment per task |

Forced arms get a variant context file (below) that withholds the model-switch
endpoint; the choosing arm gets the full coordinator card. All three share the same
sync arm setting for a given run.

## the variant patch

- smart-always: `arms/coordinator-smart.md` — same card, model section replaced by
  "every sub-session runs the root default (smart); do not switch models."
- fast-always: `arms/coordinator-fast.md` — same card, model section replaced by
  "every sub-session runs the root default (fast); do not switch models."
- choosing: `arms/coordinator.md` verbatim.

## the flat baseline

`arms/flat.md` — one plain session, no coordinator. It receives all 5 tasks as they
arrive (same user turns as the coordinator arm) and must do them ITSELF in its one
long context. This is the ad-hoc long session the owner thesis says loses.
