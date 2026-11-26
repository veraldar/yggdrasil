import { join } from 'path';
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  expect,
  test,
} from '@playwright/test';

/**
 * A ROOT'S PAGE IS THE HOME SCREEN OF THAT COMPUTER (owner 11-24 07:58: "the button should be at
 * the same place. I should have also the artifact and settings button at top right with access
 * to all the roots. I want the same layout." — and: "when I am on the Debian box and I try to
 * change the theme … I get an error").
 *
 * On its own rig (sim/root-home-layout-e2e.sh), an Android phone at 360 px, touch, the app's
 * world = utopia. Three computers: home, lab (today's brain) and old (a brain from before
 * PUT /root/theme — what debian-box ran until 11-24).
 *   a) / and /roots/<x> carry the same header keys, band, new-session key and rows in the same
 *      boxes; no tab strip; the name opens that computer's settings, the artifacts key its
 *      artifacts, the roots key every computer — each closes back to that computer's page
 *   b) a world picked for lab is saved on lab, survives a reload, and is lab's only: home, old,
 *      / and /settings keep the app's world
 *   c) a role's engine and an engine's model saved for lab survive a reload, on lab only
 *   d) a world picked for the computer on the older brain: one plain line, no error, nothing
 *      changes; what that brain can take (a role) still saves and persists
 */
const HOME = process.env.PW_HOME_BRAIN || '';
const LAB = process.env.PW_LAB_BRAIN || '';
const OLD = process.env.PW_OLD_BRAIN || '';
const TOKEN = process.env.PW_DEVICE_TOKEN || '';
const SHOTS = process.env.PW_SHOTS || '';
const LIVE = /:(4096|4100|4101|4191|4310|4501|4502|4503|8080|8090|8101|8191|8443|8447)\b/;

test.skip(
  !HOME || !LAB || !TOKEN || [HOME, LAB, OLD, process.env.PW_BASE_URL || ''].some((u) => LIVE.test(u)),
  'needs its own rig (sim/root-home-layout-e2e.sh) — never a live brain'
);
test.describe.configure({ mode: 'serial' });

type RootJ = {
  name: string;
  reachable?: boolean;
  main?: string | null;
  theme?: string;
  theme_rev?: number;
};
type TreeJ = { name: string; theme?: string; theme_rev?: number; roots?: RootJ[] };
type Box = { x: number; y: number; w: number; h: number };

const treeOf = async (r: APIRequestContext): Promise<TreeJ> => (await r.get(`${HOME}/root`)).json();
const inTree = async (r: APIRequestContext, name: string) =>
  (await treeOf(r)).roots?.find((x) => x.name === name);

async function shot(page: Page, name: string): Promise<Buffer> {
  return page.screenshot(SHOTS ? { path: join(SHOTS, `rhl-${name}.png`) } : {});
}

async function paired(context: BrowserContext) {
  const base = new URL(test.info().project.use.baseURL || 'http://127.0.0.1:18560');
  await context.addCookies([
    { name: 'bifrost_device', value: TOKEN, domain: base.hostname, path: '/', httpOnly: true },
  ]);
}

/** another phone of the owner: paired, behind the door, its own (empty) caches */
async function otherPhone(browser: Browser): Promise<BrowserContext> {
  const use = test.info().project.use;
  const origin = new URL(use.baseURL!).origin;
  const ctx = await browser.newContext({
    baseURL: use.baseURL,
    viewport: use.viewport,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    userAgent: use.userAgent,
    storageState: {
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [
            { name: 'bifrost-door', value: 'v2' },
            { name: 'bifrost-first-turn', value: '1' },
            { name: 'theme', value: 'utopia' },
          ],
        },
      ],
    },
  });
  await paired(ctx);
  return ctx;
}

const htmlWorld = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

async function noOverflow(page: Page, label: string) {
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(sw, `${label}: no sideways scroll at 360 px`).toBeLessThanOrEqual(cw);
}

/** where the home screen's parts sit (CSS px, one decimal) and how its name is set */
async function measure(page: Page) {
  // the refresh key reads "…" while a load runs: measure the settled screen
  await expect(page.getByTestId('refresh-key')).not.toHaveClass(/ok/, { timeout: 20_000 });
  await expect(page.locator('main ul .oz-row').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(300); // the keys' 240 ms colour transition out of "loading"
  return page.evaluate(() => {
    const box = (sel: string): Box | null => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      const n = (v: number) => Math.round(v * 10) / 10;
      return { x: n(r.x), y: n(r.y), w: n(r.width), h: n(r.height) };
    };
    type Box = { x: number; y: number; w: number; h: number };
    const title = document.querySelector('[data-testid="home-title"] h1')!;
    const cs = getComputedStyle(title);
    return {
      roots: box('[data-testid="roots-key"]'),
      artifacts: box('[data-testid="artifacts-key"]'),
      refresh: box('[data-testid="refresh-key"]'),
      head: box('header.oz-head'),
      band: box('figure.oz-band'),
      chip: box('[data-testid="working-filter"]'),
      newKey: box('main .oz-k.ok.h-11'),
      row: box('main ul .oz-row'),
      mainBar: box('.oz-roots'),
      title: box('[data-testid="home-title"]'),
      titleType: [cs.fontSize, cs.fontWeight, cs.letterSpacing, cs.textTransform, cs.color],
    };
  });
}

test.beforeEach(async ({ context }) => paired(context));

test('the rig: three computers, each with its MAIN and a session of its own', async ({ request }) => {
  test.setTimeout(120_000);
  const seed = async (brain: string, title: string) => {
    const have = (await (await request.get(`${brain}/session`)).json()) as { title: string }[];
    if (!have.some((s) => s.title === title)) {
      expect((await request.post(`${brain}/session`, { data: { title } })).ok()).toBe(true);
    }
  };
  await seed(HOME, '[MAIN]');
  await seed(HOME, 'home chores');
  await seed(LAB, 'lab notes');
  if (OLD) await seed(OLD, 'old box chores');
  for (const name of ['lab', ...(OLD ? ['old'] : [])]) {
    await expect
      .poll(async () => {
        const r = await inTree(request, name);
        return !!r?.reachable && !!r.main;
      }, { timeout: 90_000, intervals: [1000] })
      .toBe(true);
  }
  if (OLD) {
    // "old" really is an older brain: it names no world and has no route to take one
    const own = (await (await request.get(`${OLD}/root`)).json()) as RootJ;
    expect(own.theme_rev, 'the older brain names no picked world').toBeUndefined();
    const direct = await request.put(`${OLD}/root/theme`, { data: { theme: 'terminus' } });
    expect(direct.status(), 'the older brain has no PUT /root/theme').toBe(404);
  }
});

test('a) the home screen and every computer: the same header, band and rows in the same boxes', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const roots = ['home', 'lab', ...(OLD ? ['old'] : [])];

  await page.goto('/');
  await expect(page.getByTestId('home-title')).toHaveText('BIFROST', { timeout: 20_000 });
  const ref = await measure(page);
  expect(await htmlWorld(page)).toBe('utopia');
  await noOverflow(page, '/');
  const homeShot = await shot(page, 'a1-home');
  // what the owner named: BIFROST top left, then roots · artifacts · refresh top right
  expect(ref.roots!.x).toBeLessThan(ref.artifacts!.x);
  expect(ref.artifacts!.x).toBeLessThan(ref.refresh!.x);
  expect(ref.refresh!.x + ref.refresh!.w).toBeCloseTo(360 - 12, 0);
  // refresh is an icon key: the same box as roots and artifacts, an icon inside, no text
  expect({ w: ref.refresh!.w, h: ref.refresh!.h }, 'refresh key box').toEqual({ w: ref.roots!.w, h: ref.roots!.h });
  expect(ref.artifacts!.w).toBe(ref.roots!.w);
  expect(await page.getByTestId('refresh-key').locator('svg.oz-ic').count()).toBe(1);
  expect((await page.getByTestId('refresh-key').innerText()).trim()).toBe('');
  console.log('KEYS', JSON.stringify([ref.roots, ref.artifacts, ref.refresh]));

  const shots: Record<string, Buffer> = {};
  for (const r of roots) {
    await test.step(`/roots/${r}`, async () => {
      await page.goto(`/roots/${r}`);
      await expect(page.getByTestId('root-view')).toHaveAttribute('data-reachable', 'on', {
        timeout: 20_000,
      });
      await expect(page.getByTestId('home-title')).toHaveText(r);
      const got = await measure(page);
      // the header keys: the very same boxes
      expect(got.roots, 'roots key').toEqual(ref.roots);
      expect(got.artifacts, 'artifacts key').toEqual(ref.artifacts);
      expect(got.refresh, 'refresh key').toEqual(ref.refresh);
      expect(got.head, 'header').toEqual(ref.head);
      // the band and its chip, the first row, the roots at the bottom
      expect(got.band, 'band').toEqual(ref.band);
      expect(got.chip, 'band chip').toEqual(ref.chip);
      expect(got.row, 'first row').toEqual(ref.row);
      expect(got.mainBar, 'MAIN bar').toEqual(ref.mainBar);
      // the new-session key starts where home's does, as tall (home's shares its line with
      // the terminal and search keys — home-only things; here it has the line)
      expect([got.newKey!.x, got.newKey!.y, got.newKey!.h]).toEqual([
        ref.newKey!.x,
        ref.newKey!.y,
        ref.newKey!.h,
      ]);
      // the name sits where BIFROST sits, set the same way
      expect([got.title!.x, got.title!.y, got.title!.h]).toEqual([
        ref.title!.x,
        ref.title!.y,
        ref.title!.h,
      ]);
      expect(got.titleType).toEqual(ref.titleType);
      // the app's world, and nothing of the old page: no tab strip, no back arrow, no info line
      expect(await htmlWorld(page)).toBe('utopia');
      await expect(
        page.locator(
          '[data-testid="root-tabs"], [data-testid^="tab-"], [data-testid="roots-back"], [data-testid="root-sub"], .oz-tabs'
        )
      ).toHaveCount(0);
      await expect(page.getByTestId('root-sess').first()).toBeVisible();
      await noOverflow(page, `/roots/${r}`);
      shots[r] = await shot(page, `a2-root-${r}`);
    });
  }

  // the two screens side by side, as the owner asked to see them
  if (SHOTS) {
    const side = await page.context().newPage();
    await side.setViewportSize({ width: 760, height: 800 });
    const img = (b: Buffer) => `<img width="360" src="data:image/png;base64,${b.toString('base64')}">`;
    await side.setContent(
      `<body style="margin:0;display:flex;gap:20px;padding:10px;background:#888">${img(homeShot)}${img(shots.lab)}</body>`
    );
    await side.screenshot({ path: join(SHOTS, 'rhl-a3-side-by-side-home-and-lab.png') });
    if (shots.old) {
      await side.setContent(
        `<body style="margin:0;display:flex;gap:20px;padding:10px;background:#888">${img(homeShot)}${img(shots.old)}</body>`
      );
      await side.screenshot({ path: join(SHOTS, 'rhl-a3-side-by-side-home-and-old.png') });
    }
    await side.close();
  }
});

test('a) by touch: roots → a computer; its name → its settings; the artifacts key → its artifacts; each closes back', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // how /settings and /artifacts open from home: where their back keys sit
  await page.goto('/settings');
  const backOf = async (sel: string) => {
    await expect(page.locator(sel).first()).toBeVisible({ timeout: 20_000 });
    return page.locator(sel).first().boundingBox();
  };
  const settingsBack = await backOf('header.oz-head .oz-k.sm');
  await page.goto('/artifacts');
  const artifactsBack = await backOf('header.oz-head .oz-k.sm');

  await page.goto('/');
  await expect(page.getByTestId('roots-key')).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    await page.getByTestId('roots-key').tap();
    await expect(page.getByTestId('roots-sheet')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await shot(page, 'a4-sheet-from-home');
  await page.locator('[data-testid="root-row"][data-root="lab"]').tap();
  await page.waitForURL(/\/roots\/lab$/, { timeout: 20_000 });
  await expect(page.getByTestId('root-sess').filter({ hasText: 'lab notes' })).toBeVisible({
    timeout: 20_000,
  });

  // its name → its settings (as BIFROST → /settings), back → its page
  await page.getByTestId('home-title').tap();
  await page.waitForURL(/\/roots\/lab\/settings$/, { timeout: 20_000 });
  await expect(page.getByTestId('root-settings')).toHaveAttribute('data-root', 'lab');
  await expect(page.locator('header.oz-head')).toContainText('settings');
  await expect(page.locator('header.oz-head')).toContainText('lab');
  await expect(page.getByTestId('root-world-block').locator('[data-testid="world-pick"]')).toHaveCount(8);
  await expect(page.getByTestId('root-roles-block')).toBeVisible();
  await expect(page.getByTestId('roots-state')).toHaveText('on', { timeout: 20_000 });
  expect(await page.getByTestId('settings-back').boundingBox()).toEqual(settingsBack);
  await noOverflow(page, 'lab settings');
  await shot(page, 'a5-lab-settings');
  await page.getByTestId('settings-back').tap();
  await page.waitForURL(/\/roots\/lab$/, { timeout: 20_000 });

  // the artifacts key → its artifacts (as /artifacts), back → its page
  await page.getByTestId('artifacts-key').tap();
  await page.waitForURL(/\/roots\/lab\/artifacts$/, { timeout: 20_000 });
  await expect(page.getByTestId('artifacts-view')).toHaveAttribute('data-root', 'lab');
  expect(await page.locator('header.oz-head .oz-k.sm').first().boundingBox()).toEqual(artifactsBack);
  await page.getByRole('button', { name: /^all/ }).tap();
  const file = page.locator('[data-testid="artifact-row"][data-name="lab-notes.md"]');
  await expect(file).toBeVisible({ timeout: 20_000 });
  await noOverflow(page, 'lab artifacts');
  await shot(page, 'a6-lab-artifacts');
  // the file is read from lab itself
  await file.tap();
  await expect(page.getByText('hello from lab')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'back to list' }).tap();
  await page.getByTestId('artifacts-back').tap();
  await page.waitForURL(/\/roots\/lab$/, { timeout: 20_000 });

  // the roots key is on this page too: every computer, and home's row is the way back to /
  await page.getByTestId('roots-key').tap();
  const rows = page.getByTestId('roots-sheet').getByTestId('root-row');
  await expect(rows).toHaveCount(OLD ? 3 : 2);
  await expect(rows.nth(0)).toHaveAttribute('data-root', 'home');
  await shot(page, 'a7-sheet-from-lab');
  if (OLD) {
    await page.locator('[data-testid="root-row"][data-root="old"]').tap();
    await page.waitForURL(/\/roots\/old$/, { timeout: 20_000 });
    await expect(page.getByTestId('home-title')).toHaveText('old');
    await expect(page.getByTestId('root-sess').filter({ hasText: 'old box chores' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('root-sess').filter({ hasText: 'lab notes' })).toHaveCount(0);
    await page.getByTestId('roots-key').tap();
  }
  await page.locator('[data-testid="root-row"][data-root="home"]').tap();
  await page.waitForURL((u) => u.pathname === '/', { timeout: 20_000 });
  await expect(page.getByTestId('home-title')).toHaveText('BIFROST');
  await expect(page.getByTestId('roots-sheet')).toHaveCount(0);
});

test('b) a world picked for lab is saved on lab, survives a reload, and is lab\'s only', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const before = await treeOf(request);

  await page.goto('/roots/lab/settings');
  const terminus = page.locator('[data-testid="world-pick"][data-world="terminus"]');
  await expect(page.locator('[data-testid="world-pick"][data-world="utopia"]')).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 20_000 }
  );
  await expect(page.getByTestId('roots-state')).toHaveText('on', { timeout: 20_000 });
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/roots/lab/theme') && r.request().method() === 'PUT'
  );
  await terminus.tap();
  expect((await saved).status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminus');
  await expect(terminus).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('save-error')).toHaveCount(0);
  // saved on lab itself (its own data/root.json), counted as a pick
  const lab = (await (await request.get(`${LAB}/root`)).json()) as RootJ;
  expect([lab.theme, (lab.theme_rev ?? 0) > 0]).toEqual(['terminus', true]);
  await shot(page, 'b1-lab-settings-terminus');

  // reload: still lab's world — its settings, its page, its artifacts
  await page.reload();
  await expect(page.getByTestId('root-settings')).toHaveAttribute('data-root-theme', 'terminus', {
    timeout: 20_000,
  });
  await expect(terminus).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminus');
  await page.goto('/roots/lab');
  await expect(page.getByTestId('root-view')).toHaveAttribute('data-root-theme', 'terminus', {
    timeout: 20_000,
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminus');
  await expect(page.getByTestId('root-sess').first()).toBeVisible({ timeout: 20_000 });
  await shot(page, 'b2-lab-page-terminus-after-reload');
  await page.goto('/roots/lab/artifacts');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminus', { timeout: 20_000 });

  // lab's only: home, the home screen and /settings keep the app's world; so does old
  for (const path of ['/roots/home', '/', '/settings', ...(OLD ? ['/roots/old'] : [])]) {
    await page.goto(path);
    await expect(page.locator('main').first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500); // a tree answer would have painted by now
    expect(await htmlWorld(page), `${path} keeps the app's world`).toBe('utopia');
  }
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: /^utopia —/ })).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'b3-app-settings-still-utopia');
  await page.goto('/roots/home/settings');
  await expect(page.locator('[data-testid="world-pick"][data-world="utopia"]')).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 20_000 }
  );
  const after = await treeOf(request);
  expect([after.theme, after.theme_rev], "home's own world is untouched").toEqual([
    before.theme,
    before.theme_rev,
  ]);
  if (OLD) expect((await inTree(request, 'old'))?.theme_rev ?? 0).toBe(0);

  // on the home screen a session that lives on lab wears lab's swatch
  await page.goto('/roots/lab');
  await page.getByTestId('roots-new').tap();
  const title = `made on lab ${Date.now() % 100000}`;
  await page.getByTestId('roots-new-name').fill(title);
  await page.getByTestId('roots-create').tap();
  await page.waitForURL(/\/session\/[^?]+\?id=/, { timeout: 30_000 });
  await page.goto('/');
  const row = page.locator('.oz-row', { hasText: title });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByTestId('root-tag')).toHaveText('[lab]');
  await expect(row.getByTestId('root-tag-swatch')).toHaveAttribute('data-theme', 'terminus');
  expect(await htmlWorld(page)).toBe('utopia');

  // another phone sees the same: lab in terminus, the app in its own world
  const ctx = await otherPhone(browser);
  const other = await ctx.newPage();
  await other.goto('/roots/lab');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'terminus', { timeout: 20_000 });
  await other.goto('/');
  await expect(other.getByTestId('home-title')).toHaveText('BIFROST', { timeout: 20_000 });
  await other.waitForTimeout(1500);
  expect(await htmlWorld(other)).toBe('utopia');
  await ctx.close();
});

test('c) a role\'s engine and an engine\'s model saved for lab survive a reload, on lab only', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await page.goto('/roots/lab/settings');
  const role = page.locator('[data-testid="root-role"][data-role="build"]');
  await expect(role).toBeVisible({ timeout: 20_000 });
  await expect(role.getByTestId('role-engine')).toHaveText('root');
  await role.locator('> button').tap();
  const putRole = page.waitForResponse(
    (r) => r.url().endsWith('/api/roots/lab/agent/build') && r.request().method() === 'PUT'
  );
  await page.getByTestId('role-build-eng-claude').tap();
  expect((await putRole).status()).toBe(200);
  await expect(role.getByTestId('role-engine')).toHaveText('Claude Code');
  await expect(page.getByTestId('save-error')).toHaveCount(0);

  // an engine's default model
  const engine = page.locator('[data-testid="root-engine"][data-engine="claude"]');
  await engine.locator('> button').tap();
  const putEngine = page.waitForResponse(
    (r) => r.url().endsWith('/api/roots/lab/engine/claude') && r.request().method() === 'PUT'
  );
  await page.getByTestId('engine-claude-model-sonnet').tap();
  expect((await putEngine).status()).toBe(200);
  await expect(engine.getByTestId('engine-model')).toContainText('sonnet');
  await shot(page, 'c1-lab-role-and-engine-saved');

  // saved on lab itself
  const onLab = async (path: string) => (await request.get(`${LAB}${path}`)).json();
  expect((await onLab('/agent/build')).harness).toBe('claude');
  const engines = (await onLab('/engine')) as { name: string; model: string | null }[];
  expect(engines.find((e) => e.name === 'claude')?.model).toBe('sonnet');

  // reload: both are still there
  await page.reload();
  await expect(role.getByTestId('role-engine')).toHaveText('Claude Code', { timeout: 20_000 });
  await expect(engine.getByTestId('engine-model')).toContainText('sonnet');
  await expect(role.getByTestId('role-model')).toContainText('sonnet'); // the role follows its engine
  await shot(page, 'c2-lab-role-and-engine-after-reload');

  // lab's only: home's build role still runs on the root
  const homeBuild = (await (await request.get(`${HOME}/agent/build`)).json()) as { harness: string };
  expect(homeBuild.harness).toBe('root');
  await page.goto('/roots/home/settings');
  await expect(
    page.locator('[data-testid="root-role"][data-role="build"]').getByTestId('role-engine')
  ).toHaveText('root', { timeout: 20_000 });
});

test('d) a computer on an older brain: one plain line instead of an error; what it can take still saves', async ({
  page,
  request,
}) => {
  test.skip(!OLD, 'the rig has no older brain (OLD_BIN)');
  test.setTimeout(180_000);

  await page.goto('/roots/old/settings');
  await expect(page.getByTestId('roots-state')).toHaveText('on', { timeout: 20_000 });
  const utopia = page.locator('[data-testid="world-pick"][data-world="utopia"]');
  const terminus = page.locator('[data-testid="world-pick"][data-world="terminus"]');
  await expect(utopia).toHaveAttribute('aria-pressed', 'true');

  // the pick that showed the owner an error on 11-24
  const answered = page.waitForResponse(
    (r) => r.url().endsWith('/api/roots/old/theme') && r.request().method() === 'PUT'
  );
  await terminus.tap();
  const res = await answered;
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({ error: 'old needs an update for this', outdated: true });
  const line = page.getByTestId('save-error');
  await expect(line).toHaveText('old needs an update for this');
  await expect(page.getByText(/404|Not Found|502|failed/i)).toHaveCount(0);
  // nothing changed: the page is back in the app's world, nothing is kept anywhere
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'utopia');
  await expect(utopia).toHaveAttribute('aria-pressed', 'true');
  await expect(terminus).toHaveAttribute('aria-pressed', 'false');
  expect((await inTree(request, 'old'))?.theme_rev ?? 0).toBe(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('oz-root-worlds') || '{}').old ?? null)
  ).toBeNull();
  await noOverflow(page, 'old settings with the line');
  await shot(page, 'd1-old-needs-an-update');

  await page.reload();
  await expect(utopia).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  expect(await htmlWorld(page)).toBe('utopia');
  await expect(page.getByTestId('save-error')).toHaveCount(0);

  // a role is something that brain can take: it saves there and survives a reload
  const role = page.locator('[data-testid="root-role"][data-role="build"]');
  await expect(role).toBeVisible({ timeout: 20_000 });
  await role.locator('> button').tap();
  const putRole = page.waitForResponse(
    (r) => r.url().endsWith('/api/roots/old/agent/build') && r.request().method() === 'PUT'
  );
  await page.getByTestId('role-build-eng-claude').tap();
  expect((await putRole).status()).toBe(200);
  await expect(role.getByTestId('role-engine')).toHaveText('Claude Code');
  await page.reload();
  await expect(role.getByTestId('role-engine')).toHaveText('Claude Code', { timeout: 20_000 });
  await shot(page, 'd2-old-role-saved-after-reload');

  // an engine: saved where that brain has engines; where it has none (a brain from before
  // them lists none, so the page shows no engines block) the route says the same one line
  const put = await page.request.put('/api/roots/old/engine/claude', { data: { model: 'sonnet' } });
  if (put.status() === 200) {
    await page.reload();
    await expect(
      page.locator('[data-testid="root-engine"][data-engine="claude"]').getByTestId('engine-model')
    ).toContainText('sonnet', { timeout: 20_000 });
  } else {
    expect(put.status()).toBe(409);
    expect(await put.json()).toEqual({ error: 'old needs an update for this', outdated: true });
    await expect(page.getByTestId('root-engines-block')).toHaveCount(0);
  }
});
