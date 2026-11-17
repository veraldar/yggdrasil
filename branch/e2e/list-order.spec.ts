import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';

/** The session list (owner 11-17), on the stack the owner uses (PW_BASE_URL = :8447), a Pixel 7:
 *   - ordered by the owner's OWN newest message: a reply, a report or another session's message
 *     never moves a session up (agent replies used to jump sessions to the top);
 *   - one status word, nothing longer: "working" while it works, "terminal" for a terminal's
 *     conversation (the lost 19:30 message).
 *  Two scratch sessions; the brain is asked directly (E2E_OC_URL) only to send one of them a message
 *  from the other, as MAIN or a session does. */
test.use({ ...devices['Pixel 7'] });
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const OC = process.env.E2E_OC_URL || 'http://127.0.0.1:4101';
const tag = Date.now().toString(36).slice(-5);
const A = { name: `e2e-order-a-${tag}`, id: '' };
const B = { name: `e2e-order-b-${tag}`, id: '' };

type Row = { id: string; title: string; userAt?: number; lastAt?: number; pending?: boolean };
const rows = async (request: APIRequestContext) => (await (await request.get('/api/session')).json()) as Row[];
const rowOf = async (request: APIRequestContext, id: string) => (await rows(request)).find((r) => r.id === id);

/** the owner's message, as the phone sends it; resolves when the session is idle again */
async function say(request: APIRequestContext, s: { name: string; id: string }, text: string) {
  await request.post(`/api/session/${s.name}/messages`, { data: { text, async: true }, headers: { 'X-Session-Pin': s.id } });
  await idle(request, s.id);
}

async function idle(request: APIRequestContext, id: string) {
  await expect.poll(async () => {
    const r = await rowOf(request, id);
    return !!r && !r.pending && (r.lastAt || 0) > 0;
  }, { timeout: 150_000, intervals: [2000] }).toBe(true);
}

/** the list's order on the phone: row titles top to bottom, without their [TAG] */
const titles = async (page: Page) =>
  (await page.locator('.oz-row .t').allTextContents()).map((t) => t.replace(/^\[[A-Z]{3}\]\s*/, ''));

test.beforeAll(async ({ request }) => {
  for (const s of [A, B]) {
    s.id = (await (await request.post('/api/session', { data: { name: s.name } })).json()).id;
    expect(s.id).toBeTruthy();
  }
});

test.afterAll(async ({ request }) => {
  for (const s of [A, B]) if (s.id) await request.delete(`/api/session/${s.id}`);
});

test("a reply never moves a session up; the owner's own message does", async ({ page, request }) => {
  await say(request, A, 'Reply with exactly: a-1');
  await say(request, B, 'Reply with exactly: b-1');
  // A hears from another session (as from MAIN): its reply lands after B's message — no owner message
  const r = await request.post(`${OC}/session/${A.id}/message?async=1&origin=${B.id}`, {
    data: { parts: [{ type: 'text', text: 'Reply with exactly: a-2' }] },
  });
  expect(r.ok(), await r.text()).toBe(true);
  await page.waitForTimeout(3000);
  await idle(request, A.id);
  await idle(request, B.id);
  const [a, b] = [await rowOf(request, A.id), await rowOf(request, B.id)];
  expect(a!.lastAt!, 'A has a newer reply than B’s message').toBeGreaterThan(b!.userAt!);
  expect(b!.userAt!, 'B: the owner wrote there last').toBeGreaterThan(a!.userAt!);
  const ids = (await rows(request)).map((x) => x.id);
  expect(ids.indexOf(B.id), 'the brain + the app order it by the owner').toBeLessThan(ids.indexOf(A.id));
  await page.goto('/');
  await expect(page.locator('.oz-row .t', { hasText: A.name })).toBeVisible();
  let order = await titles(page);
  expect(order.indexOf(B.name), 'on the phone too').toBeLessThan(order.indexOf(A.name));
  await page.screenshot({ path: 'test-results/order-1-reply-stays.png' });
  // the owner writes in A: A goes up
  await say(request, A, 'Reply with exactly: a-3');
  await page.goto('/');
  await expect(page.locator('.oz-row .t', { hasText: A.name })).toBeVisible();
  order = await titles(page);
  expect(order.indexOf(A.name)).toBeLessThan(order.indexOf(B.name));
});

test('one status word: "working" while it works, "terminal" for a terminal\'s conversation, nothing else', async ({ page, request }) => {
  await request.post(`/api/session/${A.name}/messages`, {
    data: { text: 'Run the shell command `sleep 10`, then reply with exactly: a-4', async: true },
    headers: { 'X-Session-Pin': A.id },
  });
  await expect.poll(async () => (await rowOf(request, A.id))?.pending, { timeout: 20_000 }).toBe(true);
  await page.goto('/');
  const rowA = page.locator('.oz-row').filter({ has: page.locator('.t', { hasText: A.name }) });
  await expect(rowA.locator('.oz-st')).toHaveText('working');
  await page.screenshot({ path: 'test-results/order-2-working.png' });
  const words = await page.locator('.oz-row .oz-st').allTextContents();
  expect(words.length).toBeGreaterThan(0);
  for (const w of words) expect(['working', 'terminal'], `status word "${w}"`).toContain(w);
  // :8447 has terminal conversations continued here (the scratch ones): they say "terminal"
  expect(words).toContain('terminal');
  await idle(request, A.id);
  await page.goto('/');
  await expect(rowA.locator('.oz-st')).toHaveCount(0); // done: no word, nothing longer
});
