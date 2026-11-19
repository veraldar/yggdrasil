#!/usr/bin/env node
/* s16.mjs — S16: talk by mic inside a session that lives on ANOTHER root (lead-review L10).
 *
 * Run by `sim/trunk-rtc-e2e.sh --scenario s16`, AT HOME (the box's namespace), like the rtc spec:
 * the phone is its own Chromium inside the phone's namespace (PW_PHONE_CHROME wraps nsenter); its
 * microphone is a WAV of Ása's sentence rendered by the rig's own TTS (piper): lead silence, the
 * sentence ending in "over" (the hands-free commit word; the agent strips it from every turn), a long
 * silent tail (Chromium loops the file: the tail keeps the sentence from coming round again).
 * Everything the phone does goes through the VPS's :443 (the ap) to the box. The box runs two
 * brains: home (the app's OPENCODE_URL — the voice agent only ever talks to home) and lab.
 *
 *  S16.1  the box console's QR → the phone pairs through the ap → its list
 *  S16.2  setup: home's MAIN starts two sessions on root lab → proxies on home
 *  Two ways of talking, each on its own session (a fresh one: no turn of the other in it):
 *   hold (h): the mic key HELD while the sentence plays (push to talk, text mode)
 *   free (f): the mic key TAPPED (hands-free), the sentence + "over" commits the turn
 *  S16.x3 Ása taps the session on her list → its page, the mic key on it
 *  S16.x4 she talks → lab stores exactly ONE user message with those words; home keeps no copy
 *  S16.x5 …and that message is marked spoken (info.modality = "voice")
 *  S16.x6 the answer is spoken on the phone: reply audio over the voice room (never https through
 *         the VPS), the bytes the box's TTS made, its STT = lab's reply
 *  S16.x7 still once, 20 s later; reading the proxy on home shows lab's turn
 *
 * S16_ROOT=home: the CONTROL — the same walks on sessions that live on home (no proxy), so a
 * failure can be told apart: package 2's (only with lab) or the app's (both).
 * S16_WAYS=hold,free (default both) · S16_SAY / S16_KEYWORDS: the sentence and its key words.
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
const ROOT = env('S16_ROOT', 'lab');
const WAYS = env('S16_WAYS', 'hold,free').split(',').filter(Boolean);
const SAY = env('S16_SAY', 'please add oat milk and eggs to the shopping list. over');
const KEY = words(env('S16_KEYWORDS', 'oat milk eggs shopping list'));
must(AP && STATE && BASE && HOME && VOICE && PHONE_CHROME && APP, 'run by sim/trunk-rtc-e2e.sh --scenario s16');
must(ROOT === 'home' || LAB, 'S16_ROOT=lab needs PW_LAB');
const WHERE = ROOT === 'lab' ? LAB : HOME; // the brain whose store holds the real session
const TITLES = { hold: `${ROOT} notes`, free: `${ROOT} talk` };

const hits = (text) => KEY.filter((w) => words(text).includes(w)).length;
const userTurns = async (sid) =>
  ((await brain(WHERE, `/session/${sid}/message`)).body || []).filter((m) => m.info.role === 'user' && hits(textOf(m)) >= 3);

const t00 = Date.now();
const LEAD = 3.0;
const wav = await renderSay(VOICE, SAY, join(STATE, 's16-say.wav'), { lead: LEAD, tail: 45 });
process.stderr.write(`s16: root ${ROOT}, ways ${WAYS}; Ása's WAV ${wav.speech.toFixed(1)} s of speech (${wav.total.toFixed(1)} s with silence) → ${wav.path}\n`);

const box = await chromium.launch();
const desk = await box.newContext({ viewport: { width: 1280, height: 900 } });
const consolePage = await desk.newPage();
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
screens.push(['phone', phone], ['box', consolePage]);

let mainId = '';
const S = {}; // way → {proxy, real}

async function walk(way) {
  const x = way === 'hold' ? 'h' : 'f';
  const title = TITLES[way];
  const s = S[way];
  let turn = null;
  let released = 0;
  const how = way === 'hold' ? 'holds the mic' : 'taps the mic (hands-free) and talks, "over" at the end';

  await step(`S16.${x}3`, `[${way}] Ása taps "${title}" on her list → its page, the mic key on it`, async () => {
    must(s, 'needs S16.2');
    await phone.goto(`${AP}/`);
    const row = rowOf(phone, title);
    await row.first().waitFor({ timeout: 30_000 });
    await row.first().tap();
    await phone.waitForURL(/\/session\//, { timeout: 20_000 });
    await phone.getByTestId('composer-mic').waitFor({ timeout: 20_000 });
    await hydrated(phone, '[data-testid="composer-mic"]');
    must(phone.url().includes(s.proxy), `the page ${phone.url()} is not ${s.proxy}`);
    return phone.url().replace(AP, '');
  });

  await step(`S16.${x}4`, `[${way}] she ${how}: "${SAY}" → ${ROOT} stores exactly ONE user message with those words`, async () => {
    must(s && phone.url().includes(s.proxy), `needs S16.${x}3`);
    const mic = phone.getByTestId('composer-mic');
    const t0 = Date.now();
    let liveMs = -1;
    roomTts.chunks = [];
    roomTts.first = roomTts.last = 0;
    if (way === 'hold') {
      const release = await touchDown(phone, mic);
      try {
        await poll(async () => /\bheard\b/.test((await mic.getAttribute('class')) || ''), 40_000, 'the mic never went live (no "heard")', 200);
        liveMs = Date.now() - t0;
        await sleep(Math.round((LEAD + wav.speech + 1.5) * 1000));
      } finally {
        await release();
        released = Date.now();
      }
    } else {
      await mic.tap();
      await phone.getByTestId('free-strip').waitFor({ timeout: 40_000 });
      liveMs = Date.now() - t0;
      released = Date.now(); // the turn ends with "over" — no release
    }
    const got = await poll(async () => {
      const u = await userTurns(s.real);
      return u.length ? u : null;
    }, 90_000, `no user message with the words on ${ROOT} (tokens ${JSON.stringify(tokens)})`);
    turn = got[got.length - 1];
    must(got.length === 1, `${got.length} user messages with the words on ${ROOT}`);
    if (ROOT === 'lab') {
      // home's own store (reading the proxy over HTTP reads lab): no copy of the turn there
      const file = join(STATE, 'home', 'data', 'session', `${s.proxy}.json`);
      const local = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).messages || []).filter((m) => m.info?.role === 'user' && hits(textOf(m)) >= 3) : [];
      must(local.length === 0, `home's store kept ${local.length} user message(s) with the words for the proxy`);
    }
    return `${way === 'hold' ? 'press→mic live' : 'tap→hands-free'} ${liveMs} ms · on ${ROOT} ${Date.now() - t0} ms after the press · heard "${textOf(turn).slice(0, 90)}" (${hits(textOf(turn))}/${KEY.length} key words)`;
  });

  await step(`S16.${x}5`, `[${way}] that message on ${ROOT} is marked spoken: info.modality = "voice"`, async () => {
    must(turn, `needs S16.${x}4`);
    must(turn.info.modality === 'voice', `info.modality = ${JSON.stringify(turn.info.modality)}${way === 'hold' ? ' (branch/voice/agent.py marks a turn voice only in hands-free: "voice = mode == \'free\' and …")' : ''}`);
    return 'modality voice';
  });

  await step(`S16.${x}6`, `[${way}] the answer is spoken on the phone: room audio, = the box's TTS bytes, its STT is ${ROOT}'s reply`, async () => {
    must(turn, `needs S16.${x}4`);
    const reply = await poll(async () => {
      const ms = (await brain(WHERE, `/session/${s.real}/message`)).body || [];
      const at = ms.findIndex((m) => m.info.id === turn.info.id);
      return ms.slice(at + 1).find((m) => m.info.role === 'assistant' && m.info.time?.completed) || null;
    }, 90_000, `${ROOT} never answered the voice turn`);
    await poll(() => roomTts.chunks.length > 0, 60_000,
      `no reply audio arrived over the room (${ROOT} answered "${textOf(reply).slice(0, 60)}"; ${way === 'hold' ? 'a text-mode hold on a session page: the page speaks only in hands-free or the first-turn walk' : 'hands-free'})`);
    await poll(() => Date.now() - roomTts.last > 4_000, 120_000, 'the reply audio never ended', 500);
    const pcm = Buffer.concat(roomTts.chunks);
    must(pcm.length > 16_000, `${pcm.length} bytes of reply audio`);
    must(httpsTts.length === 0, `/api/tts/stream over https: ${JSON.stringify(httpsTts)}`);
    const diag = join(APP, '.diag', `tts-${new Date().toISOString().slice(0, 10)}.log`);
    const made = (existsSync(diag) ? readFileSync(diag, 'utf8').split('\n') : [])
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((d) => Date.parse(d.ts) >= released - 2_000)
      .map((d) => d.bytes);
    must(made.includes(pcm.length) || made.reduce((a, b) => a + b, 0) === pcm.length, `the box's TTS made ${JSON.stringify(made)} bytes, the phone got ${pcm.length}`);
    const stt = await sttOf(VOICE, pcm, roomTts.rate);
    const want = new Set(words(textOf(reply)));
    const got = words(stt);
    const share = got.filter((w) => want.has(w)).length / Math.max(1, got.length);
    must(share > 0.4, `STT "${stt.slice(0, 120)}" vs ${ROOT}'s reply "${textOf(reply).slice(0, 120)}"`);
    must(hits(stt) >= 2, `the sentence's words are not in the spoken reply: "${stt.slice(0, 160)}"`);
    return `first sound ${roomTts.first - released} ms after ${way === 'hold' ? 'release' : 'the tap'} · ${pcm.length} bytes (${(pcm.length / 2 / roomTts.rate).toFixed(1)} s) over the room, 0 via https · STT "${stt.slice(0, 70)}" (${Math.round(share * 100)}% in ${ROOT}'s reply)`;
  });

  if (way === 'free') await phone.getByTestId('free-exit').tap({ timeout: 5_000 }).catch(() => {});

  await step(`S16.${x}7`, `[${way}] still once, 20 s later; reading it on home shows ${ROOT}'s turn`, async () => {
    must(turn, `needs S16.${x}4`);
    await sleep(20_000);
    const u = await userTurns(s.real);
    must(u.length === 1, `${u.length} user messages with the words on ${ROOT}`);
    const seen = (await brain(HOME, `/session/${s.proxy}/message`)).body || [];
    must(seen.some((m) => m.info?.id === turn.info.id), 'reading the session on home does not show the voice turn');
    return 'one turn';
  });
}

try {
  await step('S16.1', 'box console QR → the phone pairs through vps:443 (the ap) → its list', async () => {
    await pair(consolePage, phone, { base: BASE, ap: AP, png: join(STATE, 's16-pair-qr.png') });
    mainId = String((await phoneFetch(phone, '/api/session/main')).body.id || '');
    must(/^ses_/.test(mainId), `MAIN ${mainId}`);
    return `MAIN ${mainId}`;
  });

  await step('S16.2', `setup: home's MAIN starts ${WAYS.map((w) => `"${TITLES[w]}"`).join(' and ')}${ROOT === 'lab' ? ' on root lab → proxies on home' : ' on home (control)'}`, async () => {
    must(mainId, 'needs S16.1');
    const out = [];
    for (const way of WAYS) {
      const title = TITLES[way];
      const r = await brain(HOME, `/session/${mainId}/message`, {
        method: 'POST',
        body: { parts: [{ type: 'text', text: tool([['session_start', { title, agent: 'build', brief: 'Reply with exactly: READY', ...(ROOT === 'lab' ? { root: 'lab' } : {}) }]]) }] },
        timeout: 120_000,
      });
      must(r.status === 200, `MAIN answered ${r.status}`);
      const row = await poll(async () => ((await brain(HOME, '/tree')).body || []).find((t) => t.title === title), 30_000, `no row "${title}" on home`);
      const info = (await brain(HOME, `/session/${row.id}`)).body;
      const real = ROOT === 'lab' ? info?.remote?.id : row.id;
      must(real && (ROOT === 'home' || info?.remote?.root === 'lab'), `"${title}" remote ${JSON.stringify(info?.remote)}`);
      await poll(async () => ((await brain(WHERE, `/session/${real}/message`)).body || []).some((m) => m.info.role === 'assistant' && textOf(m).includes('READY')), 30_000, `the brief of "${title}" never ran on ${ROOT}`);
      S[way] = { proxy: row.id, real };
      out.push(`${title}: ${row.id}${ROOT === 'lab' ? ` → ${real} on lab` : ''}`);
    }
    return out.join(' · ');
  });

  for (const way of WAYS) await walk(way);

  await step('∀', `the phone only ever reached ${AP}`, async () => {
    must(offAp.length === 0, offAp.slice(0, 3).join(' '));
  });
} finally {
  process.stderr.write(`s16 (root ${ROOT}): ${failed.length ? 'RED ' + failed.join(' ') : 'GREEN'} in ${Math.round((Date.now() - t00) / 1000)} s\n`);
  await phoneBrowser.close().catch(() => {});
  await box.close().catch(() => {});
}
process.exit(failed.length ? 1 : 0);
