import { type Locator, type Page, devices, expect, test } from '@playwright/test';

/** v1 · the app's trunk-only pieces (spec §5.5; §13 C7, C8, D6, D16), in both door modes on the twin:
 *    TWIN_AUTH=trunk  → PW_BASE_URL = the stand-in trunk front (:19050): the pieces are there
 *    TWIN_AUTH=tailnet → PW_BASE_URL = :8250: none of them shows (W2 — the tailnet door is untouched)
 *  The trunk's answers the roots sheet reads (/t/roots/pending, /t/me/roots) are stubbed per test with
 *  page.route; the writes (DELETE /t/roots/:id, POST …/refuse) go to the front for real, with the
 *  browser's own cookie (same origin). */
test.use({ ...devices['Pixel 7'], serviceWorkers: 'block' });

let TRUNK = false;
test.beforeAll(async ({ request }) => {
  const r = await request.get('/t/state').catch(() => null);
  TRUNK = !!r?.ok() && /json/.test(r.headers()['content-type'] || '');
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

/** the door said its mode: /api/build answered (FreshReload publishes it to lib/auth-mode.ts) */
const settled = (page: Page) => page.waitForResponse((r) => new URL(r.url()).pathname === '/api/build');

async function openSheet(page: Page) {
  await expect(async () => {
    await page.getByRole('button', { name: 'roots', exact: true }).tap();
    await expect(page.getByTestId('roots-sheet')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

async function hold(page: Page, el: Locator) {
  const b = await el.boundingBox();
  if (!b) throw new Error('nothing to hold');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
}

test('/settings: "account & devices ›" → the trunk’s /account behind a trunk, absent on the tailnet door', async ({ page }) => {
  const build = settled(page);
  await page.goto('/settings');
  const b = await (await build).json();
  expect(b.auth === 'trunk').toBe(TRUNK);
  await expect(page.getByTestId('agents-link')).toBeVisible();
  if (TRUNK) {
    const link = page.getByTestId('account-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/account');
    await expect(page.locator('li', { has: link })).toContainText('account & devices');
  } else {
    await page.waitForTimeout(500);
    await expect(page.getByTestId('account-link')).toHaveCount(0);
    expect(b).not.toHaveProperty('auth');
  }
});

test('D16: the manifest carries real home-screen icons, and iOS gets an apple-touch-icon', async ({ page, request }) => {
  const m = await (await request.get('/manifest.json')).json();
  const sizes = (m.icons as Array<{ src: string; sizes: string; type: string; purpose?: string }>).map(
    (i) => `${i.sizes}/${i.purpose}`
  );
  expect(sizes).toEqual(expect.arrayContaining(['192x192/any', '512x512/any', '512x512/maskable']));
  for (const i of m.icons) {
    const r = await request.get(i.src);
    expect(r.status(), i.src).toBe(200);
    expect(r.headers()['content-type'], i.src).toContain(i.type);
  }
  await page.goto('/');
  const apple = page.locator('link[rel="apple-touch-icon"]');
  await expect(apple).toHaveCount(1);
  const href = (await apple.getAttribute('href'))!;
  const r = await request.get(href);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('image/png');
});

test('C8: computers waiting to join come from the trunk; Add opens the trunk’s card, Refuse goes to the trunk', async ({
  page,
}) => {
  test.skip(!TRUNK, 'behind a v1 trunk only');
  const exp = Date.now() + 4 * 60_000;
  await page.route('**/t/roots/pending', (r) =>
    r.fulfill({
      json: [
        { id: 'enr_e2eA', hostname: 'debian-box', os: 'linux', wg_fp: 'AB12CD34', expires_at: exp },
        { id: 'enr_e2eB', name: 'mac-studio', os: 'macos', fingerprint: 'EF56', expires_at: new Date(exp).toISOString() },
      ],
    })
  );
  await page.goto('/');
  await openSheet(page);
  const rows = page.getByTestId('join-row');
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  const a = page.locator('[data-testid="join-row"][data-req="enr_e2eA"]');
  await expect(a).toContainText('debian-box');
  await expect(a).toContainText('key AB12CD34');
  await expect(a.getByTestId('join-left')).toHaveText(/^[34]:\d\d$/);
  // refuse: the trunk answers (the front checks the cookie and the admin role)
  const refused = page.waitForResponse((r) => r.url().endsWith('/t/roots/enroll/enr_e2eB/refuse'));
  await page.locator('[data-testid="join-row"][data-req="enr_e2eB"]').getByTestId('join-refuse').tap();
  expect((await refused).status()).toBe(200);
  // add: the trunk's own approval card (step-up there), same origin
  await a.getByTestId('join-add').tap();
  await expect(page).toHaveURL(/\/auth\/root\?e=enr_e2eA$/);
});

test('C7: hold-to-remove revokes the root on the trunk (DELETE /t/roots/<trunk id>, by name)', async ({ page }) => {
  test.skip(!TRUNK, 'behind a v1 trunk only');
  // the tree with a second computer (the twin has one root): /api/roots answered as the brain would
  await page.route('**/api/roots', async (r) => {
    const real = await (await r.fetch()).json();
    await r.fulfill({
      json: { ...real, roots: [{ id: 'lab', name: 'lab', reachable: true, os: 'linux', running: 0 }] },
    });
  });
  await page.route('**/t/me/roots', (r) =>
    r.fulfill({
      json: [
        { id: 'rt_home', name: 'home', online: true, has_app: true, has_voice: true, dtls_fp: '', door: true },
        { id: 'rt_lab01', name: 'lab', online: true, has_app: false, has_voice: false, dtls_fp: '', door: false },
      ],
    })
  );
  await page.goto('/');
  await openSheet(page);
  const lab = page.locator('[data-testid="root-row"][data-root="lab"]');
  await expect(lab).toBeVisible({ timeout: 15_000 });
  await hold(page, lab);
  await expect(page.getByTestId('root-confirm')).toContainText('Remove lab?');
  const del = page.waitForResponse((r) => r.request().method() === 'DELETE');
  await page.getByTestId('root-remove').tap();
  const d = await del;
  expect(new URL(d.url()).pathname).toBe('/t/roots/rt_lab01');
  expect(d.status()).toBe(200);
  await expect(page.getByTestId('root-confirm')).toHaveCount(0);
});

