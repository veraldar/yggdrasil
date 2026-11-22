import { type APIRequestContext, type Page, devices, expect, test } from '@playwright/test';

/** ROOT-COORD UI fixes (11-13), driven like a person on a phone (Pixel 7, taps, no reloads)
 *  against a root-coord brain on a real upstream: E2E_OC_URL = that brain, PW_BASE_URL = this
 *  build served against it (the scratch pair :4191 / :8191). */
const OC = process.env.E2E_OC_URL || 'http://127.0.0.1:4191';
test.use({ ...devices['Pixel 7'] });

type Info = { id: string; title: string; agent?: string; parentID?: string };
type BrainMsg = {
  info: { role: string; time: { completed?: number }; meta?: Record<string, unknown> };
  parts: { type: string; text?: string; tool?: string }[];
};

const sessions = async (r: APIRequestContext): Promise<Info[]> =>
  (await r.get(`${OC}/session`)).json();
const mainOf = async (r: APIRequestContext) => {
  const s = (await sessions(r)).find((x) => x.title === '[MAIN]');
  expect(s, 'the brain has a [MAIN]').toBeTruthy();
  return s!;
};
const brainMsgs = async (r: APIRequestContext, id: string, internal = false): Promise<BrainMsg[]> =>
  (await r.get(`${OC}/session/${id}/message${internal ? '?internal=1' : ''}`)).json();

/** type into the composer and tap send — the way a thumb does it */
async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('message…');
  await box.tap();
  await box.fill(text);
  await page.getByRole('button', { name: 'send', exact: true }).tap();
}

/** an agent message containing `token` shows up on screen — polls only, never a reload. Spaces
 *  inside the token are tolerated: glm-5.3-flash once answered "pong mwewit 9n" (11-13) */
async function replyShows(page: Page, token: string, timeout = 150_000) {
  await expect(
    page
      .locator('[data-mi]', { hasText: '(agent' })
      .filter({ hasText: new RegExp(token.split('').join('\\s*')) })
  ).toBeVisible({
    timeout,
  });
}

test('live: a session reached in-app from MAIN (route tag) shows its reply without a reload', async ({
  page,
  request,
}) => {
  test.setTimeout(6 * 60_000);
  const main = await mainOf(request);
  const child = (await sessions(request)).find((s) => s.parentID === main.id);
  test.skip(!child, 'MAIN has no child session on this brain to route to');
  await page.goto(`/session/main?id=${main.id}`);
  const link = page.locator('a[data-route]', { hasText: child!.title }).first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.tap();
  await page.waitForURL(new RegExp(`id=${child!.id}`));
  const token = `pong${Date.now().toString(36)}`;
  await send(page, `Reply with exactly this one word and nothing else: ${token}`);
  await replyShows(page, token);
});

test('fix this on MAIN: a fix-agent session tagged [FIX], runs a tool, then answers live', async ({
  page,
  request,
}) => {
  test.setTimeout(8 * 60_000);
  const main = await mainOf(request);
  await page.goto(`/session/main?id=${main.id}`);
  // the send fails once (the proxy says 500) — MAIN never sees the message
  await page.route('**/api/session/main/messages', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, json: { error: 'e2e: forced send failure' } })
      : route.fallback()
  );
  await send(page, 'this send is made to fail');
  const fix = page.getByRole('alert').getByRole('button', { name: 'fix this' });
  await expect(fix).toBeVisible({ timeout: 20_000 });
  await page.unroute('**/api/session/main/messages');
  await fix.tap();
  await page.waitForURL(/\/session\/fix-main-[^?]+\?id=ses_/, { timeout: 30_000 });
  const id = new URL(page.url()).searchParams.get('id')!;
  try {
    const info = (await (await request.get(`${OC}/session/${id}`)).json()) as Info;
    expect(info.agent, 'the fixing session runs its own agent').toBe('fix');
    // it works with tools (the coordinator could not): wait for its first tool call…
    await expect
      .poll(
        async () =>
          (await brainMsgs(request, id)).some((m) => m.parts.some((p) => p.type === 'tool')),
        { timeout: 180_000, intervals: [1000] }
      )
      .toBe(true);
    // …then stop the investigation the way a person would (the working row's cancel)
    const cancel = page.getByRole('button', { name: 'cancel' });
    await expect(cancel).toBeVisible({ timeout: 20_000 });
    await cancel.tap();
    await expect(cancel).toHaveCount(0, { timeout: 30_000 });
    // live after the in-app hop from MAIN: a reply lands on screen without a reload
    const token = `pong${Date.now().toString(36)}`;
    await send(
      page,
      `Stop the investigation. Reply with exactly this one word and nothing else: ${token}`
    );
    await replyShows(page, token);
    // the session list says which agent runs it: [FIX] before the title
    await page.goto('/');
    await expect(page.getByText(/^\[FIX\]\s*fix main/).first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await request.post(`${OC}/session/${id}/abort`).catch(() => {});
    await request.delete(`/api/session/${id}`).catch(() => {});
  }
});

test('settings: one role section — MAIN shows coordinator, locked on the root, never switches', async ({
  page,
  request,
}) => {
  const main = await mainOf(request);
  await page.goto(`/session/main?id=${main.id}`);
  await page.getByRole('link', { name: 'session settings' }).tap();
  await page.waitForURL(/\/session\/main\/settings/);
  const blk = (h: string) =>
    page.locator('.oz-blk', { has: page.getByRole('heading', { name: h, exact: true }) });
  await expect(blk('role')).toHaveCount(1);
  await expect(blk('agent')).toHaveCount(0); // the word on screen is "role"
  await expect(blk('profile')).toHaveCount(0); // the separate profile card is gone
  await expect(page.getByTestId('profile-card')).toHaveCount(0);
  const chip = (n: string) => blk('role').getByRole('button', { name: n, exact: true });
  await expect(chip('coordinator')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('lead')).toHaveCount(0); // MAIN is offered no other role
  await chip('coordinator').tap();
  await expect(page.getByTestId('role-desc')).toBeVisible(); // a tap explains
  // and it runs on the root, locked
  const runsOn = blk('runs on');
  await expect(runsOn.getByRole('button', { name: 'root', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(runsOn.getByRole('button', { name: 'Claude Code', exact: true })).toBeDisabled();
  await page.waitForTimeout(1500); // a write would have landed by now
  const info = (await (await request.get(`${OC}/session/${main.id}`)).json()) as Info & {
    engine?: string;
  };
  expect([info.agent, info.engine ?? 'root']).toEqual(['coordinator', 'root']);
});

test('settings: another session switches (after what changes), never to the coordinator', async ({
  page,
  request,
}) => {
  const s = (await (
    await request.post('/api/session', { data: { name: `e2e-agent-${Date.now().toString(36)}` } })
  ).json()) as Info;
  try {
    const agents = (await (await request.get('/api/agents')).json()) as {
      name: string;
      description: string;
    }[];
    const research = agents.find((a) => a.name === 'research');
    test.skip(!research, 'this brain has no research profile');
    await page.goto(`/session/${s.title}?id=${s.id}`);
    await page.getByRole('link', { name: 'session settings' }).tap();
    const blk = page.locator('.oz-blk', {
      has: page.getByRole('heading', { name: 'role', exact: true }),
    });
    await expect(blk.getByRole('button', { name: 'research', exact: true })).toBeVisible();
    await expect(blk.getByRole('button', { name: 'coordinator', exact: true })).toHaveCount(0);
    await blk.getByRole('button', { name: 'research', exact: true }).tap();
    await page.getByTestId('role-diff').getByRole('button', { name: 'switch' }).tap();
    await expect(blk.getByRole('button', { name: 'research', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect
      .poll(async () => ((await (await request.get(`${OC}/session/${s.id}`)).json()) as Info).agent)
      .toBe('research');
  } finally {
    await request.delete(`/api/session/${s.id}`);
  }
});

test('artifacts: an html artifact opens rendered — new tab and in place', async ({
  page,
  context,
}) => {
  const dir = process.env.E2E_ARTIFACTS_DIR;
  test.skip(!dir, 'E2E_ARTIFACTS_DIR = the artifacts dir the served app reads');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const name = `e2e-render-${Date.now().toString(36)}.html`;
  const file = `${dir}/${name}`;
  writeFileSync(
    file,
    '<!doctype html><title>e2e</title><h1 id="e2e-rendered">rendered, not source</h1>'
  );
  try {
    await page.goto('/artifacts');
    const opener = page.getByRole('button', { name: `open ${name} in new tab` });
    await expect(opener).toBeVisible({ timeout: 20_000 });
    const [tab] = await Promise.all([context.waitForEvent('page'), opener.tap()]);
    await tab.waitForLoadState();
    await expect(tab.locator('#e2e-rendered')).toHaveText('rendered, not source');
    expect(await tab.locator('body').innerText()).not.toContain('<h1');
    await tab.close();
    // the card itself opens the page in place
    await page.getByRole('button', { name, exact: true }).tap();
    await page.waitForURL(new RegExp(`/api/artifact/${name}`));
    await expect(page.locator('#e2e-rendered')).toHaveText('rendered, not source');
  } finally {
    unlinkSync(file);
  }
});

test('full log on MAIN: internal turns + tool calls behind the header key', async ({
  page,
  request,
}) => {
  test.setTimeout(10 * 60_000);
  const main = await mainOf(request);
  const done = async () =>
    (await brainMsgs(request, main.id)).filter(
      (m) => m.info.role === 'assistant' && m.info.time.completed
    ).length;
  await page.goto(`/session/main?id=${main.id}`);
  const before = await done();
  const folder = `logt${Date.now().toString(36)}`;
  await send(
    page,
    `build me a tiny python script hi.py in a folder named ${folder} that prints hi, with one pytest test`
  );
  // MAIN routes it (one reply), then comes back unprompted when the session reports (another)
  await expect
    .poll(done, { timeout: 7 * 60_000, intervals: [5000] })
    .toBeGreaterThanOrEqual(before + 2);
  const inbox = page.locator('.oz-internal', { hasText: '[inbox]' });
  const started = page.locator('.oz-log', { hasText: 'session_start' });
  await expect(inbox).toHaveCount(0); // the clean conversation is the default
  await expect(started).toHaveCount(0);
  const key = page.getByRole('button', { name: 'show the full log' });
  await key.tap();
  await expect(inbox.last()).toBeVisible({ timeout: 20_000 });
  await expect(started.last()).toBeVisible();
  await expect(page.getByText(/· session_start → ".+" \(build\)/).last()).toBeVisible();
  await page.getByRole('button', { name: 'hide the full log' }).tap();
  await expect(inbox).toHaveCount(0);
  await expect(started).toHaveCount(0);
});

test('roles: from MAIN settings — no claude/agy roles, the engines, make tester, a session takes it and moves engine (what changes first), delete', async ({
  page,
  request,
}) => {
  test.setTimeout(4 * 60_000);
  const NAME = 'tester';
  await request.delete(`${OC}/agent/${NAME}`).catch(() => {}); // a leftover from an aborted run
  const main = await mainOf(request);
  const s = (await (
    await request.post('/api/session', { data: { name: `e2e-agents-${Date.now().toString(36)}` } })
  ).json()) as Info;
  const brainSession = async () =>
    (await (await request.get(`${OC}/session/${s.id}`)).json()) as Info & {
      engine?: string;
      model?: { id?: string; providerID?: string };
    };
  try {
    // MAIN's settings → roles
    await page.goto(`/session/main?id=${main.id}`);
    await page.getByRole('link', { name: 'session settings' }).tap();
    await page.getByRole('link', { name: 'roles ›' }).tap();
    await page.waitForURL(/\/agents$/);
    // claude and agy are engines now, not roles
    await expect(page.getByTestId('agent-row').first()).toBeVisible();
    await expect(page.locator('[data-testid="agent-row"][href="/agents/claude"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="agent-row"][href="/agents/agy"]')).toHaveCount(0);
    // the engines block: Claude Code's own models, each with what it is for
    const cc = page.locator('[data-testid="engine-row"][data-engine="claude"]');
    await cc.getByRole('button', { name: /Claude Code/ }).tap();
    await expect(cc.getByRole('button', { name: 'haiku', exact: true })).toBeVisible();
    await expect(cc.getByText(/strong/).first()).toBeVisible();
    await cc.getByRole('button', { name: /Claude Code/ }).tap(); // closed, nothing saved
    // a new root role: read + bash only, glm-5.3-flash
    await page.getByRole('button', { name: 'new role' }).tap();
    await page.getByLabel('new role name').fill(NAME);
    await page.getByRole('button', { name: 'create', exact: true }).tap();
    await page.waitForURL(new RegExp(`/agents/${NAME}`));
    await page.getByLabel('description').fill('e2e: reads and runs, nothing else');
    await page.getByRole('button', { name: 'glm-5.3-flash', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'read', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await page.getByRole('button', { name: 'bash', exact: true }).tap();
    await page.getByRole('button', { name: 'create role' }).tap();
    await expect(page.getByText('saved', { exact: true })).toBeVisible();
    const made = await (await request.get(`${OC}/agent/${NAME}`)).json();
    expect(
      Object.entries(made.tools)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort()
    ).toEqual(['bash', 'read']);
    expect(made.model).toBe('glm-5.3-flash');
    await page.getByRole('button', { name: 'back' }).tap();
    await expect(page.getByTestId('agent-row').filter({ hasText: NAME })).toBeVisible();

    // a throwaway session: on glm-5.2 first, then it takes tester — what changes comes first
    await page.goto(`/session/${s.title}?id=${s.id}`);
    await page.getByRole('link', { name: 'session settings' }).tap();
    await page.waitForURL(/\/settings$/);
    const modelPick = page.locator('.oz-pick');
    await modelPick.tap();
    await page.getByRole('button', { name: 'yggdrasil/glm-5.2', exact: true }).tap();
    await expect(modelPick).toContainText('glm-5.2');
    const roleBlk = page.locator('.oz-blk', {
      has: page.getByRole('heading', { name: 'role', exact: true }),
    });
    await roleBlk.getByRole('button', { name: NAME, exact: true }).tap();
    const diff = page.getByTestId('role-diff');
    await expect(diff).toBeVisible();
    await expect(diff).toContainText(`build → ${NAME}`);
    await expect(diff).toContainText('root (unchanged)');
    // it runs on tester's default engine (the root) and tester names a model: it takes it
    await expect(diff).toContainText('glm-5.2 → glm-5.3-flash');
    await expect(diff).toContainText('tools');
    await expect(diff).toContainText('−write'); // build (the brain's default it ran) wrote; tester doesn't
    expect((await brainSession()).agent).not.toBe(NAME); // nothing applied before 'switch'
    await diff.getByRole('button', { name: 'switch' }).tap();
    await expect(diff).toHaveCount(0);
    await expect.poll(async () => (await brainSession()).agent).toBe(NAME);
    expect((await brainSession()).engine).toBe('root');
    await expect(modelPick).toContainText('glm-5.3-flash');
    // the model stays the user's to change
    await modelPick.tap();
    await page.getByRole('button', { name: 'yggdrasil/glm-5.3', exact: true }).tap();
    await expect(modelPick).toContainText('yggdrasil/glm-5.3');
    await expect
      .poll(async () => (await brainSession()).model?.id)
      .toMatch(/^glm-5\.3(-think-\w+)?$/);
    expect((await brainSession()).agent).toBe(NAME);
    // runs on Claude Code: what changes says the engine moves, the role stays, it starts fresh
    const runsOn = page.locator('.oz-blk', {
      has: page.getByRole('heading', { name: 'runs on', exact: true }),
    });
    await runsOn.getByRole('button', { name: 'Claude Code', exact: true }).tap();
    const ediff = page.getByTestId('engine-diff');
    await expect(ediff).toContainText(`${NAME} (unchanged)`);
    await expect(ediff).toContainText('root → Claude Code');
    await expect(ediff).toContainText('the new engine starts fresh');
    await ediff.getByRole('button', { name: 'switch' }).tap();
    await expect.poll(async () => (await brainSession()).engine).toBe('claude');
    expect((await brainSession()).agent).toBe(NAME);
    // on Claude Code the session picks from Claude's models, not the root's
    await modelPick.tap();
    await expect(page.getByRole('button', { name: /claude\/haiku/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /yggdrasil\// })).toHaveCount(0);
    await page.getByRole('button', { name: /claude\/sonnet/ }).tap();
    await expect
      .poll(async () => (await brainSession()).model)
      .toEqual({ id: 'sonnet', providerID: 'claude' });
    // customize ‹role› › opens its editor
    await expect(page.getByRole('link', { name: `customize ${NAME} ›` })).toBeVisible();

    // a new role on opencode: its own models, grouped by provider, picked from a list
    const OC_NAME = `${NAME}-oc`;
    const ocList: string[] = (await (await request.get(`${OC}/agent/build`)).json())
      .models_by_harness.opencode;
    await page.goto('/agents');
    await page.getByRole('button', { name: 'new role' }).tap();
    await page.getByLabel('new role name').fill(OC_NAME);
    await page.getByRole('button', { name: 'create', exact: true }).tap();
    await page.waitForURL(new RegExp(`/agents/${OC_NAME}`));
    await page.getByRole('button', { name: 'opencode', exact: true }).tap();
    const pick = ocList[Math.min(3, ocList.length - 1)];
    if (ocList.length > 8) {
      expect(await page.locator('select[aria-label="model"] optgroup').count()).toBeGreaterThan(1);
      await page.getByLabel('model').selectOption(pick);
    } else {
      await page.getByRole('button', { name: pick, exact: true }).tap();
    }
    await page.getByRole('button', { name: 'create role' }).tap();
    await expect(page.getByText('saved', { exact: true })).toBeVisible();
    const oc = await (await request.get(`${OC}/agent/${OC_NAME}`)).json();
    expect([oc.harness, oc.model]).toEqual(['opencode', pick === 'default' ? null : pick]);
    await page.getByRole('button', { name: 'delete role' }).tap();
    await page.getByRole('button', { name: 'tap again to delete' }).tap();
    await page.waitForURL(/\/agents$/);
    await page.goto(`/session/${s.title}/settings?id=${s.id}`);

    // delete tester: two taps, back on the list without it
    await page.goto(`/agents/${NAME}`);
    await page.getByRole('button', { name: 'delete role' }).tap();
    await page.getByRole('button', { name: 'tap again to delete' }).tap();
    await page.waitForURL(/\/agents$/);
    await expect(page.getByTestId('agent-row').first()).toBeVisible();
    await expect(page.getByTestId('agent-row').filter({ hasText: NAME })).toHaveCount(0);
    expect((await request.get(`${OC}/agent/${NAME}`)).status()).toBe(404);
  } finally {
    await request.delete(`/api/session/${s.id}`).catch(() => {});
    await request.delete(`${OC}/agent/${NAME}`).catch(() => {});
    await request.delete(`${OC}/agent/${NAME}-oc`).catch(() => {});
  }
});

test('roles: one shared prompt, stored once — edit it on the roles page, every role reads it once; [TAG]s in the session list', async ({
  page,
  request,
}) => {
  test.setTimeout(3 * 60_000);
  const main = await mainOf(request);
  const s = (await (
    await request.post('/api/session', { data: { name: `e2e-tags-${Date.now().toString(36)}` } })
  ).json()) as Info;
  const was = (await (await request.get('/api/shared-prompt')).json()) as {
    prompt: string;
    custom: boolean;
  };
  const original = was.prompt;
  const marker = `e2e marker ${Date.now().toString(36)}`;
  try {
    // MAIN's settings → roles: the shared prompt, once, with the intent section
    await page.goto(`/session/main?id=${main.id}`);
    await page.getByRole('link', { name: 'session settings' }).tap();
    await page.getByRole('link', { name: 'roles ›' }).tap();
    await page.waitForURL(/\/agents$/);
    const shared = page.getByLabel('shared prompt');
    await expect(shared).toHaveValue(
      /Re-interpret the user's intent before you do what you are asked/
    );
    // edit it here, once
    await shared.fill(`${original}\n\n${marker}`);
    await page.getByRole('button', { name: 'save', exact: true }).tap();
    await expect(page.getByText(/saved — every role reads it/)).toBeVisible();
    // build: one prompt of its own, no per-model choice; the shared text arrives once
    await page.locator('[data-testid="agent-row"][data-role="build"]').tap();
    await page.waitForURL(/\/agents\/build$/);
    await expect(page.getByRole('group', { name: 'model tier' })).toHaveCount(0);
    await expect(page.getByLabel('system prompt')).not.toHaveValue(/Re-interpret/);
    await page.getByText(/everything the model reads/).tap();
    const full = page.getByTestId('system-full');
    await expect(full).toContainText(marker);
    await expect(full).toContainText('[agent: build]');
    await expect(full).toContainText('that is how the tree brings your question to them.');
    const text = (await full.textContent()) || '';
    expect(text.split("Re-interpret the user's intent").length - 1, 'the shared text once').toBe(1);
    // a role on Claude Code gets the same shared prompt with its instructions
    const cc = `e2e-cc-${Date.now().toString(36)}`;
    const put = await request.put(`${OC}/agent/${cc}`, {
      data: { harness: 'claude', description: 'e2e: shared prompt on Claude Code' },
    });
    expect(put.ok(), await put.text()).toBe(true);
    try {
      await page.goto(`/agents/${cc}`);
      await page.getByText(/everything the model reads/).tap();
      await expect(page.getByTestId('system-full')).toContainText(marker);
    } finally {
      await request.delete(`${OC}/agent/${cc}`).catch(() => {});
    }
    // the session list: the agent in three capitals before the title; MAIN keeps its own
    await page.goto('/');
    await expect(page.getByText(new RegExp(`^\\[BUI\\]\\s*${s.title}$`))).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/^\[COO\]/)).toHaveCount(0);
  } finally {
    await request
      .put('/api/shared-prompt', { data: { prompt: was.custom ? original : '' } })
      .catch(() => {});
    await request.delete(`/api/session/${s.id}`).catch(() => {});
  }
});
