import { type Page, expect, test } from '@playwright/test';
import { join } from 'path';

/** The artifacts key in MAIN's session header (owner 11-26), 360 px, on sim/roots-page-e2e.sh:
 *  visible, the same badge as home's, tap → the artifacts screen, back → MAIN; and no overflow with
 *  the voice-test chip on. SHOT_MODE=before|after names the screenshot. */
const TOKEN = process.env.PW_DEVICE_TOKEN || '';
const HOME = process.env.PW_HOME_BRAIN || '';
const OUT = process.env.PW_SHOTS || '';
const MODE = process.env.SHOT_MODE || 'after';
test.skip(!TOKEN || !HOME, 'needs the roots-page rig');

const now = Date.now();
const ARTS = [1, 2, 3].map((i) => ({ name: `a${i}.html`, mtime: now - i * 1000, size: 10, ext: 'html', type: 'html' }));

async function setup(page: Page, voiceTest = false) {
  const base = new URL(test.info().project.use.baseURL || 'http://127.0.0.1:18620');
  await page.context().addCookies([{ name: 'bifrost_device', value: TOKEN, domain: base.hostname, path: '/', httpOnly: true }]);
  await page.addInitScript((vt) => {
    localStorage.setItem('oz-artifact-init', '1');
    localStorage.setItem('oz-home-root', 'home');
    if (vt) localStorage.setItem('bifrost-voice-test', '1');
  }, voiceTest);
  await page.route('**/api/artifact', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: ARTS }) : r.fallback()));
}
const main = async (page: Page) => {
  await page.goto('/session/main');
  await expect(page.locator('header.oz-head')).toBeVisible({ timeout: 20_000 });
};
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => {
    const h = document.querySelector('header.oz-head') as HTMLElement;
    return h.scrollWidth <= h.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
  })).toBe(true);

test('MAIN header: artifacts key, badge = home, opens artifacts, back → MAIN, no overflow', async ({ page, request }) => {
  test.setTimeout(120_000);
  const list = (await (await request.get(`${HOME}/session`)).json()) as { title: string }[];
  if (!list.some((s) => s.title === '[MAIN]')) await request.post(`${HOME}/session`, { data: { title: '[MAIN]' } });
  await setup(page);
  await page.goto('/home');
  await expect(page.getByTestId('artifact-badge')).toHaveText('3', { timeout: 20_000 });
  await main(page);
  if (MODE === 'before') {
    await expect(page.getByTestId('artifacts-key')).toHaveCount(0);
    if (OUT) await page.screenshot({ path: join(OUT, 'before-5-main-header.png') });
    return;
  }
  const key = page.getByTestId('artifacts-key');
  await expect(key).toBeVisible();
  await expect(page.getByTestId('artifact-badge')).toHaveText('3');
  await noOverflow(page);
  if (OUT) await page.screenshot({ path: join(OUT, 'after-5-main-header.png') });
  await key.tap();
  await page.waitForURL(/\/artifacts/, { timeout: 15_000 });
  await expect(page.getByTestId('artifacts-view')).toBeVisible();
  await page.getByTestId('artifacts-back').tap();
  await page.waitForURL(/\/session\/main/, { timeout: 15_000 });
  await expect(page.getByTestId('artifacts-key')).toBeVisible();
  // another session has none
  const other = `x-${Date.now() % 100000}`;
  await request.post(`${HOME}/session`, { data: { title: other } });
  await page.goto(`/session/${other}`);
  await expect(page.locator('header.oz-head')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('artifacts-key')).toHaveCount(0);
});

test('MAIN header with the voice-test chip on: still one row, no overflow', async ({ page }) => {
  await setup(page, true);
  await main(page);
  if (MODE === 'before') return;
  await expect(page.getByTestId('voice-test-chip')).toBeVisible();
  await expect(page.getByTestId('artifacts-key')).toBeVisible();
  await noOverflow(page);
  if (OUT) await page.screenshot({ path: join(OUT, 'after-6-main-header-voicetest.png') });
});
