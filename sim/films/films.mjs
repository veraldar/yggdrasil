#!/usr/bin/env node
/* films.mjs — records the site's films: the real app on a Pixel 7, driven by taps, over the trunk.
 *
 * Run by `sim/trunk-rtc-e2e.sh --scenario films` (through sim/films/record.sh), AT HOME (the box's
 * namespace). The world is the voice rig's: the phone is its own Chromium in the phone's namespace,
 * it only talks to the VPS's :443, the box runs the app in devices mode, LiveKit, the real voice
 * agent and speech engines, and three brains: home, studio, workshop (each with its own MAIN). The
 * model is sim/films/film_upstream.py: it answers the lines in script.json, so a film says the same
 * thing every time it is recorded. No session, name or word in this world is the owner's.
 *
 *  F0.1 the box console's QR → the phone pairs through the ap
 *  F0.2 the sessions of the invented world are made (script.json "seed"), each with one real turn
 *  talk  hold the tree on the home screen, speak (a WAV as the microphone), hear the answer
 *  tree  the roots key → the list of computers → studio: its MAIN, its sessions → a typed turn there
 *  file  the paperclip → a PDF → a question → the answer links a file it made → the file opens
 *
 * Each film: $FILMS_OUT/raw/<name>/f*.jpg + raw/<name>.ffconcat (the phone's screen, every frame the
 * browser painted, at the phone's own resolution, with the browser's timestamps — Playwright's own
 * video is a quarter of that and its clock is not ours) and $FILMS_OUT/<name>.json (the cut marks
 * and captions, in seconds from the first frame). sim/films/cut.py makes the films from those.
 * FILMS_ONLY=talk,tree picks films.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATE, brain, chromium, devices, env, failed, hydrated, must, pair, poll, renderSay, rowOf, screens, sleep, step, textOf, touchDown,
} from '../reach/rig-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AP = env('PW_AP_URL');
const AP_IP = env('PW_AP_IP');
const BASE = env('PW_BASE_URL');
const HOME = env('PW_HOME');
const VOICE = env('PW_VOICE');
const PHONE_CHROME = env('PW_PHONE_CHROME');
const OUT = env('FILMS_OUT');
const PEER = env('PW_PEER_TOKEN');
const ROOTS = Object.fromEntries([['home', HOME], ...env('PW_ROOTS').split(',').filter(Boolean).map((kv) => kv.split('='))]);
must(AP && STATE && BASE && HOME && VOICE && PHONE_CHROME && OUT, 'run by sim/trunk-rtc-e2e.sh --scenario films');
const SCRIPT = JSON.parse(readFileSync(join(HERE, 'script.json'), 'utf8'));
const LINE = Object.fromEntries(SCRIPT.lines.map((l) => [l.id, l]));
const ONLY = env('FILMS_ONLY').split(',').filter(Boolean);
const wants = (f) => !ONLY.length || ONLY.includes(f);
mkdirSync(join(OUT, 'raw'), { recursive: true });

const LEAD = 1.2; // silence in the WAV before the sentence

/** a dot where the finger is: touches are invisible on a recording */
const FINGER = () => {
  let d;
  let since = 0;
  const dot = () => {
    if (!d) {
      d = document.createElement('div');
      d.style.cssText =
        'position:fixed;z-index:2147483647;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;' +
        'background:rgba(255,255,255,.30);border:2px solid rgba(255,255,255,.9);pointer-events:none;opacity:0;transition:opacity .12s';
    }
    if (!d.isConnected) document.documentElement.appendChild(d);
    return d;
  };
  const at = (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    const el = dot();
    el.style.left = `${t.clientX}px`;
    el.style.top = `${t.clientY}px`;
    el.style.opacity = '1';
    since = Date.now();
  };
  const off = () => setTimeout(() => d && (d.style.opacity = '0'), Math.max(0, 380 - (Date.now() - since)));
  addEventListener('touchstart', at, { capture: true, passive: true });
  addEventListener('touchmove', at, { capture: true, passive: true });
  addEventListener('touchend', off, { capture: true, passive: true });
  addEventListener('touchcancel', off, { capture: true, passive: true });
};

/** one launch of the phone. `wav` = its microphone; `film` = record its screen under that name */
async function phoneFor({ wav, storage, film }) {
  const args = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    `--host-resolver-rules=MAP ${new URL(AP).hostname} ${AP_IP}`,
    '--ignore-certificate-errors',
  ];
  if (wav) args.push(`--use-file-for-fake-audio-capture=${wav}`);
  const browser = await chromium.launch({ executablePath: PHONE_CHROME, args });
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
  if (film) await ctx.addInitScript(FINGER);
  ctx.on('page', (p) => p.on('console', (m) => appendFileSync(join(STATE, 'films-phone-console.log'), `${m.type()} ${m.text().slice(0, 400)}\n`)));
  const page = await ctx.newPage();
  const marks = [];
  const now = () => Date.now() / 1000; // epoch seconds: the clock of the frames' own timestamps
  const frames = [];
  let cdp = null;
  if (film) {
    const dir = join(OUT, 'raw', film);
    mkdirSync(dir, { recursive: true });
    cdp = await ctx.newCDPSession(page);
    cdp.on('Page.screencastFrame', (ev) => {
      const file = `f${String(frames.length).padStart(5, '0')}.jpg`;
      writeFileSync(join(dir, file), Buffer.from(ev.data, 'base64'));
      frames.push({ t: ev.metadata.timestamp, file });
      cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  }
  screens.length = 0;
  screens.push(['phone', page]);
  return {
    browser, ctx, page,
    /** a caption, from now until the next one */
    cap: (text) => marks.push({ t: now(), cap: text }),
    /** a cut mark: start, poster, end */
    mark: (k) => marks.push({ t: now(), mark: k }),
    /** close the phone; the video and its marks land in $FILMS_OUT */
    async done(extra = {}) {
      const closed = now();
      if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
      await ctx.close();
      await browser.close();
      if (!film) return '';
      must(frames.length > 10, `only ${frames.length} frames of ${film} were captured`);
      const t0 = frames[0].t;
      const rel = (t) => Math.round((t - t0) * 1000) / 1000;
      const lines = ['ffconcat version 1.0'];
      frames.forEach((f, i) => {
        const next = i + 1 < frames.length ? frames[i + 1].t : closed;
        lines.push(`file ${film}/${f.file}`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
      });
      lines.push(`file ${film}/${frames[frames.length - 1].file}`); // the concat demuxer wants the last one named twice
      writeFileSync(join(OUT, 'raw', `${film}.ffconcat`), lines.join('\n') + '\n');
      writeFileSync(join(OUT, `${film}.json`), JSON.stringify({
        name: film, title: SCRIPT.films[film].title, frames: `raw/${film}.ffconcat`, count: frames.length, length: rel(closed),
        marks: marks.map((m) => ({ ...m, t: rel(m.t) })), ...extra,
      }, null, 2));
      return `${frames.length} frames`;
    },
  };
}

const msgs = async (base, sid) => (await brain(base, `/session/${sid}/message`)).body || [];
const sessions = async (base) => (await brain(base, '/session')).body || [];
const peerHdr = PEER ? { 'x-ygg-peer': PEER } : {};

async function send(phone, text, { typed = true } = {}) {
  const box = phone.getByPlaceholder('message…');
  await box.tap({ timeout: 30_000 });
  if (typed) await box.pressSequentially(text, { delay: 55 });
  else await box.fill(text);
  await sleep(350);
  await phone.getByRole('button', { name: 'send', exact: true }).tap({ timeout: 30_000 });
}

// ------------------------------------------------------------------------------------------------
let paired = null;
let mainId = '';
const box = await chromium.launch();
const consolePage = await (await box.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

await step('F0.1', "the box console's QR → the phone pairs through the ap", async () => {
  const P = await phoneFor({});
  await pair(consolePage, P.page, { base: BASE, ap: AP, png: join(STATE, 'films-qr.png') });
  mainId = await poll(async () => ((await sessions(HOME)).find((s) => s.title === '[MAIN]') || {}).id, 30_000, 'home has no [MAIN]');
  paired = await P.ctx.storageState();
  await P.done();
  return `paired; home MAIN ${mainId}`;
});

await step('F0.2', 'the invented world: its sessions, each with one real turn', async () => {
  must(paired, 'needs F0.1');
  const made = [];
  for (const s of SCRIPT.seed) {
    const base = ROOTS[s.root];
    must(base, `no brain for root ${s.root}`);
    const hdr = s.root === 'home' ? {} : peerHdr;
    const c = await brain(base, '/session', { method: 'POST', body: { title: s.title }, headers: hdr });
    must(c.status < 300 && c.body.id, `POST /session on ${s.root}: ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`);
    if (s.say) {
      const r = await brain(base, `/session/${c.body.id}/message`, { method: 'POST', body: { parts: [{ type: 'text', text: s.say }] }, timeout: 120_000, headers: hdr });
      must(r.status < 300, `the turn on ${s.root}/${s.title}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      const reply = (await msgs(base, c.body.id)).filter((m) => m.info.role === 'assistant').map(textOf).join(' ');
      must(!/MOCK-REPLY/.test(reply) && reply.trim(), `"${s.say}" got no scripted answer: ${reply.slice(0, 120)}`);
    }
    made.push(`${s.root}/${s.title}`);
  }
  return made.join(' · ');
});

// ------------------------------------------------------------------------------------------- talk
if (wants('talk')) {
  const F = SCRIPT.films.talk;
  const answer = LINE[F.line].answer;
  await step('talk', `hold the tree, say "${F.say}", hear the answer`, async () => {
    must(paired, 'needs F0.1');
    const wav = await renderSay(VOICE, F.say, join(STATE, 'films-talk.wav'), { lead: LEAD, tail: 45 });
    const P = await phoneFor({ wav: wav.path, storage: paired, film: 'talk' });
    const phone = P.page;
    await phone.goto(`${AP}/`);
    const roots = phone.getByTestId('roots');
    await roots.waitFor({ timeout: 30_000 });
    await hydrated(phone, '[data-testid="roots-hit"]');
    await rowOf(phone, 'holiday photos').first().waitFor({ timeout: 30_000 });
    await sleep(1500);
    const before = (await msgs(HOME, mainId)).filter((m) => m.info.role === 'user').length;
    P.mark('start');
    P.cap('Hold the tree.');
    await sleep(1400);
    const release = await touchDown(phone, phone.getByTestId('roots-hit'));
    let talkMs = 0;
    const t0 = Date.now();
    try {
      await poll(async () => (await roots.getAttribute('data-phase')) === 'talk', 40_000, 'the tree never went live (data-phase talk)', 100);
      talkMs = Date.now() - t0;
      P.cap(`Speak: “${F.say}”`);
      await sleep(Math.round((LEAD + wav.speech + 0.9) * 1000));
    } finally {
      await release();
    }
    P.cap('Let go.');
    const turn = await poll(async () => {
      const u = (await msgs(HOME, mainId)).filter((m) => m.info.role === 'user');
      return u.length > before ? u[u.length - 1] : null;
    }, 60_000, 'the words never reached MAIN');
    must(new RegExp(LINE[F.line].match, 'i').test(textOf(turn)), `speech-to-text heard "${textOf(turn).slice(-120)}"`);
    await poll(async () => (await roots.getAttribute('data-phase')) === 'speaking', 120_000, 'the answer was never spoken (data-phase speaking)', 100);
    P.cap(`It answers out loud: “${answer}”`);
    P.mark('poster');
    await poll(async () => (await roots.getAttribute('data-phase')) !== 'speaking', 120_000, 'it never stopped speaking', 200);
    await sleep(1600);
    P.mark('end');
    const said = await phone.getByTestId('roots-say').innerText().catch(() => '');
    await P.done({ heard: textOf(turn).split('\n').filter(Boolean).pop(), answer });
    return `hold→live ${talkMs} ms · heard "${textOf(turn).split('\n').filter(Boolean).pop()}" · on screen "${said.slice(0, 80)}"`;
  });
}

// ------------------------------------------------------------------------------------------- tree
if (wants('tree')) {
  const F = SCRIPT.films.tree;
  const answer = LINE[F.line].answer;
  await step('tree', `the roots key → the computers → ${F.root}: its MAIN and sessions → "${F.type}" there`, async () => {
    must(paired, 'needs F0.1');
    const P = await phoneFor({ storage: paired, film: 'tree' });
    const phone = P.page;
    await phone.goto(`${AP}/`);
    await phone.getByTestId('roots').waitFor({ timeout: 30_000 });
    await hydrated(phone, '[data-testid="roots-hit"]');
    await rowOf(phone, 'holiday photos').first().waitFor({ timeout: 30_000 });
    await sleep(1500);
    P.mark('start');
    P.cap('All your computers are one tap away.');
    await sleep(1600);
    await poll(async () => {
      await phone.getByRole('button', { name: 'roots', exact: true }).tap();
      return phone.getByTestId('roots-sheet').isVisible();
    }, 20_000, 'the roots sheet never opened', 1500);
    const rows = phone.getByTestId('root-row');
    await poll(async () => (await rows.count()) >= 3, 20_000, 'fewer than three computers in the list');
    P.cap('One row for each, with its state.');
    P.mark('poster');
    await sleep(2600);
    await phone.locator(`[data-testid="root-row"][data-root="${F.root}"]`).tap();
    const view = phone.getByTestId('root-view');
    await view.waitFor({ timeout: 20_000 });
    await view.getByTestId('root-main').waitFor({ timeout: 20_000 });
    await poll(async () => (await view.getByTestId('root-sess').count()) >= 2, 20_000, `${F.root}'s sessions never listed`);
    P.cap('Each has its own main session, and its own sessions.');
    await sleep(2800);
    await view.getByTestId('root-main').tap();
    await phone.waitForURL(/\/session\//, { timeout: 20_000 });
    await phone.getByPlaceholder('message…').waitFor({ timeout: 20_000 });
    await hydrated(phone, '[data-testid="composer-mic"]');
    P.cap('Talk or type to it, like the one at home.');
    await sleep(900);
    await send(phone, F.type);
    await phone.getByText('1,800 frames', { exact: false }).first().waitFor({ timeout: 90_000 });
    P.cap('It answers from that computer, live.');
    await sleep(3200);
    P.mark('end');
    const url = phone.url().replace(AP, '');
    await P.done({ answer });
    return `${F.root}'s MAIN at ${url}`;
  });
}

// ------------------------------------------------------------------------------------------- file
if (wants('file')) {
  const F = SCRIPT.films.file;
  await step('file', `the paperclip → ${F.file} → "${F.type}" → the answer links a file it made → it opens`, async () => {
    must(paired, 'needs F0.1');
    const pdf = join(STATE, F.file);
    execFileSync('python3', [join(HERE, '..', 'reach', 'make_pdf.py'), pdf, '--mb', '0.2', '--marker', 'october'], { stdio: 'pipe' });
    const P = await phoneFor({ storage: paired, film: 'file' });
    const phone = P.page;
    await phone.goto(`${AP}/`);
    const row = rowOf(phone, F.session);
    await row.first().waitFor({ timeout: 30_000 });
    await sleep(1200);
    P.mark('start');
    P.cap('Open a session.');
    await sleep(1200);
    await row.first().tap();
    await phone.waitForURL(/\/session\//, { timeout: 20_000 });
    await phone.getByPlaceholder('message…').waitFor({ timeout: 20_000 });
    await hydrated(phone, '[data-testid="composer-mic"]');
    P.cap('The paperclip takes any file.');
    await sleep(1300);
    const [chooser] = await Promise.all([
      phone.waitForEvent('filechooser', { timeout: 15_000 }),
      phone.getByRole('button', { name: 'attach' }).tap(),
    ]);
    await chooser.setFiles(pdf);
    await phone.getByTestId('attachment').first().waitFor({ timeout: 20_000 });
    await sleep(1200);
    const alert = await phone.locator('main [role="alert"]').allInnerTexts().catch(() => []);
    must(!alert.join(' ').trim(), `the composer says: ${alert.join(' ').slice(0, 200)}`);
    P.cap('Ask about it.');
    await send(phone, F.type);
    const link = phone.locator('[data-mi] a[href*="october-summary.html"]').last();
    await link.waitFor({ timeout: 120_000 });
    P.cap('It answers, and makes a file.');
    P.mark('poster');
    await sleep(2600);
    P.cap('The file opens on your phone.');
    const popup = P.ctx.waitForEvent('page', { timeout: 6_000 }).catch(() => null);
    await link.tap();
    const other = await popup;
    const view = other || phone;
    await view.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await poll(async () => {
      for (const f of view.frames()) if (/1,284/.test(await f.locator('body').innerText().catch(() => ''))) return true;
      return false;
    }, 30_000, 'the file never showed (no "1,284" on the page)');
    await sleep(3000);
    P.mark('end');
    await P.done({ popup: !!other });
    return other ? 'the link opened a new tab (its picture is not in this recording)' : 'the file opened in the app';
  });
}

await box.close();
process.exit(failed.length ? 1 : 0);
