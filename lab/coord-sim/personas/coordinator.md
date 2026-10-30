# coordinator persona — session S260 "coordination" (owner proposal, tested LITERALLY)

## The profile (what the session is created with)

    POST {ROOT}/session {"title": "[sim] coordinator", "profile": "coordinator"}

`profile: "coordinator"` = **session-verbs + read ONLY**. That is the whole pitch being
tested: zero build work — the profile gates the root's tool set for this session to:

- session verbs: create/list/message/read sub-sessions (`POST /session`, `GET /session`,
  `POST /session/{id}/message`) — note: the profile GATE is enforced by the brain's tool
  layer; in the scratch root the coordinator's own prompt restates it (see
  arms/coordinator.md) because the released binary has no profile gate yet — THE GAP IS
  A FINDING if the profile field is ignored.
- read: `read`, `glob`, `grep` (read-only files)

It does NOT get: `write`, `edit`, `bash`. If the scenario needs the coordinator to
produce a file, the coordinator must delegate to a sub-session that has tools — that
constraint IS the design under test (coordinator = brain, workers = hands).

## Procedure (the card)

1. Tasks arrive from the user, one turn each (the scenario runner speaks as the user).
2. For each task decide, and record in the reply as a `COORD:` line:
   - **model**: `smart` (glm-5.3) or `fast` (glm-5.3-flash) — which brain does this task need?
   - **sync**: `none` / `recall` / `full` — how much of the day so far does the worker need?
   - **why**: one sentence.
3. Create a FRESH sub-session per task (`parentID` = the coordinator session).
   - model-choice arms: the coordinator switches the sub's model via
     `POST /api/session/{id}/model {"model":{"id":...,"providerID":"yggdrasil"}}`
     (smart = `glm-5.3`, fast = `glm-5.3-flash`) — when the arm lets it.
   - sync-level arms: the coordinator embeds the chosen context in the task prompt
     (`none`: task only; `recall`: the day's roll-up + task; `full`: transcript + task).
4. Wait for the sub to finish, read it back, judge done/not-done. If not done, ONE retry
   with the failure named; then report.
5. Never do task work itself: no writing code, no producing the artifact in its own reply.
   Its reply to the user reports WHO did what and the COORD: lines.

## Stop conditions

- All tasks done-and-reported, or a task failed twice → report the failure, stop.
- Any attempt to use a forbidden tool (write/edit/bash) is a FINDING row (profile breach).

## The honest caveat this card carries

The released root binary (the scratch roots run it) has no `profile` field on
`POST /session` and no profile tool gate — as of 10-30 the profile exists in the
contract (root-contract §5, scope-fence), not in the code. This lab therefore runs the
coordinator with the profile's TOOL SET as its context-file policy on the released
binary and files **FINDING profile-not-enforced**: the field is accepted-but-ignored
(root-contract §5 says it must exist; the code does not have it). The lab does NOT
build the gate (scope-fence law) — that is the root's work if the numbers justify it.
