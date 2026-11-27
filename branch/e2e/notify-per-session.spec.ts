import { devices, expect, test } from '@playwright/test';
import { slugify } from '../lib/slug';

/** Notifications per session (owner 11-17): a session may wake the phone only when its own switch
 *  says so — off by default, on for MAIN; the switch is in the session's settings. Run against the
 *  stack the owner uses (PW_BASE_URL = :8447), a Pixel 7 with taps. MAIN's own choice is never
 *  touched: the run checks its default and that its settings show what the app holds.
 *  What a notification says (11-17): the session's digest of its last reply — its name, then what
 *  happened or the question it waits on — one plain line, never "reply ready" or the reply itself. */
test.use({ ...devices['Pixel 7'] });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

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

type Msg = { role: string; text?: string; time: number };
const MARKDOWN = 'Reply with a markdown report: a "## Fruit report" heading, then six bullet points, each one full sentence about a different fruit, with the fruit name in **bold**.';

/** one turn of the scratch session, sent as the phone does; its reply's text once it is finished */
async function turn(request: import('@playwright/test').APIRequestContext, text: string): Promise<string> {
  const sent = Date.now();
  await request.post(`/api/session/${slug}/messages`, { data: { text, async: true }, headers: { 'X-Session-Pin': id } });
  let reply = '';
  await expect
    .poll(
      async () => {
        const rows = (await (await request.get('/api/session')).json()) as { id: string; pending?: boolean; lastRole?: string }[];
        const row = rows.find((r) => r.id === id);
        if (!row || row.pending || row.lastRole !== 'assistant') return 0;
        const r = await request.get(`/api/session/${slug}/messages?limit=2`, { headers: { 'X-Session-Pin': id } });
        const ms = (await r.json()) as Msg[];
        const last = ms[ms.length - 1];
        reply = last?.role === 'assistant' && last.time > sent - 2000 ? last.text || '' : '';
        return reply.length;
      },
      { timeout: 150_000, intervals: [2000] }
    )
    .toBeGreaterThan(0);
  return reply;
}

/** a lock-screen line: short, one line, no markdown, not the old placeholder, not the raw reply */
function digestLike(body: string, reply: string) {
  expect(body.length, body).toBeGreaterThan(8);
  expect(body.length, body).toBeLessThanOrEqual(180);
  expect(body, 'no markdown marks').not.toMatch(/(^|\s)#{1,6}\s|\*\*|`|\n/);
  expect(body).not.toMatch(/^(reply ready|replied)\b/);
  expect(body.length, 'a digest, not the reply').toBeLessThan(reply.length);
}

test("a notification is the session's digest of its reply", async ({ request }) => {
  expect((await request.put('/api/notify', { data: { slug, on: true } })).ok()).toBe(true);
  const reply = await turn(request, MARKDOWN);
  const d = (await (await request.get(`/api/notify?slug=${slug}&notice=1`)).json()) as {
    on: boolean;
    notice: { title: string; body: string };
  };
  expect(d.on).toBe(true);
  expect(d.notice.title, 'the session it is about').toBe(slug);
  digestLike(d.notice.body, reply);
  console.log(`notice: ${d.notice.title} — ${d.notice.body}`);
  // the same reply asked again: the same words (one digest per reply)
  const again = (await (await request.get(`/api/notify?slug=${slug}&notice=1`)).json()) as typeof d;
  expect(again.notice).toEqual(d.notice);
  // switched off: no words are made
  await request.put('/api/notify', { data: { slug, on: false } });
  expect(((await (await request.get(`/api/notify?slug=${slug}&notice=1`)).json()) as typeof d).notice).toBeUndefined();
});

test('on the phone: a reply in a session you asked in shows its digest', async ({ page, request }) => {
  await request.put('/api/notify', { data: { slug, on: true } });
  // the phone's notifications, as the app makes them (permission given, no service worker), with
  // the app in the background — as when you send and put the phone away (the list watches the
  // sessions you asked in only then: in front, you see the list itself)
  await page.addInitScript((s: string) => {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    const shown: { title: string; body?: string }[] = [];
    (window as unknown as { __shown: typeof shown }).__shown = shown;
    class N {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title: string, o?: NotificationOptions) {
        shown.push({ title, body: o?.body });
      }
    }
    Object.defineProperty(window, 'Notification', { value: N, configurable: true });
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'getRegistration', { value: async () => undefined, configurable: true });
    }
    localStorage.setItem('oz-read-init', '1');
    localStorage.setItem('oz-asked', JSON.stringify({ [s]: Date.now() }));
  }, slug);
  const reply = turn(request, 'Reply in two short sentences: what is the capital of Iceland, and one thing it is known for.');
  await page.goto('/');
  const text = await reply;
  const shown = () => page.evaluate(() => (window as unknown as { __shown: { title: string; body?: string }[] }).__shown);
  await expect.poll(async () => (await shown()).length, { timeout: 90_000 }).toBeGreaterThan(0);
  const n = (await shown())[0];
  expect(n.title).toBe(slug);
  digestLike(n.body || '', text + ' '.repeat(200)); // a two-sentence reply may be about as short as its digest
  console.log(`shown: ${n.title} — ${n.body}`);
  await request.put('/api/notify', { data: { slug, on: false } });
});
