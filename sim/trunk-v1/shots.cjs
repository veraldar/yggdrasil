// shots.cjs — drive the v1 trunk's shell pages in Chromium as a Pixel 7 at 360 px and screenshot
// every page and state (storyboard steps 1, 2a–2c, 3 + login, account, offline, claimed).
// Run by sim/trunk-v1/shots.py (it starts the trunk); exits 1 on a console error, a CSP
// violation or a missing element.
//   NODE_PATH=branch/node_modules node sim/trunk-v1/shots.cjs <url> <out dir> <ctl argv as JSON>
'use strict';
const { chromium, devices } = require('playwright');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const [url, out, ctlJson, dbPath] = process.argv.slice(2);
const ctl = JSON.parse(ctlJson);
const problems = [];

function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0;
  const outb = [];
  for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) {
    val = (val << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) { outb.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(outb);
}
let lastStep = 0;
function totp(secret) {
  let step = Math.floor(Date.now() / 30000) - 1;
  while (step <= lastStep) step++;
  lastStep = step;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const off = mac[19] & 15;
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 1000000;
  return String(n).padStart(6, '0');
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  // a deliberate 4xx answer (wrong code, weak password, 410 claimed) logs "Failed to load resource";
  // anything else — a script error, a CSP refusal — is a problem
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  let n = 0;
  const shot = async (name) => {
    await page.waitForTimeout(250);
    const file = `${out}/${String(++n).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    // the page must fit 360 px: nothing scrolls sideways
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    if (w > 360) problems.push(`${name}: ${w}px wide at a 360px viewport`);
    console.log('shot', file);
  };
  const must = async (sel) => {
    try { await page.waitForSelector(sel, { state: 'visible', timeout: 8000 }); } catch (e) { problems.push('missing ' + sel); }
  };

  // step 1 — before the agent: /claim without a ticket
  await page.goto(url + '/claim');
  await must('#c-wait');
  await shot('claim-waiting-for-agent');

  // the agent (this script) reads the code on the console and begins the claim
  const code = JSON.parse(execFileSync(ctl[0], [...ctl.slice(1), 'claim-code', '--json']).toString()).code;
  const begin = await page.evaluate(async (c) => {
    const r = await fetch('/t/claim/begin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c }) });
    return r.json();
  }, code);
  // 2a — approve
  await page.goto(url + '/claim#t=' + begin.ticket);
  await must('#c-approve');
  await shot('claim-2a-approve');
  await page.click('#c-approve-btn');
  // 2b — create the admin
  await must('#c-signup');
  await page.fill('#c-email', 'owner@example.org');
  await page.fill('#c-password', 'short');
  await page.click('#c-signup-btn');
  await shot('claim-2b-create-admin');
  await page.fill('#c-password', 'Q1W2E3R4T5Y6');
  await page.click('#c-signup-btn');
  await must('#c-signup-err');
  await shot('claim-2b-password-on-the-list');
  await page.fill('#c-password', 'correct horse battery staple 7');
  await page.click('#c-signup-btn');
  // 2c — TOTP
  await must('#c-totp');
  await page.click('details.manual summary');
  await shot('claim-2c-totp');
  const secret = (await page.textContent('#c-secret')).replace(/\s/g, '');
  await page.fill('#c-code', '000000');
  await page.click('#c-totp-btn');
  await must('#c-totp-err');
  await shot('claim-2c-wrong-code');
  await page.fill('#c-code', totp(secret));
  await page.click('#c-totp-btn');
  await must('#c-codes');
  await shot('claim-2c-recovery-codes');
  // 3 — the empty trunk
  await page.click('#c-done');
  await page.waitForURL(url + '/');
  await must('#e-listen');
  await page.waitForFunction(() => document.getElementById('e-email').textContent.includes('@'));
  await shot('empty-trunk-linux');
  await page.click('label[for=os-mac]');
  await shot('empty-trunk-macos');
  await page.click('label[for=os-win]');
  await shot('empty-trunk-windows');
  // the account page
  await page.goto(url + '/account');
  await page.waitForFunction(() => document.getElementById('a-dev-name').textContent !== '…');
  await shot('account');
  await page.click('#a-recovery-new');
  await must('#a-codes-box');
  await shot('account-new-recovery-codes');
  await page.click('#a-totp-reset');
  await must('#a-totp-box');
  await shot('account-reset-authenticator');
  // offline (signed in, no door)
  await page.goto(url + '/offline');
  await page.waitForFunction(() => document.getElementById('o-email').textContent.includes('@'));
  await shot('offline');
  // the claim page once claimed (410)
  await page.goto(url + '/claim');
  await shot('claimed-410');
  // sign out → /login
  await page.goto(url + '/account');
  await page.waitForFunction(() => document.getElementById('a-dev-name').textContent !== '…');
  await page.click('#a-logout');
  await page.waitForURL(url + '/login');
  await must('#l-form');
  await shot('login');
  await page.fill('#l-email', 'owner@example.org');
  await page.fill('#l-password', 'not the password');
  await page.fill('#l-code', '123456');
  await page.click('#l-btn');
  await must('#l-err');
  await shot('login-generic-error');
  await page.click('#l-use-recovery');
  await shot('login-recovery-code');
  await page.click('#l-use-code');
  await page.fill('#l-password', 'correct horse battery staple 7');
  await page.fill('#l-code', totp(secret));
  await page.click('#l-btn');
  await page.waitForURL(url + '/');
  await must('#e-listen');
  await shot('signed-in-again');
  // the access cookie gone (as if expired): a page goes to /login, which refreshes quietly and comes back
  await ctx.clearCookies({ name: 'bifrost_device' });
  await page.goto(url + '/account');
  await page.waitForURL(url + '/account', { timeout: 8000 }).catch(() => problems.push('silent refresh did not come back to /account'));
  await page.waitForFunction(() => document.getElementById('a-dev-name').textContent !== '…');
  await shot('account-after-silent-refresh');
  // the first root enrolls (a row in WIRE's roots table, as an enrollment leaves it): the empty page notices
  await page.goto(url + '/');
  await must('#e-listen');
  execFileSync('python3', ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"INSERT INTO roots (id, name, hostname, os, arch, root_pub, wg_pub, wg_addr, peer_token_hash, enrolled_at) VALUES ('rt_test', 'test', 'test', 'linux', 'x86_64', 'pub_test', 'wg_test', '10.77.0.250', '00', 0)\"); c.commit()", dbPath]);
  await page.waitForURL(url + '/offline', { timeout: 10000 }).catch(() => problems.push('the empty page did not move on when has_roots flipped'));
  await shot('first-root-connected-no-door-yet');

  // M3: /devices (with a second device + a root), /pair (mint + joined), /audit
  // a phone joins through a QR minted by the console: pair-qr, redeem in this page context
  const link = JSON.parse(execFileSync(ctl[0], [...ctl.slice(1), 'pair-qr']).toString());
  // the phone is a different browser (its own cookie jar: it must not clobber this one)
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 });
  const phone = await phoneCtx.newPage();
  phone.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push('phone console: ' + m.text()); });
  await phone.goto(link.url); // /pair#v=2&t=… → the page redeems and shows joined
  await phone.waitForSelector('#p-joined', { timeout: 8000 }).catch(() => problems.push('phone did not join'));
  await shot('pair-phone-joined');
  await phoneCtx.close();

  // minting a QR needs a fresh step-up: confirm with the authenticator first
  await page.goto(url + '/account');
  await page.evaluate(async (code) => {
    await fetch('/t/auth/step-up', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ totp: code }) });
  }, totp(secret));
  await page.goto(url + '/pair');
  await must('#p-qr-img');
  await page.waitForFunction(() => document.getElementById('p-qr-img').querySelector('svg'));
  await shot('pair-qr-minted');
  // regenerate (the storyboard: one QR per phone, regenerate kills the old one)
  await page.click('#p-regen');
  await page.waitForTimeout(400);
  await shot('pair-qr-regenerated');
  await page.click('#p-done'); // done: burns it and goes to /devices
  await page.waitForURL(url + '/devices');
  await must('#d-list');
  await page.waitForFunction(() => document.querySelectorAll('#d-list .dev-row').length >= 2);
  await shot('devices');
  // rename flow + confirm sheet for a device
  await page.fill('#d-list .dev-row input', 'Pixel 7 phone');
  await shot('devices-rename');
  const rm = await page.$('#d-list .dev-row .acts button.danger');
  if (rm) { await rm.click(); await must('#d-sheet'); await shot('devices-confirm-remove'); await page.click('#d-sheet-no'); }
  // kill-switch sheet
  const kill = await page.$('.dev-row .acts button.danger:not(:first-of-type)');
  const killBtns = await page.$$('button');
  let killBtn = null;
  for (const b of killBtns) {
    const t = await b.textContent();
    if (t.includes('Kill every device')) { killBtn = b; break; }
  }
  if (killBtn) {
    await killBtn.click();
    await must('#d-kill-sheet');
    await page.check('#d-kill-lockdown');
    await shot('devices-kill-switch-sheet');
    await page.click('#d-kill-no');
  }
  // audit page
  await page.goto(url + '/audit');
  await page.waitForFunction(() => document.getElementById('au-chain').textContent.includes('verified'));
  await page.waitForFunction(() => document.querySelectorAll('#au-list .au-row').length > 3);
  await shot('audit');
  await page.selectOption('#au-action', 'auth.login').catch(() => {});
  await page.waitForTimeout(300);
  await shot('audit-filtered');

  await browser.close();
  fs.writeFileSync(`${out}/problems.json`, JSON.stringify(problems, null, 1));
  if (problems.length) { console.error('PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
  console.log('shots: ok, no console errors, nothing wider than 360px');
})().catch((e) => { console.error(e); process.exit(1); });
