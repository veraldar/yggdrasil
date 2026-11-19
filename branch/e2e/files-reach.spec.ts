import { createHash, randomBytes } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { deflateSync } from 'zlib';
import { type Page, type Request, expect, test } from '@playwright/test';

/** Package 2 — files are files (contract §C), the way a person does it on a Pixel 7: tap the
 *  paperclip, pick a PDF and a photo, they go to the brain in pieces, the sent message shows
 *  the photo and a chip for the PDF, a tap on the chip opens the PDF. A file over the limit
 *  shows the brain's own words and nothing is sent. A file a session on another root made
 *  opens here. Config: playwright.files.config.ts (a stand-in brain, or the real one). */

const MiB = 1024 * 1024;
const LIMIT_MB = Number(process.env.E2E_FILE_MAX_MB || 5);
const LAB = process.env.E2E_LAB_ROOT || 'lab';
const LAB_DIR = process.env.E2E_LAB_ARTIFACTS!;
const HOME_DIR = process.env.E2E_HOME_ARTIFACTS!;
// the owner's screenshots land in E2E_SHOTS_DIR when set (p2-files-*.png)
const SHOTS = process.env.E2E_SHOTS_DIR || '';
const TAG = Date.now().toString(36);

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** a real PNG (a soft gradient with a block), so the thumbnail and the message show a picture */
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const block = x > w * 0.35 && x < w * 0.65 && y > h * 0.3 && y < h * 0.7;
      raw[o] = block ? 240 : Math.round((x / w) * 90) + 20;
      raw[o + 1] = block ? 190 : Math.round((y / h) * 120) + 60;
      raw[o + 2] = block ? 40 : 170;
      raw[o + 3] = 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** a valid one-page PDF padded to about `bytes` with a binary stream nobody draws */
function pdf(bytes: number): Buffer {
  const text = 'BT /F1 28 Tf 72 700 Td (P2 files report) Tj ET';
  const pad = randomBytes(Math.max(0, bytes - 1200));
  const objs: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'
    ),
    Buffer.from(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([
      Buffer.from(`<< /Length ${pad.length} >>\nstream\n`),
      pad,
      Buffer.from('\nendstream'),
    ]),
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let at = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(at);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(b);
    at += b.length;
  });
  const xref =
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `p2-files-${name}.png`) });
}

/** a fresh session on the brain the app serves, opened like a tap from the list does */
async function openSession(page: Page, label: string): Promise<string> {
  const r = await page.request.post('/api/session', {
    data: { name: `e2e-files-${label}-${TAG}` },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const s = (await r.json()) as { id: string; title: string };
  made.push(s.id);
  await page.goto(`/session/${encodeURIComponent(s.title)}?id=${s.id}`);
  await expect(page.getByRole('textbox', { name: 'message' })).toBeVisible();
  return s.id;
}

const made: string[] = [];
test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`/api/session/${id}`).catch(() => {});
});

test('paperclip: a PDF and a photo go up in pieces, the message shows both, the PDF opens', async ({
  page,
}) => {
  await openSession(page, 'pick');
  const report = pdf(3 * MiB);
  const photo = png(640, 400);
  const puts: Request[] = [];
  const sends: Request[] = [];
  const uploadOf = new Map<string, string>(); // file name → its upload id
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/file/upload/')) puts.push(r);
    if (r.method() === 'POST' && /\/api\/session\/[^/]+\/messages$/.test(r.url())) sends.push(r);
  });
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || !r.url().endsWith('/api/file/upload')) return;
    const d = (await r.json().catch(() => ({}))) as { upload?: string };
    if (d.upload) uploadOf.set((r.request().postDataJSON() as { name: string }).name, d.upload);
  });

  // the paperclip opens the phone's picker — any file now (no accept=image/*)
  await expect(page.locator('input[type=file]')).not.toHaveAttribute('accept', /.+/);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'attach' }).tap();
  await (
    await chooser
  ).setFiles([
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: report },
    { name: 'photo.png', mimeType: 'image/png', buffer: photo },
  ]);

  // both chips: the photo with its thumbnail, the PDF by name; ready once the brain has them
  const chips = page.getByTestId('attachment');
  await expect(chips).toHaveCount(2);
  await expect(chips.filter({ hasText: 'report.pdf' })).toBeVisible();
  await expect(chips.locator('img')).toHaveCount(1);
  await expect(chips.filter({ has: page.locator('[data-state]') })).toHaveCount(0); // (chips ARE the state)
  await expect(page.locator('[data-testid=attachment][data-state=ready]')).toHaveCount(2, {
    timeout: 30_000,
  });
  // pieces: the 3 MB PDF went in ≥ 2 PUTs, none over 1 MiB (offsets step by ≤ 1 MiB)
  const up = uploadOf.get('report.pdf') || '';
  expect(up).not.toBe('');
  const offsets = puts
    .filter((p) => p.url().includes(`/api/file/upload/${up}?`))
    .map((p) => Number(new URL(p.url()).searchParams.get('offset')));
  expect(offsets.length).toBeGreaterThanOrEqual(2);
  expect(offsets[0]).toBe(0);
  for (let i = 1; i < offsets.length; i++) {
    expect(offsets[i] - offsets[i - 1]).toBeGreaterThan(0);
    expect(offsets[i] - offsets[i - 1]).toBeLessThanOrEqual(MiB);
  }
  expect(report.length - offsets[offsets.length - 1]).toBeLessThanOrEqual(MiB);
  expect(uploadOf.has('photo.png')).toBe(true);

  await page.getByRole('textbox', { name: 'message' }).fill('the report and a photo');
  await shot(page, 'composer');
  await page.getByRole('button', { name: 'send' }).tap();

  // the message carried REFs, not data URLs
  await expect.poll(() => sends.length).toBe(1);
  const sent = sends[0].postDataJSON() as {
    refs?: { hash: string; name: string }[];
    images?: unknown;
  };
  expect(sent.images).toBeUndefined();
  expect(sent.refs?.map((r) => r.name).sort()).toEqual(['photo.png', 'report.pdf']);
  expect(sent.refs?.find((r) => r.name === 'report.pdf')?.hash).toBe(sha(report));
  expect(sent.refs?.find((r) => r.name === 'photo.png')?.hash).toBe(sha(photo));
  // the composer is empty again
  await expect(chips).toHaveCount(0);

  // the message as the brain stored it: the photo as a picture, the PDF as a chip (name + size)
  const mine = page.locator('[data-from=you]').filter({ hasText: 'the report and a photo' });
  await expect(mine).toHaveCount(1);
  const img = mine.locator('img[src*="/api/file/"]');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640);
  const chip = mine.getByTestId('msg-file');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('report.pdf');
  await expect(chip).toContainText('3.0 MB');
  // the brain answered after it (the stand-in names the files; any brain answers something)
  await expect(page.locator('[data-mi]').last()).toContainText('(agent)', { timeout: 60_000 });
  await shot(page, 'sent');

  // a tap on the chip opens the PDF: a new tab on /api/file/<hash>, the bytes we picked
  const href = (await chip.getAttribute('href')) || '';
  expect(href).toMatch(new RegExp(`^/api/file/${sha(report)}\\?`));
  expect(new URL(href, 'http://x').searchParams.get('name')).toBe('report.pdf');
  const opened = page
    .context()
    .waitForEvent('request', (r) => r.url().includes(`/api/file/${sha(report)}`));
  const tab = page.context().waitForEvent('page');
  await chip.tap();
  const res = await (await opened).response();
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-type']).toMatch(/^application\/pdf/);
  await (await tab).close();
  const got = await page.request.get(href);
  expect(got.status()).toBe(200);
  expect(got.headers()['content-type']).toMatch(/^application\/pdf/);
  expect(sha(await got.body())).toBe(sha(report));

  // a reload reads it back from the brain alike (no echo involved)
  await page.reload();
  const again = page.locator('[data-from=you]').filter({ hasText: 'the report and a photo' });
  await expect(again.locator('img[src*="/api/file/"]')).toBeVisible();
  await expect(again.getByTestId('msg-file')).toContainText('report.pdf');
});

test('a file over the limit: the brain says so word for word, nothing is sent', async ({
  page,
}) => {
  await openSession(page, 'limit');
  const puts: Request[] = [];
  const sends: Request[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes('/api/file/upload/')) puts.push(r);
    if (r.method() === 'POST' && /\/api\/session\/[^/]+\/messages$/.test(r.url())) sends.push(r);
  });
  const big = randomBytes((LIMIT_MB + 1) * MiB);
  const refused = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/file/upload')
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'attach' }).tap();
  await (
    await chooser
  ).setFiles([{ name: 'backup.tar', mimeType: 'application/x-tar', buffer: big }]);
  const r = await refused;
  expect(r.status()).toBe(413);
  const { error } = (await r.json()) as { error: string };
  expect(error).toMatch(/^backup\.tar is .+ MB\. The limit is [\d.]+ MB per file\.$/);
  // the brain's words, exactly, on the page (the error line: its text, then its keys)
  const alert = page.getByRole('alert').filter({ hasText: error });
  await expect(alert).toBeVisible();
  expect(await alert.evaluate((el) => (el.textContent || '').trim())).toBe(
    `${error} fix this dismiss`
  );
  await expect(page.getByTestId('attachment')).toHaveCount(0);
  await shot(page, 'over-limit');
  // nothing went: no piece, no message — the send key is the mic again
  await page.waitForTimeout(1500);
  expect(puts).toHaveLength(0);
  expect(sends).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'send' })).toHaveCount(0);
});

test('a pasted picture goes up like a picked one', async ({ page }) => {
  await openSession(page, 'paste');
  const photo = png(200, 120);
  await page.getByRole('textbox', { name: 'message' }).tap();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    const ta = document.querySelector('textarea[aria-label=message]')!;
    ta.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    );
  }, photo.toString('base64'));
  await expect(page.locator('[data-testid=attachment][data-state=ready]')).toHaveCount(1);
  await page.getByRole('button', { name: 'send' }).tap();
  const mine = page.locator('[data-from=you]').last();
  await expect(mine.locator(`img[src*="/api/file/${sha(photo)}"]`)).toBeVisible();
});

test('a file a session on another root made opens here', async ({ page }) => {
  const md = `e2e-lab-plan-${TAG}.md`;
  const html = `e2e-lab-page-${TAG}.html`;
  const local = `e2e-home-page-${TAG}.html`;
  await mkdir(LAB_DIR, { recursive: true });
  await mkdir(HOME_DIR, { recursive: true });
  await writeFile(path.join(LAB_DIR, md), '## Lab plan\n\nmade on the lab root\n');
  await writeFile(path.join(LAB_DIR, html), '<html><body><h1>Lab Page</h1></body></html>');
  await writeFile(path.join(HOME_DIR, local), '<html><body><h1>Home Page</h1></body></html>');
  try {
    const q = `?root=${LAB}&session=ses_e2elab`;
    // the transcript of a proxy session: the brain gives its links with the root they live on
    await page.route('**/api/session/*/messages*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        headers: {
          'X-Total-Count': '2',
          'X-Run-State': 'none|1|assistant',
          'X-Run-Live': '0',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify([
          { role: 'user', text: 'show me what you made', images: [], time: Date.now() - 60_000 },
          {
            role: 'assistant',
            text: `The plan: [plan](/api/artifact/${md}${q})\nThe page: [page](/api/artifact/${html}${q})`,
            images: [],
            time: Date.now() - 30_000,
            done: true,
          },
        ]),
      })
    );
    await page.goto(`/session/e2e-files-lab-${TAG}?id=mock-lab`);
    // inline: the md is read through the other root and rendered; the page shows in its frame
    await expect(page.getByRole('heading', { name: 'Lab plan' })).toBeVisible();
    const frame = page.locator(`iframe[src*="${html}"]`);
    await expect(frame).toHaveAttribute('src', `/api/artifact/${html}${q}`);
    await expect(frame.contentFrame().getByRole('heading', { name: 'Lab Page' })).toBeVisible();
    // a tap on the link opens it in a tab of its own, as a local file opens
    const tab = page.context().waitForEvent('page');
    await page.getByRole('link', { name: 'plan' }).tap();
    const t = await tab;
    await expect(t.locator('body')).toContainText('made on the lab root');
    await t.close();
    // the same headers a local artifact of that kind gets (type, sandbox when opened alone)
    const doc = { 'sec-fetch-dest': 'document' };
    const remote = await page.request.get(`/api/artifact/${html}${q}`, { headers: doc });
    const home = await page.request.get(`/api/artifact/${local}`, { headers: doc });
    expect(remote.status()).toBe(200);
    expect(home.status()).toBe(200);
    for (const h of ['content-type', 'content-security-policy', 'cache-control'])
      expect(remote.headers()[h], h).toBe(home.headers()[h]);
    // a name only the other root has is not found here without its root
    expect((await page.request.get(`/api/artifact/${html}`)).status()).toBe(404);
  } finally {
    await rm(path.join(LAB_DIR, md), { force: true });
    await rm(path.join(LAB_DIR, html), { force: true });
    await rm(path.join(HOME_DIR, local), { force: true });
  }
});

/** The real thing, two real brains (home + lab; e2e/fixtures/real-brains.sh): MAIN starts a
 *  session on lab; its reply links a file it made there; on the phone the link opens through
 *  home, and a PDF picked inside that session reaches lab (same bytes) and opens. */
test('a session on another root: its file opens here, a picked PDF reaches it', async ({
  page,
  request,
}) => {
  const OC = process.env.E2E_OC_URL || '';
  const LAB_URL = process.env.E2E_LAB_URL || '';
  test.skip(!OC || !LAB_URL, 'needs the real brains (E2E_OC_URL + E2E_LAB_URL)');
  const md = `e2e-lab-made-${TAG}.md`;
  const title = `lab work ${TAG}`;
  await mkdir(LAB_DIR, { recursive: true });
  await writeFile(path.join(LAB_DIR, md), '## Lab made\n\nwritten by the session on lab\n');
  try {
    // MAIN (the coordinator) starts the session on lab; the mock model follows the tool script
    const main = (await (
      await request.post(`${OC}/session`, { data: { title: '[MAIN]' } })
    ).json()) as { id: string };
    // (the mock answers the first word after "exactly:" — the link is one word)
    const brief = `Reply with exactly: [plan](/api/artifact/${md})`;
    const script = `tool:${JSON.stringify([[['session_start', { title, agent: 'build', root: LAB, brief }]]])}`;
    const said = await request.post(`${OC}/session/${main.id}/message`, {
      data: { parts: [{ type: 'text', text: script }] },
      timeout: 60_000,
    });
    expect(said.ok(), await said.text()).toBeTruthy();
    let proxy = '';
    await expect
      .poll(
        async () => {
          const rows = (await (await request.get(`${OC}/tree`)).json()) as {
            id: string;
            title: string;
          }[];
          proxy = rows.find((r) => r.title === title)?.id || '';
          return proxy;
        },
        { timeout: 30_000 }
      )
      .not.toBe('');
    made.push(proxy);

    // the owner opens that session: the reply's link names lab, the file renders and opens
    await page.goto(`/session/${encodeURIComponent(title.replace(/\s+/g, '-'))}?id=${proxy}`);
    await expect(page.getByRole('heading', { name: 'Lab made' })).toBeVisible({ timeout: 30_000 });
    const link = page.getByRole('link', { name: 'plan', exact: true });
    expect(await link.getAttribute('href')).toMatch(
      new RegExp(`^/api/artifact/${md.replace(/\./g, '\\.')}\\?root=${LAB}&session=\\S+$`)
    );
    const tab = page.context().waitForEvent('page');
    await link.tap();
    const t = await tab;
    await expect(t.locator('body')).toContainText('written by the session on lab');
    await t.close();

    // a PDF picked inside it goes to lab — the same bytes — and opens from the message
    const report = pdf(2 * MiB + 4321);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'attach' }).tap();
    await (
      await chooser
    ).setFiles([{ name: 'lab-report.pdf', mimeType: 'application/pdf', buffer: report }]);
    await expect(page.locator('[data-testid=attachment][data-state=ready]')).toHaveCount(1, {
      timeout: 30_000,
    });
    await page.getByRole('textbox', { name: 'message' }).fill('Reply with exactly: GOT-THE-PDF');
    await page.getByRole('button', { name: 'send' }).tap();
    await expect(page.getByText('GOT-THE-PDF', { exact: true }).last()).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(async () => (await request.get(`${LAB_URL}/file/${sha(report)}/info`)).status(), {
        timeout: 30_000,
      })
      .toBe(200);
    const mine = page.locator('[data-from=you]').filter({ hasText: 'GOT-THE-PDF' });
    const chip = mine.getByTestId('msg-file');
    await expect(chip).toContainText('lab-report.pdf');
    const got = await page.request.get((await chip.getAttribute('href')) || '');
    expect(got.status()).toBe(200);
    expect(sha(await got.body())).toBe(sha(report));
  } finally {
    await rm(path.join(LAB_DIR, md), { force: true });
  }
});
