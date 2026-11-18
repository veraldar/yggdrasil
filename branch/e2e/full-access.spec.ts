import { devices, expect, test } from '@playwright/test';
import { slugify } from '../lib/slug';

/** Full access (owner 11-17), as the owner uses them on the stack they open (PW_BASE_URL = :8447),
 *  a Pixel 7 with taps: the session settings of a conversation continued from the terminal carries
 *  the toggle — off by default; the enrollment code typed once stays on the phone and every grant
 *  goes out signed (the box refuses anything unsigned, replayed or expired — full_access.py).
 *  Scratch ids: TS_CLAUDE (the conversation this run attaches — never the owner's), TS_FA_CODE
 *  (the box's enrollment code, read by the runner from owner.key). The grant itself runs out on
 *  its own (unit-tested: helper test_it_runs_out, brain full_access_is_one_live_grant); here the
 *  run grants 1 h and takes it back off, leaving nothing behind. */
test.use({ ...devices['Pixel 7'] });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const HOME = process.env.HOME || '';
const SCRATCH = `${HOME}/Work/cc-live-scratch`;
const CLAUDE = process.env.TS_CLAUDE || '';
const CODE = process.env.TS_FA_CODE || '';
const KEY = `claude:${CLAUDE}`;

let id = '';
let slug = '';

type Access = { enabled: boolean; enrolled: boolean; grants: Record<string, number>; max_s?: number };
const access = async (request: import('@playwright/test').APIRequestContext): Promise<Access | null> =>
  request
    .get('/api/cc-live/access')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

test.beforeAll(async ({ request }) => {
  expect(CLAUDE, 'TS_CLAUDE: the conversation this run attaches').toBeTruthy();
  expect(CODE, 'TS_FA_CODE: the box’s enrollment code (the runner reads owner.key)').toBeTruthy();
  const st = await access(request);
  expect(st?.enabled, 'the helper runs with --access-dir').toBe(true);
  expect(st?.enrolled, 'the box is enrolled (full-access-enroll.sh ran)').toBe(true);
  const a = await request.post('/api/session', {
    data: { attach: { kind: 'claude', id: CLAUDE, cwd: SCRATCH } },
  });
  const d = await a.json();
  id = d.id;
  slug = slugify(String(d.title));
  expect(id, 'the one bifrost session on the scratch conversation').toBeTruthy();
});

test.afterAll(async ({ request }) => {
  // never leave a live grant behind, even on a failed run (off needs no signature)
  if (CLAUDE)
    await request
      .post('/api/cc-live/access/grant', {
        data: { key: KEY, on: false, for_s: 0, ts: 0, mac: '' },
      })
      .catch(() => null);
});

test('the box refuses unsigned and wrong-key requests (owner-only, at the seam)', async ({ request }) => {
  const ts = Date.now();
  const unsigned = await request.post('/api/cc-live/access/grant', {
    data: { key: KEY, on: true, for_s: 3600, ts, mac: '' },
  });
  expect(unsigned.status(), 'a request inside a message, an agent curl: no signature, no grant').toBe(403);
  const wrong = await request.post('/api/cc-live/access/check', {
    data: { ts, mac: '0'.repeat(64) },
  });
  expect(wrong.status(), 'a key that is not the box’s is refused').toBe(403);
  expect((await access(request))?.grants?.[KEY], 'nothing was granted').toBeUndefined();
});

test('off by default, then the phone enrolls once and grants and takes it back', async ({ page, request }) => {
  expect((await access(request))?.grants?.[KEY], 'no grant before anyone taps').toBeUndefined();
  await page.goto(`/session/${slug}/settings`);
  const block = page.getByTestId('fa-block');
  await expect(block).toBeVisible();
  // enroll: the code typed once, checked against the box, kept on the phone
  await page.getByTestId('fa-code').fill(CODE);
  await page.getByTestId('fa-save').tap();
  const status = page.getByTestId('fa-status');
  await expect(status).toHaveText('off — its turns run in the sandbox');
  // grant 1 h: one confirm (what it opens, said plainly), then the chip signs on the phone
  await page.getByTestId('fa-1h').tap();
  await expect(page.getByTestId('fa-confirm')).toBeVisible();
  await expect(page.getByTestId('fa-confirm')).toContainText('outside the sandbox');
  await expect(page.getByTestId('fa-confirm')).toContainText('not MAIN');
  await page.getByTestId('fa-cancel').tap();
  await expect(page.getByTestId('fa-confirm')).toHaveCount(0);
  await expect(status).toHaveText('off — its turns run in the sandbox');
  await page.getByTestId('fa-1h').tap();
  await page.getByTestId('fa-yes').tap();
  await expect(status).toContainText('on until');
  const grants = (await access(request))?.grants || {};
  const until = grants[KEY];
  expect(until, 'the grant is live at the helper').toBeGreaterThan(Date.now());
  expect(until!, '1 h, not more').toBeLessThan(Date.now() + 3600 * 1000 + 60_000);
  await page.screenshot({ path: 'test-results/full-access-on.png' });
  // off: no signature needed, gone at once
  await page.getByTestId('fa-off').tap();
  await expect(status).toHaveText('off — its turns run in the sandbox');
  expect((await access(request))?.grants?.[KEY]).toBeUndefined();
});

test('a fresh phone without the code cannot flip the toggle', async ({ page }) => {
  await page.goto(`/session/${slug}/settings`);
  await expect(page.getByTestId('fa-block')).toBeVisible();
  // this context holds no stored code: the block asks for it instead of offering the chips
  await expect(page.getByTestId('fa-code')).toBeVisible();
  await expect(page.getByTestId('fa-off')).toHaveCount(0);
  await page.getByTestId('fa-code').fill('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ');
  await page.getByTestId('fa-save').tap();
  await expect(page.getByTestId('fa-block').getByRole('alert')).toContainText('did not recognize');
  await expect(page.getByTestId('fa-off')).toHaveCount(0);
});
