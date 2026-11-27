import { expect, test, type Page } from '@playwright/test';
import { OC } from './brain';

/** Read position vs. arriving messages (owner 11-24): a new message follows the bottom ONLY when
 *  the reader already sits at the bottom; scrolled up, the text they read stays exactly where it
 *  is. Runs on the twin with the mock model (`reply with exactly: X`): the session is longer than
 *  the page's 60-message window, so every arriving message also slides that window — the case the
 *  owner hits on MAIN. Messages arrive from outside the page (straight into the brain), the way a
 *  reply, a report or another device's turn lands. */
// the owner's phone: Android Chrome, 360 px wide, a finger on glass
test.use({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

const NAME = `e2e-readpos-${Date.now().toString(36)}`;
let sid = '';
const LOREM =
  'the quick brown fox jumps over the lazy dog while the reader keeps reading this line of text';

async function say(text: string) {
  const r = await fetch(`${OC}/session/${sid}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text }] }),
  });
  expect(r.ok, `brain POST message → ${r.status}`).toBe(true);
  await r.text();
}

/** one turn = the prompt (several lines: messages of different heights) + the mock's exact reply */
const turn = (tag: string, lines: number) =>
  say(`reply with exactly: ${tag}\n` + Array.from({ length: lines }, (_, k) => `${tag} ${k} ${LOREM}`).join('\n'));

/** the transcript's scroller: distance from the bottom, and where a given text sits in it */
async function view(page: Page, needle?: string) {
  return page.evaluate((needle) => {
    const sc = document.querySelector('[data-mi]')?.parentElement;
    if (!sc) return { dist: Infinity, at: null }; // not rendered yet
    const top = sc.getBoundingClientRect().top;
    let at: number | null = null;
    if (needle) {
      for (const el of Array.from(sc.querySelectorAll('[data-mi]'))) {
        if ((el.textContent || '').includes(needle)) at = el.getBoundingClientRect().top - top;
      }
    }
    return { dist: sc.scrollHeight - sc.scrollTop - sc.clientHeight, at };
  }, needle);
}

/** a finger on the transcript: touch down, drag down by `down` px (= toward older), hold still
 *  (no fling), lift. Chrome scrolls it as it would on the phone (minus its ~15 px touch slop). */
async function swipe(page: Page, down: number) {
  const cdp = await page.context().newCDPSession(page);
  for (let left = down; left > 0; left -= 450) {
    const dy = Math.min(450, left);
    const y0 = 160;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: y0 }] });
    const steps = Math.max(6, Math.round(dy / 20));
    for (let k = 1; k <= steps; k++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 180, y: y0 + (dy * k) / steps }],
      });
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(120);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(150);
  }
  await cdp.detach();
}

/** the first message whose top is inside the visible part — a unique line of it is the needle */
async function readingLine(page: Page) {
  return page.evaluate(() => {
    const sc = document.querySelector('[data-mi]')?.parentElement as HTMLElement;
    const top = sc.getBoundingClientRect().top;
    for (const el of Array.from(sc.querySelectorAll('[data-mi]'))) {
      const y = el.getBoundingClientRect().top - top;
      const m = /(R\d+) 0 /.exec(el.textContent || '');
      if (y >= 0 && m) return `${m[1]} 0 the quick`;
    }
    return '';
  });
}

test.beforeAll(async () => {
  const r = await fetch(`${OC}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: NAME }),
  });
  sid = ((await r.json()) as { id: string }).id;
  expect(sid).toBeTruthy();
  // 40 turns = 80 messages: past the page's window of 60
  for (let k = 0; k < 40; k++) await turn(`R${k}`, 1 + (k % 4));
});

test.afterAll(async () => {
  if (sid) await fetch(`${OC}/session/${sid}`, { method: 'DELETE' }).catch(() => {});
});

test('scrolled up: arriving messages never move the text being read; at the bottom: they follow', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sid}`);
  await expect(page.locator('[data-mi]').filter({ hasText: 'R39 3' })).toHaveCount(1);
  // opening a session lands at the bottom
  await expect.poll(async () => (await view(page)).dist, { timeout: 10_000 }).toBeLessThan(2);

  await page.waitForTimeout(1_500); // the opening settles

  // ── 1. the reader drags up with a finger and reads
  await swipe(page, 2400);
  await page.waitForTimeout(400);
  const needle = await readingLine(page);
  expect(needle, 'a message top in view to read').toBeTruthy();
  const before = await view(page, needle);
  expect(before.dist, 'scrolled well up').toBeGreaterThan(1000);
  await page.screenshot({ path: 'test-results/readpos-1-reading.png' });

  // ── 2. two turns land from elsewhere (4 messages: the 60-message window slides by 4)
  await turn('NEW1', 2);
  await turn('NEW2', 1);
  await expect(page.locator('[data-mi]').filter({ hasText: 'NEW2 0' })).toHaveCount(1, { timeout: 15_000 });
  // a full poll and every delayed snap later, the line read is still exactly where it was
  await page.waitForTimeout(3_000);
  const after = await view(page, needle);
  await page.screenshot({ path: 'test-results/readpos-2-after-arrivals.png' });
  expect(after.at, `"${needle}" still on the page`).not.toBeNull();
  expect(Math.abs((after.at as number) - (before.at as number)), `"${needle}" moved: ${before.at} → ${after.at}`).toBeLessThanOrEqual(2);
  expect(after.dist, 'not yanked to the bottom').toBeGreaterThan(1000);

  // ── 3. the small "new messages ↓" pill: tap → the newest message, following again
  const pill = page.getByTestId('new-below');
  await expect(pill).toBeVisible();
  await pill.tap();
  await expect.poll(async () => (await view(page)).dist, { timeout: 5_000 }).toBeLessThan(2);
  await expect(pill).toBeHidden();

  // ── 4. at the bottom: an arriving message is followed (normal chat behaviour stays)
  await turn('NEW3', 3);
  await expect(page.locator('[data-mi]').filter({ hasText: 'NEW3 0' })).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(async () => (await view(page)).dist, { timeout: 5_000 }).toBeLessThan(2);
  await expect(page.locator('[data-mi]').last()).toBeInViewport();
  await page.screenshot({ path: 'test-results/readpos-3-followed.png' });
  await expect(pill).toBeHidden();
});

test('a reader a little above the bottom (inside the threshold) still follows', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sid}`);
  await expect.poll(async () => (await view(page)).dist, { timeout: 10_000 }).toBeLessThan(2);
  // the opening settles first (its own late snaps while fonts and layout land, ~300 ms)
  await page.waitForTimeout(1_500);
  await swipe(page, 60); // ≈ 45 px after the touch slop
  await page.waitForTimeout(400);
  const d = (await view(page)).dist;
  expect(d).toBeGreaterThan(10);
  expect(d).toBeLessThan(80);
  // nothing new: two polls later the reader is still where they put themselves (no idle yank)
  await page.waitForTimeout(5_500);
  expect(Math.abs((await view(page)).dist - d), 'an idle poll moved the reader').toBeLessThanOrEqual(2);
  // something new: inside the threshold counts as the bottom — it follows
  await turn('NEW4', 1);
  await expect(page.locator('[data-mi]').filter({ hasText: 'NEW4 0' })).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(async () => (await view(page)).dist, { timeout: 5_000 }).toBeLessThan(2);
});
