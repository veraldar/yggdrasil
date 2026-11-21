#!/usr/bin/env node
/* render.mjs DIR — shoots DIR/movie.html frame by frame (window.renderAt(t), 30 a second) into
 * DIR/movie-raw.mp4. DIR also holds font.woff and footage/ (make.sh puts them there).
 * RENDER_FROM / RENDER_TO (seconds) shoot a part; RENDER_STILLS="3,12.5,30" writes still-<t>.png only. */
import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(process.env.APP_DIR || join(HERE, '..', '..', '..', 'branch'), 'package.json'));
const { chromium } = require('playwright');
const DIR = process.argv[2];
const FPS = 30;
const count = (n) => readdirSync(join(DIR, 'footage', n)).filter((f) => f.endsWith('.jpg')).length;
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
await page.addInitScript((foot) => { window.FOOT = foot; }, { talk: { n: count('talk') }, tree: { n: count('tree') }, file: { n: count('file') } });
await page.goto('file://' + join(DIR, 'movie.html'));
await page.evaluate(() => document.fonts.ready);
const dur = await page.evaluate(() => window.DURATION);
const cdp = await page.context().newCDPSession(page);
const shot = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
if (process.env.RENDER_STILLS) {
  for (const t of process.env.RENDER_STILLS.split(',').map(Number)) {
    await page.evaluate((t) => window.renderAt(t), t);
    writeFileSync(join(DIR, `still-${String(t).padStart(5, '0')}.png`), await shot());
  }
  await browser.close();
  process.exit(0);
}
const from = Number(process.env.RENDER_FROM || 0), to = Number(process.env.RENDER_TO || dur);
const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p', join(DIR, 'movie-raw.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
const n0 = Math.round(from * FPS), n1 = Math.round(to * FPS);
for (let f = n0; f < n1; f++) {
  await page.evaluate((t) => window.renderAt(t), f / FPS);
  if (!ff.stdin.write(await shot())) await new Promise((r) => ff.stdin.once('drain', r));
  if ((f - n0) % 300 === 0) process.stderr.write(`frame ${f - n0} of ${n1 - n0}\n`);
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
await browser.close();
console.log(`rendered ${n1 - n0} frames (${((n1 - n0) / FPS).toFixed(1)} s)`);
