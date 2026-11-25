/**
 * The meter's app half (trunk observability, proposal v2 §5.4): the device-token lifecycle as
 * event lines — pairing, refresh (and how early it came), refresh-token reuse, refusals with
 * their hint, revocations, the kill switch. The bridge (trunk/src/meter.rs) writes its half
 * into the same folder; the morning report joins them by device id.
 *
 * Passive and never in the way: `event()` only pushes onto an in-memory queue; a timer writes
 * the queue once a second with appendFile. A full queue drops and counts. No request ever
 * waits for it, and a failed write is counted, never thrown.
 *
 * Never recorded: tokens, token hashes, pairing codes, cookies, IP addresses (the region —
 * lib/region.ts, a /16 at most — is the finest place it keeps, and only at home).
 *
 *   BIFROST_OBS=off        nothing is written
 *   BIFROST_OBS_DIR=<dir>  where; else `<the devices file's folder>/../obs` (the bridge's)
 * Files: app-events-YYYY-MM-DD.jsonl (UTC), deleted after 14 days by the bridge's meter.
 */
import { appendFile, chmod, mkdir } from 'fs/promises';
import path from 'path';

const MAX_QUEUE = 2000;
const queue: string[] = [];
let dropped = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let ready: Promise<string | null> | null = null;

export function obsOff(): boolean {
  return /^(off|0)$/i.test(process.env.BIFROST_OBS || '');
}

/** The folder the lines go to (null = off). */
export function obsDir(): string | null {
  if (obsOff()) return null;
  if (process.env.BIFROST_OBS_DIR) return process.env.BIFROST_OBS_DIR;
  const devices = process.env.BIFROST_DEVICES_FILE || '.devices.json';
  return path.join(path.dirname(path.resolve(devices)), '..', 'obs');
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One event line: {ts, t, kind, door, …fields}. Synchronous, cheap, never throws. */
export function event(kind: string, fields: Record<string, unknown> = {}): void {
  try {
    if (obsOff()) return;
    if (queue.length >= MAX_QUEUE) {
      dropped += 1;
      return;
    }
    const ts = Date.now();
    const line: Record<string, unknown> = {
      ts,
      t: new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      kind,
      door: process.env.BIFROST_AUTH === 'devices' || process.env.BIFROST_AUTH === 'trunk' ? 'public' : 'tailnet',
    };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = v;
    if (dropped > 0) {
      line.obs_dropped = dropped;
      dropped = 0;
    }
    queue.push(JSON.stringify(line));
    if (!timer) {
      timer = setInterval(() => void flush(), 1000);
      // never keep the process alive for the meter
      (timer as { unref?: () => void }).unref?.();
    }
  } catch {
    dropped += 1;
  }
}

/** Write what is queued (the timer calls it; tests call it directly). */
export async function flush(): Promise<number> {
  // one write at a time: a slow disk never piles appends up on node's thread pool
  if (queue.length === 0 || flushing) return 0;
  flushing = true;
  const lines = queue.splice(0, queue.length);
  try {
    ready ??= (async () => {
      const d = obsDir();
      if (!d) return null;
      // device ids and regions live here: the owner's eyes only (the bridge makes it 0700 too)
      await mkdir(d, { recursive: true, mode: 0o700 });
      await chmod(d, 0o700); // an existing folder too
      return d;
    })();
    const d = await ready;
    if (!d) return 0;
    // one file per UTC day; a batch spanning midnight lands by its first line's day
    const ts = Number(JSON.parse(lines[0]).ts) || Date.now();
    await appendFile(path.join(d, `app-events-${day(ts)}.jsonl`), lines.join('\n') + '\n', { mode: 0o600 });
    return lines.length;
  } catch {
    ready = null;
    dropped += lines.length;
    return 0;
  } finally {
    flushing = false;
  }
}

/** The region's kind without its address part: lan / net / cgnat / loopback … */
export function regionKind(region: string): string {
  return String(region || 'unknown').split(':')[0];
}
