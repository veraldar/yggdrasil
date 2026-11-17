/** Which sessions may notify the phone (owner 11-17): off by default, on for MAIN — the one
 *  conversation that comes back to you. Each session's settings has the switch. Kept by the app
 *  next to the push subscriptions; both the push (lib/push.ts) and the in-page notification
 *  (lib/notify.ts, through /api/notify) ask it. */
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { isMainSlug } from './tree-first';

const FILE = path.join(process.cwd(), '.notify-sessions.json');

async function load(): Promise<Record<string, boolean>> {
  try {
    const d = JSON.parse(await readFile(FILE, 'utf8'));
    return d && typeof d === 'object' ? (d as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** before a session's own choice: MAIN on, the rest off */
export const notifyDefault = (slug: string): boolean => isMainSlug(slug);

/** a session's own choice, else its default */
export async function notifyOn(slug: string): Promise<boolean> {
  const set = (await load())[slug];
  return typeof set === 'boolean' ? set : notifyDefault(slug);
}

export async function setNotify(slug: string, on: boolean): Promise<void> {
  const d = await load();
  // only a choice that differs from the default is kept (a deleted session leaves nothing behind)
  if (on === notifyDefault(slug)) delete d[slug];
  else d[slug] = on;
  await writeFile(FILE, JSON.stringify(d, null, 1));
}
