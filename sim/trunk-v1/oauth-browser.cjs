// oauth-browser.cjs — the OAuth sign-in in a real Chromium (Pixel 7, 360 px): tap "Continue with
// Mock ID" on /login → the mock provider (another site: 127.0.0.1 vs localhost) → back to the
// trunk's callback with the browser-binding cookie (SameSite=Lax must survive the cross-site
// return) → /login's second step → TOTP → signed in. Run by sim/trunk-v1-auth.py; prints one JSON
// line per check, then {"done": true, "last_step": N}.
//
//   NODE_PATH=branch/node_modules node sim/trunk-v1/oauth-browser.cjs <public url> <params JSON {secret, last_step}>
'use strict';
const { chromium, devices } = require('playwright');
const crypto = require('crypto');

const [url, paramsJson] = process.argv.slice(2);
const P = JSON.parse(paramsJson);
let lastStep = P.last_step || 0;
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const check = (name, ok, detail) => emit({ check: name, ok: !!ok, detail: ok ? undefined : detail });

function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0;
  const o = [];
  for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) {
    val = (val << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) { o.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(o);
}
async function totp() {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    for (const step of [now - 1, now, now + 1]) {
      if (step > lastStep) {
        lastStep = step;
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64BE(BigInt(step));
        const mac = crypto.createHmac('sha1', b32decode(P.secret)).update(buf).digest();
        const off = mac[19] & 15;
        return String((mac.readUInt32BE(off) & 0x7fffffff) % 1000000).padStart(6, '0');
      }
    }
    await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 200));
  }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  const hops = [];
  page.on('request', (r) => { if (r.isNavigationRequest()) hops.push(new URL(r.url()).host + new URL(r.url()).pathname); });

  await page.goto(url + '/login?next=/account');
  await page.waitForSelector('#l-oauth .oauth-btn[data-provider=mock]');
  await Promise.all([page.waitForSelector('#l-via:not([hidden])', { timeout: 15000 }), page.click('#l-oauth .oauth-btn[data-provider=mock]')]);
  const mockHost = hops.find((h) => h.endsWith('/authorize'));
  check('browser OAuth: the button went to the provider and came back to the callback', !!mockHost && hops.some((h) => h.includes('/t/auth/oauth/mock/callback')), hops);
  check('browser OAuth: the second step shows, the ticket left the address bar', (await page.textContent('#l-via')).includes('Mock ID') && !page.url().includes('mfa='), page.url());
  const before = await page.evaluate(async () => (await fetch('/t/me')).status);
  check('browser OAuth: no session before the second factor', before === 401, before);
  await page.fill('#l-code', await totp());
  await Promise.all([page.waitForURL(url + '/account'), page.click('#l-btn')]);
  const me = await page.evaluate(async () => { const r = await fetch('/t/me'); return { s: r.status, d: await r.json() }; });
  check('browser OAuth: Mock ID + TOTP → signed in as the admin, back on ?next=/account', me.s === 200 && me.d.device.role === 'admin', me);
  const a = await page.evaluate(async () => (await (await fetch('/t/account')).json()));
  check('browser OAuth: /account shows the provider instead of a password', !(await page.isVisible('#a-pw-form')) && (await page.textContent('#a-oauth-name')).includes('Mock ID'), a.oauth);
  check('browser OAuth: the binding cookie is gone after the callback', !(await ctx.cookies()).some((c) => c.name === 'bifrost_oauth'), await ctx.cookies());
  check('browser OAuth: no console error or CSP refusal', problems.length === 0, problems);
  await browser.close();
  emit({ done: true, last_step: lastStep });
})().catch((e) => { emit({ check: 'oauth-browser.cjs ran to the end', ok: false, detail: String(e && e.stack || e) }); emit({ done: true, last_step: lastStep }); process.exit(1); });
