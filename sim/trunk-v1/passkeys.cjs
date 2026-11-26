// passkeys.cjs — G3.7 passkey cases in Chromium (Pixel 7, 360 px) with a CDP virtual authenticator
// (WebAuthn.addVirtualAuthenticator: CTAP2, internal, user verification). Run by
// sim/trunk-v1-auth.py against its own trunk; prints one JSON line per check
// ({"check", "ok", "detail"}), then {"done": true, "last_step": N}.
//
//   NODE_PATH=branch/node_modules node sim/trunk-v1/passkeys.cjs <public url> <shot dir> <params JSON>
//   params: {email, password, secret, last_step}
//
// Besides the real authenticator, it signs assertions itself with the credential's private key
// (WebAuthn.getCredentials hands it out): that is how each server-side check is proven — another
// origin, another RP ID, no user verification, a counter that did not move, a replayed or
// wrong-kind challenge, a create-type client data, a bad signature (×5 → lockout).
'use strict';
const { chromium, devices } = require('playwright');
const crypto = require('crypto');

const [url, out, paramsJson] = process.argv.slice(2);
const P = JSON.parse(paramsJson);
const problems = [];
let lastStep = P.last_step || 0;

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const check = (name, ok, detail) => { emit({ check: name, ok: !!ok, detail: ok ? undefined : detail }); return ok; };
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // a step the trunk will still take (now-1 … now+1, newer than the last one used)
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
    await sleep(30000 - (Date.now() % 30000) + 200);
  }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 780 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  // the page's own fetch (same origin, cookies, Origin header) — what the shell script does
  // /t/audit answers newest first. (an expired access token — 20 s on a rig — is refreshed once, as the shell's authed() does)
  const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
    const go = async () => {
      const init = { method: m, credentials: 'same-origin', headers: {} };
      if (b !== null) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(b); }
      const r = await fetch(p, init);
      let d = null;
      try { d = await r.json(); } catch (e) { /* not json */ }
      return { status: r.status, data: d };
    };
    let r = await go();
    if (r.status === 401 && r.data && r.data.reauth === 'refresh') {
      const f = await fetch('/t/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (f.status === 200) r = await go();
    }
    return r;
  }, [method, path, body === undefined ? null : body]);
  const me = () => api('GET', '/t/me');
  const audit = async (n) => ((await api('GET', '/t/audit?limit=' + (n || 5))).data || {}).entries || [];
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const shot = async (name) => {
    await page.waitForTimeout(300);
    await page.screenshot({ path: out + '/' + name + '.png', fullPage: true });
    check('shot ' + name + ': nothing wider than 360 px', await noOverflow(), name);
  };

  // 1 · sign in with password + TOTP (no passkey yet)
  await page.goto(url + '/login');
  await page.waitForSelector('#l-passkey:not([hidden])');
  check('login: "Sign in with a passkey" shows where WebAuthn is available', await page.isVisible('#l-passkey'));
  await page.fill('#l-email', P.email);
  await page.fill('#l-password', P.password);
  await page.fill('#l-code', await totp());
  await Promise.all([page.waitForURL(url + '/'), page.click('#l-btn')]);
  let m = await me();
  check('login: password + TOTP → admin device', m.status === 200 && m.data.device.role === 'admin', m);
  const firstDevice = m.data.device.id;

  // 2 · enrol on /account (step-up first when 2FA is not fresh any more)
  await page.goto(url + '/account');
  await page.waitForSelector('#a-pk-form:not([hidden])');
  check('account: the passkey section offers "Add a passkey" to an admin', await page.isVisible('#a-pk-add'));
  await page.fill('#a-pk-name', 'Pixel 7 (virtual)');
  await page.click('#a-pk-add');
  const stepUpFirst = await Promise.race([
    page.waitForSelector('#a-stepup:not([hidden])', { timeout: 8000 }).then(() => true).catch(() => false),
    page.waitForSelector('.pk-row', { timeout: 8000 }).then(() => false).catch(() => false),
  ]);
  if (stepUpFirst) {
    await page.fill('#a-stepup-code', await totp());
    await page.click('#a-stepup-form button[type=submit]');
  }
  await page.waitForSelector('.pk-row', { timeout: 10000 });
  let a = await api('GET', '/t/account');
  check('account: passkey enrolled (listed, no key material in the answer)', a.status === 200 && a.data.passkeys.length === 1 && a.data.passkeys[0].name === 'Pixel 7 (virtual)' && !JSON.stringify(a.data.passkeys).includes('cred'), a.data && a.data.passkeys);
  let creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  check('account: the authenticator holds one credential for rp ' + new URL(url).hostname, creds.length === 1 && creds[0].rpId === new URL(url).hostname, creds.map((c) => c.rpId));
  let rows = await audit(5);
  check('audit: passkey.add', rows.some((e) => e.action === 'passkey.add'), rows.map((e) => e.action));
  const again = await api('POST', '/t/account/passkeys/begin', { name: 'x' });
  check('account: enrolling again excludes the registered credential', again.status !== 200 || (again.data.options.publicKey.excludeCredentials || []).length === 1, again);
  await shot('m4-account-passkeys');

  // 3 · sign out, sign in with the passkey alone (both factors)
  await Promise.all([page.waitForURL(/\/login/), page.click('#a-logout')]);
  await page.waitForSelector('#l-passkey:not([hidden])');
  await shot('m4-login-passkey');
  await Promise.all([page.waitForURL(url + '/'), page.click('#l-passkey')]);
  m = await me();
  check('passkey login: a new admin device (the admin\'s own passkey on it), fresh', m.status === 200 && m.data.device.role === 'admin' && m.data.device.id !== firstDevice && m.data.device.fresh === true, m.data);
  rows = await audit(5);
  const login = rows.find((e) => e.action === 'auth.login');
  check('audit: auth.login first=passkey second=passkey', login && login.detail.first === 'passkey' && login.detail.second === 'passkey', login);
  a = await api('GET', '/t/account');
  check('passkey login: the counter and last use are stored', a.data.passkeys[0].sign_count >= 1 && a.data.passkeys[0].last_used > 0, a.data.passkeys);

  // 4 · password + passkey as the second factor
  await page.goto(url + '/account');
  await Promise.all([page.waitForURL(/\/login/), page.click('#a-logout')]);
  await page.fill('#l-email', P.email);
  await page.fill('#l-password', P.password);
  await page.click('#l-btn');
  await page.waitForSelector('#l-mfa-passkey:not([hidden])');
  await Promise.all([page.waitForURL(url + '/'), page.click('#l-mfa-passkey')]);
  rows = await audit(3);
  const l2 = rows.find((e) => e.action === 'auth.login');
  check('password + passkey (second factor) → signed in, audited first=password second=passkey', l2 && l2.detail.first === 'password' && l2.detail.second === 'passkey', l2);

  // 5 · forged assertions, signed with the credential's own key: each server check on its own
  creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  const cred = creds[0];
  const key = crypto.createPrivateKey({ key: Buffer.from(cred.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const credId = b64u(Buffer.from(cred.credentialId, 'base64'));
  let counter = cred.signCount;
  const rpHash = (id) => crypto.createHash('sha256').update(id).digest();
  const forge = (challenge, o) => {
    const flags = o.flags === undefined ? 0x05 : o.flags; // UP | UV
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(o.counter >>> 0);
    const authData = Buffer.concat([rpHash(o.rpId || new URL(url).hostname), Buffer.from([flags]), ctr]);
    const cd = Buffer.from(JSON.stringify({ type: o.type || 'webauthn.get', challenge: b64u(unb64u(challenge)), origin: o.origin || url, crossOrigin: false }));
    const sig = o.badSig ? crypto.randomBytes(70) : crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(cd).digest()]), key);
    return { id: credId, rawId: credId, type: 'public-key', extensions: {},
      response: { authenticatorData: b64u(authData), clientDataJSON: b64u(cd), signature: b64u(sig), userHandle: cred.userHandle ? b64u(Buffer.from(cred.userHandle, 'base64')) : null } };
  };
  const tryForge = async (o, intent) => {
    intent = intent || 'login';
    const b = await api('POST', '/t/auth/passkey/begin', { intent });
    if (b.status !== 200) return { begin: b };
    const ch = b.data.options.publicKey.challenge;
    const f = await api('POST', '/t/auth/passkey/finish', { intent, challenge: b.data.challenge, credential: forge(ch, o) });
    return { f, handle: b.data.challenge, ch };
  };
  const whyOf = async () => { const r = (await audit(3)).find((e) => e.action === 'auth.passkey_fail'); return r && r.detail.why; };
  let r = await tryForge({ counter: ++counter });
  check('forged-but-correct assertion (the harness itself) → 200', r.f && r.f.status === 200, r);
  const good = r;
  for (const [name, o, why] of [
    ['another origin', { counter: counter + 1, origin: 'http://evil.example:' + new URL(url).port }, 'origin'],
    ['another RP ID', { counter: counter + 1, rpId: 'evil.example' }, 'rp_id'],
    ['no user verification (UP only)', { counter: counter + 1, flags: 0x01 }, 'uv'],
    ['a counter that did not move (cloned authenticator)', { counter }, 'counter'],
  ]) {
    r = await tryForge(o);
    const w = await whyOf();
    check('passkey refused: ' + name + ' → 401, audited (' + why + ')', r.f && r.f.status === 401 && r.f.data.why === 'passkey' && w === why, [r.f, w]);
  }
  // clear the failure count with a good one, then the challenge cases
  r = await tryForge({ counter: ++counter });
  check('a good assertion after refusals → 200 (and resets the failure count)', r.f && r.f.status === 200, r.f);
  let f = await api('POST', '/t/auth/passkey/finish', { intent: 'login', challenge: good.handle, credential: forge(good.ch, { counter: ++counter }) });
  check('passkey refused: a used challenge (one-use) → 401 challenge', f.status === 401 && f.data.why === 'challenge', f);
  const su = await api('POST', '/t/auth/passkey/begin', { intent: 'step-up' });
  f = await api('POST', '/t/auth/passkey/finish', { intent: 'login', challenge: su.data.challenge, credential: forge(su.data.options.publicKey.challenge, { counter: ++counter }) });
  check('passkey refused: a step-up challenge used to sign in → 401 challenge', su.status === 200 && f.status === 401 && f.data.why === 'challenge', [su.status, f]);
  r = await tryForge({ counter: ++counter, type: 'webauthn.create' });
  check('passkey refused: client data of type webauthn.create → 401', r.f && r.f.status === 401, r.f);
  // lockout: 5 bad signatures in a row (the one above counted) → 429, audited
  let last = null;
  for (let i = 0; i < 4; i++) last = (await tryForge({ counter: ++counter, badSig: true })).f;
  rows = await audit(4);
  check('passkey lockout: 5 refused assertions → 429 + lockout.mfa (the TOTP lockout, shared)', last && last.status === 429 && rows.some((e) => e.action === 'lockout.mfa'), [last, rows.map((e) => e.action)]);
  const locked = await api('POST', '/t/auth/passkey/begin', { intent: 'login' });
  check('passkey lockout: no new prompt while locked', locked.status === 429, locked);
  await sleep(16000); // TRUNK_TEST_FAST: 15 min → 15 s

  // 6 · a cloned authenticator: put the credential back with an old counter → refused
  creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  const live = creds[0];
  await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: live.credentialId });
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: Object.assign({}, live, { signCount: 1 }) });
  await page.goto(url + '/account');
  await Promise.all([page.waitForURL(/\/login/), page.click('#a-logout')]);
  await page.waitForSelector('#l-passkey:not([hidden])');
  await page.click('#l-passkey');
  await page.waitForSelector('#l-err:not([hidden])');
  const errText = await page.textContent('#l-err');
  await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: live.credentialId });
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: Object.assign({}, live, { signCount: counter + 100 }) });

  // 7 · step-up with the passkey (2FA no longer fresh), then delete the passkey
  await page.fill('#l-email', P.email);
  await page.fill('#l-password', P.password);
  await page.fill('#l-code', await totp());
  await Promise.all([page.waitForURL(url + '/'), page.click('#l-btn')]);
  const cw = await whyOf();
  check('cloned authenticator (old counter) → the sign-in page refuses it, audited (counter)', /not accepted/.test(errText) && cw === 'counter', [errText, cw]);
  await sleep(11000); // fresh: 600 s → 10 s
  m = await me();
  check('step-up: 2FA is no longer fresh', m.data.device.fresh === false, m.data.device);
  await page.goto(url + '/account');
  await page.waitForSelector('.pk-row button');
  await page.click('.pk-row button');
  await page.click('.pk-row button');
  await page.waitForSelector('#a-stepup-passkey:not([hidden])');
  check('step-up: removing a passkey asks for a fresh 2FA, and offers the passkey for it', await page.isVisible('#a-stepup:not([hidden])'));
  await page.click('#a-stepup-passkey');
  await page.waitForSelector('#a-pk-none:not([hidden])', { timeout: 10000 });
  a = await api('GET', '/t/account');
  rows = await audit(6);
  check('step-up by passkey → fresh, then the passkey is removed (the action ran again after the step-up)',
    a.data.passkeys.length === 0 && a.data.device.fresh === true && rows.some((e) => e.action === 'auth.step_up' && e.detail.second === 'passkey') && rows.some((e) => e.action === 'passkey.remove'),
    [a.data.passkeys, rows.map((e) => [e.action, e.detail])]);
  const gone = await api('POST', '/t/auth/passkey/begin', { intent: 'login' });
  check('a removed passkey no longer signs in (no passkey left → 409)', gone.status === 409 && gone.data.why === 'no-passkey', gone);
  const mem = await api('DELETE', '/t/account/passkeys/pk_nope');
  check('deleting an unknown passkey → 404', mem.status === 404, mem);

  check('no console error or CSP refusal on the pages', problems.length === 0, problems);
  await browser.close();
  emit({ done: true, last_step: lastStep });
})().catch((e) => { emit({ check: 'passkeys.cjs ran to the end', ok: false, detail: String(e && e.stack || e) }); emit({ done: true, last_step: lastStep }); process.exit(1); });
