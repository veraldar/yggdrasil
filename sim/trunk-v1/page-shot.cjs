// page-shot.cjs — screenshot trunk pages as a Pixel 7 at 360 px (G3.7 M4: the OAuth buttons and
// steps). Prints one JSON line {"shots": [{name, ok, problems}]}; exit 1 when a page had a console
// error, a CSP refusal, a missing element or anything wider than the screen.
//
//   NODE_PATH=branch/node_modules node sim/trunk-v1/page-shot.cjs <out dir> <JSON [{name, url, wait}]>
'use strict';
const { chromium, devices } = require('playwright');

const [out, listJson] = process.argv.slice(2);
const list = JSON.parse(listJson);

(async () => {
  const browser = await chromium.launch();
  const res = [];
  for (const s of list) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push('console: ' + m.text()); });
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    try {
      await page.goto(s.url);
      if (s.wait) await page.waitForSelector(s.wait, { timeout: 10000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: out + '/' + s.name + '.png', fullPage: true });
      if (!(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))) problems.push('wider than 360 px');
    } catch (e) {
      problems.push(String(e.message || e));
    }
    res.push({ name: s.name, ok: problems.length === 0, problems });
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify({ shots: res }));
  process.exit(res.every((r) => r.ok) ? 0 : 1);
})();
