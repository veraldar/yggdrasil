/**
 * The spoken reply's transport: over the voice ROOM when the phone talks through the trunk, over
 * https otherwise.
 *
 * The phone speaks MAIN's replies itself (lib/speech.ts — the deck: playback, stop, faster, pause;
 * the agent's audio output is off). Its audio comes from the app's /api/tts/stream. Through the
 * trunk that https request ends at the VPS (the access point terminates the app's TLS), so the
 * reply's sound would cross the VPS readable while the microphone's does not. When the token came
 * with the trunk's ICE (`iceTcp`) and a voice room is up with its agent in it, the deck asks the
 * agent instead (RPC `tts_stream`): the agent fetches the same /api/tts/stream on the box's
 * loopback and streams the bytes back as a LiveKit byte stream — DTLS between this phone and the
 * box, like the mic. Same bytes, same deck; only the road changes. Anything else (no room, no
 * agent yet, an old agent, a slow start) falls back to https, so speech never waits on this.
 */
import { type ByteStreamReader, type Room, RoomEvent } from 'livekit-client';
import { trunkActive } from '@/lib/trunk-ice';

const TOPIC = 'bifrost.tts';
// the agent answers once the box's synthesis has STARTED (a whole reply on a small CPU voice takes
// seconds before its first byte — over https the deck waits that long too); then its stream opens
const SYNTH_MS = 60_000;
const OPEN_MS = 5_000;
const MAX_RPC = 14_000; // LiveKit RPC payloads stop at 15 KiB

type Waiter = (reader: ByteStreamReader) => void;
let room: Room | null = null;
const waiting = new Map<string, Waiter>();

/** this room carries the phone's voice now (the session page and the roots call it on connect) */
export function voiceRoom(r: Room): void {
  room = r;
  r.registerByteStreamHandler(TOPIC, (reader) => {
    const id = reader.info.attributes?.id || '';
    const w = waiting.get(id);
    if (!w) return; // nobody asked (a stopped reply): dropped
    waiting.delete(id);
    w(reader);
  });
  r.on(RoomEvent.Disconnected, () => {
    if (room === r) room = null;
  });
}

function agentOf(r: Room): string | null {
  // the job that serves the room (lib/voice-room.ts), else any agent in it
  const agents = Array.from(r.remoteParticipants.values()).filter(
    (p) => p.isAgent || p.identity.startsWith('agent-')
  );
  const serving = agents.find((p) => p.attributes?.['bifrost.serving'] === '1');
  return (serving || agents[0])?.identity ?? null;
}

/** test hook: a harness may watch the bytes that arrived over the room (never set in the app) */
type Tap = (chunk: Uint8Array, rate: number) => void;
const tap = () => (globalThis as unknown as { __bifrostTtsTap?: Tap }).__bifrostTtsTap;

async function overRoom(
  body: { text: string; lang?: string },
  signal: AbortSignal
): Promise<Response | null> {
  const r = room;
  const agent = r && r.state === 'connected' ? agentOf(r) : null;
  if (!r || !agent || !trunkActive()) return null;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify({ id, text: body.text, lang: body.lang || '' });
  if (payload.length > MAX_RPC) return null;
  // the stream may open the moment the agent answers: listen before asking
  let open: (r: ByteStreamReader | null) => void = () => {};
  const opened = new Promise<ByteStreamReader | null>((done) => (open = done));
  waiting.set(id, (reader) => open(reader));
  let rate = 0;
  try {
    const answer = JSON.parse(
      await r.localParticipant.performRpc({
        destinationIdentity: agent,
        method: 'tts_stream',
        payload,
        responseTimeout: SYNTH_MS,
      })
    ) as { status?: number; rate?: number };
    if (answer.status !== 200) throw new Error(`agent tts ${answer.status}`);
    rate = Number(answer.rate) || 24000;
  } catch {
    waiting.delete(id);
    return null; // an agent without tts_stream, gone, or its TTS failed: https
  }
  const t = setTimeout(() => {
    waiting.delete(id);
    open(null);
  }, OPEN_MS);
  const reader = await opened;
  clearTimeout(t);
  if (!reader || signal.aborted) return null;
  const got = { reader, rate };
  const it = got.reader[Symbol.asyncIterator]();
  signal.addEventListener('abort', () => void it.return?.(), { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const { done, value } = await it.next();
      if (done) return ctl.close();
      tap()?.(value, got.rate);
      ctl.enqueue(value);
    },
    async cancel() {
      await it.return?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'X-Sample-Rate': String(got.rate), 'X-Bifrost-Tts': 'room' },
  });
}

/** the reply's PCM stream (int16 LE, X-Sample-Rate): over the voice room when it can, else https */
export async function ttsStream(
  body: { text: string; lang?: string },
  signal: AbortSignal
): Promise<Response> {
  const viaRoom = await overRoom(body, signal).catch(() => null);
  if (viaRoom) return viaRoom;
  return fetch('/api/tts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}
