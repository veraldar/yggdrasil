#!/usr/bin/env node
/* s16.mjs — S16: talk by mic inside a session — on the home root and on ANOTHER root (lead-review
 * L10), and be answered the way you asked (L16): a spoken turn aloud, a typed turn in writing.
 *
 * Run by `sim/trunk-rtc-e2e.sh --scenario s16`, AT HOME (the box's namespace), like the rtc spec:
 * the phone is its own Chromium inside the phone's namespace (PW_PHONE_CHROME wraps nsenter); its
 * microphone is a WAV of Ása's sentence rendered by the rig's own TTS (piper): lead silence, the
 * sentence, a long silent tail (Chromium loops the file: the tail keeps it from coming round again).
 * Hands-free ends the sentence with "over" (its commit word); a hold never says it (the agent would
 * commit it as a keyword turn while the finger is still down). Chromium takes its fake mic at launch,
 * so each way gets its own browser — the same paired phone (its cookies and pin carried over).
 * Everything the phone does goes through the VPS's :443 (the ap) to the box. The box runs two
 * brains: home (the app's OPENCODE_URL — the voice agent only ever talks to home) and lab.
 *
 *  S16.1  the box console's QR → the phone pairs through the ap → its list
 *  S16.2  setup: home's MAIN starts one session per walk (on home, or on root lab → a proxy on home)
 *  A walk = a way of talking @ the root its session lives on, each on a fresh session.
 *  S16_WALKS, default hold@home,hold@lab,free@lab — step ids carry both letters (hh, hl, fl):
 *   hold (h): the mic key HELD while the sentence plays (push to talk, text mode)
 *   free (f): the mic key TAPPED (hands-free), the sentence + "over" commits the turn
 *  S16.xr3 Ása taps the session on her list → its page, the mic key on it
 *  S16.xr4 she talks → that root stores exactly ONE user message with those words (a proxy: home
 *          keeps no copy)
 *  S16.xr5 …and that message is marked spoken (info.modality = "voice")
 *  S16.xr6 the answer is spoken on the phone: reply audio over the voice room (never https through
 *          the VPS), the bytes the box's TTS made, its STT = that root's reply
 *  S16.xr7 still once, 20 s later; reading the session on home shows the turn
 *  S16.hr8 (hold walks) she then TYPES a turn there → the answer comes in writing, nothing is said
 *  S16.fr8 (hands-free walks) while the phone listens hands-free, a turn TYPED elsewhere (her
 *          computer: the phone shows no box to type in hands-free) → the phone speaks its answer
 *          too (L16's exception: hands-free speaks every answer — you switched it on to listen)
 *
 * S16_SAY / S16_KEYWORDS: the sentence and its key words. (S16_ROOT + S16_WAYS, the older knobs,
 * still pick the walks: S16_ROOT=home S16_WAYS=hold = hold@home.)
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STATE, brain, chromium, devices, env, failed, hydrated, must, pair, phoneFetch, poll, renderSay,
  rowOf, screens, sleep, step, sttOf, textOf, tool, touchDown, wavOf, words,
} from './rig-lib.mjs';

const AP = env('PW_AP_URL');
const AP_IP = env('PW_AP_IP');
const BASE = env('PW_BASE_URL');
const HOME = env('PW_HOME');
const LAB = env('PW_LAB');
const VOICE = env('PW_VOICE');
const PHONE_CHROME = env('PW_PHONE_CHROME');
const APP = env('APP_DIR');
const OLD = env('S16_ROOT', '') || env('S16_WAYS', '');
const WALKS = (OLD
  ? env('S16_WAYS', 'hold,free').split(',').filter(Boolean).map((w) => `${w}@${env('S16_ROOT', 'lab')}`)
  : env('S16_WALKS', 'hold@home,hold@lab,free@lab').split(',').filter(Boolean)
).map((k) => ({ key: k, way: k.split('@')[0], root: k.split('@')[1] }));
const SAY = env('S16_SAY', 'please add oat milk and eggs to the shopping list');
const KEY = words(env('S16_KEYWORDS', 'oat milk eggs shopping list'));
must(AP && STATE && BASE && HOME && VOICE && PHONE_CHROME && APP, 'run by sim/trunk-rtc-e2e.sh --scenario s16');
must(WALKS.length && WALKS.every((w) => ['hold', 'free'].includes(w.way) && ['home', 'lab'].includes(w.root)), `S16_WALKS ${JSON.stringify(WALKS)}`);
must(WALKS.every((w) => w.root === 'home') || LAB, 'a walk on lab needs PW_LAB');
const whereOf = (root) => (root === 'lab' ? LAB : HOME); // the brain whose store holds the real session
const titleOf = (w) => `${w.root} ${w.way === 'hold' ? 'notes' : 'talk'}`;
const TYPED = 'now what is seven times six';

const hits = (text) => KEY.filter((w) => words(text).includes(w)).length;
const userTurns = async (where, sid) =>
  ((await brain(where, `/session/${sid}/message`)).body || []).filter((m) => m.info.role === 'user' && hits(textOf(m)) >= 3);

const t00 = Date.now();
const LEAD = 3.0;
const WAV = {
  hold: await renderSay(VOICE, SAY, join(STATE, 's16-hold.wav'), { lead: LEAD, tail: 45 }),
  free: await renderSay(VOICE, `${SAY}. over`, join(STATE, 's16-free.wav'), { lead: LEAD, tail: 45 }),
};
process.stderr.write(`s16: walks ${WALKS.map((w) => w.key)}; Ása's WAVs: hold ${WAV.hold.speech.toFixed(1)} s, free ${WAV.free.speech.toFixed(1)} s of speech (+ ${LEAD} s lead, 45 s tail)\n`);

const box = await chromium.launch();
const desk = await box.newContext({ viewport: { width: 1280, height: 900 } });
const consolePage = await desk.newPage();
const offAp = [];
/** one launch of Ása's phone: its fake mic = `wavPath`; `storage` = the paired phone's state */
async function phoneFor(wavPath, storage) {
  const browser = await chromium.launch({
    executablePath: PHONE_CHROME,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
      `--host-resolver-rules=MAP ${new URL(AP).hostname} ${AP_IP}`,
      '--ignore-certificate-errors',
    ],
  });
  const ctx = await browser.newContext({
    ...devices['Pixel 7'],
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
    storageState: storage || {
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
  const P = { browser, ctx, roomTts, httpsTts: [], tokens: [] };
  ctx.on('request', (r) => {
    const u = r.url();
    if (/^(https?|wss?):/.test(u) && !u.startsWith(`${AP}/`) && !u.startsWith(`${AP.replace(/^https/, 'wss')}/`)) offAp.push(u);
  });
  ctx.on('response', (r) => {
    if (r.url().includes('/api/tts/stream')) P.httpsTts.push(r.status());
    if (r.url().endsWith('/api/token') && r.request().method() === 'POST') P.tokens.push(r.status());
  });
  ctx.on('page', (p) => p.on('console', (m) => appendFileSync(join(STATE, 's16-phone-console.log'), `${m.type()} ${m.text().slice(0, 400)}\n`)));
  P.page = await ctx.newPage();
  screens.length = 0;
  screens.push(['phone', P.page], ['box', consolePage]);
  return P;
}

let mainId = '';
let paired = null; // the paired phone's cookies + storage, carried into each launch
const S = {}; // walk key → {proxy, real}

async function walk(w, P) {
  const { page: phone, roomTts, httpsTts, tokens } = P;
  const { way, root: ROOT } = w;
  const WHERE = whereOf(ROOT);
  const wav = WAV[way];
  const x = `${way[0]}${ROOT[0]}`; // hh, hl, fl
  const title = titleOf(w);
  const s = S[w.key];
  let turn = null;
  let released = 0;
  const how = way === 'hold' ? 'holds the mic' : 'taps the mic (hands-free) and talks, "over" at the end';

  await step(`S16.${x}3`, `[${way}@${ROOT}] Ása taps "${title}" on her list → its page, the mic key on it`, async () => {
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

  await step(`S16.${x}4`, `[${way}@${ROOT}] she ${how}: "${SAY}" → ${ROOT} stores exactly ONE user message with those words`, async () => {
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
      const u = await userTurns(WHERE, s.real);
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

  await step(`S16.${x}5`, `[${way}@${ROOT}] that message on ${ROOT} is marked spoken: info.modality = "voice"`, async () => {
    must(turn, `needs S16.${x}4`);
    must(turn.info.modality === 'voice', `info.modality = ${JSON.stringify(turn.info.modality)}`);
    return 'modality voice';
  });

  await step(`S16.${x}6`, `[${way}@${ROOT}] the answer is spoken on the phone: room audio, = the box's TTS bytes, its STT is ${ROOT}'s reply`, async () => {
    must(turn, `needs S16.${x}4`);
    const reply = await poll(async () => {
      const ms = (await brain(WHERE, `/session/${s.real}/message`)).body || [];
      const at = ms.findIndex((m) => m.info.id === turn.info.id);
      return ms.slice(at + 1).find((m) => m.info.role === 'assistant' && m.info.time?.completed) || null;
    }, 90_000, `${ROOT} never answered the voice turn`);
    await poll(() => roomTts.chunks.length > 0, 60_000,
      `no reply audio arrived over the room (${ROOT} answered "${textOf(reply).slice(0, 60)}"; ${way})`);
    // kept as evidence: the phone's screen while the answer is being said, and the sound it got
    await sleep(1500);
    await phone.screenshot({ path: join(STATE, `s16-${x}-spoken.png`) }).catch(() => {});
    await poll(() => Date.now() - roomTts.last > 4_000, 120_000, 'the reply audio never ended', 500);
    const pcm = Buffer.concat(roomTts.chunks);
    writeFileSync(join(STATE, `s16-${x}-reply.wav`), wavOf(pcm, roomTts.rate));
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

  if (way === 'free') {
    // L16's exception: while hands-free is on, the answer to a TYPED turn is spoken too
    await step(`S16.${x}8`, `[${way}@${ROOT}] the phone listens hands-free; "${TYPED}" is typed on her computer → the phone speaks that answer too`, async () => {
      must(turn, `needs S16.${x}4`);
      // the first answer is said to its end, the mic is back: listening
      const cycle = phone.getByTestId('free-phase');
      await poll(async () => (await cycle.getAttribute('data-cycle').catch(() => '')) === 'listening', 150_000, 'hands-free never came back to listening', 500);
      roomTts.chunks = [];
      roomTts.first = roomTts.last = 0;
      const sent = Date.now();
      // typed elsewhere: a plain text turn, no modality, posted to home like any other client
      const r = await brain(HOME, `/session/${s.proxy}/message?async=1`, { method: 'POST', body: { parts: [{ type: 'text', text: TYPED }] }, timeout: 30_000 });
      must(r.status === 200, `the typed turn was refused: ${r.status}`);
      const got = await poll(async () => {
        const ms = (await brain(WHERE, `/session/${s.real}/message`)).body || [];
        const at = ms.findIndex((m) => m.info.role === 'user' && textOf(m).includes('seven times six'));
        const a = at < 0 ? null : ms.slice(at + 1).find((m) => m.info.role === 'assistant' && m.info.time?.completed);
        return a ? { u: ms[at], a } : null;
      }, 90_000, `${ROOT} never answered the typed turn`);
      must(got.u.info.modality !== 'voice', `the typed turn is marked ${JSON.stringify(got.u.info.modality)}`);
      await poll(() => roomTts.chunks.length > 0, 60_000, 'the typed turn\'s answer was not spoken while hands-free was on');
      await sleep(1500);
      await phone.screenshot({ path: join(STATE, `s16-${x}-typed.png`) }).catch(() => {});
      await poll(() => Date.now() - roomTts.last > 4_000, 120_000, 'that answer\'s audio never ended', 500);
      const pcm = Buffer.concat(roomTts.chunks);
      must(pcm.length > 16_000, `${pcm.length} bytes of speech`);
      const stt = await sttOf(VOICE, pcm, roomTts.rate);
      // that answer, not the first one said again (the rig's small STT garbles words: by share)
      const want = new Set(words(textOf(got.a)));
      const heard = words(stt);
      const share = heard.filter((w) => want.has(w)).length / Math.max(1, heard.length);
      must(share > 0.4, `STT "${stt.slice(0, 120)}" vs the answer "${textOf(got.a).slice(0, 120)}"`);
      must(hits(stt) < 2, `this is the first answer again: "${stt.slice(0, 120)}"`);
      return `typed turn stored without modality · ${pcm.length} bytes of speech, first sound ${roomTts.first - sent} ms after send · STT "${stt.slice(0, 60)}" (${Math.round(share * 100)}% in the answer)`;
    });
    await phone.getByTestId('free-exit').tap({ timeout: 5_000 }).catch(() => {});
  }

  await step(`S16.${x}7`, `[${way}@${ROOT}] still once, 20 s later; reading it on home shows ${ROOT}'s turn`, async () => {
    must(turn, `needs S16.${x}4`);
    await sleep(20_000);
    const u = await userTurns(WHERE, s.real);
    must(u.length === 1, `${u.length} user messages with the words on ${ROOT}`);
    const seen = (await brain(HOME, `/session/${s.proxy}/message`)).body || [];
    must(seen.some((m) => m.info?.id === turn.info.id), 'reading the session on home does not show the voice turn');
    return 'one turn';
  });

  if (way !== 'hold') return;
  // L16, the other half: a turn she TYPES is answered in writing — the page says nothing
  await step(`S16.${x}8`, `[${way}@${ROOT}] she then types "${TYPED}" → the answer comes in writing; nothing is said aloud`, async () => {
    must(turn, `needs S16.${x}4`);
    roomTts.chunks = [];
    roomTts.first = roomTts.last = 0;
    httpsTts.length = 0;
    const boxEl = phone.getByPlaceholder('message…');
    await boxEl.tap({ timeout: 30_000 });
    await boxEl.fill(TYPED, { timeout: 30_000 });
    await phone.getByRole('button', { name: 'send', exact: true }).tap({ timeout: 30_000 });
    const got = await poll(async () => {
      const ms = (await brain(WHERE, `/session/${s.real}/message`)).body || [];
      const at = ms.findIndex((m) => m.info.role === 'user' && textOf(m).includes('seven times six'));
      const a = at < 0 ? null : ms.slice(at + 1).find((m) => m.info.role === 'assistant' && m.info.time?.completed);
      return a ? { u: ms[at], a } : null;
    }, 90_000, `${ROOT} never answered the typed turn`);
    must(got.u.info.modality !== 'voice', `the typed turn is marked ${JSON.stringify(got.u.info.modality)}`);
    // on screen, in writing
    // (the rig's model echoes the turn: her words show twice — her own bubble and the reply)
    must(textOf(got.a).includes('seven times six'), `the reply does not echo the typed turn: "${textOf(got.a).slice(0, 80)}"`);
    await poll(async () => (await phone.getByText('seven times six', { exact: false }).count()) >= 2, 30_000, 'the written answer is not on the screen');
    const head = textOf(got.a).replace(/\s+/g, ' ').trim().slice(0, 24);
    // …and silence: long enough for a spoken reply to have started (the held one's first sound came well inside this)
    await sleep(12_000);
    await phone.screenshot({ path: join(STATE, `s16-${x}-typed.png`) }).catch(() => {});
    must(roomTts.chunks.length === 0 && httpsTts.length === 0, `the typed turn's answer was spoken: ${roomTts.chunks.length} chunk(s) over the room, https ${JSON.stringify(httpsTts)}`);
    return `typed turn stored without modality · "${head}…" on screen · 0 bytes of speech in 12 s`;
  });
}

try {
  await step('S16.1', 'box console QR → the phone pairs through vps:443 (the ap) → its list', async () => {
    const P = await phoneFor(WAV.hold.path, null);
    await pair(consolePage, P.page, { base: BASE, ap: AP, png: join(STATE, 's16-pair-qr.png') });
    mainId = String((await phoneFetch(P.page, '/api/session/main')).body.id || '');
    paired = await P.ctx.storageState();
    await P.browser.close();
    must(/^ses_/.test(mainId), `MAIN ${mainId}`);
    return `MAIN ${mainId}`;
  });

  await step('S16.2', `setup: home's MAIN starts ${WALKS.map((w) => `"${titleOf(w)}"`).join(', ')} (a session on lab = a proxy on home)`, async () => {
    must(mainId, 'needs S16.1');
    const out = [];
    for (const w of WALKS) {
      const title = titleOf(w);
      const ROOT = w.root;
      const WHERE = whereOf(ROOT);
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
      S[w.key] = { proxy: row.id, real };
      out.push(`${title}: ${row.id}${ROOT === 'lab' ? ` → ${real} on lab` : ''}`);
    }
    return out.join(' · ');
  });

  for (const w of WALKS) {
    const P = await phoneFor(WAV[w.way].path, paired);
    try {
      await walk(w, P);
    } finally {
      await P.browser.close().catch(() => {});
    }
  }

  await step('∀', `the phone only ever reached ${AP}`, async () => {
    must(offAp.length === 0, offAp.slice(0, 3).join(' '));
  });
} finally {
  process.stderr.write(`s16 (${WALKS.map((w) => w.key)}): ${failed.length ? 'RED ' + failed.join(' ') : 'GREEN'} in ${Math.round((Date.now() - t00) / 1000)} s\n`);
  await box.close().catch(() => {});
}
process.exit(failed.length ? 1 : 0);
