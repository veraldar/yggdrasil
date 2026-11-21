/** MAIN's voice primitives, shared (MAINFRAME-C, 10-26): the session view and
 *  the front page's roots talk to the same voice agent through the same room
 *  (room = session slug), so the pieces that are pure protocol live here.
 *  Moved verbatim out of app/session/[slug]/page.tsx — MAIN imports them, its
 *  behavior is unchanged. */
import { type Room, Track } from 'livekit-client';

/** echo gate tail: the speaker's output buffer + the room's reverb outlive
 *  the audio element's end by a few hundred ms */
export const ECHO_TAIL_MS = 400;

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${what} timeout (${ms / 1000}s)`)), ms)
    ),
  ]);
}

/** The voice agent can lag the room join (fresh dispatch after a page
 *  reload or a teardown): poll briefly instead of dropping the turn — a
 *  commit fired while `remoteParticipants` is still empty reaches nobody
 *  and the hold is lost silently (req 09-29 'switching from hand free to
 *  keyboard and then using the push to talk is not working'). */
const SERVING = 'bifrost.serving';
const WAITING = 'bifrost.waiting';

/** The agent that serves this room. A new job is dispatched on every page load and hold; for a
 *  moment several can be in the room (the newcomer waits its turn, or leaves at once). The
 *  phone's calls go to the one that says it serves — a waiting one cannot answer them, and the
 *  hold was lost (11-20). An older agent says nothing: then the first one, as before. */
export function servingAgent(room: Room) {
  const all = Array.from(room.remoteParticipants.values());
  return (
    all.find((p) => p.attributes?.[SERVING] === '1') ||
    all.find((p) => p.attributes?.[WAITING] !== '1') ||
    all[0] ||
    null
  );
}

export async function agentInRoom(room: Room, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const all = Array.from(room.remoteParticipants.values());
    const serving = all.find((p) => p.attributes?.[SERVING] === '1');
    if (serving) return serving;
    // jobs of this agent generation are here but none serves yet (one is about to take the
    // room): wait for it. An older agent (it marks nothing) is taken at once, as before.
    const marked = all.some((p) => p.attributes?.[WAITING] === '1');
    if (all.length && !marked) return servingAgent(room);
    if (Date.now() >= deadline) return all.length ? servingAgent(room) : null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** Text-mode PTT: release the CAPTURE DEVICE between holds. A muted track
 *  still holds the mic hardware (phone shows 'mic in use' — req 09-29
 *  'mic on only on push to talk'), and a full room teardown forces a
 *  reconnect on the next press — slower than the hold on a laggy link.
 *  So the room + agent stay warm; unpublishing stops the device, and the
 *  next hold's setMicrophoneEnabled(true) re-acquires it (~200ms). */
export function releaseMicDevice(room: Room) {
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (pub?.track) {
    try {
      room.localParticipant.unpublishTrack(pub.track, true);
    } catch {
      /* track already gone */
    }
  }
}

/** Keywords-only while a reply plays (owner 11-13 r2): tell the voice agent when the deck starts
 *  and stops speaking, so meanwhile it keeps only voice commands and "… over" — room noise and the
 *  reply's own echo never join the next message. Fire and forget. */
export function tellDeckState(room: Room | null, speaking: boolean, text = ''): void {
  const agent = room && servingAgent(room);
  if (!room || !agent) return;
  void room.localParticipant
    .performRpc({
      destinationIdentity: agent.identity,
      method: 'deck_state',
      // the words being spoken (voice-fixes 11-14): the agent drops their echo from what the mic hears
      payload: JSON.stringify(speaking && text ? { speaking, text: text.slice(0, 4000) } : { speaking }),
      responseTimeout: 3_000,
    })
    .catch(() => {});
}
