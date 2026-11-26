#!/usr/bin/env node
/* phone.mjs — one simulated phone (a Pixel 7 in Chromium) for the voice persona sim.
 *
 * The rig (vsim.py) drives it over stdio, one JSON object per line:
 *   → {"id": 1, "cmd": "open", "tab": "home", "url": "http://127.0.0.1:8170/session/main?id=…"}
 *   ← {"id": 1, "ok": true, "result": {…}}            (errors: {"id": 1, "ok": false, "error": "…"})
 * Commands run concurrently (a keyword can be spoken while a long dictation still plays).
 *
 * One phone = one browser context (its own storage, mic permission granted) with one TAB per
 * app it talks to: one owner phone can hold several roots' apps, or each persona gets its own
 * phone. Every tab carries audio-bridge.js: the mic is a per-turn audio injection, everything
 * the page plays is recorded (see that file).
 *
 * Commands: open · handsfree · say · pull · since · tap · eval · shot · echo · close
 * Args: --name NAME --out DIR [--headed] [--cfg JSON] [--device "Pixel 7"]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
// playwright comes from the app's own toolchain (branch/node_modules) unless PLAYWRIGHT_DIR says
const require = createRequire(join(process.env.PLAYWRIGHT_DIR || join(HERE, '..', '..', 'branch'), 'package.json'));
const { chromium, devices } = require('playwright');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']);
    return acc;
  }, [])
);
const NAME = args.name || 'phone';
const OUT = args.out || '.';
mkdirSync(OUT, { recursive: true });
const CFG = JSON.parse(args.cfg || '{}');
const log = (...a) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)} ${NAME}] ${a.join(' ')}\n`);
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const bridge = readFileSync(join(HERE, 'audio-bridge.js'), 'utf8').replace('})(__VSIM_CFG__);', `})(${JSON.stringify(CFG)});`);
const browser = await chromium.launch({
  headless: !args.headed,
  args: [
    '--use-fake-ui-for-media-stream', // mic permission prompt auto-accepted
    '--use-fake-device-for-media-stream', // device list exists (the stream itself is ours)
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=AudioServiceOutOfProcess',
  ],
});
const dev = devices[args.device || 'Pixel 7'];
const tabs = new Map(); // name → {page, ctx, tts: [], console: []}
const contexts = new Map(); // origin → context (one phone: storage per origin, like a real browser)
let context = null;

async function ctxFor() {
  if (context) return context;
  context = await browser.newContext({ ...dev, permissions: ['microphone'] });
  await context.addInitScript(bridge);
  return context;
}

async function openTab(name, url, seeds) {
  const c = await ctxFor();
  let t = tabs.get(name);
  if (!t) {
    const origin = new URL(url).origin;
    if (!contexts.has(origin)) {
      contexts.set(origin, true);
      // a returning device (the door walked, first voice turn done) unless the scenario says otherwise
      const kv = seeds || { 'bifrost-door': 'v2', 'bifrost-first-turn': '1', 'oz-tts-rate': '1' };
      await c.addInitScript(
        ([o, kv]) => {
          if (location.origin !== o) return;
          try {
            for (const [k, v] of Object.entries(kv)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
          } catch {
            /* storage off */
          }
        },
        [origin, kv]
      );
    }
    const page = await c.newPage();
    t = { page, tts: [], console: [] };
    page.on('request', (r) => {
      if (!r.url().includes('/api/tts/stream')) return;
      let text = '';
      let lang = null;
      try {
        const j = r.postDataJSON() || {};
        text = String(j.text || '');
        lang = j.lang || null; // the language the app picked for this reply's voice
      } catch {
        /* not json */
      }
      t.tts.push({ t: Date.now(), text, lang, status: null, url: r.url() });
      r.response()
        .then((resp) => {
          const e = t.tts.find((x) => x.text === text && x.status === null);
          if (e) {
            e.status = resp ? resp.status() : 0;
            e.tHead = Date.now();
          }
        })
        .catch(() => {});
    });
    page.on('console', (m) => {
      if (/tts|voice|livekit|audio/i.test(m.text())) t.console.push({ t: Date.now(), type: m.type(), text: m.text().slice(0, 300) });
      if (t.console.length > 500) t.console.splice(0, 200);
    });
    page.on('pageerror', (e) => t.console.push({ t: Date.now(), type: 'pageerror', text: String(e).slice(0, 300) }));
    tabs.set(name, t);
  }
  await t.page.goto(url, { waitUntil: 'domcontentloaded' });
  return t;
}

function tab(name) {
  const t = tabs.get(name || [...tabs.keys()][0]);
  if (!t) throw new Error(`no tab ${name}`);
  return t;
}

function wav16(int16b64, rate, path) {
  const pcm = Buffer.from(int16b64, 'base64');
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([h, pcm]));
}

const handlers = {
  async open({ tab: name = 'main', url, seeds, ready = 'message…', timeout = 30000 }) {
    const t = await openTab(name, url, seeds);
    if (ready) await t.page.getByPlaceholder(ready).waitFor({ timeout });
    return { url: t.page.url() };
  },
  /** devices mode: scan the QR — open its URL (the code rides the fragment), let /pair redeem it
   *  (the device + refresh cookies land in this phone's context) and wait for the landing */
  async pair({ tab: name = 'main', url, timeout = 30000 }) {
    const t = await openTab(name, url);
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const path = new URL(t.page.url()).pathname;
      if (path !== '/pair') break;
      // v1 trunk: its /pair page redeems the fragment in place and shows "joined" (no redirect)
      if (await t.page.locator('#p-joined:visible').count().catch(() => 0)) break;
      const err = await t.page.locator('text=/already used|expired|not one the box issued|failed/i').count().catch(() => 0);
      if (err) throw new Error(`pairing refused: ${await t.page.locator('body').innerText()}`.slice(0, 300));
      await t.page.waitForTimeout(250);
    }
    const cookies = (await t.page.context().cookies()).map((c) => c.name);
    if (!cookies.includes('bifrost_device')) throw new Error(`paired page ${t.page.url()} but no device cookie`);
    return { landed: t.page.url(), cookies };
  },
  /** tap the mic (a tap = hands-free on bifrost) and wait until the voice room is up */
  async handsfree({ tab: name, testid = 'composer-mic', timeout = 40000, settle = 3000 }) {
    const t = tab(name);
    const t0 = Date.now();
    await t.page.getByTestId(testid).tap();
    const deadline = t0 + timeout;
    while (Date.now() < deadline) {
      const s = await t.page.evaluate((t0) => window.__vsim.since(t0), t0);
      const bad = s.diag.find((e) => /unavailable|failed/i.test(e.msg));
      if (bad) throw new Error(`voice: ${bad.msg}`);
      const up = s.diag.some((e) => e.msg === 'ready' || e.msg === 'room connected');
      if (up && s.uiState.startsWith('listening')) {
        await t.page.waitForTimeout(settle); // the agent joins and arms its keyword loop
        return { ms: Date.now() - t0, ui: s.uiState, diag: s.diag.map((e) => e.msg) };
      }
      await t.page.waitForTimeout(250);
    }
    const s = await t.page.evaluate((t0) => window.__vsim.since(t0), t0);
    throw new Error(`hands-free never became ready: ${s.uiState} ${s.diag.map((e) => e.msg).join(' | ')}`);
  },
  /** play a wav into the mic; resolves when it has been fully spoken */
  async say({ tab: name, wav, gain }) {
    const t = tab(name);
    const b64 = readFileSync(wav).toString('base64');
    return t.page.evaluate(([b, g]) => window.__vsim.say(b, { gain: g }), [b64, gain || 1]);
  },
  /** save what a bus recorded since the previous pull */
  async pull({ tab: name, bus = 'reply', path }) {
    const t = tab(name);
    const r = await t.page.evaluate((bus) => window.__vsim.pull(bus), bus);
    if (r.n && path) wav16(r.b64, r.rate, path);
    return { t0: r.t0, n: r.n, sec: r.n / r.rate, path: r.n ? path : null };
  },
  /** the timeline since `t`: loud reply spans, diag, UI state, media/mic events, TTS calls */
  async since({ tab: name, t: since = 0 }) {
    const t = tab(name);
    const s = await t.page.evaluate((x) => window.__vsim.since(x), since);
    s.tts = t.tts.filter((x) => x.t >= since);
    s.console = t.console.filter((x) => x.t >= since).slice(-40);
    return s;
  },
  async tap({ tab: name, testid, selector }) {
    const t = tab(name);
    await (testid ? t.page.getByTestId(testid) : t.page.locator(selector)).first().tap();
    return {};
  },
  async eval({ tab: name, js }) {
    return tab(name).page.evaluate(js);
  },
  async echo({ tab: name, gain }) {
    await tab(name).page.evaluate((g) => window.__vsim.setEcho(g), gain);
    return {};
  },
  async shot({ tab: name, path }) {
    await tab(name).page.screenshot({ path });
    return { path };
  },
  async close() {
    for (const t of tabs.values()) await t.page.goto('about:blank').catch(() => {});
    await browser.close();
    setTimeout(() => process.exit(0), 100);
    return {};
  },
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const h = handlers[m.cmd];
  if (!h) return send({ id: m.id, ok: false, error: `unknown cmd ${m.cmd}` });
  Promise.resolve()
    .then(() => h(m))
    .then((result) => send({ id: m.id, ok: true, result }))
    .catch((e) => {
      log(`${m.cmd} failed: ${e && e.message}`);
      send({ id: m.id, ok: false, error: String((e && e.message) || e) });
    });
});
rl.on('close', () => browser.close().finally(() => process.exit(0)));
send({ id: 0, ok: true, result: { ready: true, name: NAME } });
log('phone up');
