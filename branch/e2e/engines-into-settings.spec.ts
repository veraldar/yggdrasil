import { mkdirSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { OC } from './brain';

/** Engines moved from /agents (roles page) into /settings (360×780 Android touch).
 *  Runs against an isolated rig (PW_BASE_URL + E2E_OC_URL), never a live brain. */
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.E2E_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

type Engine = { name: string; model: string | null; models: string[] };

async function noOverflow(page: Page, where: string) {
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(sw, `${where}: horizontal overflow (${sw}px > ${cw}px)`).toBeLessThanOrEqual(cw);
}

test('settings hosts the engines block, saves default model, and fits 360px cleanly', async ({
  page,
  request,
}) => {
  const beforeList = (await (await request.get(`${OC}/engine`)).json()) as Engine[];
  const before = beforeList.find((e) => e.name === 'claude')!;
  expect(before, 'brain exposes claude engine').toBeTruthy();
  const nextModel = before.models.find((m) => m !== (before.model || 'default'))!;
  expect(nextModel, 'claude exposes an alternate model').toBeTruthy();

  await page.goto('/settings');
  const block = page.getByTestId('engines-block');
  await expect(block).toBeVisible();
  await expect(block.getByRole('heading', { name: 'engines', exact: true })).toBeVisible();

  const eng = (n: string) => block.locator(`[data-testid="engine-row"][data-engine="${n}"]`);
  for (const n of ['root', 'claude', 'antigravity']) await expect(eng(n)).toBeVisible();
  await expect(eng('opencode')).toBeHidden();
  await expect(eng('codex')).toBeHidden();
  await noOverflow(page, '/settings closed');

  // open more engines fold
  await block.getByText('more engines (installed, unused)').tap();
  await expect(eng('opencode')).toBeVisible();
  await expect(eng('codex')).toBeVisible();
  await noOverflow(page, '/settings with more engines open');

  // open Claude Code row, pick another default model, verify persistence across reload
  try {
    await eng('claude')
      .getByRole('button', { name: /Claude Code/ })
      .tap();
    await expect(
      eng('claude').getByRole('button', { name: before.model || 'default', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await noOverflow(page, '/settings with claude open');
    await shot(page, '1-settings-engines-open');

    const put = page.waitForResponse(
      (r) => r.url().endsWith('/api/engines/claude') && r.request().method() === 'PUT'
    );
    await eng('claude').getByRole('button', { name: nextModel, exact: true }).tap();
    expect((await put).status()).toBe(200);
    await expect(eng('claude')).toContainText(`· ${nextModel}`);

    await expect
      .poll(
        async () =>
          ((await (await request.get(`${OC}/engine`)).json()) as Engine[]).find(
            (e) => e.name === 'claude'
          )?.model
      )
      .toBe(nextModel === 'default' ? null : nextModel);

    // reload /settings: saved default stays
    await page.reload();
    await expect(eng('claude')).toContainText(`· ${nextModel}`);
    await shot(page, '2-settings-engines-saved');
  } finally {
    await request.put(`${OC}/engine/claude`, { data: { model: before.model } }).catch(() => {});
  }
});

test('roles page (/agents) and role editor (/agents/lead) no longer show the engines section', async ({
  page,
}) => {
  await page.goto('/settings');
  await page.getByTestId('agents-link').tap();
  await page.waitForURL(/\/agents$/);

  await expect(page.getByRole('heading', { name: 'roles', exact: true })).toBeVisible();
  await expect(page.getByTestId('agent-row').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'new role' })).toBeVisible();
  await expect(page.getByTestId('engines-block')).toHaveCount(0);
  await expect(page.getByTestId('engine-row')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'engines', exact: true })).toHaveCount(0);
  await noOverflow(page, '/agents');
  await shot(page, '3-agents-no-engines');

  // open a role editor: its own "runs on by default" stays, no engines section
  await page.locator('[data-testid="agent-row"][data-role="lead"]').tap();
  await page.waitForURL(/\/agents\/lead$/);
  await expect(
    page.getByRole('heading', { name: 'runs on by default', exact: true })
  ).toBeVisible();
  await expect(page.getByTestId('engines-block')).toHaveCount(0);
  await noOverflow(page, '/agents/lead');
});

test('settings shows inline refusal when engine save fails and hides engines on 404 (older brain)', async ({
  page,
}) => {
  await page.route('**/api/engines/claude', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'model not offered' }),
        })
      : route.fallback()
  );
  await page.goto('/settings');
  const claude = page.locator('[data-testid="engine-row"][data-engine="claude"]');
  await expect(claude).toBeVisible();
  await claude.getByRole('button', { name: /Claude Code/ }).tap();
  await claude.getByRole('button', { name: 'haiku', exact: true }).tap();
  await expect(claude.getByRole('alert')).toHaveText('model not offered');

  // older brain without /engine (404): settings still renders cleanly without engines block
  await page.unroute('**/api/engines/claude');
  await page.route('**/api/engines', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' })
  );
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'about', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'world', exact: true })).toBeVisible();
  await expect(page.getByTestId('agents-link')).toBeVisible();
  await expect(page.getByTestId('engines-block')).toHaveCount(0);
});
