import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { type APIRequestContext, type Locator, type Page, expect, test } from '@playwright/test';

/**
 * THE ROOTS SHEET + A COMPUTER'S OWN PAGE (E2 · the whole tree), driven like a person on a phone:
 * home → the roots key → one row per computer with its world swatch & state → tap lab →
 * /roots/lab: the home screen of that computer (11-24: the home header — its name → its
 * settings, roots, artifacts, refresh — no tab strip), same rows as home, bottom MAIN bar →
 * ＋ starts a session ON lab → back home: that session's row carries the [lab] tag + swatch →
 * its settings (/roots/lab/settings): change lab's world (saved on lab, wears it on reload & in
 * its session) → hold lab in roots sheet → "Remove lab?" → Remove → gone (roots.json marks it
 * revoked, the home brain forgets it).
 */
const HOME = process.env.PW_HOME_BRAIN || '';
const LAB = process.env.PW_LAB_BRAIN || '';
const TOKEN = process.env.PW_DEVICE_TOKEN || '';
const STATE = process.env.PW_RIG_STATE || '';
const SHOTS = process.env.PW_SHOTS || '';
const TRUNK = process.env.PW_TRUNK_AUTH === '1';
const LIVE = /:(4096|4100|4101|4191|4310|4501|4502|4503|8080|8090|8101|8191|8443|8447)\b/;

test.skip(
  !HOME ||
    !LAB ||
    !TOKEN ||
    !STATE ||
    [HOME, LAB, process.env.PW_BASE_URL || ''].some((u) => LIVE.test(u)),
  'needs its own rig (sim/roots-sheet-e2e.sh) — never a live brain'
);

type Info = { id: string; title: string; card?: { root?: string; kind?: string } };
type RootJ = { name: string; reachable?: boolean; main?: string | null; theme?: string };

const sessionsOf = async (r: APIRequestContext, brain: string): Promise<Info[]> =>
  (await r.get(`${brain}/session`)).json();

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `p3-roots-${name}.png`) });
}

/** the roots key → the sheet (a tap before the page is live is tried again) */
async function openSheet(page: Page) {
  await expect(async () => {
    await page.getByRole('button', { name: 'roots', exact: true }).tap();
    await expect(page.getByTestId('roots-sheet')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

/** a press held past the sheet's 0.5 s, by a finger that does not move */
async function hold(page: Page, el: Locator) {
  const b = await el.boundingBox();
  if (!b) throw new Error('nothing to hold');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
}

test('roots sheet → a computer\'s page: its settings, theme saved on lab, sessions, MAIN, hold → remove', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(180_000);
  const base = new URL(test.info().project.use.baseURL || 'http://127.0.0.1:18520');
  await context.addCookies([
    { name: 'bifrost_device', value: TOKEN, domain: base.hostname, path: '/', httpOnly: true },
  ]);

  await test.step('the rig: home sees lab (its MAIN is up), a session already lives on lab', async () => {
    if (!(await sessionsOf(request, HOME)).some((s) => s.title === '[MAIN]')) {
      expect((await request.post(`${HOME}/session`, { data: { title: '[MAIN]' } })).ok()).toBe(
        true
      );
    }
    if (!(await sessionsOf(request, LAB)).some((s) => s.title === 'lab notes')) {
      expect((await request.post(`${LAB}/session`, { data: { title: 'lab notes' } })).ok()).toBe(
        true
      );
    }
    await expect
      .poll(
        async () => {
          const r = (await (await request.get(`${HOME}/root`)).json()) as { roots?: RootJ[] };
          const lab = r.roots?.find((x) => x.name === 'lab');
          return !!lab?.reachable && !!lab.main;
        },
        { timeout: 60_000, intervals: [1000] }
      )
      .toBe(true);
  });

  await test.step('home → the roots key → home first (home · swatch · on), then lab (swatch · on · linux)', async () => {
    await page.goto('/');
    await openSheet(page);
    const sheet = page.getByTestId('roots-sheet');
    await expect(sheet).toBeVisible();
    const rows = sheet.getByTestId('root-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-root', 'home');
    await expect(rows.nth(0)).toContainText('home');
    await expect(rows.nth(0).getByTestId('root-swatch')).toBeVisible();
    await expect(rows.nth(0).getByTestId('root-state')).toHaveText('on');
    await expect(rows.nth(1)).toHaveAttribute('data-root', 'lab');
    await expect(rows.nth(1).getByTestId('root-swatch')).toBeVisible();
    await expect(rows.nth(1).getByTestId('root-state')).toHaveText('on');
    await expect(rows.nth(1)).toContainText('linux');
    await shot(page, 'sheet');
  });

  await test.step("tap lab → /roots/lab: the home screen's header, lab's sessions, bottom MAIN bar", async () => {
    await page.getByTestId('root-row').nth(1).tap();
    await page.waitForURL(/\/roots\/lab$/, { timeout: 20_000 });
    const view = page.getByTestId('root-view');
    await expect(view).toHaveAttribute('data-root', 'lab');
    // 11-24: its name sits where BIFROST sits, with the home screen's three keys; no tab strip
    await expect(page.getByTestId('home-title')).toHaveText('lab');
    await expect(page.getByTestId('roots-key')).toBeVisible();
    await expect(page.getByTestId('artifacts-key')).toBeVisible();
    await expect(page.getByTestId('refresh-key')).toBeVisible();
    await expect(page.locator('[data-testid^="tab-"], [data-testid="roots-back"]')).toHaveCount(0);
    await expect(page.getByTestId('root-main')).toBeVisible();
    await expect(view.getByTestId('root-sess').filter({ hasText: 'lab notes' })).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, 'lab');
  });

  await test.step('its settings (its name): pick terminus on lab → saved on lab brain + page wears terminus', async () => {
    await page.getByTestId('home-title').tap();
    await page.waitForURL(/\/roots\/lab\/settings$/, { timeout: 20_000 });
    await expect(page.getByTestId('root-world-block')).toBeVisible();
    await expect(page.getByTestId('roots-state')).toHaveText('on', { timeout: 20_000 });
    await page.locator('[data-testid="world-pick"][data-world="terminus"]').tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminus');
    await expect
      .poll(async () => ((await (await request.get(`${LAB}/root`)).json()) as RootJ).theme, {
        timeout: 10_000,
      })
      .toBe('terminus');
    await shot(page, 'lab-settings');
    await page.getByTestId('settings-back').tap();
    await page.waitForURL(/\/roots\/lab$/, { timeout: 20_000 });
  });

  await test.step("tap lab's MAIN bar → opens its proxy wearing lab's terminus theme", async () => {
    await page.getByTestId('root-main').tap();
    await page.waitForURL(/\/session\/main-lab\?id=/, { timeout: 20_000 });
    const id = new URL(page.url()).searchParams.get('id');
    const proxy = (await sessionsOf(request, HOME)).find((s) => s.id === id);
    expect(proxy?.card?.kind).toBe('root-main');
    expect(proxy?.card?.root).toBe('lab');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminus', { timeout: 10_000 });
    await expect(page.getByTestId('session-root-tag')).toHaveText('lab');
  });

  const TITLE = `made on lab ${Date.now() % 100000}`;
  await test.step('＋ on /roots/lab → a session there, opened here', async () => {
    await page.goto('/roots/lab');
    await expect(page.getByTestId('root-main')).toBeVisible();
    await page.getByTestId('roots-new').tap();
    await page.getByTestId('roots-new-name').fill(TITLE);
    await page.getByTestId('roots-create').tap();
    await page.waitForURL(/\/session\/[^?]+\?id=/, { timeout: 30_000 });
    await expect
      .poll(async () => (await sessionsOf(request, LAB)).some((s) => s.title === TITLE), {
        timeout: 15_000,
      })
      .toBe(true);
  });

  await test.step('back home: that session carries the [lab] tag + swatch; no MAIN of lab on the list', async () => {
    await page.goto('/');
    const row = page.locator('.oz-row', { hasText: TITLE });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId('root-tag')).toHaveText('[lab]');
    await expect(row.getByTestId('root-tag-swatch')).toHaveAttribute('data-theme', 'terminus');
    await expect(page.locator('.oz-row', { hasText: '[MAIN] lab' })).toHaveCount(0);
    await expect(page.getByTestId('root-tag')).toHaveCount(1);
    await shot(page, 'home-tag');
  });

  await test.step('hold lab → "Remove lab?" → Remove → the row is gone', async () => {
    await openSheet(page);
    const lab = page.locator('[data-testid="root-row"][data-root="lab"]');
    await expect(lab).toBeVisible();
    // a hold on home asks nothing: on release it opens home's page — the home screen itself
    // (11-24: the home root's row leads to /, the way back from any computer's page)
    await hold(page, page.locator('[data-testid="root-row"][data-root="home"]'));
    await expect(page.getByTestId('roots-sheet')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('root-confirm')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/');
    await openSheet(page);
    await hold(page, lab);
    const ask = page.getByTestId('root-confirm');
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('Remove lab?');
    await shot(page, 'remove');
    await page.getByTestId('root-keep').tap();
    await expect(ask).toHaveCount(0);
    await expect(lab).toBeVisible();
    await hold(page, lab);
    if (TRUNK) {
      const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/t/roots/rt_lab'));
      await page.getByTestId('root-remove').tap();
      expect((await del).status()).toBe(200);
      await expect(page.getByTestId('root-confirm')).toHaveCount(0);
      const removed = readFileSync(join(STATE, 'roots-removed.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { id?: string });
      expect(removed.some((r) => r.id === 'rt_lab')).toBe(true);
    } else {
      await page.getByTestId('root-remove').tap();
      await expect(lab).toHaveCount(0);
      await expect(page.getByTestId('root-row')).toHaveCount(1);
      const rec = JSON.parse(readFileSync(join(STATE, 'roots.json'), 'utf8')).roots.find(
        (r: { id: string }) => r.id === 'lab'
      );
      expect(rec.revoked).toBe(true);
      expect(Date.parse(rec.revoked_at)).toBeGreaterThan(Date.now() - 120_000);
      const after = (await (await request.get(`${HOME}/root`)).json()) as { roots?: RootJ[] };
      expect(after.roots?.some((x) => x.name === 'lab')).toBe(false);
      await page.goto('/');
      await openSheet(page);
      await expect(page.getByTestId('root-row')).toHaveCount(1);
    }
  });

  await test.step('pending joins show in the roots sheet with code & countdown and can be refused', async () => {
    if (TRUNK) {
      writeFileSync(
        join(STATE, 'roots-pending.json'),
        JSON.stringify([
          {
            id: 'enr_debian01',
            hostname: 'debian-box',
            name: 'debian-box',
            os: 'linux',
            wg_fp: 'AB12CD34',
            expires_at: Date.now() + 4 * 60_000,
          },
        ])
      );
      await page.goto('/');
      await openSheet(page);
      const row = page.locator('[data-testid="join-row"][data-join="debian-box"]');
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.getByTestId('join-left')).toContainText(':');
      await expect(row.getByTestId('join-add')).toBeVisible();
      await row.getByTestId('join-refuse').tap();
      await expect(row).toHaveCount(0, { timeout: 10_000 });
      const removed = readFileSync(join(STATE, 'roots-removed.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { enroll?: string; refused?: boolean });
      expect(removed.some((r) => r.enroll === 'enr_debian01' && r.refused === true)).toBe(true);
      return;
    }
    const wg = Buffer.alloc(32, 0x55).toString('base64');
    const res = await request.post(`${base.origin}/api/roots/join`, {
      data: { name: 'debian-box', os: 'linux', host: 'debian-box', wg_pub: wg },
    });
    expect(res.status()).toBe(201);
    const j = (await res.json()) as { req: string; secret: string; code: string };
    // renewal keeps the exact same req id
    const res2 = await request.post(`${base.origin}/api/roots/join`, {
      data: { name: 'debian-box', os: 'linux', host: 'debian-box', wg_pub: wg },
    });
    expect(res2.status()).toBe(201);
    const j2 = (await res2.json()) as { req: string; secret: string; code: string };
    expect(j2.req).toBe(j.req);
    expect(j2.code).toBe(j.code);

    const row = page.locator('[data-testid="join-row"][data-join="debian-box"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('join-code')).toHaveText(j.code);
    await expect(row.getByTestId('join-left')).toContainText(':');
    await expect(row.getByTestId('join-add')).toBeVisible();
    await row.getByTestId('join-refuse').tap();
    await expect(row).toHaveCount(0, { timeout: 10_000 });
    const poll = await request.get(`${base.origin}/api/roots/join/${j2.req}`, {
      headers: { 'x-join-secret': j2.secret },
    });
    expect(poll.status()).toBe(410);
    expect((await poll.json()).status).toBe('refused');
  });
});

test.describe('away', () => {
  test.use({ serviceWorkers: 'block' });

  test('a computer that is away: greyed, "last seen …", its detail page is read-only', async ({
    page,
    context,
  }) => {
    const base = new URL(test.info().project.use.baseURL || 'http://127.0.0.1:18520');
    await context.addCookies([
      { name: 'bifrost_device', value: TOKEN, domain: base.hostname, path: '/', httpOnly: true },
    ]);
    const seen = Date.now() - 5 * 60_000;
    await page.route('**/api/roots', (r) =>
      r.fulfill({
        json: {
          home: { name: 'home', os: 'linux', running: 1, theme: 'aether', main: null },
          roots: [
            {
              id: 'mac-studio',
              name: 'Mac Studio',
              os: 'macos',
              arch: 'arm64',
              cpus: 28,
              reachable: false,
              seen,
              running: 0,
              theme: 'terminus',
              theme_rev: 1, // picked for it: an away computer keeps its picked world
            },
            {
              id: 'old-box',
              name: 'old-box',
              os: 'linux',
              reachable: false,
              seen: null,
              running: 0,
              theme: 'stagnation',
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
          main: { id: 'm1', proxy: 'p1', title: '[MAIN]' },
          sessions: [
            { id: 's1', title: 'render the site', agent: 'lead', status: 'done', updated: seen, proxy: 'p2' },
            { id: 's2', title: 'photos import', agent: 'fix', status: 'blocked', updated: seen - 3_600_000 },
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
          theme_rev: 1,
          hardware: { os: 'macos', arch: 'arm64', cpus: 28 },
          models: ['glm-5.3'],
          roles: [{ name: 'lead', description: '', harness: 'claude', model: 'opus' }],
          engines: [],
        },
      })
    );
    await page.route('**/api/roots/mac-studio/artifacts', (r) =>
      r.fulfill({ json: { root: 'mac-studio', reachable: false, artifacts: [] } })
    );
    await page.goto('/');
    await openSheet(page);
    const mac = page.locator('[data-testid="root-row"][data-root="mac-studio"]');
    await expect(mac.getByTestId('root-state')).toHaveText('last seen 5 min ago');
    await expect(mac).toHaveCSS('opacity', '0.5');
    await expect(
      page.locator('[data-testid="root-row"][data-root="old-box"]').getByTestId('root-state')
    ).toHaveText('off');
    await shot(page, 'away');
    await mac.tap();
    await page.waitForURL(/\/roots\/mac-studio$/, { timeout: 15_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminus');
    // when it was last seen: its MAIN bar says so (11-24: the header is the home screen's)
    await expect(page.getByTestId('root-main')).toContainText('last seen 5 min ago');
    await expect(page.getByTestId('root-sess')).toHaveCount(2);
    await expect(page.getByTestId('root-sess').first()).toHaveCSS('opacity', '0.5');
    await expect(page.getByTestId('root-readonly-note')).toBeVisible();
    await expect(page.getByTestId('roots-new')).toBeDisabled();
    await shot(page, 'away-view');
  });
});
