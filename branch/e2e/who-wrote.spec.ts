import { devices, expect, test } from '@playwright/test';
import { slugify } from '../lib/slug';

/** Who wrote it (owner 11-18: "I see (you) like if I wrote the message"). A message another
 *  session wrote names it — "(← MAIN)", a tap opens MAIN — and the owner's own stay "(you)"; with
 *  several writers, chips filter one writer's messages and the replies to them. Run against the
 *  stack the owner uses (PW_BASE_URL = :8447), a Pixel 7 with taps; the messages are posted to the
 *  brain (TS_BRAIN, default its loopback port) the way a session — or another root — sends them. */
test.use({ ...devices['Pixel 7'] });
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const BRAIN = process.env.TS_BRAIN || 'http://127.0.0.1:4250'; // the twin (e2e/GUARD.md)
const tag = Date.now().toString(36);
const NAME = `e2e-who-${tag}`;
let id = '';
let slug = '';

test.beforeAll(async ({ request }) => {
  const d = await (await request.post('/api/session', { data: { name: NAME } })).json();
  id = d.id;
  slug = slugify(d.title || NAME);
  expect(id, 'a scratch session').toBeTruthy();
  const list: { id: string; title: string }[] = await (await request.get(`${BRAIN}/session`)).json();
  const main = list.find((s) => s.title === '[MAIN]');
  expect(main, "the brain's MAIN").toBeTruthy();
  const post = (text: string, meta?: object) =>
    request.post(`${BRAIN}/session/${id}/message`, {
      data: { parts: [{ type: 'text', text }], ...(meta && { meta }) },
      timeout: 120_000,
    });
  expect((await post(`Reply with exactly: who-you-${tag}`)).ok()).toBe(true);
  const fromMain = { from: { session: main!.id, title: main!.title } };
  expect((await post(`Reply with exactly: who-main-${tag}`, fromMain)).ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  if (id) await request.delete(`/api/session/${id}`);
});

test('a message from MAIN says so; the filter shows one writer and the replies to them', async ({
  page,
}) => {
  await page.goto(`/session/${slug}`);
  const mine = page.locator('[data-from="you"]', { hasText: `who-you-${tag}` });
  const mains = page.locator('[data-from]:not([data-from="you"])', { hasText: `who-main-${tag}` });
  await expect(mine).toBeVisible({ timeout: 20_000 });
  await expect(mine.locator('.oz-who')).toContainText('(you)');
  await expect(mains.getByTestId('msg-from')).toHaveText('(← MAIN)');
  const reply = (t: string) =>
    page.locator('[data-mi]:not([data-from])', { hasText: new RegExp(`^\\(agent\\).*${t}`) });
  await expect(reply(`who-main-${tag}`)).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: 'test-results/who-1-all.png' });

  const chips = page.getByTestId('who-filter');
  await expect(chips.getByRole('button')).toHaveText(['all', 'you', 'MAIN']);
  await chips.getByRole('button', { name: 'MAIN', exact: true }).tap();
  await expect(mains).toBeVisible();
  await expect(reply(`who-main-${tag}`)).toBeVisible();
  await expect(mine).toHaveCount(0);
  await expect(reply(`who-you-${tag}`)).toHaveCount(0);
  await page.screenshot({ path: 'test-results/who-2-main.png' });

  await chips.getByRole('button', { name: 'you', exact: true }).tap();
  await expect(mine).toBeVisible();
  await expect(mains).toHaveCount(0);
  await chips.getByRole('button', { name: 'all', exact: true }).tap();
  await expect(mine).toBeVisible();
  await expect(mains).toBeVisible();

  // the sender's name opens it
  await mains.getByTestId('msg-from').tap();
  await expect(page).toHaveURL(/\/session\/main$/);
});
