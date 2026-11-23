import { join } from 'path';
import { type Page, expect, test } from '@playwright/test';

/**
 * Root detail page E2E on a sim twin (sim/acceptance/twin-up.sh, :8250, tailnet mode)
 * verified at 360px phone viewport (360×780).
 *
 * Covers:
 *  - roots sheet → world swatch + state → tap opens /roots/<home>
 *  - 360px zero horizontal overflow across all three tabs (sessions · artifacts · settings)
 *  - sessions tab: same rows as home screen, + new session, bottom MAIN bar
 *  - artifacts tab: lists artifacts, opens markdown inline
 *  - settings tab: per-root world saved on brain (persists across reload + fresh browser context),
 *    roles inline editor, engines inline editor, this computer info
 *  - offline remote computer state: keeps world, last-seen, dimmed rows + read-only note,
 *    disabled controls, remove still enabled
 */
const SHOTS = process.env.PW_SHOTS || '';

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `root-detail-360-${name}.png`) });
}

async function assertNoOverflow360(page: Page, label: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${label}: horizontal overflow at 360px`).toBeLessThanOrEqual(clientWidth);
}

test('root detail page on sim twin at 360px: flow, 3 tabs, per-root theme persistence', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const tree = (await (await request.get('/api/roots')).json()) as {
    home: { name: string; theme?: string } | null;
  };
  expect(tree.home?.name, 'twin brain must report home root name').toBeTruthy();
  const home = tree.home!.name;

  // seed a session so the sessions tab has a real row to check
  const seedTitle = `rd-check-${Date.now().toString(36)}`;
  const created = await (
    await request.post('/api/session', { data: { name: seedTitle } })
  ).json();
  expect(created.id).toBeTruthy();

  try {
    // 1. Roots sheet → tap home → /roots/<home>
    await page.goto('/');
    await expect(page.getByTestId('roots-key')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('roots-key').click();
    await expect(page.getByTestId('roots-sheet')).toBeVisible();
    const homeRow = page.locator(`[data-testid="root-row"][data-root="${home}"]`);
    await expect(homeRow).toBeVisible();
    await expect(homeRow.getByTestId('root-swatch')).toBeVisible();
    await expect(homeRow.getByTestId('root-state')).toHaveText('on');
    await shot(page, '1-roots-sheet');

    await homeRow.click();
    await page.waitForURL(new RegExp(`/roots/${encodeURIComponent(home)}$`), { timeout: 15_000 });
    await expect(page.getByTestId('roots-title')).toHaveText(home);
    await expect(page.getByTestId('roots-state')).toContainText('on');
    await expect(page.getByTestId('tab-sessions')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('root-sess').filter({ hasText: seedTitle })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('root-main')).toBeVisible();
    await assertNoOverflow360(page, 'sessions tab');
    await shot(page, '2-sessions');

    // 2. Artifacts tab (zero overflow at 360px)
    await page.getByTestId('tab-artifacts').click();
    await expect(page.getByTestId('root-artifacts-tab')).toBeVisible();
    await assertNoOverflow360(page, 'artifacts tab');
    await shot(page, '3-artifacts');

    // 3. Settings tab: pick terminus, verify saved on brain & seen by a fresh second phone
    await page.getByTestId('tab-settings').click();
    await expect(page.getByTestId('root-world-block')).toBeVisible();
    await expect(page.getByTestId('root-roles-block')).toBeVisible();
    await expect(page.getByTestId('root-info-block')).toBeVisible();
    await assertNoOverflow360(page, 'settings tab');

    await page.locator('[data-testid="world-pick"][data-world="terminus"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminus');
    await expect(
      page.locator('[data-testid="world-pick"][data-world="terminus"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await shot(page, '4-settings-terminus');

    // verify saved on the brain itself
    const afterSet = (await (await request.get(`/api/roots/${encodeURIComponent(home)}/settings`)).json()) as {
      theme: string;
    };
    expect(afterSet.theme).toBe('terminus');

    // a brand-new context ("another phone") sees terminus automatically
    const otherCtx = await browser.newContext({
      viewport: { width: 360, height: 780 },
      baseURL: test.info().project.use.baseURL,
      storageState: {
        cookies: [],
        origins: [
          {
            origin: new URL(test.info().project.use.baseURL!).origin,
            localStorage: [
              { name: 'bifrost-door', value: 'v2' },
              { name: 'bifrost-first-turn', value: '1' },
            ],
          },
        ],
      },
    });
    const otherPage = await otherCtx.newPage();
    await otherPage.goto(`/roots/${encodeURIComponent(home)}`);
    await expect(otherPage.locator('html')).toHaveAttribute('data-theme', 'terminus', {
      timeout: 10_000,
    });
    await otherCtx.close();

    // expand a role inline editor in settings
    await page.locator('[data-testid="root-role"][data-role="lead"] > button').click();
    await expect(page.getByTestId('role-lead-eng-root')).toBeVisible();
    await assertNoOverflow360(page, 'settings role expanded');

    // restore home theme to aether
    await page.locator('[data-testid="world-pick"][data-world="aether"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'aether');

    // back ‹ goes back to the roots sheet on home
    await page.getByTestId('roots-back').click();
    await expect(page.getByTestId('roots-sheet')).toBeVisible({ timeout: 15_000 });
  } finally {
    await request.delete(`/api/session/${created.id}`).catch(() => {});
  }
});

test.describe('offline remote root at 360px', () => {
  test.use({ serviceWorkers: 'block' });

  test('offline computer keeps its world, shows last seen, dimmed read-only rows, remove still active', async ({
    page,
  }) => {
    const seen = Date.now() - 12 * 60_000;
    await page.route('**/api/roots', (r) =>
      r.fulfill({
        json: {
          home: { name: 'omarchy', os: 'linux', arch: 'x86_64', cpus: 16, mem_gb: 30, running: 1, theme: 'aether', main: 'm0' },
          roots: [
            {
              id: 'mac-studio',
              name: 'mac-studio',
              os: 'macos',
              arch: 'arm64',
              cpus: 28,
              reachable: false,
              seen,
              running: 0,
              theme: 'terminus',
              theme_rev: 2, // picked for it: an offline computer keeps its picked world
            },
          ],
        },
      })
    );
    await page.route('**/api/roots/mac-studio/sessions', (r) =>
      r.fulfill({
        json: {
          root: 'mac-studio',
          reachable: false,
          main: { id: 'mm', proxy: null, title: '[MAIN]' },
          sessions: [
            {
              id: 's1',
              title: 'render run',
              agent: 'lead',
              status: 'idle',
              headline: 'batch 7 of 12 · two subs running',
              updated: seen,
              proxy: null,
            },
            {
              id: 's2',
              title: 'sync job loops',
              agent: 'fix',
              status: 'blocked',
              card: { status: 'blocked', needs: 'may I stop the sync job?' },
              updated: seen - 3_600_000,
              proxy: null,
            },
          ],
        },
      })
    );
    await page.route('**/api/roots/mac-studio/settings', (r) =>
      r.fulfill({
        json: {
          root: 'mac-studio',
          home: false,
          reachable: false,
          seen,
          theme: 'terminus',
          theme_rev: 2,
          hardware: { os: 'macos', arch: 'arm64', cpus: 28 },
          models: ['glm-5.3-flash', 'glm-5.3'],
          roles: [
            { name: 'coordinator', description: '', harness: null, model: 'glm-5.3-flash' },
            { name: 'lead', description: '', harness: 'claude', model: 'opus' },
          ],
          engines: [
            { name: 'root', label: 'root', model: 'glm-5.3-flash', models: ['glm-5.3-flash'] },
          ],
          joined_at: '2026-11-22T10:00:00Z',
        },
      })
    );
    await page.route('**/api/roots/mac-studio/artifacts', (r) =>
      r.fulfill({
        json: {
          root: 'mac-studio',
          reachable: false,
          artifacts: [
            { name: 'render-report.html', mtime: seen, size: 49152, ext: 'html' },
            { name: 'mlx-report.md', mtime: seen - 120_000, size: 9216, ext: 'md' },
          ],
        },
      })
    );

    await page.goto('/roots/mac-studio');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminus');
    await expect(page.getByTestId('roots-title')).toHaveText('mac-studio');
    await expect(page.getByTestId('roots-state')).toContainText('last seen');
    await expect(page.getByTestId('roots-new')).toBeDisabled();
    await expect(page.getByTestId('root-sess')).toHaveCount(2);
    await expect(page.getByTestId('root-sess').first()).toHaveCSS('opacity', '0.5');
    await expect(page.getByTestId('root-readonly-note')).toBeVisible();
    await expect(page.getByTestId('root-main').locator('button')).toBeDisabled();
    await assertNoOverflow360(page, 'offline sessions');
    await shot(page, '5-offline-sessions');

    await page.getByTestId('tab-settings').click();
    await expect(page.getByTestId('root-world-block')).toHaveCSS('opacity', '0.5');
    await expect(page.locator('[data-testid="world-pick"]').first()).toBeDisabled();
    // remove still works when offline
    await expect(page.getByTestId('root-remove-btn')).toBeEnabled();
    await assertNoOverflow360(page, 'offline settings');
    await shot(page, '6-offline-settings');
  });
});

/** Owner 11-23 22:19: "I said keep the same design, the ux should be the same between root as is
 *  our current root". Release 20261123-2204 painted /roots/debian-box in 'stagnation' (dark) —
 *  a world nobody picked: the brain's name-hashed default, theme_rev 0 — and the home screen
 *  adopted home's unpicked 'aether', flipping the owner's light app dark. A computer wears a
 *  world of its own only once one was picked for it; otherwise every page is the app's world
 *  and the root page is built from the home screen's own parts. */
test.describe('same design as the home screen at 360px', () => {
  test.use({ serviceWorkers: 'block' });

  test('unpicked computer wears the app world (utopia), home is not flipped, home parts reused', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const now = Date.now();
    // GET /api/roots as on the live brain 11-23, before the owner re-picked home's world
    await page.route('**/api/roots', (r) =>
      r.fulfill({
        json: {
          home: {
            name: 'omarchy', os: 'linux', arch: 'x86_64', cpus: 16, mem_gb: 30, running: 0,
            theme: 'aether', theme_rev: 0, main: null,
          },
          roots: [
            {
              id: 'debian-box', name: 'debian-box', os: 'linux', arch: 'x86_64', cpus: 16,
              mem_gb: 30, reachable: true, seen: now, running: 0, models: ['glm-5.3-flash'],
              theme: 'stagnation', theme_rev: 0, main: 'm1', main_proxy: 'p1',
            },
          ],
          joins: [],
        },
      })
    );
    await page.route('**/api/roots/debian-box/sessions', (r) =>
      r.fulfill({
        json: {
          root: 'debian-box',
          reachable: true,
          main: { id: 'm1', proxy: 'p1', title: '[MAIN]', preview: 'talk to debian-box' },
          sessions: [
            { id: 's1', title: 'disk check', agent: 'build', status: 'done', headline: 'all disks fine', updated: now - 60_000, proxy: 'p2' },
          ],
        },
      })
    );
    await page.route('**/api/roots/debian-box/settings', (r) =>
      r.fulfill({
        json: {
          root: 'debian-box', home: false, reachable: true, seen: now,
          theme: 'stagnation', theme_rev: 0,
          hardware: { os: 'linux', arch: 'x86_64', cpus: 16, mem_gb: 30 },
          models: ['glm-5.3-flash'], roles: [], engines: [], joined_at: '2026-11-23T19:00:56Z',
        },
      })
    );
    await page.route('**/api/roots/debian-box/artifacts', (r) =>
      r.fulfill({ json: { root: 'debian-box', reachable: true, artifacts: [] } })
    );
    // the owner's phone: the app's world is utopia (light), and the release's old paint cache
    // still holds debian-box's unpicked default
    await page.addInitScript(() => {
      if (sessionStorage.getItem('rd-seeded')) return;
      sessionStorage.setItem('rd-seeded', '1');
      localStorage.setItem('theme', 'utopia');
      localStorage.setItem('oz-root-themes', JSON.stringify({ 'debian-box': 'stagnation' }));
    });
    const bgOf = (sel: string) =>
      page.evaluate(
        (q) => getComputedStyle(document.querySelector(q)!).getPropertyValue('--oz-bg').trim(),
        sel
      );
    const KEY_CSS = ['height', 'font-size', 'justify-content', 'background-color', 'border-top-color', 'color'];
    const cssOf = (loc: import('@playwright/test').Locator) =>
      loc.evaluate((el, props) => props.map((p) => getComputedStyle(el).getPropertyValue(p)), KEY_CSS);

    // home: the tree answers (the sheet lists debian-box) and the app stays utopia
    await page.goto('/');
    await expect(page.getByTestId('roots-key')).toBeVisible({ timeout: 15_000 });
    const homeNew = page.getByRole('button', { name: 'new session' });
    const homeKey = await cssOf(homeNew);
    await page.getByTestId('roots-key').click();
    const row = page.locator('[data-testid="root-row"][data-root="debian-box"]');
    await expect(row).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'utopia');
    // its swatch shows no world of its own (none picked)
    expect(await row.getByTestId('root-swatch').getAttribute('data-theme')).toBeNull();
    const homeBg = await bgOf('main');
    await shot(page, '7-home-utopia');

    // its page: the app's world, the home screen's parts
    await row.click();
    await page.waitForURL(/\/roots\/debian-box$/, { timeout: 15_000 });
    await expect(page.getByTestId('roots-state')).toContainText('on');
    await expect(page.getByTestId('root-sess')).toHaveCount(1);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'utopia');
    expect(await page.getByTestId('root-view').getAttribute('data-root-theme')).toBeNull();
    expect(await bgOf('[data-testid="root-view"]')).toBe(homeBg);
    expect(await page.evaluate(() => localStorage.getItem('oz-root-themes'))).toBeNull();
    // the home screen's band and chip, the app's tab strip (as /artifacts), its new-session key
    await expect(page.getByTestId('root-band')).toBeVisible();
    await expect(page.getByTestId('working-filter')).toHaveText('all quiet');
    await expect(page.getByTestId('root-tabs')).toHaveClass(/\boz-tabs\b/);
    await expect(page.locator('.oz-ptabs, .oz-worlds2, .oz-kind')).toHaveCount(0);
    expect(await cssOf(page.getByTestId('roots-new'))).toEqual(homeKey);
    // the home screen's row: one status word, and only "working" — no "done"
    await expect(page.getByTestId('root-sess').locator('.oz-st')).toHaveCount(0);
    await assertNoOverflow360(page, 'unpicked sessions');
    await shot(page, '8-unpicked-sessions');

    // settings: the app's world list; current = the world it wears (the app's)
    await page.getByTestId('tab-settings').click();
    await expect(page.locator('.oz-world[data-testid="world-pick"]')).toHaveCount(8);
    await expect(
      page.locator('[data-testid="world-pick"][data-world="utopia"]')
    ).toHaveAttribute('aria-pressed', 'true');
    await assertNoOverflow360(page, 'unpicked settings');
    await shot(page, '9-unpicked-settings');
  });
});
