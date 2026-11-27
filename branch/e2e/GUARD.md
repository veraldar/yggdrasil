# e2e guard — which stack a spec may touch (phase 0, plan G7.3).
#
# The live preview (:4101/:8101/:8447) is the owner's MAIN. A spec that seeds sessions
# there litters the store (54 gone e2e-* sessions were indexed by the librarian).
#
# The rules, enforced by e2e/brain.ts at load time:
#   - a spec needs E2E_OC_URL / TS_BRAIN: set it in the runner (the twin). There is no
#     silent default to a live brain anymore.
#   - E2E_ALLOW_LIVE=1 is the explicit override (a human, on purpose, read-write on live).
#   - PW_BASE_URL still says which app is driven; specs that POST through the app inherit
#     the app's brain by construction (the runner points the app at the twin).
#
# Suites and where they belong (verify-twin.sh):
#   list-order.spec.ts        twin (writes e2e-order-* sessions)
#   working-filter.spec.ts    twin (stubs its own status matrix; the last test writes
#                             e2e-wf-* sessions and sends one real turn)
#   notify-per-session.spec.ts twin (writes e2e-notify-* sessions)
#   who-wrote.spec.ts         twin by default (writes e2e-who-*); TS_BRAIN names the brain
#   antigravity-harness.spec.ts twin (E2E_OC_URL)
#   image-read-live.spec.ts   twin by default (E2E_OC_URL); "live" = a real image read, not
#                             the live store — the name predates this guard
#   voice-live-lib.ts         helper: PV from E2E_OC_URL, no silent live default
#   voice-commands-check.ts   helper: PV from E2E_OC_URL
#   terminal-sessions.spec.ts the live stack by design (real terminals + cc-live helper,
#                             scratch conversations TS_CLAUDE/TS_AGY/TS_OC) — keep it in
#                             verify-8447.sh, which owns those ids
#   cc-live.spec.ts           the live stack by design (drives the real helper on :4320)
#
# verify-8447.sh (root-coord) keeps: terminal-sessions, cc-live. It used to run list-order
# and notify-per-session against :8447; from phase 0 they run on the twin only
# (sim/acceptance/verify-twin.sh in this tree).
