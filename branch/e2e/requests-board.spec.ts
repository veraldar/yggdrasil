import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/** The requests board at 360 px, on the rig brain's copy of the live sessions. */
const SHOTS =
  process.env.RB_SHOTS ||
  path.join(os.homedir(), 'Work/root-coord-pwa/artifacts/requests-board-pwa-shots');
const BRAIN = process.env.E2E_OC_URL || 'http://127.0.0.1:19700';

test.use({ viewport: { width: 360, height: 740 } });

async function noOverflow(page: import('@playwright/test').Page) {
  const w = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(w.sw, 'no sideways scroll').toBeLessThanOrEqual(w.cw);
}

test('cards render from the copied live data, grouped, owner words exact', async ({
  page,
  request,
}) => {
  const rows: { status: string; text: string }[] = await (
    await request.get(`${BRAIN}/asks?limit=300`)
  ).json();
  expect(rows.length).toBeGreaterThan(50);
  const res = await page.goto('/requests');
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId('requests-view')).toBeVisible();
  await expect(page.getByTestId('ask-card').first()).toBeVisible();

  // grouped by status: every card sits in the group of its own status
  const groups = await page
    .locator('[data-testid^="group-"][data-testid$="done"], section[data-testid^="group-"]')
    .count();
  expect(groups).toBeGreaterThanOrEqual(3);
  for (const s of ['blocked', 'asked', 'done', 'answered']) {
    const g = page.getByTestId(`group-${s}`);
    if (await g.count()) {
      for (const st of await g
        .getByTestId('ask-card')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))) {
        expect(st).toBe(s);
      }
    }
  }

  // owner words are exact: a short ask appears verbatim, with its time
  const short = rows.find((r) => r.status === 'done' && r.text.length < 200)!;
  const card = page.getByTestId('ask-card').filter({ hasText: short.text });
  await expect(card.getByTestId('ask-text').first()).toHaveText(short.text);
  await expect(card.getByTestId('ask-when').first()).toContainText('asked');

  // a done card shows branch + commit
  const done = page.getByTestId('group-done');
  await expect(done).toBeVisible();
  const git = done.getByTestId('ask-git').first();
  await expect(git).toContainText('artifact-copy-ui');
  await expect(git).toContainText('b37fe433');

  await noOverflow(page);
  await page.screenshot({ path: path.join(SHOTS, 'live-top.png') });
  await page.getByTestId('group-done').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'live-done.png') });
});

test('a ask long as an essay clamps and opens', async ({ page, request }) => {
  const rows: { status: string; text: string }[] = await (
    await request.get(`${BRAIN}/asks?limit=2000`)
  ).json();
  const long = rows.find((r) => r.text.length > 400)!;
  await page.goto('/requests');
  for (const s of ['answered', 'asked', 'blocked', 'done']) {
    if (long.status === s) {
      const head = page.getByTestId(`group-head-${s}`);
      if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
    }
  }
  // the long ask may sit beyond the first page of its group — show more until it is there
  const key = long.text.slice(0, 40);
  const text = page.getByTestId('ask-text').filter({ hasText: key }).first();
  for (let i = 0; i < 30 && !(await text.count()); i++) {
    const more = page.getByRole('button', { name: /^show \d+ more$/ }).first();
    if (!(await more.count())) break;
    await more.click();
  }
  await expect(text).toBeVisible();
  const before = (await text.textContent())!.length;
  expect(before).toBeLessThan(long.text.length);
  await text.locator('xpath=following-sibling::button').click();
  await expect(text).toHaveText(long.text);
  await noOverflow(page);
});

test('every status group, plain words (stalled and running from fixed rows)', async ({ page }) => {
  const now = Date.now();
  const mk = (id: string, status: string, text: string, why: string, extra = {}) => ({
    id,
    text,
    created: now - 3600e3,
    home: { id: 'ses_main', title: '[MAIN]' },
    session: { id: 'ses_x' + id, title: 'Build ' + id },
    status,
    why,
    branch: '',
    commit: '',
    note: '',
    updated: now,
    ...extra,
  });
  const rows = [
    mk(
      'b1',
      'blocked',
      'fix the settings buttons so every row is one bare button',
      'waiting on an answer or a fix',
      { note: 'stuck rig lock' }
    ),
    mk(
      's1',
      'stalled',
      'ship the trunk to the new VPS',
      'busy but nothing has happened for 42 min'
    ),
    mk(
      'r1',
      'running',
      'make a board with cards to remember what I asked',
      'working now · last activity 2 min'
    ),
    mk('a1', 'asked', 'also add the artifact button at the top of main', 'not picked up yet'),
    mk('d1', 'done', 'copy link keys on artifacts', 'finished and landed', {
      branch: 'artifact-copy-ui',
      commit: 'b37fe433aaaa',
    }),
    mk('c1', 'answered', 'status?', 'answered, nothing to land'),
  ];
  await page.route('**/api/asks', (r) => r.fulfill({ json: rows }));
  await page.goto('/requests');
  for (const s of ['blocked', 'stalled', 'running', 'asked', 'done']) {
    await expect(page.getByTestId(`group-${s}`).getByTestId('ask-card')).toHaveCount(1);
    await page.getByTestId(`group-${s}`).screenshot({ path: path.join(SHOTS, `group-${s}.png`) });
  }
  await page.getByTestId('group-head-answered').click();
  await expect(page.getByTestId('group-answered').getByTestId('ask-card')).toHaveCount(1);
  await page
    .getByTestId('group-answered')
    .screenshot({ path: path.join(SHOTS, 'group-answered.png') });
  await noOverflow(page);
  await page.screenshot({ path: path.join(SHOTS, 'all-groups.png'), fullPage: true });
  // no jargon: no raw ids, no "ses_", no "msg_" on the page
  const body = await page.locator('main').innerText();
  expect(body).not.toMatch(/ses_|msg_|undefined|\[object/);
});
