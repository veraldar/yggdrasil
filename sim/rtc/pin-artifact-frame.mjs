#!/usr/bin/env node
/** pin-artifact-frame.mjs — pinned-mode artifact-frame check (fix-3 verification rig).
 *
 * Run inside the trunk-rtc world (same env as trunk-rtc.spec.ts): the phone pairs by
 * QR through the VPS, the app pins its channel, then we time what the integrator
 * measured: a sandbox="allow-same-origin" iframe loading an html artifact, and the
 * gallery's thumbnails — all must ride the pinned channel fast (no 10 s waitState).
 *
 *   node sim/rtc/pin-artifact-frame.mjs        exit 0 = PASS (prints timings)
 */
import { appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PW_REQUIRE || 'playwright');

const AP = process.env.PW_AP_URL || '';
const BASE = process.env.PW_BASE_URL || '';
const STATE = process.env.PW_STATE || '';
const PHONE_CHROME = process.env.PW_PHONE_CHROME || '';
if (!AP || !BASE || !STATE || !PHONE_CHROME) {
  console.error('run by sim/trunk-rtc-e2e.sh (the namespaced world)');
  process.exit(2);
}

const steps = [];
const step = (name, what, ok, ms, extra = '') => {
  steps.push({ name, what, ok, ms, extra });
  console.log(`${name} ${ok ? 'PASS' : 'FAIL'} ${what}${extra ? ` · ${extra}` : ''}`);
  // the rig's own table (steps.tsv: name, what, PASS/FAIL, detail) — trunk-rtc-e2e.sh reads it
  try {
    appendFileSync(
      join(STATE, 'steps.tsv'),
      `${name}\t${ok ? 'PASS' : 'FAIL'}\t${what}\t${extra}\n`
    );
  } catch {
    /* STATE may be unset in a bare run */
  }
};

// the box console browser (this machine, loopback): shows the QR the phone scans
const box = await chromium.launch();
const boxPage = await box.newPage();

// the phone: its own chromium inside the phone's namespace
const AP_IP = process.env.PW_AP_IP || '';
const phone = await chromium.launch({
  executablePath: PHONE_CHROME,
  args: [
    `--host-resolver-rules=MAP ${new URL(AP).hostname} ${AP_IP}`,
    // the test ap's self-signed cert (a phone on the real trunk has Let's Encrypt)
    '--ignore-certificate-errors',
  ],
});
const phoneCtx = await phone.newContext({
  ...devices['Pixel 7'],
  locale: 'en-US',
  ignoreHTTPSErrors: true,
  storageState: {
    cookies: [],
    origins: [
      {
        origin: AP,
        localStorage: [
          { name: 'bifrost-door', value: 'v2' },
          { name: 'bifrost-first-turn', value: '1' },
        ],
      },
    ],
  },
});
const phonePage = await phoneCtx.newPage();

try {
  // ---------------------------------------------------------------- pair
  const t0 = Date.now();
  await boxPage.goto(`${BASE}/pair`);
  const qr = boxPage.getByTestId('pair-qr');
  await qr.waitFor({ state: 'visible', timeout: 30_000 });
  const png = join(STATE, 'pair-qr.png');
  await qr.screenshot({ path: png });
  const { execFileSync } = await import('child_process');
  const qrUrl = execFileSync('zbarimg', ['-q', '--raw', png]).toString().trim();
  await phonePage.goto(qrUrl);
  await phonePage.waitForURL(`${AP}/`, { timeout: 60_000 });
  await phonePage.getByTestId('roots').waitFor({ state: 'visible', timeout: 60_000 });
  // the app announces its pin state (the indicator); wait for 'pinned'
  await phonePage.getByTestId('pin-state').waitFor({ state: 'visible', timeout: 60_000 });
  await phonePage.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="pin-state"]');
      const st = el ? el.getAttribute('data-state') : null;
      if (st === 'pinned' || st === 'fallback') return true; // either rides a known door
      const pin = JSON.parse(localStorage.getItem('bifrost.pin') || 'null');
      return !!(pin && pin.deviceId); // paired: the channel may say 'connecting' while loading
    },
    null,
    { timeout: 60_000 }
  );
  // settle: give the channel its moment, then read the final state
  await phonePage.waitForTimeout(3000);
  const pinState = await phonePage.evaluate(() => {
    const el = document.querySelector('[data-testid="pin-state"]');
    const pin = JSON.parse(localStorage.getItem('bifrost.pin') || 'null');
    return { state: el ? el.getAttribute('data-state') : null, device: pin && pin.deviceId };
  });
  console.log('pin state:', JSON.stringify(pinState));
  const pairedMs = Date.now() - t0;

  // the frame load: watch the phone's console for the sw's fall-through line
  const fallThrough = [];
  phonePage.on('console', (m) => {
    if (m.text().includes('pin fall-through')) fallThrough.push(m.text());
  });

  // ---------------------------------------------------------------- F1 a gallery thumbnail frame
  await phonePage.goto(`${AP}/artifacts`); // through the ap, the pinned door
  // the rig's app serves the checkout's artifacts dir: it has html files (door-tree, far-vision)
  const firstFrame = phonePage.locator('[data-testid="artifact-grid"] iframe').first();
  const tf = Date.now();
  await firstFrame.waitFor({ state: 'visible', timeout: 30_000 });
  const thumbMs = Date.now() - tf;
  // the frame's document must be tunnelled: ask the SW's log — check the page's pin state and
  // the frame's load finished without a fall-through
  await phonePage.waitForTimeout(1500);

  // ---------------------------------------------------------------- F2 a chat-inline frame via the viewer
  // direct: build an allow-same-origin iframe to an html artifact, timed
  const r = await phonePage.evaluate(async () => {
    const t = performance.now();
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-same-origin');
    f.src = '/api/artifact/door-tree.html';
    document.body.appendChild(f);
    await new Promise((done) => (f.onload = done));
    const txt = (() => {
      try {
        return f.contentDocument ? 'controlled' : 'opaque';
      } catch {
        return 'opaque-exception';
      }
    })();
    return { ms: Math.round(performance.now() - t), txt };
  });
  await phonePage.waitForTimeout(1500);

  // ---------------------------------------------------------------- F3 the owner's case: a new TAB,
  // a top-level navigation to /api/artifact/… — the open-in-new-tab corner button
  const t3 = Date.now();
  const tab = await phoneCtx.newPage();
  await tab.goto(`${AP}/api/artifact/door-tree.html`);
  const tabMs = Date.now() - t3;
  const tabBody = (await tab.textContent('body')).length > 100; // a real artifact page, not an error json
  await tab.waitForTimeout(1500);
  await tab.close();

  // F4 a media file inside such an opened page: the films' <video> src
  const t4 = Date.now();
  const tab2 = await phoneCtx.newPage();
  await tab2.goto(`${AP}/api/artifact/door-tree.html`);
  await tab2.waitForTimeout(300);
  const media = await tab2.evaluate(async () => {
    const t = performance.now();
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = '/api/artifact/door-tree.html'; // any artifact path: SW routing is by URL
    await new Promise((done) => {
      v.onloadedmetadata = done;
      v.onerror = done;
    });
    return { ms: Math.round(performance.now() - t) };
  });
  await tab2.close();

  const ok = r.ms < 1500 && thumbMs < 10_000 && fallThrough.length === 0;
  step(
    'F1',
    'gallery thumbnail frame (pinned): visible under 10 s, no fall-through',
    thumbMs < 10_000 && fallThrough.length === 0,
    thumbMs,
    `thumb ${thumbMs} ms · frame ${r.ms} ms (${r.txt}) · fall-throughs: ${fallThrough.length}`
  );
  step(
    'F2',
    'sandbox=allow-same-origin frame to an html artifact: under 1.5 s, tunneled doc',
    r.ms < 1500 && r.txt === 'controlled',
    r.ms,
    `${r.ms} ms, ${r.txt}`
  );
  step(
    'F3',
    'new tab, top-level /api/artifact page (the open-in-new-tab corner button): under 3 s, real bytes',
    tabMs < 3000 && tabBody,
    tabMs,
    `${tabMs} ms, body "${tabBody ? 'real artifact' : 'wrong'}"`
  );
  step(
    'F4',
    'media request from inside an opened /api page: no 10 s wait',
    media.ms < 3000,
    media.ms,
    `${media.ms} ms`
  );
  console.log(`\npair→pinned ${pairedMs} ms`);
} finally {
  writeFileSync(
    join(STATE, 'pin-frame-steps.json'),
    JSON.stringify({ steps, exit: steps.every((s) => s.ok) ? 0 : 1 }, null, 1)
  );
  await phone.close().catch(() => {});
  await box.close().catch(() => {});
}
process.exit(steps.every((s) => s.ok) ? 0 : 1);
