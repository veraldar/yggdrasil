import { type Page, expect, test } from '@playwright/test';
import { join } from 'path';
import { homePathOf } from '../lib/home-path-of';

/**
 * THE ROOTS PAGE (owner 11-26), at 360 px, on sim/roots-page-e2e.sh (never a live brain):
 *   /            first contact → the tree door (S8); a device that walked it → /roots/
 *   /roots/      plain white, no root's theme; each row in its own root's palette (computed colours)
 *   /<home>      the home screen (the rig's home root is "home"); /roots/<name> unchanged
 *   back         /roots/<name> → back → /roots/ ; /<home> → back → /roots/
 *   manifest     its start URL lands on the roots list
 * The tree is mocked at /api/roots: the app's world is utopia; debian-box picked terminus.
 */
const TOKEN = process.env.PW_DEVICE_TOKEN || '';
const SHOTS = process.env.PW_SHOTS || '';
const LIVE = /:(4096|4100|4101|4191|4310|4501|4502|4503|8080|8090|8101|8191|8443|8447)\b/;
test.skip(!TOKEN || LIVE.test(process.env.PW_BASE_URL || ''), 'needs its own rig (sim/roots-page-e2e.sh)');

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};
const TREE = {
  home: { name: 'home', os: 'linux', running: 3, theme: 'aether', theme_rev: 0, main: null },
  roots: [
    { id: 'mac-studio', name: 'mac-studio', os: 'macos', reachable: false, seen: null, theme: 'aether', theme_rev: 0 },
    { id: 'omarchy-lab', name: 'omarchy-lab', os: 'linux', reachable: true, behind: true, theme: 'aether', theme_rev: 0 },
    { id: 'debian-box', name: 'debian-box', os: 'linux', reachable: true, behind: true, theme: 'terminus', theme_rev: 1 },
  ],
  joins: [],
};

async function setup(page: Page, door: boolean) {
  const base = new URL(test.info().project.use.baseURL || 'http://127.0.0.1:18620');
  await page.context().addCookies([
    { name: 'bifrost_device', value: TOKEN, domain: base.hostname, path: '/', httpOnly: true },
  ]);
  await page.addInitScript(
    ([d]) => {
      if (!d) localStorage.removeItem('bifrost-door');
      localStorage.setItem('theme', 'utopia');
    },
    [door]
  );
  await page.route('**/api/roots', (r) => r.fulfill({ json: TREE }));
  await page.route('**/api/roots/*/sessions', (r) =>
    r.fulfill({ json: { root: 'x', reachable: true, main: null, sessions: [] } })
  );
  await page.route('**/api/roots/*/artifacts', (r) =>
    r.fulfill({ json: { reachable: true, artifacts: [] } })
  );
}
const shot = async (page: Page, n: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `roots-page-${n}.png`) });
};

test('S8: a fresh device on / still gets the tree door — not the roots list, not MAIN', async ({ page }) => {
  await setup(page, false);
  await page.goto('/');
  await expect(page.getByTestId('tree-first')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByTestId('tree-first')).toBeVisible();
  await shot(page, 'door');
});

test('a fresh device gets the door wherever it first lands: /, /<home>, /roots/', async ({ page }) => {
  await setup(page, false);
  for (const path of ['/', homePathOf(TREE.home.name), '/roots/']) {
    await test.step(path, async () => {
      await page.goto(path);
      await expect(page.getByTestId('tree-first')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1000);
      // /<home> shows the door where it stands; /roots/ is sent to `/`
      expect(new URL(page.url()).pathname).toBe(path === '/roots/' ? '/' : path);
      await expect(page.getByTestId('tree-first')).toBeVisible();
    });
  }
});

test('a walked device: / → /roots/ keeps the query string and the hash', async ({ page }) => {
  await setup(page, true);
  await page.goto('/?x=1#y');
  await page.waitForURL(/\/roots\/?\?x=1#y$/, { timeout: 20_000 });
  const u = new URL(page.url());
  expect([u.pathname.replace(/\/$/, ''), u.search, u.hash]).toEqual(['/roots', '?x=1', '#y']); // next drops the trailing slash
});

test('a walked device: / → /roots/ (white page, rows tinted per root), /<home>, back', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page, true);
  await test.step('/ goes to /roots/', async () => {
    await page.goto('/');
    await page.waitForURL(/\/roots\/?$/, { timeout: 20_000 });
    await expect(page.getByTestId('root-row')).toHaveCount(4);
  });
  await test.step('plain white; rows in their own palettes', async () => {
    const sheet = page.getByTestId('roots-sheet');
    await expect(sheet).toHaveCSS('background-color', rgb('#ffffff'));
    await expect(page.getByTestId('roots-title')).toHaveCSS('color', rgb('#16181a'));
    await expect(page.getByTestId('root-swatch')).toHaveCount(0);
    const row = (id: string) => page.locator(`[data-testid="root-row"][data-root="${id}"]`);
    // debian-box: terminus (picked)
    const d = row('debian-box');
    await expect(d).toHaveCSS('background-color', rgb('#26161b'));
    await expect(d.locator('.t')).toHaveCSS('color', rgb('#efdccb'));
    await expect(d.locator('.oz-r2')).toHaveCSS('color', rgb('#a68a85'));
    await expect(d.getByTestId('root-state')).toHaveCSS('color', rgb('#a8c47e'));
    await expect(d.getByTestId('root-behind')).toHaveCSS('color', rgb('#f09a56'));
    // home + omarchy-lab: nobody picked a world → the app's own (utopia)
    for (const id of ['home', 'omarchy-lab']) {
      const r = row(id);
      await expect(r).toHaveCSS('background-color', rgb('#f6f8ee'));
      await expect(r.locator('.t')).toHaveCSS('color', rgb('#1a2e1c'));
      await expect(r.locator('.oz-r2')).toHaveCSS('color', rgb('#55664f'));
      await expect(r.getByTestId('root-state')).toHaveCSS('color', rgb('#2c6a3a'));
    }
    await expect(row('omarchy-lab').getByTestId('root-behind')).toHaveCSS('color', rgb('#8a5e10'));
    // off: the same tint, faded
    await expect(row('mac-studio')).toHaveCSS('background-color', rgb('#f6f8ee'));
    await expect(row('mac-studio')).toHaveCSS('opacity', '0.5');
    // the page wears no theme of its own: the html keeps the app's (utopia), only the page is white
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'utopia');
    await shot(page, 'roots');
  });
  await test.step('the home row → /home; back → /roots/', async () => {
    await page.locator('[data-testid="root-row"][data-root="home"]').tap();
    await page.waitForURL(/\/home$/, { timeout: 15_000 });
    await expect(page.getByTestId('home-title')).toBeVisible();
    await shot(page, 'home');
    await page.goBack();
    await page.waitForURL(/\/roots\/?$/, { timeout: 15_000 });
    await expect(page.getByTestId('root-row')).toHaveCount(4);
  });
  await test.step('a root → /roots/debian-box (unchanged); back → /roots/', async () => {
    await page.locator('[data-testid="root-row"][data-root="debian-box"]').tap();
    await page.waitForURL(/\/roots\/debian-box$/, { timeout: 15_000 });
    await expect(page.getByTestId('root-view')).toHaveAttribute('data-root', 'debian-box');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminus');
    await shot(page, 'root-debian-box');
    await page.goBack();
    await page.waitForURL(/\/roots\/?$/, { timeout: 15_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'utopia');
  });
  await test.step('the roots key on a page → /roots/ ; the back key on the list → home', async () => {
    await page.goto('/home');
    await page.getByTestId('roots-key').tap();
    await page.waitForURL(/\/roots\/?$/, { timeout: 15_000 });
    await page.getByTestId('roots-close').tap();
    await page.waitForURL(/\/home$/, { timeout: 15_000 });
  });
  await test.step('a bookmark of a name that is not the home root → the list; the manifest start URL → the list', async () => {
    await page.goto('/not-a-root');
    await page.waitForURL(/\/roots\/?$/, { timeout: 15_000 });
    const m = await (await page.request.get('/manifest.json')).json();
    await page.goto(m.start_url);
    await page.waitForURL(/\/roots\/?$/, { timeout: 15_000 });
  });
});
