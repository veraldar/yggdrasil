import { mkdir, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { type Page, expect, test } from '@playwright/test';
import { OC } from './brain';

/** Copy-link keys at 360px (proposal artifact-copy-proposal.html, KISS):
 *  - artifacts grid: a copy key in each card's corner, tap = the full /api/artifact/<name> URL
 *    on the clipboard, check for 2 s; tapping the card itself still opens it;
 *  - chat: a full-width "copy link" key under every inline artifact (html, md, text, pdf).
 *  The list view is unchanged (no key). */
test.use({
  viewport: { width: 360, height: 780 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

const DIR = process.env.E2E_ARTIFACTS_DIR || path.join(process.cwd(), '..', 'artifacts');
const madeFiles: string[] = [];
const madeSessions: string[] = [];

test.beforeAll(async () => {
  await mkdir(DIR, { recursive: true });
});

test.afterAll(async () => {
  for (const f of madeFiles) await unlink(path.join(DIR, f)).catch(() => {});
  for (const sid of madeSessions) {
    await fetch(`${OC}/session/${sid}`, { method: 'DELETE' }).catch(() => {});
  }
});

async function seedSessionWithReply(title: string, replyText: string): Promise<string> {
  const created = await fetch(`${OC}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  expect(created.ok, `create session → ${created.status}`).toBe(true);
  const { id } = (await created.json()) as { id: string };
  madeSessions.push(id);
  const msg = await fetch(`${OC}/session/${id}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: `reply with exactly: ${replyText}` }] }),
  });
  expect(msg.ok, `seed message → ${msg.status}`).toBe(true);
  return `/session/${title}?id=${id}`;
}

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('clipboard allowed', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  });

  test('grid: corner copy key puts the full artifact URL on the clipboard; card still opens', async ({
    page,
    baseURL,
  }) => {
    const name = `e2e-copy-grid-${Date.now().toString(36)}.html`;
    madeFiles.push(name);
    await writeFile(path.join(DIR, name), '<!doctype html><meta charset="utf-8"><h1>grid</h1>');
    await page.goto('/artifacts');

    const grid = page.getByTestId('artifact-grid');
    await expect(grid).toBeVisible();
    const card = grid.locator('div.relative', { has: page.getByLabel(name, { exact: true }) });
    const key = card.getByTestId('artifact-copy-key');
    await expect(key).toBeVisible();

    // the key sits in the card's top-right corner beside "open in new tab", thumb-sized
    const [cBox, kBox, tabBox] = await Promise.all([
      card.boundingBox(),
      key.boundingBox(),
      card.getByRole('button', { name: `open ${name} in new tab` }).boundingBox(),
    ]);
    expect(cBox && kBox && tabBox).toBeTruthy();
    if (cBox && kBox && tabBox) {
      expect(kBox.width).toBeGreaterThanOrEqual(28);
      expect(kBox.height).toBeGreaterThanOrEqual(28);
      expect(kBox.x + kBox.width).toBeLessThanOrEqual(cBox.x + cBox.width + 1);
      expect(kBox.y).toBeLessThanOrEqual(cBox.y + 12);
      expect(kBox.x).toBeGreaterThanOrEqual(tabBox.x + tabBox.width - 1); // no overlap
      expect(kBox.x + kBox.width).toBeLessThanOrEqual(360);
    }
    expect(await noOverflow(page)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: 'test-results/artifact-copy-grid-360.png' });

    await key.click();
    const want = `${baseURL}/api/artifact/${encodeURIComponent(name)}`;
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(want);
    await expect(key).toHaveAttribute('aria-label', `${name} link copied`);
    await page.screenshot({ path: 'test-results/artifact-copy-grid-copied-360.png' });
    // back to idle after ~2 s
    await expect(key).toHaveAttribute('aria-label', `copy link to ${name}`, { timeout: 5000 });

    // tapping the card itself is unchanged: an html card opens the artifact page
    await expect(page).toHaveURL(/\/artifacts$/);
    await card.getByLabel(name, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/api/artifact/${name}$`));
  });

  test('list view: no copy key', async ({ page }) => {
    const name = `e2e-copy-list-${Date.now().toString(36)}.md`;
    madeFiles.push(name);
    await writeFile(path.join(DIR, name), 'list');
    await page.goto('/artifacts');
    await page.getByRole('button', { name: 'all' }).click();
    await expect(page.getByTestId('artifact-list')).toBeVisible();
    await expect(page.getByTestId('artifact-copy-key')).toHaveCount(0);
  });

  const KINDS: { kind: string; ext: string; body: Buffer | string }[] = [
    { kind: 'html', ext: 'html', body: '<!doctype html><meta charset="utf-8"><h1>x</h1>' },
    { kind: 'md', ext: 'md', body: '# Copy md\n\nbody' },
    { kind: 'text', ext: 'txt', body: 'line 1\nline 2\n' },
    { kind: 'pdf', ext: 'pdf', body: '%PDF-1.1\n%%EOF\n' },
  ];
  for (const k of KINDS) {
    test(`chat (${k.kind}): full-width copy button under the artifact, copies the full URL`, async ({
      page,
      baseURL,
    }) => {
      const name = `e2e-copy-chat-${k.kind}-${Date.now().toString(36)}.${k.ext}`;
      madeFiles.push(name);
      await writeFile(path.join(DIR, name), k.body);
      const url = await seedSessionWithReply(
        `e2e-copy-${k.kind}-${Date.now().toString(36)}`,
        `Here it is: /api/artifact/${name}`
      );
      await page.goto(url);

      const btn = page.getByTestId('artifact-copy');
      await expect(btn).toBeVisible();
      await expect(btn).toHaveText('copy link');
      const bBox = await btn.boundingBox();
      expect(bBox).toBeTruthy();
      if (bBox) {
        expect(bBox.height).toBeGreaterThanOrEqual(28);
        expect(bBox.x + bBox.width).toBeLessThanOrEqual(360);
        // "full width of the artifact": same left/right edges as the preview above it
        const prev =
          k.kind === 'pdf'
            ? page.getByRole('link', { name: new RegExp(`${name} — tap to view`) })
            : page.locator(`[data-testid="artifact-preview"][data-artifact-kind="${k.kind}"]`);
        const pBox = await prev.boundingBox();
        expect(pBox).toBeTruthy();
        if (pBox) {
          expect(bBox.y).toBeGreaterThanOrEqual(pBox.y + pBox.height - 1); // under it
          if (k.kind !== 'pdf') {
            expect(Math.abs(bBox.x - pBox.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(bBox.width - pBox.width)).toBeLessThanOrEqual(1);
          }
        }
      }
      expect(await noOverflow(page)).toBeLessThanOrEqual(1);

      await btn.click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        `${baseURL}/api/artifact/${name}`
      );
      await expect(btn).toHaveText('copied');
      await page.screenshot({ path: `test-results/artifact-copy-chat-${k.kind}-360.png` });
      await expect(btn).toHaveText('copy link', { timeout: 5000 });
      expect(await noOverflow(page)).toBeLessThanOrEqual(1);
    });
  }
});

test('clipboard API blocked: falls back to execCommand and still copies the URL', async ({
  page,
  baseURL,
}) => {
  const name = `e2e-copy-fallback-${Date.now().toString(36)}.md`;
  madeFiles.push(name);
  await writeFile(path.join(DIR, name), '# fallback');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    (window as unknown as { __copied: string }).__copied = '';
    document.execCommand = (cmd: string) => {
      if (cmd !== 'copy') return false;
      const el = document.activeElement as HTMLTextAreaElement | null;
      (window as unknown as { __copied: string }).__copied = el?.value ?? '';
      return true;
    };
  });
  const url = await seedSessionWithReply(
    `e2e-copy-fb-${Date.now().toString(36)}`,
    `See /api/artifact/${name}`
  );
  await page.goto(url);
  const btn = page.getByTestId('artifact-copy');
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(btn).toHaveText('copied');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe(
    `${baseURL}/api/artifact/${name}`
  );
});
