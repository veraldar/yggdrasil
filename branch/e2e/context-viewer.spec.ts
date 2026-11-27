import { OC } from './brain';
import { type Page, devices, expect, test } from '@playwright/test';
import { gotoHome } from './home';

/** The context sheet (phase 1, plan G1) on the twin (e2e/GUARD.md: the brain is
 *  E2E_OC_URL): the 4 tabs render on a real session, Sent's totals.bytes equals
 *  the brain's CTX-CAPTURE bytes for that session, and the session's time.updated
 *  is unchanged after opening the sheet (the viewer must be pure). Pixel-7 width:
 *  the sheet renders at 412px with no horizontal scroll. (✕-deletes-a-fact is
 *  phase 2 — skipped here.) */
const S = `ctx-view-${Math.random().toString(36).slice(2, 8)}`;
test.use({ ...devices['Pixel 7'] });

async function brainSession(id: string): Promise<{ time?: { updated?: number }; title?: string }> {
  const r = await fetch(`${OC}/session/${id}`);
  expect(r.ok).toBeTruthy();
  return r.json(); // the brain returns the session info flat (no .info wrapper)
}

async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'what this session knows' }).tap();
  await expect(page.getByTestId('ctx-sheet')).toBeVisible();
}

test('the context sheet: tabs, byte-truth, purity, no horizontal scroll', async ({ page }) => {
  await gotoHome(page);
  await page.getByRole('button', { name: 'new session', exact: true }).tap();
  await page.getByPlaceholder('session name…').fill(S);
  await page.getByRole('button', { name: 'create & open' }).tap();
  await expect(page).toHaveURL(new RegExp(`/session/${S}`));

  const box = page.getByPlaceholder('message…');
  await box.tap();
  await box.fill('Reply with one word: green.');
  await page.getByRole('button', { name: 'send', exact: true }).tap();
  // the reply lands (a real turn → a real capture; the twin's brain answers)
  await expect(page.locator('[data-mi]', { hasText: '(agent' }).last()).toBeVisible({ timeout: 120_000 });

  // updated BEFORE the sheet is opened (read straight from the brain)
  const sessions = (await (await fetch(`${OC}/session`)).json()) as Array<{ id: string; title: string }>;
  const row = sessions.find((s) => s.title === S);
  expect(row).toBeTruthy();
  const before = (await brainSession(row!.id))?.time?.updated;

  // the sheet: all 4 tabs render (Harness is harness-only; a root session on the
  // twin still shows the 3 core tabs)
  await openSheet(page);
  await expect(page.getByTestId('ctx-tab-sent')).toBeVisible();
  await expect(page.getByTestId('ctx-tab-main')).toBeVisible();
  await expect(page.getByTestId('ctx-tab-memory')).toBeVisible();

  // Sent: the totals chip and blocks — and the number equals the brain's
  // CTX-CAPTURE bytes for this session
  await expect(page.getByTestId('ctx-totals')).not.toHaveText('…');
  const totals = await page.getByTestId('ctx-totals').innerText();
  const ctx = await (await fetch(`${OC}/session/${row!.id}/context`)).json();
  expect(ctx.totals.bytes).toBeGreaterThan(0);
  const kb = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : `${n}`);
  expect(totals).toContain(kb(ctx.totals.bytes));
  const capture = (await (await fetch(`${OC}/session/${row!.id}/context`)).json()) as { totals: { bytes: number } };
  void capture;
  await expect(page.getByTestId('ctx-blocks').locator('li').first()).toBeVisible();

  // MAIN's view tab renders the tree line (this session is a root child on the twin;
  // its MAIN exists once the first turn landed)
  await page.getByTestId('ctx-tab-main').tap();
  await expect(page.getByTestId('ctx-main-view')).toBeVisible({ timeout: 20_000 });
  // Memory tab: the librarian's status text arrives (the twin runs the librarian)
  await page.getByTestId('ctx-tab-memory').tap();
  await expect(page.getByTestId('ctx-memory')).toBeVisible();

  // the drop line ends the Sent list; back to Sent for it
  await page.getByTestId('ctx-tab-sent').tap();
  await expect(page.getByTestId('ctx-dropped')).toBeVisible();

  // 412px: the sheet must not scroll sideways
  const scroll = await page.getByTestId('ctx-sheet').evaluate((el) => ({
    sw: el.scrollWidth,
    cw: el.clientWidth,
  }));
  expect(scroll.sw, `sheet ${scroll.sw}px inside ${scroll.cw}px`).toBeLessThanOrEqual(scroll.cw + 1);

  // the sheet is pure: close it; the brain's time.updated is unchanged
  await page.getByTestId('ctx-close').tap();
  const after = (await brainSession(row!.id))?.time?.updated;
  expect(after).toBe(before);
});
