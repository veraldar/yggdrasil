import { mkdir, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { OC } from './brain';

/** Inline chat artifact previews (html, md, text) each carry a small,
 *  thumb-sized top-right corner button at 360px that opens the artifact URL
 *  in a new browser tab — matching the artifacts list page's corner button. */
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

async function assertTopRightThumbButton(page: Page, preview: Locator, btn: Locator) {
  await expect(preview).toBeVisible();
  await expect(btn).toBeVisible();
  const [pBox, bBox] = await Promise.all([preview.boundingBox(), btn.boundingBox()]);
  expect(pBox, 'preview bounding box').toBeTruthy();
  expect(bBox, 'button bounding box').toBeTruthy();
  if (!pBox || !bBox) return;

  // Thumb-sized and non-intrusive at 360px (matches .oz-k.sm = 28px+ key)
  expect(bBox.width).toBeGreaterThanOrEqual(28);
  expect(bBox.height).toBeGreaterThanOrEqual(28);
  expect(bBox.width).toBeLessThanOrEqual(48);
  expect(bBox.height).toBeLessThanOrEqual(48);

  // Inside the top-right corner of the inline preview
  expect(bBox.x).toBeGreaterThanOrEqual(pBox.x + pBox.width / 2);
  expect(bBox.x + bBox.width).toBeLessThanOrEqual(pBox.x + pBox.width + 1);
  expect(bBox.y).toBeGreaterThanOrEqual(pBox.y - 1);
  expect(bBox.y + bBox.height).toBeLessThanOrEqual(pBox.y + 48);

  // Fits within the 360px viewport with no horizontal overflow
  expect(bBox.x + bBox.width).toBeLessThanOrEqual(360);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test('html inline preview at 360px: corner button visible and opens artifact in new tab', async ({
  page,
}) => {
  const name = `e2e-inline-${Date.now().toString(36)}.html`;
  madeFiles.push(name);
  await writeFile(
    path.join(DIR, name),
    '<!doctype html><meta charset="utf-8"><body style="margin:12px;min-height:1000px"><h1 id="inline-html">Inline HTML Artifact</h1><p>Scrollable content</p></body>'
  );

  const url = await seedSessionWithReply(
    `e2e-art-html-${Date.now().toString(36)}`,
    `Here is the mockup: /api/artifact/${name}`
  );
  await page.goto(url);

  const preview = page.locator('[data-testid="artifact-preview"][data-artifact-kind="html"]');
  await expect(preview).toBeVisible();
  const iframe = preview.locator('iframe');
  await expect(iframe).toHaveAttribute('src', `/api/artifact/${name}`);

  const openBtn = preview.getByRole('link', { name: `open ${name} in new tab` });
  await assertTopRightThumbButton(page, preview, openBtn);
  await expect(openBtn).toHaveAttribute('href', `/api/artifact/${name}`);
  await expect(openBtn).toHaveAttribute('target', '_blank');
  await expect(openBtn).toHaveAttribute('rel', /noopener/);

  await page.screenshot({ path: 'test-results/artifact-preview-html-360.png' });

  const [popup] = await Promise.all([page.waitForEvent('popup'), openBtn.click()]);
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(new RegExp(`/api/artifact/${name}$`));
  await expect(popup.locator('#inline-html')).toHaveText('Inline HTML Artifact');
  await popup.close();

  // Original chat tab stays on the session
  await expect(page).toHaveURL(/\/session\//);
});

test('md inline preview at 360px: scrolls, keeps top-right button visible, opens rendered page in new tab', async ({
  page,
}) => {
  const name = `e2e-very-long-inline-markdown-artifact-name-${Date.now().toString(36)}.md`;
  madeFiles.push(name);
  const longMd = [
    '# Inline Markdown Report',
    '',
    ...Array.from({ length: 40 }, (_, i) => `- Section line ${i + 1}: details for phone reading`),
  ].join('\n');
  await writeFile(path.join(DIR, name), longMd);

  const url = await seedSessionWithReply(
    `e2e-art-md-${Date.now().toString(36)}`,
    `Read the full report: /api/artifact/${name}`
  );
  await page.goto(url);

  const preview = page.locator('[data-testid="artifact-preview"][data-artifact-kind="md"]');
  await expect(preview).toBeVisible();
  await expect(preview.getByText('Inline Markdown Report')).toBeVisible();

  // Confirm the preview body scrolls inside its fixed max-height box
  const scroller = preview.locator('.overflow-auto').first();
  const scrollMetrics = await scroller.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);

  const openBtn = preview.getByRole('link', { name: `open ${name} in new tab` });
  await assertTopRightThumbButton(page, preview, openBtn);
  await expect(openBtn).toHaveAttribute('href', `/api/artifact/${name}`);
  await expect(openBtn).toHaveAttribute('target', '_blank');

  // Scroll the inline preview down — top-right button stays visible and pinned
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(openBtn).toBeVisible();
  await page.screenshot({ path: 'test-results/artifact-preview-md-360.png' });

  const [popup] = await Promise.all([page.waitForEvent('popup'), openBtn.click()]);
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(new RegExp(`/api/artifact/${name}$`));
  await expect(popup.getByRole('heading', { name: 'Inline Markdown Report' })).toBeVisible();
  await popup.close();
  await expect(page).toHaveURL(/\/session\//);
});

test('text inline preview at 360px: corner button visible and opens artifact in new tab', async ({
  page,
}) => {
  const name = `e2e-inline-log-${Date.now().toString(36)}.txt`;
  madeFiles.push(name);
  const longTxt = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: build output`).join('\n');
  await writeFile(path.join(DIR, name), longTxt);

  const url = await seedSessionWithReply(
    `e2e-art-txt-${Date.now().toString(36)}`,
    `Full log attached: /api/artifact/${name}`
  );
  await page.goto(url);

  const preview = page.locator('[data-testid="artifact-preview"][data-artifact-kind="text"]');
  await expect(preview).toBeVisible();
  await expect(preview.getByText('line 1: build output')).toBeVisible();

  const scroller = preview.locator('pre');
  const scrollMetrics = await scroller.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);

  const openBtn = preview.getByRole('link', { name: `open ${name} in new tab` });
  await assertTopRightThumbButton(page, preview, openBtn);
  await expect(openBtn).toHaveAttribute('href', `/api/artifact/${name}`);
  await expect(openBtn).toHaveAttribute('target', '_blank');

  await page.screenshot({ path: 'test-results/artifact-preview-txt-360.png' });

  const [popup] = await Promise.all([page.waitForEvent('popup'), openBtn.click()]);
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(new RegExp(`/api/artifact/${name}$`));
  await expect(popup.getByText('line 60: build output')).toBeVisible();
  await popup.close();
  await expect(page).toHaveURL(/\/session\//);
});
