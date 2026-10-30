"""voice-stab sweeper — reap stale agent rooms/dispatches so they can't pile up.

The 10-30 avalanche, end to end: every page refresh / PTT press minted a
fresh explicit dispatch; the worker accepted everything (load_threshold=inf)
and jobs whose human never arrived sat immortal (the entrypoint gives up
waiting after 30s and returns, but the JOB keeps running — its session never
closes, its room is held open by the agent participant). 39+ such jobs
starved 16 cores (load 40-51), VAD fell behind realtime, commits timed out,
the phone re-dispatched on every retry — a feedback loop, dead mic.

The one-job-per-room token route stops NEW stacking; the real load threshold
refuses when the box is drowning; THIS module reaps what already lingers:

- a room with dispatches but NO agent participant (its job drained; the
  dispatch can only ever mint a fresh agent for nobody) → delete the
  dispatches, and the room too if no human is there either
- an agent-alone room past the idle timeout (the human left — or never
  came — and the job's own grace lost the race) → delete the room; the
  agent's session closes with it and the job ends through its OWN shutdown
  path (we never kill worker processes directly)

The agent worker process itself is NEVER killed from here. We delete rooms
and dispatch rows — the mint-side fuel — over server APIs with room_admin
grants (the same credentials the worker already holds).

Runs at worker boot and then every SWEEP_INTERVAL_S, in-process with the
worker (shares its loop, env, no extra unit/port/token). Only the
"worker_started" event fires it, which happens in the MAIN worker process —
job child processes import this module harmlessly and never run it.
AGENT_DISABLE_SWEEPER=1 is the kill switch (rollback without a rebuild —
same pattern as AGENT_BUSY_KILL_SWITCH in the token route).

Env:
  AGENT_DISABLE_SWEEPER   =1 → don't start the sweeper
  AGENT_SWEEP_INTERVAL_S  seconds between sweeps (default 120, min 30 — the
                          10-30 storm regrew interim culls within minutes;
                          300 was too slow, the escalation asks minutes-scale)
  AGENT_JOB_IDLE_S        agent-alone seconds before a room is reaped
                          (default 120; must exceed the entrypoint's human-left
                          grace ~20s + commit tail 15s + 4s by a wide margin)
"""

import asyncio
import contextlib
import logging
import os
import time

from livekit import api as lk_api

logger = logging.getLogger("opencode-bridge.sweeper")

SWEEP_INTERVAL_S = max(30, int(os.environ.get("AGENT_SWEEP_INTERVAL_S", "120")))
AGENT_JOB_IDLE_S = max(120, int(os.environ.get("AGENT_JOB_IDLE_S", "120")))
# the agent's participant identity inside a room: livekit-agents mints
# "agent-<job_id>" (job.py accept(): identity = "agent-" + self.id — observed
# live 10-30 as agent-AJ_2AnPKPuipHps…). Match by prefix; the phone's own
# identity is always user_<room> so it can never collide.
AGENT_IDENTITY_PREFIX = "agent-"


def enabled() -> bool:
    return os.environ.get("AGENT_DISABLE_SWEEPER") != "1"


async def sweep_once(lkapi: lk_api.LiveKitAPI) -> dict:
    """One reap pass. Returns a small counts dict — the sweep's own metric.

    counts:
      rooms           rooms seen this pass
      dispatches      dispatch rows seen (across living rooms)
      reaped          dispatch rows deleted
      jobs            rooms with a live agent participant
      idle_reaped     agent-alone rooms past the idle timeout (room deleted)
    """
    counts = {
        "rooms": 0,
        "dispatches": 0,
        "reaped": 0,
        "jobs": 0,
        "idle_reaped": 0,
    }
    rooms = await lkapi.room.list_rooms(lk_api.ListRoomsRequest())
    counts["rooms"] = len(rooms.rooms)

    for room in rooms.rooms:
        name = room.name
        try:
            parts = await lkapi.room.list_participants(
                lk_api.ListParticipantsRequest(room=name)
            )
        except Exception as e:  # noqa: BLE001 — room may vanish mid-sweep
            logger.debug("sweep: participants for '%s' failed: %s", name, e)
            continue

        agents = [
            p for p in parts.participants if p.identity.startswith(AGENT_IDENTITY_PREFIX)
        ]
        humans = [
            p
            for p in parts.participants
            if not p.identity.startswith(AGENT_IDENTITY_PREFIX)
        ]
        counts["jobs"] += 1 if agents else 0

        try:
            dispatches = await lkapi.agent_dispatch.list_dispatch(name)
        except Exception as e:  # noqa: BLE001
            logger.debug("sweep: dispatches for '%s' failed: %s", name, e)
            dispatches = []
        counts["dispatches"] += len(dispatches)

        if not agents:
            # nobody home on the agent side: any dispatch here is a stub that
            # can only mint yet another job into an abandoned room.
            if dispatches:
                logger.info(
                    "sweep: room '%s' has %d dispatch(s) but no agent — reaping them",
                    name,
                    len(dispatches),
                )
                for d in dispatches:
                    with contextlib.suppress(Exception):
                        await lkapi.agent_dispatch.delete_dispatch(d.id, name)
                        counts["reaped"] += 1
            # no agent AND no human: the room itself is dead weight
            if not humans:
                logger.info("sweep: room '%s' empty — deleting it", name)
                with contextlib.suppress(Exception):
                    await lkapi.room.delete_room(lk_api.DeleteRoomRequest(room=name))
            continue

        # agent present: reap only when it has been ALONE past the idle cap —
        # an active back-to-back PTT rhythm (human leaves, rejoins within
        # seconds) is never touched; the entrypoint's own grace handles the
        # normal exits.
        if humans:
            continue
        joined_s = 0.0
        for p in agents:
            if p.joined_at:
                joined_s = max(joined_s, time.time() - p.joined_at)
        if joined_s > AGENT_JOB_IDLE_S:
            counts["idle_reaped"] += 1
            logger.warning(
                "sweep: room '%s' agent alone for %.0fs (idle cap %ss) — deleting room (job ends with its session)",
                name,
                joined_s,
                AGENT_JOB_IDLE_S,
            )
            with contextlib.suppress(Exception):
                await lkapi.room.delete_room(lk_api.DeleteRoomRequest(room=name))
            # its dispatch rows die with the room; anything left is reaped
            # next pass through the no-agent branch
    return counts


async def run_sweeper() -> None:
    """Boot sweep + periodic loop (started on worker_started from agent.py)."""
    if not enabled():
        logger.info("sweeper disabled (AGENT_DISABLE_SWEEPER=1)")
        return
    lkapi = lk_api.LiveKitAPI()  # LIVEKIT_URL/KEY/SECRET from the agent's env
    logger.info(
        "sweeper armed: every %ss, idle cap %ss", SWEEP_INTERVAL_S, AGENT_JOB_IDLE_S
    )
    while True:
        started = time.monotonic()
        try:
            counts = await sweep_once(lkapi)
            if counts["reaped"] or counts["idle_reaped"]:
                logger.warning("sweep done: %s", counts)
            else:
                logger.info("sweep done: %s", counts)
        except Exception as e:  # noqa: BLE001 — the loop must survive anything
            logger.error("sweep failed: %s", e)
        elapsed = time.monotonic() - started
        await asyncio.sleep(max(5.0, SWEEP_INTERVAL_S - elapsed))
