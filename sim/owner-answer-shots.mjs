// owner-answer-shots.mjs <branchDir> <appUrl> <outDir> <token|-> <idsJson> — drives the answer cards in a real browser at phone size.
// Prints one JSON line: what each step saw. (sim/owner-answer-e2e.py runs it and checks the brain's side.)
import { createRequire } from 'node:module';
import path from 'node:path';
const [branch, app, out, token, idsJson] = process.argv.slice(2);
const require = createRequire(path.join(branch, 'package.json'));
const { chromium } = require('playwright-core');
const ids = JSON.parse(idsJson);
const res = {};
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
if (token !== '-') await ctx.addCookies([{ name: 'bifrost_device', value: token, url: app }]);
await ctx.addInitScript(() => {
  localStorage.setItem('bifrost-door', 'v2');
  localStorage.setItem('bifrost-first-turn', '1');
});
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: path.join(out, `${n}.png`) });
await page.goto(`${app}/session/main`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="ask-card"]', { timeout: 45000 });
res.cards = await page.locator('[data-testid="ask-card"]').count();
res.questions = await page.locator('[data-testid="ask-q"]').allTextContents();
res.unpaired = await page.locator('[data-testid="ask-unpaired"]').count();
res.yes = await page.locator('[data-testid="ask-yes"]').count();
res.yesAll = await page.locator('[data-testid="ask-yes-all"]').count();
const q0 = page.locator('[data-testid="ask-q"]').first();
res.fits = await q0.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1);
await shot(token === '-' ? 'main-unpaired' : 'main-paired');
if (token !== '-') {
  if (ids.mode === 'one') {
    await page.locator('[data-testid="ask-yes"]').first().click();
    await page.waitForSelector('[data-testid="ask-done"]', { timeout: 15000 });
    res.done = await page.locator('[data-testid="ask-done"]').first().textContent();
    await shot('main-after-yes');
  } else {
    await page.locator('[data-testid="ask-yes-all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="ask-done"]').length >= document.querySelectorAll('[data-testid="ask-card"]').length, null, { timeout: 15000 });
    res.doneAll = await page.locator('[data-testid="ask-done"]').count();
    await shot('main-after-yes-all');
  }
}
await browser.close();
console.log(JSON.stringify(res));
