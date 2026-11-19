#!/usr/bin/env node
/* s16.mjs — S16: hold the mic inside a session that lives on ANOTHER root (lead-review L10).
 *
 * Run by `sim/trunk-rtc-e2e.sh --scenario s16`, AT HOME (the box's namespace), like the rtc spec:
 * the phone is its own Chromium inside the phone's namespace (PW_PHONE_CHROME wraps nsenter), its
 * microphone a WAV of Ása's sentence rendered by the rig's own TTS (piper); everything it does goes
 * through the VPS's :443 (the ap) to the box. The box runs two brains: home (the app's
 * OPENCODE_URL) and lab (its own store; a peer of home). The voice agent only ever talks to home.
 *
 *  S16.1 the box console's QR → the phone pairs through the ap → its list
 *  S16.2 setup: home's MAIN starts "lab notes" on root lab → a proxy on home, the session on lab
 *  S16.3 Ása taps "lab notes" on her list → its page, the mic key on it
 *  S16.4 she holds the mic and says the sentence → lab's store: exactly ONE user message with
 *        those words (home keeps no copy: the proxy reads lab)
 *  S16.5 …and that message is marked as spoken (info.modality = "voice")
 *  S16.6 the answer is spoken on the phone: reply audio over the voice room (never https through
 *        the VPS), byte-equal to what the box's TTS made, and its STT is lab's reply
 *  S16.7 still once, 20 s later: no second copy of the words reached lab
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STATE, brain, chromium, devices, env, failed, hydrated, must, pair, phoneFetch, poll, renderSay,
  rowOf, screens, sleep, step, sttOf, textOf, tool, touchDown, words,
} from './rig-lib.mjs';

const AP = env('PW_AP_URL');
const AP_IP = env('PW_AP_IP');
const BASE = env('PW_BASE_URL');
const HOME = env('PW_HOME');
const LAB = env('PW_LAB');
const VOICE = env('PW_VOICE');
const PHONE_CHROME = env('PW_PHONE_CHROME');
const APP = env('APP_DIR');
const SAY = env('S16_SAY', 'please add oat milk and eggs to the shopping list');
const KEY = words(env('S16_KEYWORDS', 'oat milk eggs shopping list'));
const TITLE = 'lab notes';
must(AP && STATE && BASE && HOME && LAB && VOICE && PHONE_CHROME && APP, 'run by sim/trunk-rtc-e2e.sh --scenario s16');

const hits = (text) => KEY.filter((w) => words(text).includes(w)).length;
const labUser = async (lid) =>
  ((await brain(LAB, `/session/${lid}/message`)).body || []).filter((m) => m.info.role === 'user' && hits(textOf(m)) >= 3);

const t00 = Date.now();
const wav = await renderSay(VOICE, SAY, join(STATE, 's16-say.wav'));
process.stderr.write(`s16: Ása's WAV ${wav.speech.toFixed(1)} s of speech (${wav.total.toFixed(1)} s with silence) → ${wav.path}\n`);

const box = await chromium.launch();
const desk = await box.newContext({ viewport: { width: 1280, height: 900 } });
const console_ = await desk.newPage();
const phoneBrowser = await chromium.launch({
  executablePath: PHONE_CHROME,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav.path}`,
    '--autoplay-policy=no-user-gesture-required',
    `--host-resolver-rules=MAP ${new URL(AP).hostname} ${AP_IP}`,
    '--ignore-certificate-errors',
  ],
});
const ctx = await phoneBrowser.newContext({
  ...devices['Pixel 7'],
  ignoreHTTPSErrors: true,
  permissions: ['microphone'],
  storageState: {
    cookies: [],
    origins: [{ origin: AP, localStorage: [
      { name: 'bifrost-door', value: 'v2' },
      { name: 'bifrost-first-turn', value: '1' },
      { name: 'oz-mode', value: 'text' },
    ] }],
  },
});
// the reply's sound as it arrives over the room (lib/voice-tts.ts' test hook) — the rtc spec's R3 tap
const roomTts = { chunks: [], rate: 0, first: 0, last: 0 };
await ctx.exposeBinding('__ttsTapB64', (_s, b64, rate) => {
  roomTts.chunks.push(Buffer.from(b64, 'base64'));
  roomTts.rate = rate;
  roomTts.first ||= Date.now();
  roomTts.last = Date.now();
});
await ctx.addInitScript(() => {
  globalThis.__bifrostTtsTap = (c, r) => {
    let bin = '';
    for (let i = 0; i < c.length; i++) bin += String.fromCharCode(c[i]);
    window.__ttsTapB64(btoa(bin), r);
  };
});
const httpsTts = [];
const tokens = [];
const offAp = [];
ctx.on('request', (r) => {
  const u = r.url();
  if (/^(https?|wss?):/.test(u) && !u.startsWith(`${AP}/`) && !u.startsWith(`${AP.replace(/^https/, 'wss')}/`)) offAp.push(u);
});
ctx.on('response', (r) => {
  if (r.url().includes('/api/tts/stream')) httpsTts.push(r.status());
  if (r.url().endsWith('/api/token') && r.request().method() === 'POST') tokens.push(r.status());
});
ctx.on('page', (p) => p.on('console', (m) => appendFileSync(join(STATE, 's16-phone-console.log'), `${m.type()} ${m.text().slice(0, 400)}\n`)));
const phone = await ctx.newPage();
screens.push(['phone', phone], ['box', console_]);

let mainId = '';
let proxy = '';
let labId = '';
let released = 0;
let turn = null;

try {
  await step('S16.1', 'box console QR → the phone pairs through vps:443 (the ap) → its list', async () => {
    await pair(console_, phone, { base: BASE, ap: AP, png: join(STATE, 's16-pair-qr.png') });
    mainId = String((await phoneFetch(phone, '/api/session/main')).body.id || '');
    must(/^ses_/.test(mainId), `MAIN ${mainId}`);
    return `MAIN ${mainId}`;
  });

  await step('S16.2', `setup: home's MAIN starts "${TITLE}" on root lab → a proxy on home, the session on lab`, async () => {
    must(mainId, 'needs S16.1');
    const r = await brain(HOME, `/session/${mainId}/message`, {
      method: 'POST',
      body: { parts: [{ type: 'text', text: tool([['session_start', { title: TITLE, agent: 'build', root: 'lab', brief: 'Reply with exactly: LAB-READY' }]]) }] },
      timeout: 120_000,
    });
    must(r.status === 200, `MAIN answered ${r.status}`);
    const row = await poll(async () => ((await brain(HOME, '/tree')).body || []).find((x) => x.title === TITLE), 30_000, 'no proxy row on home');
    proxy = row.id;
    const info = (await brain(HOME, `/session/${proxy}`)).body;
    labId = info?.remote?.id || '';
    must(info?.remote?.root === 'lab' && labId, `proxy ${proxy} remote ${JSON.stringify(info?.remote)}`);
    await poll(async () => ((await brain(LAB, `/session/${labId}/message`)).body || []).some((m) => textOf(m).includes('LAB-READY')), 30_000, 'the brief never ran on lab');
    return `proxy ${proxy} on home → ${labId} on lab`;
  });

  await step('S16.3', `Ása taps "${TITLE}" on her list → its page, the mic key on it`, async () => {
    must(proxy, 'needs S16.2');
    await phone.goto(`${AP}/`);
    const row = rowOf(phone, TITLE);
    await row.first().waitFor({ timeout: 30_000 });
    await row.first().tap();
    await phone.waitForURL(/\/session\//, { timeout: 20_000 });
    await phone.getByTestId('composer-mic').waitFor({ timeout: 20_000 });
    await hydrated(phone, '[data-testid="composer-mic"]');
    return phone.url().replace(AP, '');
  });

  await step('S16.4', `she holds the mic: "${SAY}" → lab stores exactly ONE user message with those words`, async () => {
    must(labId, 'needs S16.2');
    const mic = phone.getByTestId('composer-mic');
    const t0 = Date.now();
    const release = await touchDown(phone, mic);
    let heardMs = -1;
    try {
      await poll(async () => /\bheard\b/.test((await mic.getAttribute('class')) || ''), 40_000, 'the mic never went live (no "heard")', 200);
      heardMs = Date.now() - t0;
      await sleep(Math.round((wav.total - 1.0 - 1.5) * 1000)); // the sentence and most of the tail, within one loop of the WAV
    } finally {
      await release();
      released = Date.now();
    }
    const got = await poll(async () => {
      const u = await labUser(labId);
      return u.length ? u : null;
    }, 90_000, `no user message with the words on lab (tokens ${JSON.stringify(tokens)})`);
    turn = got[got.length - 1];
    must(got.length === 1, `${got.length} user messages with the words on lab`);
    // home's own store (reading the proxy over HTTP reads lab): no copy of the turn there
    const file = join(STATE, 'home', 'data', 'session', `${proxy}.json`);
    const local = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).messages || []).filter((m) => m.info?.role === 'user' && hits(textOf(m)) >= 3) : [];
    must(local.length === 0, `home's store kept ${local.length} user message(s) with the words for the proxy`);
    return `press→live ${heardMs} ms · release→on lab ${Date.now() - released} ms · heard "${textOf(turn).slice(0, 90)}" (${hits(textOf(turn))}/${KEY.length} key words)`;
  });

  await step('S16.5', 'that message on lab is marked spoken: info.modality = "voice"', async () => {
    must(turn, 'needs S16.4');
    must(turn.info.modality === 'voice', `info.modality = ${JSON.stringify(turn.info.modality)} (the agent marks a turn voice only in hands-free mode: branch/voice/agent.py "voice = mode == 'free' and …")`);
    return 'modality voice';
  });

  await step('S16.6', "the answer is spoken on the phone: room audio, = the box's TTS bytes, its STT is lab's reply", async () => {
    must(released && turn, 'needs S16.4');
    const reply = await poll(async () => {
      const ms = (await brain(LAB, `/session/${labId}/message`)).body || [];
      const at = ms.findIndex((m) => m.info.id === turn.info.id);
      const r = ms.slice(at + 1).find((m) => m.info.role === 'assistant' && m.info.time?.completed);
      return r || null;
    }, 90_000, "lab never answered the voice turn");
    await poll(() => roomTts.chunks.length > 0, 90_000, 'no reply audio arrived over the room');
    await poll(() => Date.now() - roomTts.last > 4_000, 120_000, 'the reply audio never ended', 500);
    const pcm = Buffer.concat(roomTts.chunks);
    must(pcm.length > 16_000, `${pcm.length} bytes of reply audio`);
    must(httpsTts.length === 0, `/api/tts/stream over https: ${JSON.stringify(httpsTts)}`);
    const diag = join(APP, '.diag', `tts-${new Date().toISOString().slice(0, 10)}.log`);
    const made = (existsSync(diag) ? readFileSync(diag, 'utf8').split('\n') : [])
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((x) => Date.parse(x.ts) >= released)
      .map((x) => x.bytes);
    const sum = made.reduce((a, b) => a + b, 0);
    must(made.includes(pcm.length) || sum === pcm.length, `box TTS made ${JSON.stringify(made)} bytes, the phone got ${pcm.length}`);
    const stt = await sttOf(VOICE, pcm, roomTts.rate);
    const want = new Set(words(textOf(reply)));
    const got = words(stt);
    const share = got.filter((w) => want.has(w)).length / Math.max(1, got.length);
    must(share > 0.4, `STT "${stt.slice(0, 120)}" vs lab's reply "${textOf(reply).slice(0, 120)}"`);
    must(hits(stt) >= 2, `the sentence's words are not in the spoken reply: "${stt.slice(0, 160)}"`);
    return `release→first sound ${roomTts.first - released} ms · ${pcm.length} bytes (${(pcm.length / 2 / roomTts.rate).toFixed(1)} s) over the room, 0 via https · STT "${stt.slice(0, 70)}" (${Math.round(share * 100)}% in lab's reply)`;
  });

  await step('S16.7', 'still once, 20 s later: no second copy of the words reached lab; home shows lab\'s turn', async () => {
    must(labId && turn, 'needs S16.4');
    await sleep(20_000);
    const u = await labUser(labId);
    must(u.length === 1, `${u.length} user messages with the words on lab`);
    const seen = (await brain(HOME, `/session/${proxy}/message`)).body || [];
    must(seen.some((m) => m.info?.id === turn.info.id), 'reading the proxy on home does not show lab\'s voice turn');
    return 'one turn';
  });

  await step('∀', `the phone only ever reached ${AP}`, async () => {
    must(offAp.length === 0, offAp.slice(0, 3).join(' '));
  });
} finally {
  process.stderr.write(`s16: ${failed.length ? 'RED ' + failed.join(' ') : 'GREEN'} in ${Math.round((Date.now() - t00) / 1000)} s\n`);
  await phoneBrowser.close().catch(() => {});
  await box.close().catch(() => {});
}
process.exit(failed.length ? 1 : 0);
