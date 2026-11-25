import { devices, expect, test } from '@playwright/test';

/**
 * v1 · directory pins (C6), pin-change alarm (D3), and B25 first-contact fail-closed (X11/P11).
 *   TWIN_AUTH=trunk  → PW_BASE_URL = :19050 (all 3 trunk tests run)
 *   TWIN_AUTH=tailnet → PW_BASE_URL = :8250 (verifies tailnet mode is untouched)
 */
test.use({ ...devices['Pixel 7'], serviceWorkers: 'block' });

const FP_A = 'sha-256 AA:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';
const FP_B = 'sha-256 BB:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:11';
const ALARM = "this computer's key changed — the channel is blocked";

let TRUNK = false;
test.beforeAll(async ({ request }) => {
  const r = await request.get('/t/state').catch(() => null);
  TRUNK = !!r?.ok() && /json/.test(r.headers()['content-type'] || '');
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('B25: directory pin from /t/me/roots is remembered; first-contact /offer failure → reconnecting (never fallback)', async ({
  page,
}) => {
  test.skip(!TRUNK, 'behind a v1 trunk only');
  let offers = 0;
  await page.route('**/t/me/roots', (r) =>
    r.fulfill({
      json: [
        { id: 'rt_home', name: 'home', online: true, has_app: true, has_voice: true, dtls_fp: FP_A, door: true },
      ],
    })
  );
  await page.route('**/offer', (r) => {
    offers += 1;
    return r.fulfill({ status: 502, contentType: 'text/plain', body: 'bridge offline' });
  });
  await page.goto('/');
  const badge = page.getByTestId('pin-state');
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await expect(badge).toHaveAttribute('data-state', 'reconnecting', { timeout: 15_000 });
  await expect(badge).toContainText('reconnecting — nothing sent meanwhile');
  expect(offers).toBeGreaterThanOrEqual(1);
  // remembered in bifrost.trunk.pin without touching v0.9 bifrost.pin
  const stored = await page.evaluate(() => ({
    trunk: JSON.parse(localStorage.getItem('bifrost.trunk.pin') || 'null'),
    legacy: localStorage.getItem('bifrost.pin'),
  }));
  expect(stored.trunk?.fp).toBe(FP_A);
  expect(stored.legacy).toBeNull();
  // tunnelled /api/* fetch is blocked with 503 reconnecting, never falls back to trunk TLS
  const probe = await page.evaluate(async () => {
    const r = await fetch('/api/ping');
    return { status: r.status, via: r.headers.get('x-bifrost-via') };
  });
  expect(probe).toEqual({ status: 503, via: 'reconnecting' });
});

test('D3: a changed door pin in /t/me/roots → refused + alarm, never falls back, never dials /offer', async ({
  page,
}) => {
  test.skip(!TRUNK, 'behind a v1 trunk only');
  let offers = 0;
  await page.addInitScript((fp) => {
    localStorage.setItem('bifrost.trunk.pin', JSON.stringify({ fp, rootId: 'rt_home', rootName: 'home', savedAt: '2026-11-25T00:00:00Z' }));
  }, FP_A);
  await page.route('**/t/me/roots', (r) =>
    r.fulfill({
      json: [
        { id: 'rt_home', name: 'home', online: true, has_app: true, has_voice: true, dtls_fp: FP_B, door: true },
      ],
    })
  );
  await page.route('**/offer', (r) => {
    offers += 1;
    return r.fulfill({ status: 502, body: 'should not be called' });
  });
  await page.goto('/');
  const badge = page.getByTestId('pin-state');
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await expect(badge).toHaveAttribute('data-state', 'refused', { timeout: 15_000 });
  await expect(badge).toHaveAttribute('role', 'alert');
  await expect(badge).toContainText(ALARM);
  expect(offers).toBe(0);
  // remembered pin is NOT overwritten by the attacker's new key
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('bifrost.trunk.pin') || 'null')?.fp);
  expect(kept).toBe(FP_A);
  // tunnelled /api/* fetch is refused (503), never falls back
  const probe = await page.evaluate(async () => {
    const r = await fetch('/api/ping');
    return { status: r.status, via: r.headers.get('x-bifrost-via') };
  });
  expect(probe).toEqual({ status: 503, via: 'refused' });
});

test('W2: tailnet mode ignores directory pins and stays off', async ({ page }) => {
  test.skip(TRUNK, 'tailnet mode only');
  let meRootsCalled = false;
  await page.route('**/t/me/roots', (r) => {
    meRootsCalled = true;
    return r.fulfill({ json: [] });
  });
  await page.goto('/');
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('pin-state')).toBeHidden();
  expect(meRootsCalled).toBe(false);
});
