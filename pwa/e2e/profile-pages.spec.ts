import { expect, test } from '@playwright/test';

/** Profiles referee — CATALOG-DERIVED (same law as settings.spec): every
 *  profile id and tool count is read from the SERVED registry
 *  (/api/profiles), never hardcoded — steward/coordinator/scout are being
 *  defined on the box; truth on :8090 today, truth under a stage server
 *  tomorrow. Green by product, never by env. Strictly read-only: the spec
 *  also proves NO edit surface exists (no inputs/buttons in profile blocks).
 *
 *  Run: PW_BASE_URL=http://127.0.0.1:8095 npx playwright test e2e/profile-pages.spec.ts */

type Profile = { id: string; description: string; tools: string[]; isDefault: boolean };

let profiles: Profile[];

test.beforeAll(async ({ request }) => {
  const r = await request.get('/api/profiles');
  expect(r.ok(), 'the served app must expose /api/profiles').toBeTruthy();
  profiles = (await r.json()) as Profile[];
  expect(
    profiles.length,
    'the registry must define at least 3 profiles (steward/coordinator/scout are being defined)'
  ).toBeGreaterThanOrEqual(3);
});

test('list: /settings/profiles shows every registry profile, each row opens its page', async ({
  page,
}) => {
  await page.goto('/settings/profiles');
  await expect(page.getByRole('heading', { name: 'agent profiles' })).toBeVisible();

  // every profile in the served registry is a row, linking to its own page
  const rows = page.getByTestId('profile-row');
  await expect(rows).toHaveCount(profiles.length);
  for (const p of profiles) {
    const row = rows.filter({ hasText: p.id });
    await expect(row.first()).toBeVisible();
    // registry truth: the default is marked, tool counts are shown (the
    // registry's own `*` allow reads as "all tools")
    if (p.isDefault) await expect(row.first()).toContainText('default');
    await expect(row.first()).toContainText(
      p.tools.includes('*') ? 'all tools' : `${p.tools.length} tools`
    );
  }

  // each profile's page opens and carries its OWN name (click through all)
  for (const p of profiles) {
    await page.goto('/settings/profiles');
    await rows.filter({ hasText: p.id }).first().click();
    await expect(page).toHaveURL(new RegExp(`/settings/profiles/${p.id}$`));
    await expect(page.getByTestId('profile-name')).toHaveText(p.id);
  }

  // back-navigation: detail → back → list
  await page.goto(`/settings/profiles/${profiles[0].id}`);
  await page.getByRole('link', { name: 'back' }).click();
  await expect(page).toHaveURL(/\/settings\/profiles$/);
});

test('detail: every profile page renders its granted tools as chips', async ({ page }) => {
  for (const p of profiles) {
    await page.goto(`/settings/profiles/${p.id}`);
    await expect(page.getByTestId('profile-name')).toHaveText(p.id);
    const chips = page.getByTestId('profile-tool');
    await expect(chips).toHaveCount(p.tools.length);
    for (const t of p.tools) {
      await expect(page.getByTestId('profile-tool').filter({ hasText: t }).first()).toBeVisible();
    }
  }
});

test('read-only: profile pages offer no edit surface — no forms, no inputs', async ({ page }) => {
  for (const url of ['/settings/profiles', ...profiles.map((p) => `/settings/profiles/${p.id}`)]) {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: /agent profiles|profile|allowed tools/ })).toBeVisible();
    await expect(page.locator('input, textarea, select')).toHaveCount(0);
  }
});

test('session settings: a profile-pinned session shows a read-only profile card with tools', async ({
  page,
}) => {
  const registryIds = profiles.map((p) => p.id);
  const pinned = registryIds[0];
  const name = `e2e-prof-${Date.now().toString(36)}`;
  const r = await page.request.post('/api/session', { data: { name } });
  const { id } = (await r.json()) as { id: string };
  expect(id).toBeTruthy();
  try {
    const pr = await page.request.patch(`/api/session/${id}`, { data: { agent: pinned } });
    const pinned_ok = pr.ok();
    await page.goto(`/session/${name}?id=${id}`);
    await page.getByRole("link", { name: "session settings" }).click();
    await expect(page).toHaveURL(new RegExp(`/session/${name}/settings`));
    await expect(page.getByTestId('profile-card')).toBeVisible();

    if (pinned_ok) {
      // the brain accepted a registry-named agent → the card shows THAT
      // profile's tools, chip for chip
      const p = profiles.find((x) => x.id === pinned)!;
      await expect(page.getByTestId('profile-card-name')).toHaveText(p.id);
      await expect(page.getByTestId('profile-card-tool')).toHaveCount(p.tools.length);
    } else {
      // brain-only agent set (build/plan): the card says the truth instead of
      // inventing tools — the no-card branch
      await expect(page.getByTestId('profile-card')).toContainText('defined on the brain');
    }
    // read-only: no inputs inside the card
    await expect(page.getByTestId('profile-card').locator('input, textarea')).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/session/${id}`);
  }
});

test('session settings: MAIN lands without a profile card lying — no card branch, link present', async ({
  page,
}) => {
  await page.goto('/session/MAIN/settings');
  await expect(page.getByTestId('profile-card')).toBeVisible();
  // MAIN runs the brain's own agent; no registry pin → the honest empty state
  await expect(page.getByTestId('profile-card-name')).toHaveCount(0);
  await expect(page.getByTestId('profile-card')).toContainText('no profile pinned');
  // the bridge to the browsed pages is there
  await expect(page.getByRole('link', { name: /browse all profiles/ })).toBeVisible();
});
