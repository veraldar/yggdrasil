import { readFileSync } from 'fs';
import { join } from 'path';
import { devices, expect, test } from '@playwright/test';

/**
 * G2.1 · v1 bridge (port of e2e/bridge.spec.ts):
 * Verifies the v1 bridge's /identity + trunk-state.json + directory pin delivery via /t/me/roots
 * and fail-closed pin-change alarm when a root's DTLS fingerprint changes.
 */
const STATE = process.env.PW_V1_STATE || '';
const BASE = process.env.PW_BASE_URL || '';
const BRIDGE_URL = process.env.PW_BRIDGE_URL || '';
const HOME_ROOT_ID = process.env.PW_HOME_ROOT_ID || '';

test.skip(!STATE || !BASE || !BRIDGE_URL || !HOME_ROOT_ID, 'needs scripts/v1-ladder.sh');
test.use({ ...devices['Pixel 7'], serviceWorkers: 'block' });

const admin = () => JSON.parse(readFileSync(join(STATE, 'admin.json'), 'utf8'));

test('v1 bridge: trunk-state.json up, /t/me/roots names the door root, pin-change alarm fails closed', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(90_000);
  const a = admin();
  const u = new URL(BASE);

  // bridge identity is live
  const idRes = await request.get(`${BRIDGE_URL}/identity`);
  expect(idRes.status()).toBe(200);
  const idJson = (await idRes.json()) as { fingerprint: string };
  expect(idJson.fingerprint).toMatch(/^sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

  // trunk-state.json is written by the bridge in [trunk] mode, 0600, link up
  const st = JSON.parse(readFileSync(join(STATE, 'home', 'trunk-state.json'), 'utf8'));
  expect(st.link.state).toBe('up');
  expect(st.root.id).toBe(HOME_ROOT_ID);
  expect(st.keys.length).toBeGreaterThanOrEqual(1);

  // /t/me/roots lists the home door root online
  const rootsRes = await request.get('/t/me/roots', {
    headers: { cookie: `bifrost_device=${a.cookies.bifrost_device}` },
  });
  expect(rootsRes.status()).toBe(200);
  const roots = (await rootsRes.json()) as Array<{ id: string; online: boolean; door: boolean }>;
  const home = roots.find((r) => r.id === HOME_ROOT_ID);
  expect(home?.online).toBe(true);
  expect(home?.door).toBe(true);

  // pin-change alarm: remember FP A for home, then serve FP B -> refused + alarm
  const FP_A = 'sha-256 ' + 'AA:'.repeat(31) + 'AA';
  const FP_B = 'sha-256 ' + 'BB:'.repeat(31) + 'BB';
  await context.addCookies([
    { name: 'bifrost_device', value: a.cookies.bifrost_device, domain: u.hostname, path: '/', httpOnly: true },
  ]);
  await page.addInitScript(
    ([rid, fp]) => {
      localStorage.setItem('bifrost-door', 'v2');
      localStorage.setItem('bifrost-first-turn', '1');
      localStorage.setItem(
        'bifrost.trunk.pins',
        JSON.stringify({ [rid]: { fp, rootId: rid, rootName: 'home', savedAt: '2026-11-25T00:00:00Z', door: true } })
      );
    },
    [HOME_ROOT_ID, FP_A]
  );
  await page.route('**/t/me/roots', (r) =>
    r.fulfill({
      json: [{ id: HOME_ROOT_ID, name: 'home', online: true, has_app: true, has_voice: false, dtls_fp: FP_B, door: true }],
    })
  );
  await page.goto('/');
  const badge = page.getByTestId('pin-state');
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await expect(badge).toHaveAttribute('data-state', 'refused', { timeout: 15_000 });
  await expect(badge).toContainText("this computer's key changed");
});
