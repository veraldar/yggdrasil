import { join } from 'path';
import { type Locator, type Page, expect, test } from '@playwright/test';

/**
 * ROOT UPDATES, STAGE 1 — THE "NOT UP TO DATE" MARKER, on a phone (360×780, touch):
 * home and lab run this tree's brain, old runs an older one (no `build` in its GET /root).
 * Home reports its build; old is behind, lab is not → the roots key carries the mark, on the
 * home screen and on a root's own page (the same header, HomeHead) → the roots sheet's row for
 * old says "not up to date" in --oz-active, lab's and home's do not → old stops: it is off and
 * keeps the marker → old removed: the mark is gone.
 */
const HOME = process.env.PW_HOME_BRAIN || '';
const LAB = process.env.PW_LAB_BRAIN || '';
const OLD = process.env.PW_OLD_BRAIN || '';
const OLD_PID = Number(process.env.PW_OLD_PID || 0);
const TOKEN = process.env.PW_DEVICE_TOKEN || '';
const SHOTS = process.env.PW_SHOTS || '';
const LIVE = /:(4096|4100|4101|4191|4310|4501|4502|4503|8080|8090|8101|8191|8443|8447)\b/;

test.skip(
  !HOME ||
    !LAB ||
    !OLD ||
    !OLD_PID ||
    !TOKEN ||
    [HOME, LAB, OLD, process.env.PW_BASE_URL || ''].some((u) => LIVE.test(u)),
  'needs its own rig (sim/root-behind-e2e.sh) — never a live brain'
);

type Build = { id: string; commit: string; epoch: number; describe: string; plat: string };
type Peer = { name: string; reachable: boolean; build: Build | null; behind: boolean | null };

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `root-behind-${name}.png`) });
}

/** the colour --oz-active resolves to on this page, as the browser writes colours (rgb(…)) */
const activeColor = (page: Page) =>
  page.evaluate(() => {
    const i = document.createElement('i');
    i.style.color = 'var(--oz-active)';
    document.body.appendChild(i);
    const c = getComputedStyle(i).color;
    i.remove();
    return c;
  });

const row = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="root-row"][data-root="${id}"]`);

async function openSheet(page: Page) {
  await expect(async () => {
    await page.getByRole('button', { name: 'roots', exact: true }).tap();
    await expect(page.getByTestId('roots-sheet')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

test('a root on an older brain is marked "not up to date"; one on this build is not', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(240_000);
  const base = new URL(test.info().project.use.baseURL || 'http://127.0.0.1:18540');
  await context.addCookies([
    { name: 'bifrost_device', value: TOKEN, domain: base.hostname, path: '/', httpOnly: true },
  ]);
  let mine = '';

  await test.step('GET /root reports the build; the older brain has none', async () => {
    const home = await (await request.get(`${HOME}/root`)).json();
    const b = home.build as Build;
    expect(b.id).toMatch(/^([0-9a-f]{12}|dirty-[0-9a-f]{12})$/);
    expect(b.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(b.epoch).toBeGreaterThan(1_700_000_000);
    expect(b.plat).toBe('linux-x86_64');
    expect(b.describe).not.toBe('');
    mine = b.id;
    const lab = await (await request.get(`${LAB}/root`)).json();
    expect(lab.build?.id).toBe(mine);
    const old = await (await request.get(`${OLD}/root`)).json();
    expect(old.build).toBeUndefined();
  });

  await test.step('home polls them: old is behind, lab is not (brain and /api/roots)', async () => {
    await expect
      .poll(
        async () => {
          const rs = ((await (await request.get(`${HOME}/root`)).json()).roots ?? []) as Peer[];
          return Object.fromEntries(rs.map((r) => [r.name, r.behind]));
        },
        { timeout: 60_000, intervals: [1000] }
      )
      .toEqual({ lab: false, old: true });
    const api = await (
      await request.get('/api/roots', { headers: { cookie: `bifrost_device=${TOKEN}` } })
    ).json();
    const by = Object.fromEntries(
      (api.roots as Array<Peer & { id: string }>).map((r) => [r.id, r])
    );
    expect(by.lab.behind).toBe(false);
    expect(by.lab.build?.id).toBe(mine);
    expect(by.old.behind).toBe(true);
    expect(by.old.build).toBeNull();
  });

  await test.step('the home screen: the roots key carries the mark, in --oz-active', async () => {
    await page.goto('/');
    const key = page.getByTestId('roots-key');
    await expect(key).toBeVisible({ timeout: 15_000 });
    await expect(key).toHaveClass(/\bmark\b/, { timeout: 15_000 });
    await expect(key).toHaveAttribute('data-behind', '1');
    const after = await key.evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return { bg: s.backgroundColor, w: s.width, h: s.height, content: s.content };
    });
    expect(after).toEqual({ bg: await activeColor(page), w: '7px', h: '7px', content: '""' });
    expect((page.viewportSize() ?? { width: 0 }).width).toBe(360);
    await shot(page, '1-home-key-mark');
  });

  await test.step('a root page wears the same header: its roots key has the mark too', async () => {
    for (const id of ['lab', 'old']) {
      await page.goto(`/roots/${id}`);
      await expect(page.getByTestId('root-view')).toHaveAttribute('data-root', id, {
        timeout: 15_000,
      });
      const key = page.getByTestId('roots-key');
      await expect(key).toHaveClass(/\bmark\b/, { timeout: 15_000 });
      await expect(key).toHaveAttribute('data-behind', '1');
      expect(await key.evaluate((el) => getComputedStyle(el, '::after').backgroundColor)).toBe(
        await activeColor(page)
      );
      await shot(page, `1b-root-${id}-key-mark`);
    }
    await page.goto('/');
    await expect(page.getByTestId('roots-key')).toBeVisible({ timeout: 15_000 });
  });

  await test.step('the roots sheet: old says "not up to date" in --oz-active; lab and home do not', async () => {
    await openSheet(page);
    await expect(row(page, 'old')).toHaveAttribute('data-state', 'on', { timeout: 15_000 });
    const mark = row(page, 'old').getByTestId('root-behind');
    await expect(mark).toHaveText('not up to date');
    await expect(row(page, 'old').locator('.oz-r2')).toHaveText('linux · not up to date');
    expect(await mark.evaluate((el) => getComputedStyle(el).color)).toBe(await activeColor(page));
    await expect(row(page, 'lab')).toBeVisible();
    await expect(row(page, 'lab').getByTestId('root-behind')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="root-row"]').first().getByTestId('root-behind')
    ).toHaveCount(0);
    await expect(page.getByTestId('root-behind')).toHaveCount(1);
    await shot(page, '2-sheet-old-not-up-to-date');
  });

  await test.step('old stops: it is off and keeps the marker (its last answer)', async () => {
    process.kill(OLD_PID, 'SIGTERM');
    await expect(row(page, 'old')).toHaveAttribute('data-state', 'off', { timeout: 75_000 });
    await expect(row(page, 'old').getByTestId('root-behind')).toHaveText('not up to date');
    await expect(row(page, 'old').getByTestId('root-state')).toHaveText(/last seen/);
    await shot(page, '3-sheet-old-off-keeps-marker');
  });

  await test.step('nobody behind (old removed): the home screen key has no mark', async () => {
    const r = await request.post('/api/roots/old/remove', {
      headers: { cookie: `bifrost_device=${TOKEN}` },
    });
    expect(r.ok()).toBe(true);
    await page.goto('/');
    const key = page.getByTestId('roots-key');
    await expect(key).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'roots', exact: true })).toBeVisible();
    await expect(key).not.toHaveClass(/\bmark\b/, { timeout: 15_000 });
    expect(await key.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none');
    await shot(page, '4-home-key-no-mark');
    await page.goto('/roots/lab');
    await expect(page.getByTestId('root-view')).toHaveAttribute('data-root', 'lab', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('roots-key')).not.toHaveClass(/\bmark\b/, { timeout: 15_000 });
  });
});
