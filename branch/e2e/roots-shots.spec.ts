import { type Page, test } from '@playwright/test';
import { join } from 'path';

/** 360 px screenshots of the roots pages for the owner (SHOT_MODE=before on ship-1126-app, after on
 *  this branch), on the roots-page rig: the tree is mocked, the app's world is utopia. */
const TOKEN = process.env.PW_DEVICE_TOKEN || '';
const OUT = process.env.PW_SHOTS || '';
const MODE = process.env.SHOT_MODE || 'after';
test.skip(!TOKEN || !OUT, 'needs the roots-page rig');
const TREE = {
  home: { name: 'omarchy', os: 'linux', running: 3, theme: 'utopia', theme_rev: 0, main: null },
  roots: [
    { id: 'mac-studio', name: 'mac-studio', os: 'macos', reachable: false, seen: null, theme: 'utopia', theme_rev: 0 },
    { id: 'omarchy-lab', name: 'omarchy-lab', os: 'linux', reachable: true, behind: true, theme: 'utopia', theme_rev: 0 },
    { id: 'debian-box', name: 'debian-box', os: 'linux', reachable: true, behind: true, theme: 'terminus', theme_rev: 1 },
  ],
  joins: [],
};
async function setup(page: Page) {
  const base = new URL(test.info().project.use.baseURL || 'http://127.0.0.1:18620');
  await page.context().addCookies([{ name: 'bifrost_device', value: TOKEN, domain: base.hostname, path: '/', httpOnly: true }]);
  await page.addInitScript(() => {
    localStorage.setItem('theme', 'utopia');
    localStorage.setItem('oz-home-root', 'omarchy');
  });
  await page.route('**/api/roots', (r) => r.fulfill({ json: TREE }));
  await page.route('**/api/roots/*/sessions', (r) => r.fulfill({ json: { root: 'x', reachable: true, main: null, sessions: [] } }));
  await page.route('**/api/roots/*/artifacts', (r) => r.fulfill({ json: { reachable: true, artifacts: [] } }));
}
const shot = (page: Page, n: string) => page.screenshot({ path: join(OUT, `${MODE}-${n}.png`) });

test('shots', async ({ page }) => {
  await setup(page);
  // "/" — before: the home screen; after: forwards to the roots list
  await page.goto('/');
  await page.waitForTimeout(2500);
  await shot(page, '1-slash');
  // the home screen: before it is "/", after "/omarchy"
  await page.goto(MODE === 'before' ? '/' : '/omarchy');
  await page.getByTestId('roots-key').waitFor();
  await page.waitForTimeout(1500);
  await shot(page, '3-home');
  // the roots list: before the sheet over home, after /roots/
  await page.getByTestId('roots-key').tap();
  await page.getByTestId('roots-sheet').waitFor();
  await page.waitForTimeout(1000);
  await shot(page, '2-roots');
  await page.goto('/roots/debian-box');
  await page.getByTestId('root-view').waitFor();
  await page.waitForTimeout(1500);
  await shot(page, '4-root-debian-box');
});
