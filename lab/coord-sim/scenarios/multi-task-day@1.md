# coord-sim scenario v1 — the multi-task day

## What runs (tier-3 sim: real root binary, real brains, real sessions)

A simulated work day: 5 tasks of mixed size (S/M/M/S/L) arrive one per minute while
the user talks. Each arm lives on its OWN scratch root (:414x, release binary, real
upstream) so arms cannot contaminate each other's contexts or caches.

## The arms (a run = a full matrix sweep)

- `flat` — one plain session, no coordinator: the ad-hoc long session baseline.
- `coord-<model>-<sync>` — coordinator profile session + fresh sub-session per task:
  - model ∈ {`smart`, `fast`, `choose`} — forced smart / forced fast / coordinator chooses
  - sync ∈ {`full`, `recall`, `none`} — what the next sub-session knows of the day so far

The v1 scenario runs the headline comparison (owner thesis first): flat vs
coord-choose-recall, plus the model row (smart/fast/choose at sync=recall) and the
sync row (full/recall/none at model=choose). 8 arms. Each arm ~5 tasks × 1-3 turns
per task → 8 arms ≈ 60-100 upstream turns ≈ well inside the weekly quota.

## Turn script (identical user experience in every arm)

| t | user says | task |
|---|---|---|
| 0 | "summarize this email and list action items: <t1 email>" | t1 S |
| 1 | "also write the fizzbuzz module — spec: <t2>" | t2 M |
| 2 | "and a balanced-parens module — spec: <t3>" | t3 M |
| 3 | "pull total, due date, billing email out of this invoice: <t4>" | t4 S |
| 4 | "write tomorrow's handoff note covering the day: <t5>" | t5 L (the drift probe) |

In coord arms the same turns go to the coordinator session; it delegates.
In flat the same turns go to the one session; it works itself.

## Grading (all deterministic — grader/metrics.py)

- t1, t4: `contains` (harness-bench method).
- t2, t3: hidden pytest suites on the file the worker saved (grade_code; the file ON
  DISK is the deliverable — coord workers save via sub-sessions, flat saves directly).
- t5: `contains` over the four facts (drift probe). Plus the per-reply laziness scan.

## Metrics per arm (the set — README table), one ledger row per arm per run.

## Verdicts

- PASS — arm completed, all rows written.
- FINDINGS(n) — arm completed with findings (profile gap, model-fail, drift...). The good case.
- FAIL — arm could not run (world broken); files a finding (world is the first suspect).
