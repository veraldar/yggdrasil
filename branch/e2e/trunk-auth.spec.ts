import { type Page, devices, expect, test } from '@playwright/test';

/** v1 · BIFROST_AUTH=trunk at the door, in a real browser (spec §5.3/§5.4, contract C3; §13 B10, B11,
 *  D15). Runs against the twin as a v1 root (TWIN_AUTH=trunk sim/acceptance/twin-up.sh) through its
 *  stand-in trunk front: PW_BASE_URL=http://127.0.0.1:19050. The front's auto sign-in is off for this
 *  spec (`x-trunk-seed-anon`): only the cookies this browser holds count, as behind the real trunk.
 *  Skips itself anywhere else (no /t/state). */
const ANON = { 'x-trunk-seed-anon': '1' };
test.use({
  ...devices['Pixel 7'],
  serviceWorkers: 'block',
  extraHTTPHeaders: ANON,
  storageState: {
    cookies: [],
    origins: [
      {
        origin: new URL(process.env.PW_BASE_URL || 'http://127.0.0.1:19050').origin,
        localStorage: [
          { name: 'bifrost-door', value: 'v2' },
          { name: 'bifrost-first-turn', value: '1' },
        ],
      },
    ],
  },
});

test.beforeAll(async ({ request }) => {
  const r = await request.get('/t/state').catch(() => null);
  test.skip(!r?.ok(), 'not behind a (stand-in) v1 trunk: run on the twin with TWIN_AUTH=trunk');
});

const did = (tag: string) => `dev_e2e_${tag}_${Date.now().toString(36)}`;
const signIn = (page: Page, d: string, lifeS = 900) =>
  page.goto(`/t/test/sign-in?did=${d}&life_s=${lifeS}&next=/`);
const home = (page: Page) => expect(page.getByRole('button', { name: 'new session', exact: true })).toBeVisible();

test('a stranger gets no app: every page is a 302 to /login, every /api a C3 401', async ({ page, request }) => {
  for (const p of ['/', '/session/main', '/settings', '/agents']) {
    const r = await request.get(p, { maxRedirects: 0 });
    expect(r.status(), p).toBe(302);
    expect(r.headers().location, p).toBe('/login');
    // not one byte of the app (Next writes the bare target as the redirect's body)
    const body = await r.text();
    expect(body.length, p).toBeLessThan(64);
    expect(body, p).not.toMatch(/<html|<script|_next/i);
  }
  const api = await request.get('/api/session');
  expect(api.status()).toBe(401);
  expect(await api.json()).toEqual({ why: 'missing', reauth: 'login' });
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('[data-trunk-login]')).toBeVisible();
});

test('signed in on the trunk → the app, as today (the sessions list from the root)', async ({ page, context }) => {
  await signIn(page, did('in'));
  await expect(page).toHaveURL(/\/$/);
  await home(page);
  const jar = await context.cookies();
  const names = jar.map((c) => `${c.name}@${c.path}`).sort();
  // bifrost_mode (lib/gate.ts TRUNK_MODE_COOKIE): the page's script-readable trunk-mode marker for the P11
  // boot hold in lib/pinned.ts — the value `trunk` and nothing else; the two credentials stay HttpOnly
  expect(names).toEqual(['bifrost_device@/', 'bifrost_mode@/', 'bifrost_refresh@/t/auth']);
  const mode = jar.find((c) => c.name === 'bifrost_mode')!;
  expect([mode.value, mode.httpOnly]).toEqual(['trunk', false]);
  expect(jar.filter((c) => c.name !== 'bifrost_mode').every((c) => c.httpOnly)).toBe(true);
});

test('B10: an expired access token → a single-flight POST /t/auth/refresh, then the calls go through', async ({ page }) => {
  // the page polls on its own: count over the whole window, from before the token runs out
  const refreshes: number[] = [];
  const denied: string[] = [];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/t/auth/refresh') refreshes.push(r.status());
    if (u.pathname.startsWith('/api/') && r.status() === 401) denied.push(u.pathname);
  });
  await signIn(page, did('exp'), 2);
  await home(page);
  await page.waitForTimeout(3000); // the 2 s token is now expired
  // several calls at once: they share one refresh
  const statuses = await page.evaluate(() =>
    Promise.all(['/api/session', '/api/session', '/api/build'].map((u) => fetch(u).then((r) => r.status)))
  );
  expect(statuses).toEqual([200, 200, 200]);
  expect(denied.length).toBeGreaterThan(0); // the 401s happened, and the refresh answered them
  expect(refreshes.length).toBeGreaterThanOrEqual(1);
  expect(refreshes.every((s) => s === 200)).toBeTruthy();
  expect(refreshes.length).toBeLessThan(denied.length + 1);
  console.log(`expired: ${denied.length} 401s answered by ${refreshes.length} refresh(es)`);
  await page.reload();
  await home(page);
  expect(new URL(page.url()).pathname).toBe('/');
});

test('a roam (the phone changes network): 401 region → refresh from the new address → works', async ({ page }) => {
  await signIn(page, did('roam'));
  await home(page);
  const seen: string[] = [];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/') || u.pathname === '/t/auth/refresh') seen.push(`${u.pathname} ${r.status()}`);
  });
  await page.setExtraHTTPHeaders({ ...ANON, 'x-trunk-seed-ip': '198.51.100.4' });
  expect(await page.evaluate(() => fetch('/api/session').then((r) => r.status))).toBe(200);
  expect(seen).toContain('/t/auth/refresh 200');
  expect(seen.some((x) => / 401$/.test(x))).toBeTruthy();
  expect(seen.filter((x) => x.startsWith('/t/auth/refresh')).every((x) => x.endsWith(' 200'))).toBeTruthy();
});

test('revoked on the trunk → the next call is 401 login → /login (no refresh for a revoked device)', async ({ page, request }) => {
  const d = did('rev');
  await signIn(page, d);
  await home(page);
  const cookie = (await page.context().cookies()).find((c) => c.name === 'bifrost_device')!.value;
  const refreshes: string[] = [];
  page.on('request', (q) => new URL(q.url()).pathname === '/t/auth/refresh' && refreshes.push(q.method()));
  const r = await request.post('/t/test/revoke', { data: { did: d } });
  expect(r.ok()).toBeTruthy();
  try {
    await page.waitForTimeout(300); // the app re-reads trunk-state.json on its new stamp (≤ 100 ms)
    const api = await request.get('/api/session', { headers: { cookie: `bifrost_device=${cookie}` } });
    expect(api.status()).toBe(401);
    expect(await api.json()).toEqual({ why: 'revoked', reauth: 'login' });
    // in the page: its next call (ours, or its own poll first) sends it to the trunk's sign-in
    await page.evaluate(() => void fetch('/api/session').catch(() => {})).catch(() => {});
    await expect(page).toHaveURL(/\/login$/);
    expect(refreshes).toEqual([]);
    // and its pages: straight to /login
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    await request.post('/t/test/unrevoke', { data: { did: d } });
  }
});

test('D15: what moved to the trunk is not served by the root app', async ({ page, request }) => {
  await signIn(page, did('moved'));
  await home(page);
  for (const p of ['/pair', '/devices', '/join']) {
    const r = await page.goto(p);
    expect(r?.status(), p).toBe(404);
  }
  const cookie = (await page.context().cookies()).find((c) => c.name === 'bifrost_device')!.value;
  for (const p of ['/api/pair/claim', '/api/pair/code', '/api/pair/devices', '/api/roots/join']) {
    const r = await request.post(p, { headers: { cookie: `bifrost_device=${cookie}` }, data: {} });
    expect(r.status(), p).toBe(404);
  }
});
