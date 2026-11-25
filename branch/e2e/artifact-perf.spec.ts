import { mkdir, unlink, utimes, writeFile } from 'fs/promises';
import path from 'path';
import { expect, test } from '@playwright/test';

/** Artifact performance E2E at 360×780 (owner phone shape):
 *  1. Gallery thumbnails only mount & fetch cards near the viewport (not all 30+ at once)
 *     and load with bounded concurrency, so off-screen big HTML pages never block top cards.
 *  2. Real browser `Accept-Encoding: gzip, deflate, br, zstd` actually gets gzipped responses
 *     for /api/artifact list, HTML thumbnails, HTML doc opens, and rendered .md doc opens.
 *  3. Scrolling down mounts off-screen thumbnails on demand without horizontal overflow. */
test.use({
  viewport: { width: 360, height: 780 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

const DIR = process.env.E2E_ARTIFACTS_DIR || path.join(process.cwd(), '..', 'artifacts');
const made: string[] = [];
const CARD_COUNT = 30;
const BIG_NAME = 'e2e-perf-bottom-big.html';
const MD_NAME = 'e2e-perf-report.md';

test.beforeAll(async () => {
  await mkdir(DIR, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const bodyChunk = '<p>Repeated readable paragraph content for realistic HTML compression.</p>\n';

  // Top 29 cards (newest first) + 1 large HTML card at the bottom (card #30, far below fold)
  for (let i = 0; i < CARD_COUNT - 1; i++) {
    const name = `e2e-perf-card-${String(i).padStart(2, '0')}.html`;
    made.push(name);
    const f = path.join(DIR, name);
    await writeFile(
      f,
      `<!doctype html><meta charset="utf-8"><body style="margin:12px"><h1>Card ${i}</h1>${bodyChunk.repeat(40)}</body>`
    );
    // Higher i = older, so card-00 is newest (top-left) and big card is oldest (bottom)
    const t = nowSec - i * 10;
    await utimes(f, t, t);
  }

  made.push(BIG_NAME);
  const bigPath = path.join(DIR, BIG_NAME);
  await writeFile(
    bigPath,
    `<!doctype html><meta charset="utf-8"><body><h1 id="big-page">Big Offscreen Artifact</h1>${bodyChunk.repeat(2000)}</body>`
  );
  const oldTime = nowSec - CARD_COUNT * 20;
  await utimes(bigPath, oldTime, oldTime);

  made.push(MD_NAME);
  await writeFile(
    path.join(DIR, MD_NAME),
    `# Phone Deliverable\n\n${'- Bullet line with enough text to exceed the 1 KB gzip floor.\n'.repeat(40)}`
  );
});

test.afterAll(async () => {
  for (const f of made) await unlink(path.join(DIR, f)).catch(() => {});
});

test('360px /artifacts: only near-viewport thumbnails load, all gzipped, scrolling loads the rest', async ({
  page,
}) => {
  const seenUrls = new Map<string, { ce: string; status: number }>();
  let listCe = '';

  page.on('response', (res) => {
    const u = new URL(res.url());
    if (u.pathname === '/api/artifact') {
      listCe = res.headers()['content-encoding'] || 'none';
    } else if (u.pathname.startsWith('/api/artifact/')) {
      seenUrls.set(u.pathname, {
        ce: res.headers()['content-encoding'] || 'none',
        status: res.status(),
      });
    }
  });

  await page.goto('/artifacts');
  const grid = page.getByTestId('artifact-grid');
  await expect(grid).toBeVisible();
  // Wait for top visible cards to mount & finish loading
  await expect(grid.locator('iframe').first()).toBeVisible();
  await page.waitForLoadState('networkidle');

  // 1. /api/artifact JSON list is gzipped
  expect(listCe).toBe('gzip');

  // 2. Only near-viewport cards loaded (well under CARD_COUNT = 30), and the big bottom card did NOT load
  const initialCount = seenUrls.size;
  expect(initialCount).toBeGreaterThanOrEqual(6);
  expect(initialCount).toBeLessThanOrEqual(16);
  expect(seenUrls.has(`/api/artifact/${BIG_NAME}`)).toBe(false);

  // 3. Every HTML thumbnail fetched by Chromium (Accept-Encoding: gzip, deflate, br, ...) was gzipped
  for (const [pathname, info] of seenUrls) {
    expect(info.status, pathname).toBe(200);
    expect(info.ce, `${pathname} must be gzipped`).toBe('gzip');
  }

  // 4. Zero horizontal overflow at 360px
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // 5. Scrolling to the bottom mounts and loads the big card on demand (also gzipped)
  const bigCard = page.getByRole('button', { name: new RegExp(`^${BIG_NAME}$`) });
  await bigCard.scrollIntoViewIfNeeded();
  await expect
    .poll(() => seenUrls.has(`/api/artifact/${BIG_NAME}`), { timeout: 15_000 })
    .toBe(true);
  expect(seenUrls.get(`/api/artifact/${BIG_NAME}`)?.ce).toBe('gzip');
});

test('360px artifact pages (html and md) serve gzipped with proper CSP and raw md fetch stays untouched', async ({
  page,
  request,
}) => {
  // HTML doc navigation: gzipped + sandbox allow-same-origin
  const htmlRes = await page.goto(`/api/artifact/${BIG_NAME}`);
  expect(htmlRes?.status()).toBe(200);
  expect(htmlRes?.headers()['content-encoding']).toBe('gzip');
  expect(htmlRes?.headers()['content-security-policy']).toBe('sandbox allow-same-origin');
  await expect(page.locator('#big-page')).toHaveText('Big Offscreen Artifact');

  // MD doc navigation: rendered HTML + gzipped + sandbox allow-same-origin
  const mdRes = await page.goto(`/api/artifact/${MD_NAME}`);
  expect(mdRes?.status()).toBe(200);
  expect(mdRes?.headers()['content-type']).toContain('text/html');
  expect(mdRes?.headers()['content-encoding']).toBe('gzip');
  expect(mdRes?.headers()['content-security-policy']).toBe('sandbox allow-same-origin');
  await expect(page.getByRole('heading', { name: 'Phone Deliverable' })).toBeVisible();

  // Raw chat fetch (Accept: */*) still gets raw text/markdown
  const raw = await request.get(`/api/artifact/${MD_NAME}`);
  expect(raw.status()).toBe(200);
  expect(raw.headers()['content-type']).toContain('text/markdown');
  expect(await raw.text()).toContain('# Phone Deliverable');
});
