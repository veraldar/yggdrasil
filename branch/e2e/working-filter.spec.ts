import { mkdirSync } from 'fs';
import { type Page, devices, expect, test } from '@playwright/test';

/** The band chip "N working" (11-23): it taps to a working-only list — every working
 *  session and the ancestors it hangs from — and taps again to clear. The count counts
 *  what the rows call working (a run in flight, or the brain's card says working), so
 *  a card-held "working" on a run this proxy never saw counts too.
 *  The status matrix (pending/card done·blocked·failed) is stubbed (page.route —
 *  serviceWorkers 'block', the app's SW would relay /api/* and miss the mock, as in
 *  roles-badges); the LIVE path — a real run's pending on the twin — is the last test.
 *  Twin only (e2e/GUARD.md): PW_BASE_URL = an app whose brain is E2E_OC_URL. */
test.use({
  ...devices['Pixel 7'],
  viewport: { width: 360, height: 780 }, // the owner's phone shape
  serviceWorkers: 'block',
});
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.E2E_SHOTS || '/tmp/working-filter-shots';
mkdirSync(SHOTS, { recursive: true });
const tag = Date.now().toString(36).slice(-5);

type Sess = {
  id: string;
  title: string;
  parentId?: string | null;
  preview?: string;
  pending?: boolean;
  archived?: boolean;
  card?: { status?: string } | null;
};

/** the fixture: one working, one idle (done), a parent whose CHILD works
 *  (folded branch), one failed, one blocked — six rows, two of them working */
const rows = (t: string): Sess[] => [
  { id: `w-${t}`, title: `e2e-wf-work-${t}`, pending: true },
  { id: `i-${t}`, title: `e2e-wf-idle-${t}`, card: { status: 'done' } },
  { id: `p-${t}`, title: `e2e-wf-parent-${t}`, card: { status: 'done' } },
  { id: `c-${t}`, title: `e2e-wf-kid-${t}`, parentId: `p-${t}`, card: { status: 'working' } },
  { id: `f-${t}`, title: `e2e-wf-failed-${t}`, card: { status: 'failed' } },
  { id: `b-${t}`, title: `e2e-wf-blocked-${t}`, card: { status: 'blocked' } },
];
const allDone = (t: string) =>
  rows(t).map((s) => ({ ...s, pending: false, card: { status: 'done' as const } }));

/** stub the list the app polls; later calls replace the answer */
const serve = (page: Page, list: Sess[]) =>
  page.route('**/api/session', (r) => r.fulfill({ json: list }));

const chip = (page: Page) => page.getByTestId('working-filter');
const row = (page: Page, title: string) =>
  page.locator('.oz-row').filter({ has: page.locator('.t', { hasText: title }) });

test('the chip counts what the rows call working; tapping filters to the working + their ancestors', async ({
  page,
}) => {
  const t = tag;
  await serve(page, rows(t));
  await page.goto('/');
  await expect(chip(page)).toHaveText('2 working');
  await expect(chip(page)).toHaveAttribute('aria-pressed', 'false');

  await chip(page).click();
  await expect(chip(page)).toHaveAttribute('aria-pressed', 'true');
  // the working stay — the top one, and the folded branch through its parent
  await expect(row(page, `e2e-wf-work-${t}`)).toBeVisible();
  await expect(row(page, `e2e-wf-parent-${t}`)).toBeVisible();
  await expect(row(page, `e2e-wf-kid-${t}`)).toBeVisible();
  // the rest go
  await expect(row(page, `e2e-wf-idle-${t}`)).toHaveCount(0);
  await expect(row(page, `e2e-wf-failed-${t}`)).toHaveCount(0);
  await expect(row(page, `e2e-wf-blocked-${t}`)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/filtered-360.png` });
  expect(
    await chip(page).evaluate((el) => el.getBoundingClientRect().right),
    'the chip sits inside the 360 px screen'
  ).toBeLessThanOrEqual(360);

  // again clears
  await chip(page).click();
  await expect(chip(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, `e2e-wf-idle-${t}`)).toBeVisible();
  await expect(row(page, `e2e-wf-failed-${t}`)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/unfiltered-360.png` });
});

test('closed sessions keep their key under the filter — the filter does not swallow them', async ({
  page,
}) => {
  const t = tag;
  const list = rows(t).map((s) => (s.title.includes('parent') ? { ...s, archived: true } : s));
  await serve(page, list);
  await page.goto('/');
  // unfiltered: the closed parent sits behind the top key (closed handling untouched)
  await expect(page.locator('.oz-closed').first()).toBeVisible();
  await chip(page).click();
  await expect(chip(page)).toHaveAttribute('aria-pressed', 'true');
  // the working kid's ancestor is closed — still behind the key, not dropped, not leaked
  await expect(page.locator('.oz-closed').first()).toBeVisible();
  await expect(row(page, `e2e-wf-kid-${t}`)).toHaveCount(0);
  await page.locator('.oz-closed').first().click(); // open the key
  await expect(row(page, `e2e-wf-parent-${t}`)).toBeVisible();
  await expect(row(page, `e2e-wf-kid-${t}`)).toBeVisible();
});

test('the filter lifts itself when the work ends — never a zero list', async ({ page }) => {
  const t = tag;
  await serve(page, rows(t));
  await page.goto('/');
  await chip(page).click();
  await expect(row(page, `e2e-wf-idle-${t}`)).toHaveCount(0);
  // the runs finish; the poll brings the settled list (no remount — the state
  // must clear ITSELF, not by navigation)
  await serve(page, allDone(t));
  await page.locator('button[aria-label="refresh sessions"]').click();
  await expect(chip(page)).toHaveText('all quiet');
  await expect(chip(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, `e2e-wf-idle-${t}`)).toBeVisible();
});

test('the idle chip does nothing on tap — all quiet is not a filter', async ({ page }) => {
  const t = tag;
  await serve(page, allDone(t));
  await page.goto('/');
  await expect(chip(page)).toHaveText('all quiet');
  await chip(page).click();
  await expect(chip(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, `e2e-wf-work-${t}`)).toBeVisible(); // nothing was filtered away
});

/** the live path on the twin: a REAL run's pending — the chip counts it, the filter
 *  keeps it, and when the turn ends the chip reads "all quiet" again */
test('a real run: counted, filtered, and quiet again when it ends', async ({ page, request }) => {
  test.setTimeout(240_000);
  const A = { name: `e2e-wf-live-${tag}`, id: '' };
  const B = { name: `e2e-wf-live-idle-${tag}`, id: '' };
  for (const s of [A, B]) {
    s.id = (await (await request.post('/api/session', { data: { name: s.name } })).json()).id;
    expect(s.id).toBeTruthy();
  }
  try {
    await request.post(`/api/session/${A.name}/messages`, {
      data: {
        text: 'Run the shell command `sleep 15`, then reply with exactly: wf-done',
        async: true,
      },
      headers: { 'X-Session-Pin': A.id },
    });
    await expect
      .poll(async () => {
        const list = (await (await request.get('/api/session')).json()) as Sess[];
        return list.find((x) => x.id === A.id)?.pending;
      })
      .toBe(true);
    // the app's list is cached 60 s — a created+deleted session starts it fresh (list-order's trick)
    const bust = await request.post('/api/session', { data: { name: `e2e-wf-bust-${tag}` } });
    const bid = (await bust.json()).id;
    if (bid) await request.delete(`/api/session/${bid}`);

    await page.goto('/');
    await expect(chip(page)).toHaveText(/^[1-9]\d* working$/);
    await chip(page).click();
    await expect(chip(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(row(page, A.name)).toBeVisible();
    await expect(row(page, B.name)).toHaveCount(0); // the idle one goes
    await chip(page).click();
    await expect(row(page, B.name)).toBeVisible();

    // the turn ends: the chip falls back to "all quiet", the whole list is back
    await expect
      .poll(
        async () => {
          const list = (await (await request.get('/api/session')).json()) as Sess[];
          return list.find((x) => x.id === A.id)?.pending;
        },
        { timeout: 180_000, intervals: [3000] }
      )
      .toBe(false);
    const bust2 = await request.post('/api/session', { data: { name: `e2e-wf-bust2-${tag}` } });
    const bid2 = (await bust2.json()).id;
    if (bid2) await request.delete(`/api/session/${bid2}`);
    await page.goto('/');
    await expect(chip(page)).toHaveText('all quiet');
    await expect(row(page, A.name)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/quiet-360.png` });
  } finally {
    for (const s of [A, B]) if (s.id) await request.delete(`/api/session/${s.id}`);
  }
});
