import { expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { homePathOf } from '../lib/home-path-of';

/** The home screen's address on the rig under test: `/<home root's name>` (`/` is the door's
 *  address and, once the door was walked, forwards to the roots list — owner 11-26).
 *  `base` = the origin when the request context has no baseURL of its own. */
export async function homePath(request: APIRequestContext, base = ''): Promise<string> {
  const res = await request.get(`${base}/api/roots`);
  if (!res.ok()) throw new Error("home root's name unknown");
  const tree = (await res.json()) as { home?: { name?: string | null } | null };
  if (!tree.home?.name) throw new Error("home root's name unknown");
  return homePathOf(tree.home.name);
}

/** Open the home screen (what `page.goto('/')` meant before the roots page existed). */
export async function gotoHome(
  page: Page,
  base = '',
  options?: Parameters<Page['goto']>[1]
): Promise<Response | null> {
  return page.goto(`${base}${await homePath(page.request, base)}`, options);
}

/** the home root's name as the app on this device stored it — no request of the test's own */
export async function gotoHomeOnDevice(page: Page, base = ''): Promise<void> {
  let name = '';
  await expect
    .poll(async () => (name = (await page.evaluate(() => localStorage.getItem('oz-home-root'))) || ''), { timeout: 30_000 })
    .not.toBe('');
  await page.goto(`${base}${homePathOf(name)}`);
}

/** The landing of a pairing on a device that walked the door: `<base>/` forwards to the roots
 *  list (`/roots`, the server drops the trailing slash). `waitForURL(rootsLanding(AP))`. */
export const rootsLanding =
  (base: string) =>
  (u: URL): boolean =>
    u.href.replace(/\/$/, '') === `${base}/roots`;
