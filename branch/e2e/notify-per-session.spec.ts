import { devices, expect, test } from '@playwright/test';
import { slugify } from '../lib/slug';

/** Notifications per session (owner 11-17): a session may wake the phone only when its own switch
 *  says so — off by default, on for MAIN; the switch is in the session's settings. Run against the
 *  stack the owner uses (PW_BASE_URL = :8447), a Pixel 7 with taps. MAIN's own choice is never
 *  touched: the run checks its default and that its settings show what the app holds. */
test.use({ ...devices['Pixel 7'] });
test.describe.configure({ mode: 'serial' });

const NAME = `e2e-notify-${Date.now().toString(36)}`;
let id = '';
let slug = '';

test.beforeAll(async ({ request }) => {
  const r = await request.post('/api/session', { data: { name: NAME } });
  const d = await r.json();
  id = d.id;
  slug = slugify(d.title || NAME);
  expect(id, 'a scratch session').toBeTruthy();
});

test.afterAll(async ({ request }) => {
  if (id) await request.delete(`/api/session/${id}`);
});

const held = async (request: import('@playwright/test').APIRequestContext, s: string) =>
  (await (await request.get(`/api/notify?slug=${s}`)).json()) as { on: boolean; default: boolean };

test('defaults: a new session is off, MAIN is on', async ({ request }) => {
  const fresh = await held(request, slug);
  expect(fresh.default).toBe(false);
  expect(fresh.on, 'a session never switched on stays quiet').toBe(false);
  expect((await held(request, 'main')).default, 'MAIN notifies by default').toBe(true);
  expect((await request.put('/api/notify', { data: { slug, on: 'yes' } })).status()).toBe(400);
});

test("the session's settings switch it on and off, and it holds", async ({ page, request }) => {
  await page.goto(`/session/${slug}/settings`);
  const on = page.getByTestId('notify-on');
  const off = page.getByTestId('notify-off');
  await expect(off).toHaveAttribute('aria-pressed', 'true');
  await on.tap();
  await expect(on).toHaveAttribute('aria-pressed', 'true');
  expect((await held(request, slug)).on).toBe(true);
  await page.reload();
  await expect(page.getByTestId('notify-on')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('notify-off').tap();
  await expect(page.getByTestId('notify-off')).toHaveAttribute('aria-pressed', 'true');
  expect((await held(request, slug)).on).toBe(false);
  await page.screenshot({ path: 'test-results/notify-settings.png' });
});

test("MAIN's settings show its switch as the app holds it", async ({ page, request }) => {
  const main = await held(request, 'main');
  await page.goto('/session/main/settings');
  await expect(page.getByTestId(main.on ? 'notify-on' : 'notify-off')).toHaveAttribute('aria-pressed', 'true');
});
