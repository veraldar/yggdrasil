import { NextResponse } from 'next/server';
import {
  AccessToken,
  type AccessTokenOptions,
  AgentDispatchClient,
  RoomConfiguration,
  type VideoGrant,
} from 'livekit-server-sdk';
import { lookup } from 'node:dns/promises';
import { signedInDevice } from '@/lib/admin';
import { resolveId } from '@/lib/oc';
import { watchVoice } from '@/lib/voice-revoke';

// must match branch/voice/agent.py: @server.rtc_session(agent_name=...)
const AGENT_NAME = process.env.AGENT_NAME || 'bifrost';

type IceTcp = { ip: string; port: number };

type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
  /** devices mode over the trunk: the access point's ICE-TCP address(es) — the
   *  phone adds them as passive TCP candidates (lib/trunk-ice.ts), so the media
   *  rides vps:443 → the ap's raw `livekit-ice` forward → this box's LiveKit */
  iceTcp?: IceTcp[];
};

// NOTE: you are expected to define the following environment variables in `.env.local`:
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

// don't cache the results (GET reads the env at request time, never at build)
export const revalidate = 0;
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const TOKEN_TTL_MS = 15 * 60 * 1000;

/** Voice is a state of the connection, not an error (lib/voice-token.ts): the
 *  app shows one calm line and stops asking. Always JSON — an empty 500 used
 *  to surface on the phone as "Unexpected end of JSON input". */
function unavailable(why: string) {
  return NextResponse.json({ error: 'voice-unavailable', why }, { status: 503, headers: NO_STORE });
}

// devices (v0.9) or trunk (v1): the public door, where a signed-in DEVICE is the gate
const devicesMode = () => process.env.BIFROST_AUTH === 'devices' || process.env.BIFROST_AUTH === 'trunk';

/** why voice cannot work from here, or null when it can. Tokens are minted
 *  where the network is the gate (the tailnet), on a dev server, or — devices
 *  mode, a phone paired through the trunk — for a PAIRED DEVICE only: the
 *  middleware's device gate is the auth (a live, region-bound access token),
 *  and this route names the device it mints for (`deviceOf`). */
function whyUnavailable(): string | null {
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.BIFROST_AUTH !== 'tailnet' &&
    !devicesMode()
  ) {
    return `voice needs BIFROST_AUTH=tailnet or devices (now: ${process.env.BIFROST_AUTH || 'unset'})`;
  }
  if (!LIVEKIT_URL || !API_KEY || !API_SECRET) {
    return 'no LiveKit on this computer (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET unset)';
  }
  return null;
}

/** devices / trunk mode: the paired device this request speaks for (the same
 *  credential and region the middleware just checked), or null — the box's own
 *  console and the admin token pass the gate without one, and get no voice.
 *  `kep`: a v1 token's kill epoch, which the revoke watch checks again (lib/voice-revoke). */
async function deviceOf(req: Request): Promise<{ id: string; kep?: number } | null> {
  const d = await signedInDevice(req);
  return d.ok ? { id: d.id, kep: d.kep } : null;
}

const NOT_PAIRED =
  'voice is for paired devices — pair this browser first (scan the QR from the box)';

/** BIFROST_TRUNK_ICE — where the phone's media enters the trunk: `auto` = the
 *  public name of this app (BIFROST_PUBLIC_URL) on :443, resolved here (a
 *  browser does not resolve names in ICE candidates); or `ip:port,…`; unset or
 *  `off` = none (the LAN / tailnet path is unchanged). */
async function iceTcp(): Promise<IceTcp[] | undefined> {
  const conf = (process.env.BIFROST_TRUNK_ICE || '').trim();
  if (!conf || conf === 'off') return undefined;
  const out: IceTcp[] = [];
  if (conf === 'auto') {
    let host = '';
    try {
      host = new URL(process.env.BIFROST_PUBLIC_URL || '').hostname.replace(/^\[|\]$/g, '');
    } catch {
      return undefined;
    }
    const found = await lookup(host, { all: true }).catch(() => []);
    for (const a of found) out.push({ ip: a.address, port: 443 });
  } else {
    for (const item of conf.split(',')) {
      const m = /^\[?([0-9a-fA-F:.]+)\]?:(\d{1,5})$/.exec(item.trim());
      if (m && Number(m[2]) > 0 && Number(m[2]) < 65536) out.push({ ip: m[1], port: Number(m[2]) });
    }
  }
  return out.length ? out : undefined;
}

/** GET: can voice work from here? Mints nothing, dispatches nothing — the app
 *  asks before it would ask for the mic (lib/voice-token.ts voiceProbe). */
export async function GET(req: Request) {
  const why = whyUnavailable() ?? (devicesMode() && !(await deviceOf(req)) ? NOT_PAIRED : null);
  return why ? unavailable(why) : NextResponse.json({ voice: 'available' }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  const why = whyUnavailable();
  if (why) return unavailable(why);
  const device = devicesMode() ? await deviceOf(req) : null;
  if (devicesMode() && !device) return unavailable(NOT_PAIRED);

  try {
    // Parse room config from request body (an unreadable body = no room → 400 below).
    const body = await req.json().catch(() => ({}));
    const roomConfig = body?.room_config
      ? RoomConfiguration.fromJson(body.room_config, { ignoreUnknownFields: true })
      : new RoomConfiguration();

    // Room = session slug passed by the sessions shell.
    const rawRoom = String(body?.room || '');
    console.log(
      `[token] raw room=${JSON.stringify(body?.room)} referer=${req.headers.get('referer')}`
    );
    let roomName = rawRoom.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    // VOICE_ROOM_BY_ID=1 (a second stack on the same LiveKit, e.g. a preview): rooms are named by
    // session id, so they never collide with another stack's slug rooms ("main"). The voice agent
    // finds a session by slug OR id, so nothing changes on its side.
    if (process.env.VOICE_ROOM_BY_ID === '1' && roomName) {
      roomName = await resolveId(roomName).catch(() => roomName);
    }
    // a room-less mint used to fall back to `session_<random>` — the agent
    // then spawned a phantom opencode session titled after it (2026-09-29
    // session_6898 storm). Refuse instead: callers must name the room.
    if (!roomName) {
      return NextResponse.json({ error: 'room required' }, { status: 400, headers: NO_STORE });
    }

    // Stable identity per room so reconnects resume the same participant.
    const participantName = 'user';
    const participantIdentity = `user_${roomName}`;

    const participantToken = await createParticipantToken(
      {
        identity: participantIdentity,
        name: participantName,
        // devices mode: who this voice belongs to — revoking the device removes it (lib/voice-revoke)
        ...(device ? { attributes: { device: device.id } } : {}),
      },
      roomName,
      roomConfig
    );

    // Explicit agent dispatch. LiveKit only auto-dispatches a job when a room
    // is CREATED, so rejoining a not-yet-deleted room (fast mode switch,
    // self-heal) used to land in an agent-less room: hot mic, "listening"
    // UI, nothing transcribed (2026-09-25 veraldar-org---home). Dispatching
    // per mint guarantees an agent for every fresh phone connect. Best-effort:
    // a failed dispatch still returns the token (voice just stays agent-less
    // and the session page surfaces it).
    // LIVEKIT_URL is the phone-facing TLS alias (proxied websockets only —
    // its Twirp path 404s into the PWA); the server API needs the direct
    // host. Same box, so 127.0.0.1:7880 is the sane default.
    const apiHost = (process.env.LIVEKIT_API_URL || 'http://127.0.0.1:7880').replace(
      /^ws(s):/,
      'http$1:'
    );
    if (device)
      watchVoice(
        { host: apiHost, key: API_KEY!, secret: API_SECRET! },
        roomName,
        participantIdentity,
        TOKEN_TTL_MS,
        device.kep
      );
    try {
      const dispatchClient = new AgentDispatchClient(apiHost, API_KEY, API_SECRET);
      await dispatchClient.createDispatch(roomName, AGENT_NAME);
    } catch (dispatchError) {
      console.error(`agent dispatch failed for room ${roomName}:`, dispatchError);
    }

    // Return connection details
    const ice = devicesMode() ? await iceTcp() : undefined;
    const data: ConnectionDetails = {
      serverUrl: LIVEKIT_URL!, // whyUnavailable() checked all three
      roomName,
      participantName,
      participantToken,
      ...(ice ? { iceTcp: ice } : {}),
    };
    return NextResponse.json(data, { headers: NO_STORE });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: 'token failed', why: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: NO_STORE }
    );
  }
}

function createParticipantToken(
  userInfo: AccessTokenOptions,
  roomName: string,
  roomConfig: RoomConfiguration | undefined
): Promise<string> {
  const at = new AccessToken(API_KEY, API_SECRET, {
    ...userInfo,
    ttl: TOKEN_TTL_MS / 1000,
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
