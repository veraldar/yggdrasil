/**
 * Revoking a device kills its voice — server-side, within about a second.
 *
 * A LiveKit join token outlives nothing on its own: once the phone is in the
 * room its media keeps flowing (LiveKit keeps an ICE-connected participant
 * even after its signaling socket is cut). So every token minted for a paired
 * device (devices mode) is watched here: the participant carries the device id
 * as a token ATTRIBUTE (set by this server; a participant cannot rewrite its
 * own attributes without canUpdateOwnMetadata, which no token grants), and
 * once a second the watcher asks LiveKit who holds each watched identity. A
 * holder whose device is revoked — from /devices, `install.sh pair --revoke`
 * or the kill-switch (all three only edit the shared registry) — is removed
 * from the room: LiveKit closes its peer connection, the media stops.
 *
 * The bridge cuts the same device's signaling over the trunk (trunk/src/ap.rs:
 * /rtc is device-gated and severed on revoke), so it cannot rejoin through the
 * access point either. A watch lives for the token's lifetime (plus a minute):
 * after that the join token itself is dead.
 */
import { RoomServiceClient } from 'livekit-server-sdk';
import { deviceLive } from '@/lib/devices';
import { authority, deviceStanding } from '@/lib/trunk-auth';

// kep: trunk mode (v1) — the kill epoch of the access token the voice was minted for. A v1 device is
// live while it is not on the bridge's deny-list and the trunk's kill epoch has not passed its token's.
type Watch = { room: string; identity: string; until: number; kep?: number };
type State = {
  watches: Map<string, Watch>;
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
};

const SWEEP_MS = Number(process.env.BIFROST_VOICE_SWEEP_MS) || 1000;
// one state per process, whatever module instance the route bundle loads
const g = globalThis as unknown as { __bifrostVoiceRevoke?: State };
const state: State = (g.__bifrostVoiceRevoke ??= { watches: new Map(), timer: null, busy: false });

let client: RoomServiceClient | null = null;

export function watchVoice(
  api: { host: string; key: string; secret: string },
  room: string,
  identity: string,
  ttlMs: number,
  kep?: number
): void {
  client ??= new RoomServiceClient(api.host, api.key, api.secret);
  state.watches.set(`${room}\n${identity}`, { room, identity, until: Date.now() + ttlMs + 60_000, kep });
  if (!state.timer) {
    state.timer = setInterval(() => void sweep(), SWEEP_MS);
    state.timer.unref?.();
  }
}

async function live(device: string, kep: number | undefined): Promise<boolean> {
  if (process.env.BIFROST_AUTH === 'trunk') return deviceStanding(device, kep ?? 0, authority());
  return deviceLive(device);
}

async function sweep(): Promise<void> {
  if (state.busy || !client) return;
  state.busy = true;
  try {
    for (const [k, w] of state.watches) {
      if (Date.now() > w.until) {
        state.watches.delete(k);
        continue;
      }
      let device = '';
      try {
        const p = await client.getParticipant(w.room, w.identity);
        device = p.attributes?.device || '';
      } catch {
        continue; // not in the room (yet, or any more)
      }
      if (!device || (await live(device, w.kep))) continue;
      try {
        await client.removeParticipant(w.room, w.identity);
        console.log(`[voice] device ${device} revoked — removed ${w.identity} from room ${w.room}`);
      } catch (e) {
        console.error(`[voice] could not remove ${w.identity} from ${w.room}:`, e);
      }
    }
  } finally {
    state.busy = false;
  }
}
