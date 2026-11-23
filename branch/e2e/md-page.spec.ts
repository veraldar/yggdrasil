import { afterAll, expect, test } from '@playwright/test';
import { unlink, writeFile } from 'fs/promises';
import path from 'path';

/** MD-PAGE (11-23): an owner-facing deliverable is HTML by construction —
 *  any .md dropped into artifacts/ renders as a phone-readable page on
 *  /api/artifact/<name> (360px-safe, nothing sideways), while the chat's
 *  raw fetch still gets the markdown bytes. No rule for the writer to
 *  remember: dropping the file IS the whole act.
 *  Runs against whatever the config aims at; E2E_ARTIFACTS_DIR overrides
 *  the drop dir (a twin serves its own artifacts dir, not the tree's). */

const DIR = process.env.E2E_ARTIFACTS_DIR || path.join(process.cwd(), '..', 'artifacts');
const made: string[] = [];
afterAll(async () => {
  for (const f of made) await unlink(path.join(DIR, f)).catch(() => {});
});

test.use({ viewport: { width: 360, height: 780 } }); // the phone, for real

const DOC = [
  '# Phone deliverable',
  '',
  'Prose with a verylongunbreakabletokenqwertyuiopasdfghjklzxcvbnm0123456789 and a `code span`.',
  '',
  '| column one | column two | column three |',
  '|------------|-----------|--------------|',
  '| a          | b         | c            |',
  '',
  '```ts',
  'const aVeryLongLineOfCodeThatWouldPushThePageWideIfItCould = 1;',
  '```',
  '',
  '- list item one',
  '- list item two',
].join('\n');

test('an .md artifact renders as a phone page: no sideways scroll, real markdown', async ({
  page,
}) => {
  const name = `e2e-mdpage-${Date.now().toString(36)}.md`;
  made.push(name);
  await writeFile(path.join(DIR, name), DOC);
  const res = await page.goto(`/api/artifact/${name}`);
  expect(res?.headers()['content-type']).toContain('text/html');
  // it rendered (not the escaped source): heading and table cells as such
  await expect(page.getByRole('heading', { name: 'Phone deliverable' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'column one' })).toBeVisible();
  // 360px shape: nothing pushes the page wider than the screen
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  // the whole page scrolls vertically (content is there, body not clipped)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight >= document.documentElement.clientHeight
    )
  ).toBeTruthy();
});

test('the chat fetch path still gets raw markdown bytes', async ({ request }) => {
  const name = `e2e-mdpage-raw-${Date.now().toString(36)}.md`;
  made.push(name);
  const body = '# raw spec\n\nuntouched bytes\n';
  await writeFile(path.join(DIR, name), body);
  const r = await request.get(`/api/artifact/${name}`);
  expect(r.headers()['content-type']).toContain('text/markdown');
  expect(await r.text()).toBe(body);
});
