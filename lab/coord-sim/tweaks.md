# self-evolution — the procedure-tweak register (coord-sim law)

Each nightly run may propose ONE procedure tweak via a finding. The tweak is applied
next run ONLY if it beats baseline twice (two ledger points where the tweaked run is
better on the named metric than the untweaked baseline arm on the same scenario).

| proposed | run | by | tweak | metric it must beat baseline on | status |
|---|---|---|---|---|---|
| — | — | — | — | — | (empty; first run has no prior to propose against) |

## How a tweak enters the protocol (rule-eval lineage, lab/rule-eval/protocol.md)

1. The run files a finding `tweak-proposal: <text>` with the metric named.
2. It lands in this register with status `proposed`.
3. Next run: the tweak runs as an EXTRA arm (`tweak-<name>`), same scenario.
4. If it beats the corresponding baseline arm on the named metric: status `1st-beat`,
   run it again next time. A second beat → `applied` (it becomes part of the procedure;
   the baseline arm is retired for that position).
5. A miss or a guard regression → `sunset` (with the reason). Sunset is data.
