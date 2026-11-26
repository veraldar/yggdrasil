/* rig-lib.mjs — what the package-2 phone drivers (s16.mjs, s17.mjs) share. Plain Node + the
 * Playwright LIBRARY from the app's own toolchain (as sim/voice/phone.mjs loads it), so the drivers
 * live in sim/ and need no test-runner config. Every step lands in $PW_STATE/steps.tsv — the same
 * table sim/trunk-rtc-e2e.sh and sim/trunk-full-e2e.sh print.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP_DIR || join(HERE, '..', '..', 'branch');
const require = createRequire(join(APP, 'package.json'));
export const { chromium, devices } = require('playwright');

export const env = (k, d = '') => process.env[k] || d;
export const STATE = env('PW_STATE');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const screens = [];
export const failed = [];

const clean = (s) =>
  String(s)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function record(n, ok, what, detail = '') {
  appendFileSync(join(STATE, 'steps.tsv'), `${n}\t${ok ? 'PASS' : 'FAIL'}\t${what}\t${clean(detail).slice(0, 500)}\n`);
  process.stderr.write(`${ok ? 'PASS' : 'FAIL'} ${n} ${what}${detail ? ' — ' + clean(detail).slice(0, 300) : ''}\n`);
}

/** one row of the table; a passing step may return its measurements. Never stops the walk. */
export async function step(n, what, fn) {
  try {
    const detail = await fn();
    record(n, true, what, detail || '');
    return true;
  } catch (e) {
    failed.push(n);
    record(n, false, what, e && e.message ? e.message : String(e));
    for (const [name, p] of screens) await p.screenshot({ path: join(STATE, `fail-${n}-${name}.png`) }).catch(() => {});
    return false;
  }
}

export function must(ok, msg) {
  if (!ok) throw new Error(msg);
}

/** poll fn until it returns a truthy value; throws `msg` (+ the last value) at the timeout */
export async function poll(fn, timeout, msg, every = 500) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = `error: ${e && e.message}`;
    }
    await sleep(every);
  }
  throw new Error(`${msg} (after ${Math.round(timeout / 1000)} s; last: ${clean(JSON.stringify(last) ?? 'undefined').slice(0, 200)})`);
}

/** the harness reads the box's own processes — plain node:http (the switchboard refuses
 *  browser-shaped calls). → {status, body (JSON when it parses), headers} */
export function brain(base, path, { method = 'GET', body, timeout = 60_000, headers = {} } = {}) {
  return new Promise((done, fail) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      `${base}${path}`,
      { method, timeout, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let b = raw.toString('utf8');
          try {
            b = JSON.parse(b);
          } catch {
            /* text */
          }
          done({ status: res.statusCode || 0, body: b, headers: res.headers, raw });
        });
      }
    );
    req.on('error', fail);
    req.on('timeout', () => req.destroy(new Error(`timeout: ${base}${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

export const textOf = (m) => (m?.parts || []).map((p) => (p.type === 'text' ? p.text || '' : '')).join(' ');
export const words = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** the mock's scripted tool call: one step of [[name, args], …] (sim/tree-e2e.py's tool()) */
export const tool = (calls) => `tool:${JSON.stringify([calls])}`;

/** a finger on an element, held until `release()` (real touch events — the phone's gesture) */
export async function touchDown(page, locator) {
  const b = await locator.boundingBox();
  must(b, 'nothing to touch (no bounding box)');
  const at = { x: b.x + b.width * 0.4, y: b.y + b.height * 0.55 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  return async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  };
}

/** React has hydrated this element: its handlers are attached */
export const hydrated = (page, sel) =>
  page.waitForFunction(
    (s) => {
      const el = document.querySelector(s);
      return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps'));
    },
    sel,
    { timeout: 30_000 }
  );

/** the box console shows the pairing QR; the phone "scans" it (zbarimg) and pairs through the ap */
export async function pair(box, phone, { base, ap, png }) {
  await box.goto(`${base}/pair`);
  const qr = box.getByTestId('pair-qr');
  await qr.locator('svg').waitFor({ timeout: 30_000 });
  writeFileSync(png, await qr.screenshot());
  const url = execFileSync('zbarimg', ['--raw', '-q', png]).toString().trim();
  must(url.startsWith(`${ap}/pair#`), `QR says ${url}`);
  await phone.goto(url);
  await phone.waitForURL(`${ap}/`, { timeout: 30_000 });
  await phone.getByTestId('roots').waitFor({ timeout: 30_000 });
  return url;
}

/** the phone's own fetch, from its page (its cookies, its network path: the ap) */
export const phoneFetch = (page, path, init = {}) =>
  page.evaluate(
    async ({ path, init }) => {
      const r = await fetch(path, {
        method: init.method || 'GET',
        headers: init.body ? { 'content-type': 'application/json' } : {},
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      const text = await r.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* text */
      }
      return { status: r.status, body, type: r.headers.get('content-type') || '' };
    },
    { path, init }
  );

/** a session row on the phone's list, by its title (a proxy's title may carry a [root] tag) */
export const rowOf = (page, title) =>
  page.locator('.oz-row').filter({ has: page.locator('.t', { hasText: new RegExp(`(^|\\]\\s*)${title}$`) }) });

// ---------------------------------------------------------------- WAV (PCM16 mono)
export function wavOf(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** {pcm, rate} of a PCM16 mono WAV (walks the chunks: piper's header is not always 44 bytes) */
export function pcmOf(wav) {
  const rate = wav.readUInt32LE(24);
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const n = wav.readUInt32LE(at + 4);
    if (id === 'data') return { pcm: wav.subarray(at + 8, at + 8 + n), rate };
    at += 8 + n + (n % 2);
  }
  throw new Error('no data chunk in the wav');
}

/** speak `text` with the rig's own TTS (piper, the voice server) → a padded WAV for the fake mic */
export async function renderSay(voiceV1, text, out, { lead = 1.0, tail = 4.0 } = {}) {
  const r = await fetch(`${voiceV1}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: text, voice: 'en_lessac', response_format: 'wav' }),
  });
  must(r.ok, `TTS ${r.status}`);
  const { pcm, rate } = pcmOf(Buffer.from(await r.arrayBuffer()));
  const pad = (s) => Buffer.alloc(Math.round(s * rate) * 2);
  writeFileSync(out, wavOf(Buffer.concat([pad(lead), pcm, pad(tail)]), rate));
  return { path: out, rate, speech: pcm.length / 2 / rate, total: lead + pcm.length / 2 / rate + tail };
}

/** STT of PCM16 in 2.5 s windows (the way the agent's VAD hands speech to whisper-tiny) */
/** the reply's STT pieces: about 2.5 s each, each cut moved to the quietest 20 ms within ±0.5 s —
 *  where a speaker breathes, the way the agent's VAD cuts (a fixed 2.5 s grid cut words in half; the
 *  reply opens with the brain's clock line, so what falls on a cut moves with the time of day) */
export function quietPieces(pcm, rate) {
  const n = Math.floor(pcm.length / 2);
  const step = Math.round(rate * 2.5);
  const frame = Math.max(1, Math.round(rate * 0.02));
  const look = Math.round(rate * 0.5);
  const energy = (s) => {
    let e = 0;
    for (let i = s; i < s + frame; i++) e += pcm.readInt16LE(i * 2) ** 2;
    return e;
  };
  // no piece under 0.5 s (a few samples crash the rig's speech server; a short rest joins the last
  // piece), and only whole 20 ms frames are weighed (a partial one at the end is not "quiet")
  const least = Math.round(rate * 0.5);
  const cuts = [0];
  while (cuts[cuts.length - 1] + step + least < n) {
    const last = cuts[cuts.length - 1];
    const target = last + step;
    let best = target;
    let low = Infinity;
    for (let s = Math.max(last + least, target - look); s + frame <= n - least && s < target + look; s += frame) {
      const e = energy(s);
      if (e < low) [low, best] = [e, s];
    }
    cuts.push(best);
  }
  cuts.push(n);
  return cuts.slice(1).map((c, i) => pcm.subarray(cuts[i] * 2, c * 2));
}

export async function sttOf(voiceV1, pcm, rate) {
  const parts = [];
  for (const piece of quietPieces(pcm, rate)) {
    const f = new FormData();
    f.append('file', new Blob([new Uint8Array(wavOf(piece, rate))], { type: 'audio/wav' }), 'x.wav');
    const r = await fetch(`${voiceV1}/audio/transcriptions`, { method: 'POST', body: f });
    parts.push((await r.json()).text || '');
  }
  return parts.join(' ');
}

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
