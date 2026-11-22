import { devices, expect, test } from '@playwright/test';
import { OC } from './brain';

/** An existing role's default engine changes in the editor (owner 11-22: "I still can not change a
 *  agent type harness"). The "runs on by default" picker was enabled for a new role only; the brain's
 *  upsert always took a harness change. Now: picked, saved, still there after a reload — and the
 *  model the editor sends is the NEW harness's own (the brain refuses one it does not offer).
 *  The coordinator stays on the root: the brain locks its harness, the picker says so.
 *  Twin only (e2e/GUARD.md): PW_BASE_URL = an app whose brain is E2E_OC_URL. */
test.use({ ...devices['Pixel 7'] });

const NAME = `e2e-harness-${Date.now().toString(36)}`;

test('an existing agent changes harness, and the change survives a reload', async ({
  page,
  request,
}) => {
  const made = await request.put(`${OC}/agent/${NAME}`, {
    data: { harness: 'root', description: 'e2e: harness change' },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const brainAgent = async () => await (await request.get(`${OC}/agent/${NAME}`)).json();
  const runsOn = page.locator('.oz-blk', {
    has: page.getByRole('heading', { name: 'runs on by default', exact: true }),
  });
  const chip = (label: string) => runsOn.getByRole('button', { name: label, exact: true });
  try {
    await page.goto(`/agents/${NAME}`);
    await expect(chip('root')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip('Claude Code')).toBeEnabled();
    await expect(runsOn).toContainText(
      'a session can still take another engine in its own settings'
    );

    // root → Claude Code: saved with one of Claude Code's own models
    await chip('Claude Code').tap();
    await expect(chip('Claude Code')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'save', exact: true }).tap();
    await expect(page.getByText('saved', { exact: true })).toBeVisible();
    let a = await brainAgent();
    expect(a.harness).toBe('claude');
    expect(a.models_by_harness.claude).toContain(a.model || 'default');

    await page.reload();
    await expect(chip('Claude Code')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip('root')).toHaveAttribute('aria-pressed', 'false');

    // Claude Code → root: the root's served models, not Claude Code's
    await chip('root').tap();
    await page.getByRole('button', { name: 'save', exact: true }).tap();
    await expect(page.getByText('saved', { exact: true })).toBeVisible();
    a = await brainAgent();
    expect(a.harness).toBe('root');
    if (a.model) expect(a.models_by_harness.root).toContain(a.model);
    await page.reload();
    await expect(chip('root')).toHaveAttribute('aria-pressed', 'true');

    // the coordinator's harness is locked by the brain: the picker shows it, disabled
    await page.goto('/agents/coordinator');
    await expect(chip('root')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip('Claude Code')).toBeDisabled();
    await expect(page.getByTestId('locked-harness')).toBeVisible();
  } finally {
    await request.delete(`${OC}/agent/${NAME}`).catch(() => {});
  }
});
