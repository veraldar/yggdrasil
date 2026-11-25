import { readFileSync, statSync } from 'node:fs';
import { devices, expect, test } from '@playwright/test';

/**
 * v1 · F7 model form (§4.1 item 13, §5.6 F7):
 *   - /roots/[root]/settings shows "set a model" when the root has none, with the model-step.sh
 *     presets (zai, openrouter, anthropic, openai, other) + "same as <root>", disabled unless
 *     pin state is "end to end".
 *   - PUT /api/roots/[root]/model → brain PUT /root/model writes the 0600 env file, restarts the
 *     brain, and the brain comes back serving the new model (key never in logs).
 */
test.use({ ...devices['Pixel 7'], serviceWorkers: 'block' });

let TRUNK = false;
test.beforeAll(async ({ request }) => {
  const r = await request.get('/t/state').catch(() => null);
  TRUNK = !!r?.ok() && /json/.test(r.headers()['content-type'] || '');
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('F7: /roots/[root]/settings shows "set a model" with presets + "same as <root>", disabled unless end to end', async ({
  page,
  request,
}) => {
  test.skip(!TRUNK, 'behind a v1 trunk only');
  const roots = await (await request.get('/api/roots')).json();
  const home = String(roots.home?.name || 'omarchy');

  await page.route(`**/api/roots/${encodeURIComponent(home)}/settings`, async (r) => {
    const real = await (await r.fetch()).json();
    await r.fulfill({ json: { ...real, has_model: false, models: [] } });
  });
  await page.route('**/api/roots', async (r) => {
    const real = await (await r.fetch()).json();
    await r.fulfill({
      json: { ...real, roots: [{ id: 'lab', name: 'lab', reachable: true, os: 'linux', running: 0 }] },
    });
  });

  await page.goto(`/roots/${encodeURIComponent(home)}/settings`);
  const block = page.getByTestId('root-model-block');
  await expect(block).toBeVisible({ timeout: 15_000 });
  await expect(block).toContainText('set a model');
  await expect(page.getByTestId('model-pin-guard')).toBeVisible();
  // All 5 presets from root/install/model-step.sh:19-33 + "same as lab"
  for (const id of ['zai', 'openrouter', 'anthropic', 'openai', 'other', 'same-lab']) {
    const btn = page.getByTestId(`model-provider-${id}`);
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
  }
  await expect(page.getByTestId('model-key')).toBeDisabled();
  await expect(page.getByTestId('model-save')).toBeDisabled();
});

test('F7: PUT /api/roots/[root]/model writes 0600 env file, restarts brain, and brain comes back with the new model', async ({
  request,
}) => {
  test.skip(!TRUNK, 'behind a v1 trunk only');
  const envFile = process.env.E2E_BRAIN_ENV_FILE;
  const brainLog = process.env.E2E_BRAIN_LOG;
  test.skip(!envFile, 'set E2E_BRAIN_ENV_FILE to verify env file + restart');

  const roots = await (await request.get('/api/roots')).json();
  const home = String(roots.home?.name || 'omarchy');
  const secretKey = 'sk-e2e-never-log-this-key-9942';
  const newModel = 'e2e-restarted-model-v1';

  const put = await request.put(`/api/roots/${encodeURIComponent(home)}/model`, {
    data: {
      base_url: 'http://127.0.0.1:19041',
      style: 'openai',
      model: newModel,
      api_key: secretKey,
      models: `${newModel},glm-5.3-flash`,
    },
  });
  expect(put.status(), await put.text()).toBe(200);
  const body = await put.json();
  expect(body.ok).toBe(true);
  expect(body.model).toBe(newModel);
  expect(body.restarting).toBe(true);

  // env file exists with mode 0600
  const mode = statSync(envFile!).mode & 0o777;
  expect(mode).toBe(0o600);
  const envText = readFileSync(envFile!, 'utf8');
  expect(envText).toContain(`YGG_UPSTREAM_MODEL=${newModel}`);
  expect(envText).toContain(`YGG_UPSTREAM_API_KEY=${secretKey}`);

  // wait for systemd to restart the twin brain and serve the new model
  await expect
    .poll(
      async () => {
        const r = await request.get(`/api/roots/${encodeURIComponent(home)}/settings`).catch(() => null);
        if (!r?.ok()) return '';
        const d = await r.json().catch(() => null);
        return Array.isArray(d?.models) ? d.models[0] : '';
      },
      { timeout: 15_000, intervals: [250, 500, 500] }
    )
    .toBe(newModel);

  // secret key never appears in brain.log
  if (brainLog) {
    expect(readFileSync(brainLog, 'utf8')).not.toContain(secretKey);
  }
});
