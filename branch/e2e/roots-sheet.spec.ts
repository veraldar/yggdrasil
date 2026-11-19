import { readFileSync } from 'fs';
import { join } from 'path';
import { type APIRequestContext, type Locator, type Page, expect, test } from '@playwright/test';

/**
 * THE ROOTS SHEET (E2 · the whole tree), driven like a person on a phone (Pixel 7, taps):
 * home → the roots key → one row per computer with its state → tap lab → lab's MAIN first,
 * then its sessions → ＋ starts a session ON lab (lab's own GET /session has it) → back home:
 * that session's row carries the "lab" tag → hold lab → "Remove lab?" → Remove → gone
 * (roots.json marks it revoked, the home brain forgets it).
 *
 * The rig (sim/roots-sheet-e2e.sh): PW_HOME_BRAIN / PW_LAB_BRAIN (two brains on the mock
 * upstream), PW_BASE_URL (this app, devices mode, against home), PW_DEVICE_TOKEN (a seeded
 * device), PW_RIG_STATE (roots.json there), PW_SHOTS (where the screenshots go).
 */
const HOME = process.env.PW_HOME_BRAIN || '';
const LAB = process.env.PW_LAB_BRAIN || '';
const TOKEN = process.env.PW_DEVICE_TOKEN || '';
const STATE = process.env.PW_RIG_STATE || '';
const SHOTS = process.env.PW_SHOTS || '';
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
type RootJ = { name: string; reachable?: boolean; main?: string | null };

const sessionsOf = async (r: APIRequestContext, brain: string): Promise<Info[]> =>
  (await r.get(`${brain}/session`)).json();

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `p3-roots-${name}.png`) });
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

test('roots sheet: rows with state → lab: MAIN, sessions, ＋ there → tag at home → hold → remove', async ({
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

  await test.step('home → the roots key → home first (home · on), then lab (on · linux)', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'roots', exact: true }).tap();
    const sheet = page.getByTestId('roots-sheet');
    await expect(sheet).toBeVisible();
    const rows = sheet.getByTestId('root-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-root', 'home');
    await expect(rows.nth(0)).toContainText('home');
    await expect(rows.nth(0).getByTestId('root-state')).toHaveText('on');
    await expect(rows.nth(1)).toHaveAttribute('data-root', 'lab');
    await expect(rows.nth(1).getByTestId('root-state')).toHaveText('on');
    await expect(rows.nth(1)).toContainText('linux');
    await shot(page, 'sheet');
  });

  await test.step("tap lab → lab's MAIN on top, then its sessions", async () => {
    await page.getByTestId('root-row').nth(1).tap();
    const view = page.getByTestId('root-view');
    await expect(view).toHaveAttribute('data-root', 'lab');
    await expect(page.getByTestId('roots-title')).toHaveText('lab');
    await expect(view.getByTestId('root-main')).toBeVisible();
    await expect(view.getByTestId('root-sess').filter({ hasText: 'lab notes' })).toBeVisible();
    // MAIN is the first row of the view, the sessions under it
    const first = view.locator('[data-testid="root-main"], [data-testid="root-sess"]').first();
    await expect(first).toHaveAttribute('data-testid', 'root-main');
    await shot(page, 'lab');
  });

  await test.step("tap lab's MAIN → it opens (its proxy here)", async () => {
    await page.getByTestId('root-main').tap();
    await page.waitForURL(/\/session\/main-lab\?id=/, { timeout: 20_000 });
    const id = new URL(page.url()).searchParams.get('id');
    const proxy = (await sessionsOf(request, HOME)).find((s) => s.id === id);
    expect(proxy?.card?.kind).toBe('root-main');
    expect(proxy?.card?.root).toBe('lab');
  });

  const TITLE = `made on lab ${Date.now() % 100000}`;
  await test.step('＋ on lab → a session there, opened here', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'roots', exact: true }).tap();
    await page.getByTestId('root-row').nth(1).tap();
    await expect(page.getByTestId('root-main')).toBeVisible();
    await page.getByTestId('roots-new').tap();
    await page.getByTestId('roots-new-name').fill(TITLE);
    await page.getByTestId('roots-create').tap();
    await page.waitForURL(/\/session\/[^?]+\?id=/, { timeout: 30_000 });
    // it lives on lab: lab's own list has it
    await expect
      .poll(async () => (await sessionsOf(request, LAB)).some((s) => s.title === TITLE), {
        timeout: 15_000,
      })
      .toBe(true);
  });

  await test.step('back home: that session carries the "lab" tag; no MAIN of lab on the list', async () => {
    await page.goto('/');
    const row = page.locator('.oz-row', { hasText: TITLE });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId('root-tag')).toHaveText('[lab]');
    await expect(page.locator('.oz-row', { hasText: '[MAIN] lab' })).toHaveCount(0);
    // home's own sessions carry none: the one tag is lab's
    await expect(page.getByTestId('root-tag')).toHaveCount(1);
    await shot(page, 'home-tag');
  });

  await test.step('hold lab → "Remove lab?" → Remove → the row is gone', async () => {
    await page.getByRole('button', { name: 'roots', exact: true }).tap();
    const lab = page.locator('[data-testid="root-row"][data-root="lab"]');
    await expect(lab).toBeVisible();
    // a hold on home asks nothing
    await hold(page, page.locator('[data-testid="root-row"][data-root="home"]'));
    await expect(page.getByTestId('root-view')).toHaveAttribute('data-root', 'home');
    await page.getByTestId('roots-back').tap();
    await hold(page, lab);
    const ask = page.getByTestId('root-confirm');
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('Remove lab?');
    await expect(page.getByTestId('root-view')).toHaveCount(0); // the hold did not open it
    await shot(page, 'remove');
    await page.getByTestId('root-keep').tap();
    await expect(ask).toHaveCount(0);
    await expect(lab).toBeVisible();
    await hold(page, lab);
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
    // a reload keeps it gone
    await page.goto('/');
    await page.getByRole('button', { name: 'roots', exact: true }).tap();
    await expect(page.getByTestId('root-row')).toHaveCount(1);
  });
});
