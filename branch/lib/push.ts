/** Web Push (VAPID): the proxy knows exactly when a run finishes (its async
 *  POST resolves on completion), so it can wake the phone even when Chrome
 *  froze the tab — in-page notifications can't do that on Android. */
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import webpush from 'web-push';
import { noticeFor } from './notice';
import { notifyOn } from './notify-sessions';

const SUBS_FILE = path.join(process.cwd(), '.push-subs.json');
const PUB = process.env.VAPID_PUBLIC_KEY || '';
const PRIV = process.env.VAPID_PRIVATE_KEY || '';

let configured = false;
function ensureConfigured(): boolean {
  if (!PUB || !PRIV) {
    if (!configured) console.warn('[push] VAPID keys missing — push disabled');
    configured = true;
    return false;
  }
  webpush.setVapidDetails('mailto:dweeb@dweeb.xyz', PUB, PRIV);
  return true;
}

type Sub = webpush.PushSubscription;

async function loadSubs(): Promise<Sub[]> {
  try {
    return JSON.parse(await readFile(SUBS_FILE, 'utf8')) as Sub[];
  } catch {
    return [];
  }
}

async function saveSubs(subs: Sub[]): Promise<void> {
  await writeFile(SUBS_FILE, JSON.stringify(subs, null, 1));
}

export function publicKey(): string {
  return PUB;
}

export async function addSub(sub: Sub): Promise<void> {
  if (!sub?.endpoint) return;
  const subs = await loadSubs();
  if (!subs.some((s) => s.endpoint === sub.endpoint)) subs.push(sub);
  await saveSubs(subs);
}

export async function removeSub(endpoint: string): Promise<void> {
  await saveSubs((await loadSubs()).filter((s) => s.endpoint !== endpoint));
}

/** Best-effort broadcast to every device; dead subscriptions are pruned. The words are the
 *  session's digest of the reply (lib/notice.ts); one per session on the phone (its tag). */
export async function pushRunDone(slug: string, sid?: string): Promise<void> {
  if (!ensureConfigured()) return;
  if (!(await notifyOn(slug))) return; // this session's switch (off by default; MAIN on)
  const subs = await loadSubs();
  if (!subs.length) return;
  const { title, body } = await noticeFor(slug, sid);
  const payload = JSON.stringify({ slug, title, body, tag: `oz-${slug}` });
  const alive: Sub[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s, payload, { TTL: 3600 });
        alive.push(s);
      } catch (e: any) {
        // 404/410 = subscription expired — drop it
        if (e?.statusCode !== 404 && e?.statusCode !== 410) alive.push(s);
      }
    })
  );
  if (alive.length !== subs.length) await saveSubs(alive);
}
