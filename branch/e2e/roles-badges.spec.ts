import { mkdirSync } from 'fs';
import { type APIRequestContext, type Page, devices, expect, test } from '@playwright/test';
import { sessionTag } from '../lib/agents';
import { OC } from './brain';

/** Roles and badges (roles rework 11-22, ROLES-CONTRACT.md). The badge is the ROLE — [MAI] for
 *  MAIN, [LEA] [BUI] [FIX] [REV] [RES], [TRM] for the owner's own terminal conversation — never
 *  the engine; the engine is a small grey word at the right of the row (claude · agy · opencode ·
 *  codex, none on the root). A session's settings say "role" and "runs on" apart; an engine
 *  switch says what changes first, always with the fresh-start warning. The "agents" page is the
 *  roles page (no `claude` / `agy` roles, no engines block); the engines block lives on /settings.
 *  Twin only (e2e/GUARD.md): PW_BASE_URL = an app whose brain is E2E_OC_URL. Seeds its sessions
 *  through the brain (POST /session {agent, engine}) and deletes them after. */
// the app's service worker relays /api/* once it controls the page: page.route (two mocked
// answers below) would miss those requests
test.use({ ...devices['Pixel 7'], serviceWorkers: 'block' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.E2E_SHOTS || '/tmp/roles-badges-shots';
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });

const tag = Date.now().toString(36).slice(-5);
const LEAD = `e2e-rb-lead-${tag}`; // a lead on Antigravity
const BUILD = `e2e-rb-build-${tag}`; // a build on the root
const REV = `e2e-rb-rev-${tag}`; // a review on Claude Code
const ids: string[] = [];

type Info = { id: string; title: string; agent?: string; engine?: string };
type Engine = { name: string; model: string | null; models: string[] };
const LABEL: Record<string, string> = {
  root: 'root',
  claude: 'Claude Code',
  antigravity: 'Antigravity',
  opencode: 'opencode',
  codex: 'Codex',
};

async function seed(request: APIRequestContext, title: string, agent: string, engine: string) {
  const r = await request.post(`${OC}/session`, { data: { title, agent, engine } });
  expect(r.ok(), await r.text()).toBe(true);
  const s = (await r.json()) as Info;
  ids.push(s.id);
  return s;
}
const brain = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`${OC}/session/${id}`)).json()) as Info;
const row = (page: Page, title: string) =>
  page.locator('.oz-row').filter({ has: page.locator('.t', { hasText: title }) });
const blk = (page: Page, h: string) =>
  page.locator('.oz-blk', { has: page.getByRole('heading', { name: h, exact: true }) });
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let lead: Info;
let build: Info;
let rev: Info;

test.beforeAll(async ({ request }) => {
  lead = await seed(request, LEAD, 'lead', 'antigravity');
  build = await seed(request, BUILD, 'build', 'root');
  rev = await seed(request, REV, 'review', 'claude');
});

test.afterAll(async ({ request }) => {
  for (const id of ids) await request.delete(`/api/session/${id}`).catch(() => {});
});

test('the badge rule: MAIN is MAI, a terminal conversation TRM, else the role — never the engine', () => {
  expect(sessionTag({ agent: 'coordinator' }, true)).toBe('MAI');
  expect(sessionTag({ agent: 'coordinator' })).toBe('MAI'); // a proxy of another root's MAIN
  expect(sessionTag({ agent: 'lead', harness: 'claude' })).toBe('TRM'); // a list row: attached kind
  expect(sessionTag({ agent: 'build', harness: { kind: 'claude', attached: true } })).toBe('TRM');
  expect(sessionTag({ agent: 'lead', harness: { kind: 'antigravity' } })).toBe('LEA');
  expect(sessionTag({ agent: 'claude' })).toBe('BUI'); // an old root's engine-named agents
  expect(sessionTag({ agent: 'agy' })).toBe('BUI');
  expect(sessionTag({ agent: 'docs' })).toBe('DOC');
  expect(sessionTag({})).toBe('BUI');
});

test('the list: the badge is the role, the engine a grey word (none on the root)', async ({
  page,
}) => {
  // the brain stamps both: the role and what runs it
  expect([lead.agent, lead.engine]).toEqual(['lead', 'antigravity']);
  expect([build.agent, build.engine]).toEqual(['build', 'root']);
  expect([rev.agent, rev.engine]).toEqual(['review', 'claude']);
  await page.goto('/');
  const l = row(page, LEAD);
  await expect(l.locator('.t')).toHaveText(new RegExp(`^\\[LEA\\]\\s*${esc(LEAD)}$`));
  await expect(l.getByTestId('engine-word')).toHaveText('agy');
  const b = row(page, BUILD);
  await expect(b.locator('.t')).toHaveText(new RegExp(`^\\[BUI\\]\\s*${esc(BUILD)}$`));
  await expect(b.getByTestId('engine-word')).toHaveCount(0);
  const r = row(page, REV);
  await expect(r.locator('.t')).toHaveText(new RegExp(`^\\[REV\\]\\s*${esc(REV)}$`));
  await expect(r.getByTestId('engine-word')).toHaveText('claude');
  // never an engine badge, never the status word "terminal"
  await expect(page.locator('.oz-row .t', { hasText: /^\[(CLA|AGY|OPE|COD)\]/ })).toHaveCount(0);
  await expect(page.locator('.oz-row .oz-st', { hasText: 'terminal' })).toHaveCount(0);
  await shot(page, '1-list');
});

test('the list: a terminal conversation is [TRM] with its engine word; an old root\'s "claude" role is [BUI]', async ({
  page,
}) => {
  // a terminal conversation needs a real Claude Code conversation on the brain's box: the row is
  // the proxy's shape, added to the real list here (the badge rule is the app's)
  await page.route('**/api/session', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const rows = (await res.json()) as Record<string, unknown>[];
    const base = rows.find((x) => x.id === build.id)!;
    await route.fulfill({
      response: res,
      json: [
        {
          ...base,
          id: 'ses_e2e_trm',
          title: `e2e-rb-term-${tag}`,
          harness: 'claude',
          engine: 'claude',
        },
        {
          ...base,
          id: 'ses_e2e_old',
          title: `e2e-rb-old-${tag}`,
          agent: 'claude',
          engine: 'claude',
        },
        ...rows,
      ],
    });
  });
  await page.goto('/');
  const t = row(page, `e2e-rb-term-${tag}`);
  await expect(t.locator('.t')).toHaveText(/^\[TRM\]/);
  await expect(t.getByTestId('engine-word')).toHaveText('claude');
  await expect(t.locator('.oz-st')).toHaveCount(0); // [TRM] says it: no "terminal" word
  await expect(row(page, `e2e-rb-old-${tag}`).locator('.t')).toHaveText(/^\[BUI\]/);
});

test('settings: "role" and "runs on" apart, the right chips pressed; an engine switch says what changes first', async ({
  page,
  request,
}) => {
  await page.goto(`/session/${LEAD}/settings`);
  const role = blk(page, 'role');
  const runsOn = blk(page, 'runs on');
  const leadChip = role.getByRole('button', { name: 'lead', exact: true });
  await expect(leadChip).toHaveAttribute('aria-pressed', 'true');
  await expect(leadChip).toContainText('[LEA]');
  await expect(role.getByRole('button', { name: 'build', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await expect(role.getByRole('button', { name: 'coordinator', exact: true })).toHaveCount(0);
  await expect(role.getByRole('button', { name: /claude|agy/ })).toHaveCount(0);
  const chip = (n: string) => runsOn.getByRole('button', { name: n, exact: true });
  await expect(chip('Antigravity')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('root')).toHaveAttribute('aria-pressed', 'false');
  await expect(chip('Claude Code')).toHaveAttribute('aria-pressed', 'false');
  // opencode and Codex sit behind "more engines"
  await expect(chip('opencode')).toBeHidden();
  await runsOn.getByText('more engines', { exact: true }).tap();
  await expect(chip('Codex')).toBeVisible();
  // the role's own default, as the brain has it
  const def = (await (await request.get(`${OC}/agent/lead`)).json()) as {
    harness?: string | null;
    model?: string | null;
  };
  const engines = (await (await request.get(`${OC}/engine`)).json()) as Engine[];
  const defEngine = def.harness || 'root';
  const defModel = def.model || engines.find((e) => e.name === defEngine)?.model || 'default';
  await expect(runsOn.getByTestId('engine-note')).toHaveText(
    `the lead's default: ${LABEL[defEngine]} · ${defModel}`
  );
  // the model block follows the engine: Antigravity's models only
  const pick = blk(page, 'model').locator('button.oz-pick');
  await pick.tap();
  await expect(
    page.getByRole('button', { name: /^antigravity\/gemini-4-carbon/ }).first()
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^yggdrasil\// })).toHaveCount(0);
  await pick.tap();
  await shot(page, '2-settings-lead-agy');

  // Antigravity → root: what changes, first — with the fresh-start warning; keep = nothing
  await chip('root').tap();
  const diff = page.getByTestId('engine-diff');
  await expect(diff.getByRole('heading', { name: 'what changes' })).toBeVisible();
  await expect(diff).toContainText('lead (unchanged)');
  await expect(diff).toContainText('Antigravity → root');
  const next =
    defEngine === 'root' && def.model ? def.model : engines.find((e) => e.name === 'root')!.model;
  await expect(diff).toContainText(`→ ${next}`);
  await expect(diff).toContainText("Antigravity's own → the root's:");
  await expect(diff).toContainText(
    '⚠ the new engine starts fresh: it sees only new messages, not this conversation'
  );
  await shot(page, '3-settings-what-changes');
  await diff.getByRole('button', { name: 'keep' }).tap();
  await expect(diff).toHaveCount(0);
  expect((await brain(request, lead.id)).engine).toBe('antigravity');

  // switch: the brain moves it to the root, the role stays
  await chip('root').tap();
  await diff.getByRole('button', { name: 'switch' }).tap();
  await expect.poll(async () => (await brain(request, lead.id)).engine).toBe('root');
  expect((await brain(request, lead.id)).agent).toBe('lead');
  await expect(chip('root')).toHaveAttribute('aria-pressed', 'true');
  await expect(pick).toContainText(`yggdrasil/${next}`);
  // the list follows: still [LEA], no grey word now
  await page.goto('/');
  await expect(row(page, LEAD).locator('.t')).toHaveText(/^\[LEA\]/);
  await expect(row(page, LEAD).getByTestId('engine-word')).toHaveCount(0);
});

test('settings: a role switch says what changes first and keeps the engine', async ({
  page,
  request,
}) => {
  await page.goto(`/session/${BUILD}/settings`);
  const role = blk(page, 'role');
  await expect(role.getByRole('button', { name: 'build', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await role.getByRole('button', { name: 'research', exact: true }).tap();
  await expect(page.getByTestId('role-desc')).toBeVisible(); // what the role is for
  const diff = page.getByTestId('role-diff');
  await expect(diff).toContainText('build → research');
  await expect(diff).toContainText('root (unchanged)');
  await expect(diff).not.toContainText('starts fresh');
  expect((await brain(request, build.id)).agent).toBe('build'); // nothing before 'switch'
  await diff.getByRole('button', { name: 'switch' }).tap();
  await expect.poll(async () => (await brain(request, build.id)).agent).toBe('research');
  expect((await brain(request, build.id)).engine).toBe('root');
  await expect(role.getByRole('button', { name: 'research', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

test('settings: a review off the root is read-only by instruction, not by a lock', async ({
  page,
}) => {
  await page.goto(`/session/${REV}/settings`);
  const runsOn = blk(page, 'runs on');
  await expect(runsOn.getByRole('button', { name: 'Claude Code', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(runsOn.getByTestId('review-note')).toHaveText(
    'read-only by instruction, not by a lock'
  );
  // moving it to the root: the note goes (the brain enforces read-only there)
  await runsOn.getByRole('button', { name: 'root', exact: true }).tap();
  await expect(page.getByTestId('engine-diff')).toBeVisible();
  await expect(page.getByTestId('review-note')).toHaveCount(0);
  await page.getByTestId('engine-diff').getByRole('button', { name: 'keep' }).tap();
});

test('settings: MAIN is the coordinator on the root — both locked', async ({ page, request }) => {
  const main = await request.get('/api/session/main');
  test.skip(!main.ok(), 'no MAIN session on this brain');
  await page.goto('/session/main/settings');
  const role = blk(page, 'role');
  await expect(role.getByRole('button', { name: 'coordinator', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(role.getByRole('button', { name: 'coordinator', exact: true })).toContainText(
    '[MAI]'
  );
  await expect(role.getByRole('button')).toHaveCount(1); // no other role offered
  const runsOn = blk(page, 'runs on');
  await expect(runsOn.getByRole('button', { name: 'root', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(runsOn.getByRole('button', { name: 'Claude Code', exact: true })).toBeDisabled();
  await expect(runsOn.getByTestId('engine-note')).toHaveText(
    'locked: MAIN always runs on the root'
  );
  await expect(role.getByRole('link', { name: 'roles ›' })).toBeVisible();
});

test('settings: a terminal conversation has no role and runs on its own engine, locked', async ({
  page,
}) => {
  // as the brain answers for an attached conversation (it needs a real one on the box): the
  // summary of a real session, marked attached
  await page.route(`**/api/session/${BUILD}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const d = await res.json();
    await route.fulfill({
      response: res,
      json: {
        ...d,
        agent: 'build',
        engine: 'claude',
        harness: { kind: 'claude', id: '00000000-0000-4000-8000-000000000000', attached: true },
        instructions: 'shared',
        model: { providerID: 'claude', modelID: 'opus', variant: null, variants: [] },
      },
    });
  });
  await page.goto(`/session/${BUILD}/settings`);
  const role = blk(page, 'role');
  await expect(role.getByTestId('no-role')).toHaveText('your terminal conversation: no role');
  await expect(role.locator('button[aria-pressed="true"]')).toHaveCount(0);
  const runsOn = blk(page, 'runs on');
  await expect(runsOn.getByRole('button', { name: 'Claude Code', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(runsOn.getByRole('button', { name: 'root', exact: true })).toBeDisabled();
  await expect(runsOn.getByTestId('engine-note')).toHaveText(
    'locked: your terminal conversation runs on Claude Code'
  );
  // picking a role gives it that role: it starts reading the role's instructions
  await role.getByRole('button', { name: 'lead', exact: true }).tap();
  const diff = page.getByTestId('role-diff');
  await expect(diff).toContainText('none → lead');
  await expect(diff).toContainText('the shared prompt only →');
  await diff.getByRole('button', { name: 'keep' }).tap();
});

test('the roles page has no engines block; engines live on /settings and save to the brain', async ({
  page,
  request,
}) => {
  await page.goto('/settings');

  // engines live on /settings: root · Claude Code · Antigravity; opencode and Codex in the fold
  const block = page.getByTestId('engines-block');
  await expect(block.getByRole('heading', { name: 'engines', exact: true })).toBeVisible();
  const eng = (n: string) => block.locator(`[data-testid="engine-row"][data-engine="${n}"]`);
  for (const n of ['root', 'claude', 'antigravity']) await expect(eng(n)).toBeVisible();
  await expect(eng('opencode')).toBeHidden();
  await block.getByText('more engines (installed, unused)').tap();
  await expect(eng('opencode')).toBeVisible();
  await expect(eng('codex')).toBeVisible();

  // a tap opens Claude Code's models; a pick saves its default at the brain
  const before = ((await (await request.get(`${OC}/engine`)).json()) as Engine[]).find(
    (e) => e.name === 'claude'
  )!;
  const to = before.models.find((m) => m !== (before.model || 'default'))!;
  try {
    await eng('claude')
      .getByRole('button', { name: /Claude Code/ })
      .tap();
    await expect(
      eng('claude').getByRole('button', { name: before.model || 'default', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await eng('claude').getByRole('button', { name: to, exact: true }).tap();
    await expect
      .poll(
        async () =>
          ((await (await request.get(`${OC}/engine`)).json()) as Engine[]).find(
            (e) => e.name === 'claude'
          )?.model
      )
      .toBe(to === 'default' ? null : to);
    await expect(eng('claude')).toContainText(`${to} ›`);
  } finally {
    await request.put(`${OC}/engine/claude`, { data: { model: before.model } }).catch(() => {});
  }

  // roles page: roles with their badge and default engine, no claude/agy roles, no engines block
  await page.getByTestId('agents-link').tap();
  await page.waitForURL(/\/agents$/);
  await expect(page.locator('header')).toContainText('roles');
  const rows = page.getByTestId('agent-row');
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId('engines-block')).toHaveCount(0);
  await expect(page.getByTestId('engine-row')).toHaveCount(0);
  await expect(page.locator('[data-testid="agent-row"][data-role="claude"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="agent-row"][data-role="agy"]')).toHaveCount(0);
  expect((await request.get('/api/agents/claude')).status()).toBe(404);
  const leadRow = page.locator('[data-testid="agent-row"][data-role="lead"]');
  await expect(leadRow).toContainText('[LEA]');
  const coord = page.locator('[data-testid="agent-row"][data-role="coordinator"]');
  await expect(coord).toContainText('[MAI]');
  await expect(coord).toContainText('locked');
  await expect(coord.locator('.tag')).toHaveText('root');
  await expect(page.getByRole('button', { name: 'new role' })).toBeVisible();
  await shot(page, '4-roles-page');
});
