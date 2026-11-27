import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { type Page, chromium, devices, expect, test } from '@playwright/test';
import { gotoHomeOnDevice, rootsLanding } from './home';

/**
 * LIVE DOOR PROOF (package 1, stage A) — the real https://ap.veraldar.org on a Pixel 7 screen, as a
 * person uses it: a test device paired by the box's own pairing code, the pinned channel up
 * ("end to end"), one typed turn and one spoken turn (the mic is a WAV), the answer spoken back over
 * the voice room, and the same turns seen on the tailnet door (:8447). MAIN is never written: the
 * device's "voice tests" switch sends the roots to the `voice-test` session. The device is revoked
 * at the end. Run by hand (nothing in CI): PW_LIVE=1 npx playwright test -c playwright.live-door.config.ts
 */
const TAIL = process.env.PW_DOOR === 'tailnet'; // the same turns on the tailnet door (no pairing)
const AP = TAIL ? process.env.PW_TAILNET || 'https://omarchy.tail5435b1.ts.net:8447' : 'https://ap.veraldar.org';
const TAILNET = process.env.PW_TAILNET || 'https://omarchy.tail5435b1.ts.net:8447';
const APP = 'http://127.0.0.1:4502'; // the public app on the box (admin from loopback)
const BRAIN = 'http://127.0.0.1:4101';
const OUT = process.env.PW_OUT || '/tmp/live-door';
const WAV = join(__dirname, 'fixtures/first-turn-en.wav'); // "what is two plus two?"
const ADMIN = readFileSync(join(process.env.HOME || '', '.config/yggdrasil/hub/admin-token'), 'utf8').trim();

test.skip(!process.env.PW_LIVE, 'live: run by hand with PW_LIVE=1');

type Msg = { info: { id: string; role: string; modality?: string }; parts: { type: string; text?: string }[] };
const textOf = (m: Msg) => m.parts.map((p) => p.text || '').join(' ');
const brain = async (path: string) => (await (await fetch(`${BRAIN}${path}`)).json()) as unknown;
const log: string[] = [];
const note = (s: string) => {
  log.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
  writeFileSync(join(OUT, 'steps.txt'), log.join('\n') + '\n');
};
const shot = (p: Page, n: string) => p.screenshot({ path: join(OUT, `${n}.png`) });

async function touchDown(page: Page, testId: string) {
  const b = (await page.getByTestId(testId).boundingBox())!;
  const at = { x: b.x + b.width * 0.4, y: b.y + b.height * 0.55 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  return async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  };
}

test('ap.veraldar.org on a phone: pair, end to end, type, talk, hear, same turns on :8447', async () => {
  test.setTimeout(8 * 60_000);
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({
    ...devices['Pixel 7'],
    permissions: ['microphone'],
    storageState: {
      cookies: [],
      origins: [
        {
          origin: AP,
          localStorage: [
            { name: 'bifrost-door', value: 'v2' },
            { name: 'bifrost-first-turn', value: '1' },
            { name: 'oz-mode', value: 'text' },
            { name: 'bifrost-voice-test', value: '1' }, // the roots talk to `voice-test`, never MAIN
          ],
        },
      ],
    },
  });
  // the reply's sound as it arrives over the voice room (lib/voice-tts.ts' test hook)
  const room = { bytes: 0, first: 0 };
  await ctx.exposeBinding('__ttsTapB64', (_s, b64: string) => {
    room.bytes += Buffer.from(b64, 'base64').length;
    room.first ||= Date.now();
  });
  await ctx.addInitScript(() => {
    (globalThis as unknown as { __bifrostTtsTap: (c: Uint8Array, r: number) => void }).__bifrostTtsTap = (c) => {
      let bin = '';
      for (let i = 0; i < c.length; i++) bin += String.fromCharCode(c[i]);
      (window as unknown as { __ttsTapB64: (b: string) => void }).__ttsTapB64(btoa(bin));
    };
  });
  // what the phone actually played (the deck plays the reply as audio pieces): seconds heard
  await ctx.addInitScript(() => {
    const w = window as unknown as { __played: number[] };
    w.__played = [];
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      const el = this;
      let max = 0;
      const at = w.__played.push(0) - 1;
      el.addEventListener('timeupdate', () => {
        max = Math.max(max, el.currentTime);
        w.__played[at] = max;
      });
      return orig.call(el);
    };
  });
  const phone = await ctx.newPage();
  let deviceId = '';
  try {
    if (!TAIL) {
      // ---- pair: the box mints a one-use code (what the QR carries), the phone opens it
      const code = await fetch(`${APP}/api/pair/code`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'p1-proof (test, removed after)' }),
      });
      expect(code.status).toBe(200);
      const { url } = (await code.json()) as { url: string };
      expect(url.startsWith(`${AP}/pair#`)).toBe(true);
      const t0 = Date.now();
      await phone.goto(url);
      await phone.waitForURL(rootsLanding(AP), { timeout: 60_000 });
      await gotoHomeOnDevice(phone, AP);
      deviceId = await phone.evaluate(() => String(JSON.parse(localStorage.getItem('bifrost.pin') || 'null')?.deviceId || ''));
      expect(deviceId).toMatch(/^dev_/);
      await expect(phone.getByTestId('roots')).toBeVisible({ timeout: 30_000 });
      note(`paired ${deviceId} in ${Date.now() - t0} ms`);
      // ---- the pinned channel: "end to end"
      await expect(phone.getByTestId('pin-state')).toHaveAttribute('data-state', 'pinned', { timeout: 30_000 });
      const via = await phone.evaluate(async () => {
        const r = await fetch('/api/build', { cache: 'no-store' });
        return { status: r.status, via: r.headers.get('x-bifrost-via'), body: await r.text() };
      });
      expect(via.status).toBe(200);
      expect(via.via).toBe('pinned');
      note(`pinned channel up; /api/build over it: ${via.body}`);
      const probe = await phone.evaluate(async () => (await fetch('/api/token')).status);
      expect(probe, 'voice is available to this device').toBe(200);
      await shot(phone, '1-home-end-to-end');
      // ---- the word at the owner's width (S22, 360 px): inside the roots, off MAIN's name and
      // words (11-23 it sat across MAIN's box; e2e/pin-state-place.spec.ts holds every state)
      await phone.setViewportSize({ width: 360, height: 780 });
      await phone.waitForTimeout(400);
      const place = await phone.evaluate(() => {
        const r = (s: string) => {
          const b = document.querySelector(s)!.getBoundingClientRect();
          return { l: b.left, t: b.top, r: b.right, b: b.bottom };
        };
        const pin = document.querySelector('[data-testid="pin-state"]')!;
        return {
          pin: r('[data-testid="pin-state"]'),
          name: r('[data-testid="roots-name"]'),
          say: r('[data-testid="roots-say"]'),
          roots: r('[data-testid="roots"]'),
          words: pin.textContent,
          radius: getComputedStyle(pin).borderTopLeftRadius,
        };
      });
      type Box = { l: number; t: number; r: number; b: number };
      const apart = (a: Box, b: Box) => a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t;
      note(`end to end at 360 px: ${JSON.stringify(place)}`);
      await shot(phone, '1b-home-end-to-end-360');
      expect(place.words).toBe('end to end');
      expect(apart(place.pin, place.name), "360 px: the word is off MAIN's name").toBe(true);
      expect(apart(place.pin, place.say), '360 px: the word is off the words line').toBe(true);
      const inRoots =
        place.pin.l >= place.roots.l &&
        place.pin.r <= place.roots.r &&
        place.pin.t >= place.roots.t &&
        place.pin.b <= place.roots.b;
      expect(inRoots, '360 px: inside the roots').toBe(true);
      expect(place.radius, '360 px: square, like every tag').toBe('0px');
      await phone.setViewportSize(devices['Pixel 7'].viewport);

    } else {
      await gotoHomeOnDevice(phone, AP);
      await expect(phone.getByTestId('roots')).toBeVisible({ timeout: 30_000 });
      const probe = await phone.evaluate(async () => (await fetch('/api/token')).status);
      expect(probe, 'voice is available on the tailnet door').toBe(200);
      await shot(phone, '1-home-tailnet');
      note('tailnet door open, voice available');
    }

    // ---- the voice-test session (made on first use by the app itself)
    await phone.evaluate(async () => {
      const p = await fetch('/api/session/voice-test/messages?limit=1', { cache: 'no-store' });
      if (!p.ok) await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'voice-test', test: true }) });
    });
    const sessions = (await brain('/session')) as Array<{ id: string; title: string }>;
    const vt = sessions.find((s) => s.title === 'voice-test')!;
    expect(vt, 'voice-test exists on the brain').toBeTruthy();
    const msgs = async () => (await brain(`/session/${vt.id}/message`)) as Msg[];

    // ---- one typed turn
    const tag = `door-ok-${Date.now().toString(36)}`;
    await phone.goto(`${AP}/session/voice-test`);
    const box = phone.locator('textarea[aria-label="message"]');
    await expect(box).toBeVisible({ timeout: 30_000 });
    await box.fill(`Reply with exactly: ${tag}`);
    const tType = Date.now();
    await phone.getByRole('button', { name: 'send' }).tap();
    await expect(phone.getByText(tag, { exact: true })).toBeVisible({ timeout: 180_000 });
    note(`typed turn answered on the phone in ${Date.now() - tType} ms ("${tag}")`);
    await shot(phone, '2-typed-turn');

    // ---- one spoken turn: hold the roots (they talk to voice-test on this device), say the WAV
    await gotoHomeOnDevice(phone, AP);
    const roots = phone.getByTestId('roots');
    await phone.waitForFunction(() => {
      const el = document.querySelector('[data-testid="roots-hit"]');
      return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps'));
    }, undefined, { timeout: 30_000 });
    const before = (await msgs()).filter((m) => m.info.role === 'user').length;
    const tHold = Date.now();
    const release = await touchDown(phone, 'roots-hit');
    await expect(roots).toHaveAttribute('data-phase', 'talk', { timeout: 40_000 });
    note(`hold → talk in ${Date.now() - tHold} ms`);
    await phone.waitForTimeout(3_200);
    await release();
    const released = Date.now();
    await expect.poll(async () => (await msgs()).filter((m) => m.info.role === 'user').length, { timeout: 90_000 }).toBeGreaterThan(before);
    const said = (await msgs()).filter((m) => m.info.role === 'user').pop()!;
    expect(textOf(said)).toMatch(/2 ?\+ ?2|two plus two/i);
    note(`spoken turn in voice-test ${Date.now() - released} ms after release: "${textOf(said).slice(0, 80)}" (modality ${said.info.modality})`);
    await expect(roots).toHaveAttribute('data-phase', 'speaking', { timeout: 120_000 });
    const speakAt = Date.now();
    await shot(phone, '3-speaking');
    await expect(roots).not.toHaveAttribute('data-phase', 'speaking', { timeout: 120_000 });
    const heard = await phone.evaluate(() => (window as unknown as { __played: number[] }).__played.reduce((a, b) => a + b, 0));
    expect(heard, 'the phone played the answer').toBeGreaterThan(0.5);
    const reply = (await msgs()).filter((m) => m.info.role === 'assistant').pop()!;
    note(`answer spoken: speaking ${speakAt - released} ms after release, ${heard.toFixed(1)} s played (${room.bytes ? `${room.bytes} bytes over the voice room` : 'over the pinned channel (the agent had left the room)'}); MAIN of voice-test said "${textOf(reply).slice(0, 80)}"`);

    if (!TAIL) {
      // ---- the same turns on the tailnet door
      const t = await browser.newContext({ ...devices['Pixel 7'], storageState: { cookies: [], origins: [{ origin: TAILNET, localStorage: [{ name: 'bifrost-door', value: 'v2' }, { name: 'bifrost-first-turn', value: '1' }] }] } });
      const home = await t.newPage();
      await home.goto(`${TAILNET}/session/voice-test`);
      await expect(home.getByText(tag, { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(home.getByText(/two plus two|2 ?\+ ?2/i).last()).toBeVisible({ timeout: 30_000 });
      await shot(home, '4-same-turns-on-8447');
      note('the same typed and spoken turns are on :8447');
      await t.close();
    }
  } finally {
    // the test device goes: revoked by the box (admin), then out of the devices file
    if (deviceId) {
      const r = await fetch(`${APP}/api/pair/devices`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: deviceId }),
      });
      note(`test device ${deviceId} revoked: ${r.status}`);
    }
    await browser.close();
  }
});
