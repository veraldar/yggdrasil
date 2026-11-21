#!/usr/bin/env node
/* render.mjs DIR — shoots DIR/movie.html frame by frame (window.renderAt(t), 30 a second) into
 * DIR/frames/NNNNN.jpg. DIR also holds font.woff and footage/ (make.sh puts them there, and encodes).
 * A frame that is already there is not shot again: a run that stopped goes on where it was.
 * RENDER_STILLS="3,12.5,30" writes still-<t>.png only (to look before a full render). */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(process.env.APP_DIR || join(HERE, '..', '..', '..', 'branch'), 'package.json'));
const { chromium } = require('playwright');
const DIR = process.argv[2];
const FPS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`stuck: ${what}`); })]);
const count = (n) => readdirSync(join(DIR, 'footage', n)).filter((f) => f.endsWith('.jpg')).length;
const FOOT = { talk: { n: count('talk') }, tree: { n: count('tree') }, file: { n: count('file') } };

let browser, page, cdp;
async function open() {
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 })).newPage();
  page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
  await page.addInitScript((foot) => { window.FOOT = foot; }, FOOT);
  await page.goto('file://' + join(DIR, 'movie.html'));
  await page.evaluate(() => document.fonts.ready);
  cdp = await page.context().newCDPSession(page);
}
/** the picture for second t; a step that does not come back in 8 s gets a new browser, three times at most */
async function frameAt(t, format = 'jpeg') {
  for (let tries = 0; ; tries++) {
    try {
      await within(page.evaluate((t) => window.renderAt(t), t), 8000, `renderAt(${t.toFixed(3)})`);
      const r = await within(cdp.send('Page.captureScreenshot', format === 'png' ? { format } : { format, quality: 96 }), 8000, `the shot at ${t.toFixed(3)}`);
      return Buffer.from(r.data, 'base64');
    } catch (e) {
      process.stderr.write(`second ${t.toFixed(3)}: ${String(e.message || e).split('\n')[0]} (try ${tries + 1})\n`);
      if (tries >= 3) throw e;
      await open();
    }
  }
}
await open();
const dur = await page.evaluate(() => window.DURATION);
writeFileSync(join(DIR, 'vo.json'), JSON.stringify(await page.evaluate(() => window.VO), null, 1)); // the voice's lines, for sound.py
if (process.env.RENDER_STILLS) {
  for (const t of process.env.RENDER_STILLS.split(',').map(Number)) writeFileSync(join(DIR, `still-${String(t).padStart(5, '0')}.png`), await frameAt(t, 'png'));
  await browser.close();
  process.exit(0);
}
mkdirSync(join(DIR, 'frames'), { recursive: true });
const n = Math.round(dur * FPS);
let made = 0;
for (let f = 0; f < n; f++) {
  const file = join(DIR, 'frames', `${String(f + 1).padStart(5, '0')}.jpg`);
  if (existsSync(file)) continue;
  writeFileSync(file, await frameAt(f / FPS));
  made++;
  if (f % 300 === 0) process.stderr.write(`frame ${f} of ${n}\n`);
}
await browser.close();
console.log(`${n} frames (${(n / FPS).toFixed(1)} s), ${made} shot now`);
