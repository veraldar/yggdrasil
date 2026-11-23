import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type BrowserContext, type Page, devices, expect, test } from '@playwright/test';

/**
 * v0.9 VALIDATION LADDER — the box + browser "devices" on this machine:
 *   console = desktop context on loopback (the box's own screen → pairing admin)
 *   phone   = iPhone-emulated context dialing the box's LAN address
 *   pixel   = Android-emulated second device
 *
 * pair via QR (the rendered QR is DECODED with zbarimg — no URL is read from
 * the DOM) → token mint (HttpOnly cookie) → land on home (a fresh phone: the door) → P2P data channel
 * against the QR-pinned box key → app round-trip through the transport (the
 * prompt lands in the MAIN brain session) → a spent QR replays as "used" →
 * revoke from the device list severs the phone mid-session → two live
 * devices, the kill-switch severs everything → re-pair works.
 *
 * Needs the devices-mode server (server.mjs) + the bridge — scripts/v09-ladder.sh
 * runs the whole box isolated: PW_DEVICES_MODE=1 PW_LAN_URL=http://<lan-ip>:<port>
 * PW_MAIN_SLUG=<slug of BIFROST_MAIN_TITLE>.
 */

const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:8095';
const LAN = process.env.PW_LAN_URL || '';
const MAIN_SLUG = process.env.PW_MAIN_SLUG || 'main';

test.skip(
  process.env.PW_DEVICES_MODE !== '1' || !LAN,
  'the ladder needs the devices-mode server + bridge (scripts/v09-ladder.sh)'
);

const scratch = mkdtempSync(join(tmpdir(), 'bfn-ladder-'));
let shots = 0;

async function scanQr(consolePage: Page): Promise<string> {
  await consolePage.goto(`${BASE}/pair`);
  const qr = consolePage.getByTestId('pair-qr');
  await expect(qr.locator('svg')).toBeVisible();
  const file = join(scratch, `qr-${++shots}.png`);
  writeFileSync(file, await qr.screenshot());
  return execFileSync('zbarimg', ['--raw', '-q', file]).toString().trim();
}

async function pairAndLink(page: Page, qrUrl: string) {
  // a fragment-only change is a same-document navigation — start clean
  await page.goto('about:blank');
  await page.goto(qrUrl);
  await page.waitForURL(`${LAN}/`, { timeout: 30_000 }); // home decides: the door or the list
  await page.goto(`${LAN}/p2p?session=${MAIN_SLUG}`);
  await expect(page.getByTestId('p2p-phase')).toHaveText('open', { timeout: 30_000 });
}

const pinOf = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('bifrost.pin') || 'null'));

async function apiStatus(ctx: BrowserContext, path: string) {
  return (await ctx.request.get(`${LAN}${path}`)).status();
}

test('v0.9 ladder: QR pair → P2P round-trip → revoke → kill-switch → re-pair', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const box = await desk.newPage();
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const phone = await phoneCtx.newPage();
  const pixelCtx = await browser.newContext({ ...devices['Pixel 7'] });
  const pixel = await pixelCtx.newPage();
  const probeCtx = await browser.newContext({ ...devices['Pixel 7'] }); // step 5b
  let probeAt = 0;

  let firstQr = '';
  // the code of the app's home page: the HTML of a page names the code the browser is to run for it
  const appMark = 'chunks/app/page-';
  let mainId = '';
  await test.step('1 the box console renders a QR; it decodes to the pairing URL', async () => {
    firstQr = await scanQr(box);
    expect(firstQr.startsWith(`${LAN}/pair#`)).toBe(true);
    const frag = new URLSearchParams(firstQr.split('#')[1]);
    expect(frag.get('code')).toMatch(/^bfnp-/);
    expect(frag.get('fp')).toMatch(/^sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(frag.get('bridge')).toMatch(/^http:\/\//);
    await expect(box.getByTestId('pair-fp')).toHaveText(frag.get('fp')!);
  });

  await test.step('1b a phone that is not paired sees one quiet line and nothing of the console', async () => {
    // the owner's rule (11-21): "if there is nothing I should be seeing then I should see nothing"
    // not one byte of the app first (11-21: no glimpse of it): whatever page an unpaired visitor asks for,
    // the server answers with the /pair page (served in place: no redirect, so no public name is needed)
    const appHome = await (await desk.request.get(`${BASE}/`)).text(); // what the box's own console is served
    expect(appHome, 'the console is served the app').toContain(appMark);
    for (const path of ['/', '/session/main?id=ses_x', '/devices', '/p2p', '/join?r=abcdefgh']) {
      const r = await pixelCtx.request.get(`${LAN}${path}`, { maxRedirects: 0 });
      expect(r.status(), path).toBe(200);
      expect(r.headers()['cache-control'], path).toContain('no-store');
      const html = await r.text();
      expect(html, `${path}: the /pair page's code`).toContain('chunks/app/pair/page-');
      for (const m of [appMark, 'chunks/app/session/', 'chunks/app/devices/', 'chunks/app/p2p/', 'chunks/app/join/']) {
        expect(html, `${path}: ${m}`).not.toContain(m);
      }
    }
    // the door behind a TLS end (the trunk, the live site): the hop hands the app https-flavored
    // headers (X-Forwarded-Proto: https) against its plain-HTTP listener — exactly what the 11-21
    // deploy choked on (the in-place rewrite then looked external and Next proxied it, TLS at a
    // plain listener → EPROTO → 500). It must answer 200, the pair page, never a proxy error.
    {
      const r = await pixelCtx.request.get(`${LAN}/`, {
        maxRedirects: 0,
        headers: { 'x-forwarded-for': '192.168.77.9', 'x-forwarded-proto': 'https' },
      });
      expect(r.status(), 'https-flavored headers at the plain listener').toBe(200);
      const html = await r.text();
      expect(html, 'still the /pair page, not an error').toContain('chunks/app/pair/page-');
      expect(html, 'never the app').not.toContain(appMark);
    }
    // in the browser: the only page it is ever given is /pair, and nothing of the app is ever in its DOM
    const docs: string[] = [];
    pixel.on('response', async (r) => {
      if (r.request().resourceType() !== 'document') return;
      const html = await r.text().catch(() => '');
      docs.push(`${r.status()} ${new URL(r.url()).pathname} ${html.includes(appMark) ? 'THE APP' : html.includes('chunks/app/pair/page-') ? 'the pair page' : '?'}`);
    });
    await pixel.addInitScript(() => {
      const w = window as unknown as { __app?: string };
      const look = () => {
        const el = document.querySelector('[data-testid="roots"], [data-testid="tree-first"], .oz-head, .oz-row');
        if (el && !w.__app) w.__app = el.outerHTML.slice(0, 120);
      };
      new MutationObserver(look).observe(document, { childList: true, subtree: true });
    });
    // PW_SHOTS: what the screen showed on the way — every picture the browser painted (its own frame stream:
    // a screenshot asked for while a page loads can hang, the stream cannot)
    let frames = 0;
    const cdp = process.env.PW_SHOTS ? await pixelCtx.newCDPSession(pixel) : null;
    if (cdp) {
      cdp.on('Page.screencastFrame', (ev) => {
        writeFileSync(join(process.env.PW_SHOTS!, `noflash-${String(++frames).padStart(3, '0')}.png`), Buffer.from(ev.data, 'base64'));
        void cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    }
    await pixel.goto(`${LAN}/`);
    await pixel.waitForURL(/\/pair\?unpaired=1/, { timeout: 20_000 });
    await expect(pixel.getByTestId('pair-quiet')).toHaveText('not paired');
    if (cdp) {
      await pixel.waitForTimeout(700);
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
    }
    // two pages, both the /pair page: in place of `/`, then at its own address
    expect(docs).toEqual(['200 / the pair page', '200 /pair the pair page']);
    expect(await pixel.evaluate(() => (window as unknown as { __app?: string }).__app || '')).toBe('');
    await expect(pixel.getByTestId('pin-state')).toBeHidden();
    // the box's own console is still served the app
    expect((await desk.request.get(`${BASE}/`, { maxRedirects: 0 })).status()).toBe(200);
    expect((await pixel.locator('body').innerText()).trim()).toBe('not paired');
    await expect(pixel.getByTestId('pair-qr')).toHaveCount(0);
    await expect(pixel.getByTestId('pair-status')).toHaveCount(0);
    await expect(pixel.locator('a')).toHaveCount(0); // no back, no devices link: nothing it could use
    if (process.env.PW_SHOTS) await pixel.screenshot({ path: join(process.env.PW_SHOTS, 'pair-unpaired-phone.png') });
    // the console's half is as it was: its heading, the QR, the expiry, the box key, the devices link
    await expect(box.getByText('scan with the phone')).toBeVisible();
    await expect(box.getByTestId('pair-qr').locator('svg')).toBeVisible();
    await expect(box.getByText('expires')).toBeVisible();
    await expect(box.getByTestId('pair-fp')).toHaveText(/^sha-256 /);
    await expect(box.getByRole('link', { name: /devices/ })).toBeVisible();
    if (process.env.PW_SHOTS) await box.screenshot({ path: join(process.env.PW_SHOTS, 'pair-console.png') });
  });

  await test.step('2 phone scans: pairs, mints its token, lands on home — the door (fresh)', async () => {
    // (steps 2b and 5b are the page gate's other side: a PAIRED phone is never sent away)
    await phone.goto(firstQr);
    // never straight into MAIN: a phone that never walked the door gets the door first
    await phone.waitForURL(`${LAN}/`, { timeout: 30_000 });
    await expect(phone.getByTestId('tree-first')).toBeVisible();
    const main = await phoneCtx.request.get(`${LAN}/api/session/${MAIN_SLUG}`);
    expect(main.status()).toBe(200);
    mainId = String((await main.json()).id || '');
    expect(mainId).toMatch(/^ses_/);
    const cookie = (await phoneCtx.cookies()).find((c) => c.name === 'bifrost_device');
    expect(cookie?.value).toMatch(/^bfnd-/);
    expect(cookie?.httpOnly).toBe(true);
    const pin = await pinOf(phone);
    expect(pin.fp).toBe(new URLSearchParams(firstQr.split('#')[1]).get('fp'));
    expect(await apiStatus(phoneCtx, '/api/ping')).toBe(200);
  });

  await test.step('2b a paired phone whose cookie did not ride the page request is sent on, not told "not paired"', async () => {
    // what a link followed from another site does (the cookie is SameSite=Strict): the page gate sees no
    // device and serves /pair in place; /pair asks again from inside the site and loads the page again
    const jar = await phoneCtx.cookies();
    await phoneCtx.clearCookies({ name: 'bifrost_device' });
    expect(await (await phoneCtx.request.get(`${LAN}/`)).text()).not.toContain(appMark);
    await phone.goto(`${LAN}/p2p?session=${MAIN_SLUG}`);
    await expect(phone.getByTestId('p2p-phase')).toBeVisible({ timeout: 30_000 }); // the page it asked for
    expect(phone.url()).toBe(`${LAN}/p2p?session=${MAIN_SLUG}`);
    await expect(phone.getByTestId('pair-quiet')).toHaveCount(0);
    expect((await phoneCtx.cookies()).find((c) => c.name === 'bifrost_device')?.value).toMatch(/^bfnd-/);
    expect(await apiStatus(phoneCtx, '/api/ping')).toBe(200);
    expect(jar.length).toBeGreaterThan(0);
    // for step 5b: a device paired now and left alone, so its access token really runs out
    const minted = await (await desk.request.post(`${BASE}/api/pair/code`, { data: { name: 'gate-probe' } })).json();
    const code = new URLSearchParams(String(minted.url).split('#')[1]).get('code');
    const claimed = await probeCtx.request.post(`${LAN}/api/pair/claim`, { data: { code, name: 'gate-probe' } });
    expect(claimed.status()).toBe(200);
    probeAt = Date.now();
  });

  await test.step('3 the spent QR replays as used (one-time code)', async () => {
    await pixel.goto('about:blank');
    await pixel.goto(firstQr);
    await expect(pixel.getByTestId('pair-status')).toContainText('already used');
    expect(await apiStatus(pixelCtx, '/api/ping')).toBe(401);
  });

  await test.step('4 P2P data channel opens against the pinned box key', async () => {
    await phone.goto(`${LAN}/p2p?session=${MAIN_SLUG}`);
    await expect(phone.getByTestId('p2p-phase')).toHaveText('open', { timeout: 30_000 });
  });

  const marker = `ladder-${Date.now().toString(36)}`;
  await test.step('5 app round-trip through the transport lands in the MAIN brain session', async () => {
    await phone.getByTestId('p2p-input').fill(`Reply with the single word pong. (${marker})`);
    await phone.getByTestId('p2p-send').click();
    await expect(phone.getByTestId('p2p-reply')).not.toBeEmpty({ timeout: 180_000 });
    await expect(phone.getByTestId('p2p-reply')).not.toContainText('error:');
    // read the brain session back over plain HTTP, as the phone
    const tr = await phoneCtx.request.get(`${LAN}/api/session/${mainId}/messages`);
    expect(tr.status()).toBe(200);
    expect(await tr.text()).toContain(marker);
  });

  await test.step('5b a paired device whose access token has run out still opens the app, never "not paired"', async () => {
    const ttl = Number(process.env.PW_ACCESS_TTL_S || 30);
    await phone.waitForTimeout(Math.max(0, probeAt + (ttl + 2) * 1000 - Date.now()));
    // run out, and by now cleaned out of the registry by the other devices' refreshes: the box answers
    // "pair" for it (or "refresh" if it is still listed) — either way the device IS paired
    const ping = await probeCtx.request.get(`${LAN}/api/ping`);
    expect(ping.status(), 'the access token has run out').toBe(401);
    expect(['pair', 'refresh']).toContain((await ping.json()).reauth);
    const probe = await probeCtx.newPage();
    await probe.goto(`${LAN}/`);
    await expect(probe.getByTestId('tree-first')).toBeVisible({ timeout: 30_000 }); // the app: a fresh device's door
    expect(new URL(probe.url()).pathname).toBe('/');
    await expect(probe.getByTestId('pair-quiet')).toHaveCount(0);
    expect((await probeCtx.request.get(`${LAN}/api/ping`)).status()).toBe(200);
    await probeCtx.close();
  });

  await test.step('6 revoke from the device list → the phone is severed mid-session', async () => {
    const { deviceId } = await pinOf(phone);
    await box.goto(`${BASE}/devices`);
    await box.getByTestId(`revoke-${deviceId}`).click();
    await expect(phone.getByTestId('p2p-phase')).toHaveText('severed', { timeout: 10_000 });
    await expect(phone.getByTestId('p2p-why')).toHaveText('revoked');
    expect(await apiStatus(phoneCtx, '/api/ping')).toBe(401);
    await expect(box.getByTestId(`revoked-${deviceId}`)).toBeVisible();
  });

  await test.step('6b a phone that WAS paired (it still holds its pin) and no longer is: one quiet line, no road line, no app', async () => {
    // the owner's own case (11-21, 20:06): the page said "not paired" and, under it, "via the trunk's TLS"
    expect(await pinOf(phone)).toBeTruthy();
    expect(await (await phoneCtx.request.get(`${LAN}/`)).text()).not.toContain(appMark);
    await phone.goto(`${LAN}/`);
    await phone.waitForURL(/\/pair\?unpaired=1/, { timeout: 20_000 });
    await expect(phone.getByTestId('pair-quiet')).toHaveText('not paired');
    await phone.waitForTimeout(4_000); // the old pin has had its time to try the channel and name a road
    await expect(phone.getByTestId('pin-state')).toBeHidden();
    expect((await phone.locator('body').innerText()).trim()).toBe('not paired');
    if (process.env.PW_SHOTS) await phone.screenshot({ path: join(process.env.PW_SHOTS, 'pair-once-paired-phone.png') });
  });

  await test.step('7 two live devices; the kill-switch severs everything', async () => {
    await pairAndLink(phone, await scanQr(box));
    await pairAndLink(pixel, await scanQr(box));
    await box.goto(`${BASE}/devices`);
    box.once('dialog', (d) => d.accept());
    await box.getByTestId('kill-switch').click();
    await expect(box.getByTestId('devices-note')).toContainText(/severed [2-9]\d* device/);
    for (const [page, ctx] of [
      [phone, phoneCtx],
      [pixel, pixelCtx],
    ] as const) {
      await expect(page.getByTestId('p2p-phase')).toHaveText('severed', { timeout: 10_000 });
      await expect(page.getByTestId('p2p-why')).toHaveText('kill-switch');
      expect(await apiStatus(ctx, '/api/ping')).toBe(401);
    }
  });

  await test.step('8 re-pair after the kill-switch works end to end', async () => {
    await pairAndLink(phone, await scanQr(box));
    expect(await apiStatus(phoneCtx, '/api/ping')).toBe(200);
  });

  // the disposable MAIN goes away with the run (the brain keeps no e2e debris)
  if (MAIN_SLUG !== 'main' && mainId) {
    await phoneCtx.request.delete(`${LAN}/api/session/${mainId}`);
  }
  await Promise.all([desk.close(), phoneCtx.close(), pixelCtx.close()]);
});
