import { NextResponse } from 'next/server';
import {
  AccessToken,
  type AccessTokenOptions,
  AgentDispatchClient,
  RoomConfiguration,
  type VideoGrant,
} from 'livekit-server-sdk';

// must match agent/agent.py: @server.rtc_session(agent_name=...)
const AGENT_NAME = process.env.AGENT_NAME || 'bifrost';

// voice-stab 10-30 — the avalanche fix, client side of the contract:
// 1. AVAILABILITY GATE. The mint used to dispatch unconditionally, so every
//    page refresh / PTT press minted a NEW agent job even when the worker was
//    already drowning (39+ jobs, load 40-51, VAD slower than realtime → dead
//    mic on :443, 10-30). Now the mint asks the agent worker's own HTTP
//    health server first (GET /worker → active_jobs + worker_load) and
//    refuses with status 429 + { error: 'voice_busy' } when the worker is at
//    or over its load threshold — the PWA renders that as an honest "voice
//    busy, try again" state instead of spawning job #40 into the fire.
//    AGENT_BUSY_KILL_SWITCH=1 reverts to always-mint (rollback without a
//    rebuild — the frozen flip path).
// 2. ONE JOB PER ROOM. The dispatch is idempotent per room: any lingering
//    dispatch for this room is deleted before a fresh one is created, so a
//    refresh REPLACES the room's job instead of stacking another (the agent
//    entrypoint keeps its ordered-yield guard as the belt to this brace).
const AGENT_BUSY_KILL_SWITCH = process.env.AGENT_BUSY_KILL_SWITCH === '1';
// loopback by law (labs never listen beyond loopback) — override via env only
const AGENT_HTTP = process.env.AGENT_HTTP_URL || 'http://127.0.0.1:8081';
// refusals above this load — must stay ≥ the agent's AGENT_LOAD_THRESHOLD so
// a between-updates read can't refuse a job the agent would have accepted
const BUSY_LOAD = Number(process.env.AGENT_BUSY_LOAD || '0.9');

type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
};

// NOTE: you are expected to define the following environment variables in `.env.local`:
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

// don't cache the results
export const revalidate = 0;

export async function POST(req: Request) {
  // make an exception for the vercel preview environment
  if (process.env.NODE_ENV !== 'development' && process.env.IS_VERCEL_PREVIEW !== 'true') {
    throw new Error(
      'THIS API ROUTE IS INSECURE. DO NOT USE THIS ROUTE IN PRODUCTION WITHOUT AN AUTHENTICATION LAYER.'
    );
  }

  try {
    if (LIVEKIT_URL === undefined) {
      throw new Error('LIVEKIT_URL is not defined');
    }
    if (API_KEY === undefined) {
      throw new Error('LIVEKIT_API_KEY is not defined');
    }
    if (API_SECRET === undefined) {
      throw new Error('LIVEKIT_API_SECRET is not defined');
    }

    // Parse room config from request body.
    const body = await req.json();
    const roomConfig = body?.room_config
      ? RoomConfiguration.fromJson(body.room_config, { ignoreUnknownFields: true })
      : new RoomConfiguration();

  // Room = session slug passed by the sessions shell.
  const rawRoom = String(body?.room || '');
  console.log(`[token] raw room=${JSON.stringify(body?.room)} referer=${req.headers.get('referer')}`);
  const roomName = rawRoom.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
  // a room-less mint used to fall back to `session_<random>` — the agent
  // then spawned a phantom opencode session titled after it (2026-09-29
  // session_6898 storm). Refuse instead: callers must name the room.
  if (!roomName) {
    return NextResponse.json({ error: 'room required' }, { status: 400 });
  }

    // Stable identity per room so reconnects resume the same participant.
    const participantName = 'user';
    const participantIdentity = `user_${roomName}`;

    // voice-stab: refuse the mint while the agent worker is drowning. A
    // probe failure (worker mid-restart) is NOT busy — it returns 503 and the
    // phone retries its backoff; only a live worker over threshold refuses
    // with 429 voice_busy.
    const dispatchClient = new AgentDispatchClient(
      (process.env.LIVEKIT_API_URL || 'http://127.0.0.1:7880').replace(/^ws(s):/, 'http$1:'),
      API_KEY,
      API_SECRET
    );
    if (!AGENT_BUSY_KILL_SWITCH) {
      try {
        const r = await fetch(`${AGENT_HTTP}/worker`, {
          signal: AbortSignal.timeout(2000),
          cache: 'no-store',
        });
        if (r.ok) {
          const w = (await r.json()) as { active_jobs?: number; worker_load?: number };
          const load = Number(w.worker_load ?? 0);
          const jobs = Number(w.active_jobs ?? 0);
          if (load >= BUSY_LOAD && jobs > 0) {
            console.error(
              `[token] voice_busy: refusing mint for ${roomName} (load=${load.toFixed(2)} jobs=${jobs})`
            );
            return NextResponse.json(
              { error: 'voice_busy', load, activeJobs: jobs },
              { status: 429, headers: { 'Cache-Control': 'no-store' } }
            );
          }
        }
        // non-ok / failed probe: fall through — the agent may still be up
      } catch (probeError) {
        console.error(`worker probe failed for room ${roomName}:`, probeError);
      }
    }

    // voice-stab: the explicit dispatch is now REUSE/REPLACE, not ADD, and
    // never cannibalizes a serving agent. LiveKit only auto-dispatches a job
    // when a room is CREATED, so rejoining a not-yet-deleted room (fast mode
    // switch, self-heal) used to land in an agent-less room: hot mic,
    // "listening" UI, nothing transcribed (2026-09-25 veraldar-org---home).
    // The per-mint dispatch fixed that but STACKED jobs (the 10-30 avalanche:
    // ~46-66 job processes/min on one room, live: 465 offers in 10 min).
    // A dispatch whose state.jobs is non-empty has a LIVE job — deleting it
    // kills the serving agent (first gate run proved it: the storm's own
    // deletes emptied the room). So: rows with bound jobs are REUSED (no new
    // dispatch at all — the room already has its one job; the phone just
    // rejoins); stale stubs (no jobs) are REPLACED by one fresh dispatch.
    // A burst therefore converges: first mint creates, the rest reuse.
    // Best-effort throughout: a failed dispatch still returns the token
    // (voice stays agent-less and the session page surfaces it) — the
    // entrypoint's accept-time room cap is the backstop.
    try {
      const existing = await dispatchClient.listDispatch(roomName).catch(() => []);
      let live = false;
      for (const d of existing) {
        if ((d.state?.jobs?.length ?? 0) > 0) {
          live = true; // a serving job backs this row — REUSE, hands off
          continue;
        }
        try {
          await dispatchClient.deleteDispatch(d.id, roomName);
        } catch (delError) {
          // already gone / room already deleted — harmless
          console.error(`dispatch delete failed for room ${roomName}:`, delError);
        }
      }
      if (!live) {
        await dispatchClient.createDispatch(roomName, AGENT_NAME);
      }
    } catch (dispatchError) {
      console.error(`agent dispatch failed for room ${roomName}:`, dispatchError);
    }

    const participantToken = await createParticipantToken(
      { identity: participantIdentity, name: participantName },
      roomName,
      roomConfig
    );

    // Return connection details
    const data: ConnectionDetails = {
      serverUrl: LIVEKIT_URL,
      roomName,
      participantName,
      participantToken,
    };
    const headers = new Headers({
      'Cache-Control': 'no-store',
    });
    return NextResponse.json(data, { headers });
  } catch (error) {
    if (error instanceof Error) {
      console.error(error);
      return new NextResponse(error.message, { status: 500 });
    }
  }
}

function createParticipantToken(
  userInfo: AccessTokenOptions,
  roomName: string,
  roomConfig: RoomConfiguration | undefined
): Promise<string> {
  const at = new AccessToken(API_KEY, API_SECRET, {
    ...userInfo,
    ttl: '15m',
  });
  const grant: VideoGrant = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  };
  at.addGrant(grant);

  if (roomConfig) {
    at.roomConfig = roomConfig;
  }

  return at.toJwt();
}
