import { execFileSync, spawn } from 'child_process';
import http from 'http';
import { performance } from 'perf_hooks';
import { createHmac } from 'crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { type Page, devices, expect, test } from '@playwright/test';

/**
 * G3.6 · Storyboard end-to-end (spec §9 G3.6, 15 steps) inside sim/trunk-v1-e2e.sh's namespace.
 * S06-S08 and S10 run against the merged IDP M3 API (QR pairing, member role, device revoke with
 * the live relayed stream cut, kill + lockdown + unlock). S15 (two voice roots) stays MISSING
 * (never PASS, never SKIP) until a helper is plugged in: set PW_S15_HELPER to an executable that
 * takes `<trunk base url> <state dir>` and exits 0 when a spoken turn reached each voice root.
 */
const STATE = process.env.PW_TRUNK_V1_STATE || '';
const BASE = process.env.PW_BASE_URL || '';
const BIN = process.env.PW_TRUNK_BIN || '';
const YGG_BIN = process.env.PW_YGG_BIN || '';
const MOCK_PORT = process.env.PW_MOCK_PORT || '';
const APP_DIR = process.env.PW_APP_DIR || '';
const S15_HELPER = process.env.PW_S15_HELPER || '';

test.skip(!STATE || !BASE || !BIN || !YGG_BIN || !MOCK_PORT || !APP_DIR, 'needs sim/trunk-v1-e2e.sh');
test.use({ ...devices['Pixel 7'], serviceWorkers: 'block' });

function record(step: string, res: 'PASS' | 'FAIL' | 'MISSING', what: string) {
  appendFileSync(join(STATE, 'steps.tsv'), `${step}\t${res}\t${what}\n`);
}

function b32decode(s: string): Buffer {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.replace(/[\s=-]+/g, '').toUpperCase();
  let bits = 0;
  let val = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alpha.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((val >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function totpNow(secretB32: string): string {
  const step = BigInt(Math.floor(Date.now() / 1000 / 30));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(step);
  const mac = createHmac('sha1', b32decode(secretB32)).update(buf).digest();
  const off = mac[19] & 0x0f;
  const code = (mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

function kvPub(out: string): string {
  return out.match(/public_key = "([^"]+)"/)![1];
}
function kvPriv(out: string): string {
  return out.match(/private_key = "([^"]+)"/)![1];
}

async function noOverflow360(page: Page, label: string) {
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(sw, `${label}: no horizontal overflow at 360px`).toBeLessThanOrEqual(cw);
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 20_000, stepMs = 200): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/** A long-lived GET through the trunk (the phone's live channel). `first` = headers + first chunk seen. */
function openStream(path: string, cookie: string) {
  const u = new URL(BASE);
  let firstRes!: (v: { status: number; body: string }) => void;
  let endRes!: (v: { at: number; how: string }) => void;
  const first = new Promise<{ status: number; body: string }>((r) => (firstRes = r));
  const ended = new Promise<{ at: number; how: string }>((r) => (endRes = r));
  let gotFirst = false;
  const req = http.request(
    { host: u.hostname, port: Number(u.port), path, method: 'GET', headers: { cookie: `bifrost_device=${cookie}`, accept: 'text/event-stream' } },
    (res) => {
      res.setEncoding('utf8');
      let acc = '';
      res.on('data', (c: string) => {
        acc += c;
        if (!gotFirst) {
          gotFirst = true;
          firstRes({ status: res.statusCode || 0, body: acc });
        }
      });
      res.on('end', () => endRes({ at: performance.now(), how: 'end' }));
      res.on('close', () => endRes({ at: performance.now(), how: 'close' }));
      res.on('aborted', () => endRes({ at: performance.now(), how: 'aborted' }));
      res.on('error', () => endRes({ at: performance.now(), how: 'error' }));
    }
  );
  req.on('error', () => endRes({ at: performance.now(), how: 'req-error' }));
  req.end();
  return { first, ended, destroy: () => req.destroy() };
}

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`timeout ${ms} ms: ${what}`)), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

/** The device cookie a browser context holds. */
async function deviceCookie(ctx: { cookies: () => Promise<Array<{ name: string; value: string }>> }): Promise<string> {
  const c = (await ctx.cookies()).find((x) => x.name === 'bifrost_device');
  if (!c) throw new Error('no bifrost_device cookie in the context');
  return c.value;
}

function tokenOfQrUrl(url: string): string {
  const m = url.match(/[#&]t=([^&]+)/);
  if (!m) throw new Error(`no token in ${url}`);
  return decodeURIComponent(m[1]);
}

const spawned: Array<{ name: string; pid: number }> = [];
function bg(name: string, cmd: string, args: string[], env: Record<string, string>, cwd = STATE) {
  const log = openSync(join(STATE, `${name}.log`), 'a');
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: ['ignore', log, log] });
  if (p.pid) {
    spawned.push({ name, pid: p.pid });
    writeFileSync(join(STATE, `${name}.pid`), String(p.pid));
  }
  return p;
}

test('G3.6 storyboard end to end (15 steps)', async ({ browser, request }) => {
  test.setTimeout(300_000);
  const ctlSock = join(STATE, 'trunk', 'ctl.sock');
  const email = 'owner@ljoolq.test';
  const password = 'correct-horse-battery-staple-99';
  let claimUrl = '';
  let recoveryCodes: string[] = [];
  let adminCookie = '';

  const ownerCtx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
  const owner = await ownerCtx.newPage();

  // ---- S01: scripted agent reads trunk-ctl claim-code and begins claim ----
  try {
    const raw = execFileSync(BIN, ['trunk-ctl', '--sock', ctlSock, 'claim-code', '--json'], { encoding: 'utf8' });
    const { code } = JSON.parse(raw) as { code: string };
    expect(code).toMatch(/^\d{3}-\d{3}$|^\d{6}$/);
    const r = await request.post(`${BASE}/t/claim/begin`, {
      headers: { origin: BASE },
      data: { code },
    });
    expect(r.status()).toBe(200);
    const body = (await r.json()) as { ticket: string; url: string };
    expect(body.url).toContain('/claim#t=');
    claimUrl = body.url;
    record('S01', 'PASS', 'agent reads trunk-ctl claim-code and begins claim');
  } catch (e) {
    record('S01', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // ---- S02: owner browser approves claim and creates admin with TOTP ----
  try {
    await owner.goto(claimUrl);
    await expect(owner.locator('#c-approve-btn')).toBeVisible({ timeout: 15_000 });
    await noOverflow360(owner, '/claim approve');
    await owner.locator('#c-approve-btn').click();
    await expect(owner.locator('#c-email')).toBeVisible({ timeout: 15_000 });
    await owner.locator('#c-email').fill(email);
    await owner.locator('#c-password').fill(password);
    await owner.locator('#c-signup-btn').click();
    await expect(owner.locator('#c-totp')).toBeVisible({ timeout: 15_000 });
    const secret = (await owner.locator('#c-secret').textContent())?.trim() || '';
    expect(secret.length).toBeGreaterThanOrEqual(16);
    await owner.locator('#c-code').fill(totpNow(secret));
    await owner.locator('#c-totp-btn').click();
    await expect(owner.locator('#c-codes')).toBeVisible({ timeout: 15_000 });
    const codesText = (await owner.locator('#c-codes-grid').textContent()) || '';
    recoveryCodes = codesText.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/g) || [];
    expect(recoveryCodes.length).toBeGreaterThanOrEqual(8);
    await owner.locator('#c-done').click();
    await owner.waitForURL((u) => u.pathname === '/', { timeout: 15_000 });
    const ck = (await ownerCtx.cookies()).find((c) => c.name === 'bifrost_device');
    expect(ck?.value).toMatch(/^v4\.public\./);
    adminCookie = ck!.value;
    record('S02', 'PASS', 'owner browser creates admin with TOTP (360px ok)');
  } catch (e) {
    record('S02', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // ---- S03: empty-trunk page ----
  try {
    await noOverflow360(owner, '/ empty-trunk');
    const bodyText = (await owner.locator('body').textContent()) || '';
    expect(bodyText.toLowerCase()).toMatch(/root|computer|install|connect/);
    record('S03', 'PASS', 'empty-trunk page shown at 360px with no overflow');
  } catch (e) {
    record('S03', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // ---- S04: desktop enroll (1 tap) for home + headless enroll (code) for mac & lab ----
  const roots: Record<string, { id: string; token: string; trunkKey: string; dir: string; wgHttp: number; appPort: number; bridgePid?: number }> = {};
  const ports = {
    home: { brain: 18785, bridge: 18786, media: 18787, wgHttp: 18788, wgUdp: 18789, relay: 18790, app: 18791 },
    mac: { brain: 18792, bridge: 18793, media: 18794, wgHttp: 18795, wgUdp: 18796, relay: 18797, app: 18798 },
    lab: { brain: 18765, bridge: 18766, media: 18767, wgHttp: 18768, wgUdp: 18769, relay: 18777, app: 0 },
  };
  let adminHdr = { cookie: `bifrost_device=${adminCookie}`, origin: BASE };

  try {
    // 4a. desktop enroll for home (1 tap via /auth/root?e=<id>)
    const homeDir = join(STATE, 'home');
    const homeRk = kvPub(execFileSync(BIN, ['root-key', join(homeDir, 'root.key')], { encoding: 'utf8' }));
    const homeWk = kvPub(execFileSync(BIN, ['wg-key', join(homeDir, 'wg.key')], { encoding: 'utf8' }));
    const eHome = await request.post(`${BASE}/t/roots/enroll`, {
      data: { hostname: 'home-box', os: 'linux', arch: 'x86_64', root_pub: homeRk, wg_pub: homeWk, has_app: true, has_voice: false },
    });
    expect(eHome.status()).toBe(200);
    const sHome = await eHome.json();
    const approveUrl = sHome.approve_url.startsWith('http') ? sHome.approve_url : `${BASE}${sHome.approve_url}`;
    await owner.goto(approveUrl);
    await noOverflow360(owner, '/auth/root');
    const approveBtn = owner.locator('#r-connect');
    await expect(approveBtn).toBeVisible({ timeout: 15_000 });
    await approveBtn.click();
    await expect(owner.locator('#r-done')).toBeVisible({ timeout: 15_000 });
    const pHome = await request.post(`${BASE}/t/roots/enroll/${sHome.id}/poll`, { data: { secret: sHome.poll_secret } });
    expect(pHome.status()).toBe(200);
    const rHome = await pHome.json();
    expect(rHome.status).toBe('approved');
    roots.home = { id: rHome.root_id, token: rHome.peer_token, trunkKey: rHome.trunk.trunk_key, dir: homeDir, wgHttp: ports.home.wgHttp, appPort: ports.home.app };

    // 4b. headless enroll (by-code) for mac (has_app=true for failover) and lab (light)
    for (const name of ['mac', 'lab'] as const) {
      const d = join(STATE, name);
      const rk = kvPub(execFileSync(BIN, ['root-key', join(d, 'root.key')], { encoding: 'utf8' }));
      const wk = kvPub(execFileSync(BIN, ['wg-key', join(d, 'wg.key')], { encoding: 'utf8' }));
      const enr = await request.post(`${BASE}/t/roots/enroll`, {
        data: { hostname: `${name}-box`, os: 'linux', arch: 'x86_64', root_pub: rk, wg_pub: wk, has_app: name === 'mac', has_voice: false },
      });
      expect(enr.status()).toBe(200);
      const st = await enr.json();
      const byCode = await request.post(`${BASE}/t/roots/enroll/by-code`, { headers: adminHdr, data: { code: st.code } });
      expect(byCode.status()).toBe(200);
      expect((await byCode.json()).id).toBe(st.id);
      const ap = await request.post(`${BASE}/t/roots/enroll/${st.id}/approve`, { headers: adminHdr, data: { name } });
      expect(ap.status()).toBe(200);
      const poll = await request.post(`${BASE}/t/roots/enroll/${st.id}/poll`, { data: { secret: st.poll_secret } });
      expect(poll.status()).toBe(200);
      const res = await poll.json();
      expect(res.status).toBe('approved');
      roots[name] = { id: res.root_id, token: res.peer_token, trunkKey: res.trunk.trunk_key, dir: d, wgHttp: ports[name].wgHttp, appPort: ports[name].app };
    }

    // start wg + bridge + brain + app for home, mac, lab
    for (const name of ['home', 'mac', 'lab'] as const) {
      const r = roots[name];
      const p = ports[name];
      mkdirSync(join(r.dir, 'data'), { recursive: true });
      writeFileSync(
        join(r.dir, 'wg.toml'),
        `[wg]\nkey_file = "${r.dir}/wg.key"\nudp = "127.0.0.1:${p.wgUdp}"\nrelay = "127.0.0.1:${p.relay}"\nhttp = "127.0.0.1:${p.wgHttp}"\nbrain = "http://127.0.0.1:${p.brain}"\ntrunk_state = "${r.dir}/trunk-state.json"\ntrunk_key = "${r.trunkKey}"\n`
      );
      bg(`wg-${name}`, BIN, ['wg', '-c', join(r.dir, 'wg.toml')], {});
      const priv = kvPriv(execFileSync(BIN, ['keygen'], { encoding: 'utf8' }));
      writeFileSync(
        join(r.dir, 'bridge.toml'),
        `[node]\nname = "${name}"\nprivate_key = "${priv}"\n\n[bridge]\nhttp = "127.0.0.1:${p.bridge}"\nmedia = "127.0.0.1:${p.media}"\ntokens_file = "${r.dir}/devices.json"\nopencode_url = "http://127.0.0.1:${p.brain}"\n\n[trunk]\nurl = "${BASE}"\ntrunk_key = "${r.trunkKey}"\nroot_key_file = "${r.dir}/root.key"\nroot_id = "${r.id}"\nstate_file = "${r.dir}/trunk-state.json"\nupstream = "127.0.0.1:${p.app || p.brain}"\nice_tcp = []\nwg_relay = "127.0.0.1:${p.relay}"\nwg_local = "127.0.0.1:${p.wgUdp}"\n`
      );
      chmodSync(join(r.dir, 'bridge.toml'), 0o600);
      const bp = bg(`bridge-${name}`, BIN, ['bridge', '-c', join(r.dir, 'bridge.toml')], {});
      r.bridgePid = bp.pid;

      bg(`brain-${name}`, YGG_BIN, [], {
        HOME: r.dir,
        YGG_UPSTREAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        YGG_UPSTREAM_STYLE: 'anthropic',
        YGG_UPSTREAM_API_KEY: 'mock',
        YGG_UPSTREAM_MODEL: 'mock',
        YGG_PROVIDERS: join(r.dir, 'none.json'),
        YGG_PROFILES: join(r.dir, 'agents.json'),
        YGG_ARTIFACTS_DIR: join(r.dir, 'artifacts'),
        YGG_DATA_DIR: join(r.dir, 'data'),
        YGG_PROJECT_DIR: join(r.dir, 'work'),
        YGG_LISTEN: `127.0.0.1:${p.brain}`,
        YGG_ROOT_NAME: r.id,
        YGG_PEER_TOKEN: r.token,
        YGG_PEERS_FROM: `http://127.0.0.1:${p.wgHttp}/_wg/_roots`,
        YGG_PEERS_VIA: `http://127.0.0.1:${p.wgHttp}/_wg/{id}`,
      });
    }

    const allOnline = await waitFor(async () => {
      const r = await request.get(`${BASE}/t/me/roots`, { headers: adminHdr });
      if (!r.ok()) return false;
      const list = (await r.json()) as Array<{ online: boolean }>;
      return list.length === 3 && list.every((x) => x.online);
    }, 25_000);
    expect(allOnline).toBe(true);

    // start apps on home and mac
    for (const name of ['home', 'mac'] as const) {
      const r = roots[name];
      const p = ports[name];
      bg(
        `app-${name}`,
        'node',
        ['server.mjs'],
        {
          NODE_ENV: 'production',
          PORT: String(p.app),
          HOST: '127.0.0.1',
          BIFROST_AUTH: 'trunk',
          BIFROST_TRUNK_STATE: join(r.dir, 'trunk-state.json'),
          BIFROST_TRUNK_URL: BASE,
          BIFROST_TRUST_PROXY: '1',
          OPENCODE_URL: `http://127.0.0.1:${p.brain}`,
          YGG_PEER_TOKEN: r.token,
          ARTIFACTS_DIR: join(r.dir, 'artifacts'),
          NEXT_TELEMETRY_DISABLED: '1',
        },
        APP_DIR
      );
    }
    const appsUp = await waitFor(async () => {
      const r1 = await request.get(`http://127.0.0.1:${ports.home.app}/api/build`).catch(() => null);
      const r2 = await request.get(`http://127.0.0.1:${ports.mac.app}/api/build`).catch(() => null);
      return !!r1 && !!r2 && [200, 401].includes(r1.status()) && [200, 401].includes(r2.status());
    }, 40_000);
    expect(appsUp).toBe(true);
    record('S04', 'PASS', 'desktop enroll (1-tap) + headless enroll (code); 3 roots online');
  } catch (e) {
    record('S04', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // ---- S05: phone A signs in -> tree door -> typed turn on door root ----
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
  const phone = await phoneCtx.newPage();
  try {
    await phone.goto('/');
    await expect(phone).toHaveURL(/\/login/);
    await noOverflow360(phone, '/login');
    await phone.locator('#l-email').fill(email);
    await phone.locator('#l-password').fill(password);
    await phone.locator('#l-use-recovery').click();
    await phone.locator('#l-recovery').fill(recoveryCodes[0]);
    await phone.locator('#l-btn').click();
    await phone.waitForURL((u) => u.pathname === '/', { timeout: 20_000 });
    await phone.evaluate(() => {
      localStorage.setItem('bifrost-door', 'v2');
      localStorage.setItem('bifrost-first-turn', '1');
    });
    await phone.reload();
    await expect(phone.getByRole('button', { name: 'new session', exact: true })).toBeVisible({ timeout: 20_000 });
    const word = `G36-TURN-${Date.now().toString(36)}`;
    await phone.getByRole('button', { name: 'new session', exact: true }).tap();
    await phone.getByPlaceholder('session name…').fill('g36-turn');
    await phone.getByRole('button', { name: 'create & open' }).tap();
    await phone.waitForURL(/\/session\//, { timeout: 20_000 });
    const box = phone.locator('textarea').first();
    await expect(box).toBeVisible({ timeout: 15_000 });
    await box.fill(`Reply with exactly: ${word}`);
    await phone.getByRole('button', { name: /send/i }).first().tap();
    await expect(phone.getByText(word)).toBeVisible({ timeout: 60_000 });
    record('S05', 'PASS', 'phone A signs in -> door root -> typed turn answered');
  } catch (e) {
    record('S05', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // ---- S06, S07, S08: IDP M3 — QR pairing, member role, device revoke (live channel cut) ----
  const asCookie = (c: string) => ({ cookie: `bifrost_device=${c}`, origin: BASE });
  let recNext = 2; // recovery codes [0] (S05) and [1] (S13) are spoken for
  const ensureFresh = async () => {
    const d = await request.get(`${BASE}/t/devices`, { headers: adminHdr });
    expect(d.status(), 'GET /t/devices as admin').toBe(200);
    if ((await d.json()).fresh) return;
    const su = await request.post(`${BASE}/t/auth/step-up`, { headers: adminHdr, data: { recovery: recoveryCodes[recNext++] } });
    expect(su.status(), 'step-up with a recovery code').toBe(200);
  };
  const mintQr = async () => {
    await ensureFresh();
    const m = await request.post(`${BASE}/t/pair/qr`, { headers: adminHdr, data: {} });
    expect(m.status(), 'POST /t/pair/qr').toBe(200);
    return (await m.json()) as { id: string; url: string; token: string; role: string; expires_in: number };
  };
  const consoleQr = () => JSON.parse(execFileSync(BIN, ['trunk-ctl', '--sock', ctlSock, 'pair-qr'], { encoding: 'utf8' }).trim().split('\n').pop()!) as { url: string; role: string };
  const redeemIn = async (ctx: { request: typeof request }, token: string, name: string) =>
    ctx.request.post(`${BASE}/t/pair/redeem`, { headers: { origin: BASE }, data: { token, name } });
  const adminMe = (await (await request.get(`${BASE}/t/me`, { headers: adminHdr })).json()) as { device: { id: string } };
  const adminDid = adminMe.device.id;
  let phoneBCookie = '';
  let phoneBDid = '';
  const SLUG = 'g36-turn';

  // ---- S06: phone B by QR: consumed; a second scan 410; Regenerate kills the old QR ----
  try {
    const qr1 = await mintQr();
    expect(qr1.role).toBe('member');
    expect(qr1.url).toContain('/pair#v=2&t=bfnp-');
    const st0 = await request.get(`${BASE}/t/pair/qr/${qr1.id}`, { headers: adminHdr });
    expect((await st0.json()).status).toBe('waiting');

    const bCtx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
    const r1 = await redeemIn(bCtx, qr1.token, 'phone-b');
    expect(r1.status(), 'first scan').toBe(200);
    const rj = await r1.json();
    expect(rj.device.role).toBe('member');
    phoneBCookie = await deviceCookie(bCtx);
    expect(phoneBCookie).toMatch(/^v4\.public\./);
    phoneBDid = rj.device.id;
    // phone B really is signed in: its page opens the app, not /login
    const pageB = await bCtx.newPage();
    await pageB.goto('/');
    await pageB.waitForLoadState('domcontentloaded');
    expect(new URL(pageB.url()).pathname, 'phone B lands in the app').not.toMatch(/^\/login/);
    await noOverflow360(pageB, 'phone B /');
    const me = await request.get(`${BASE}/t/me`, { headers: asCookie(phoneBCookie) });
    expect(me.status()).toBe(200);
    expect((await me.json()).device.role).toBe('member');

    // a second scan of the same QR -> 410 used (from a clean context: no cookie)
    const c2 = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
    const r2 = await redeemIn(c2, qr1.token, 'phone-x');
    expect(r2.status(), 'second scan').toBe(410);
    expect((await r2.json()).why).toBe('used');
    expect((await c2.cookies()).some((c) => c.name === 'bifrost_device'), 'no device from a used QR').toBe(false);
    const st1 = await (await request.get(`${BASE}/t/pair/qr/${qr1.id}`, { headers: adminHdr })).json();
    expect(st1.status).toBe('joined');
    expect(st1.device_name).toBe('phone-b');

    // Regenerate: the old QR is burned (410 burned), the new one works once
    const qr2 = await mintQr();
    const rg = await request.post(`${BASE}/t/pair/qr/${qr2.id}/regenerate`, { headers: adminHdr, data: {} });
    expect(rg.status(), 'regenerate').toBe(200);
    const qr3 = await rg.json();
    expect(qr3.id).not.toBe(qr2.id);
    expect(qr3.token).not.toBe(qr2.token);
    expect((await (await request.get(`${BASE}/t/pair/qr/${qr2.id}`, { headers: adminHdr })).json()).status).toBe('burned');
    const old = await redeemIn(c2, qr2.token, 'phone-old');
    expect(old.status(), 'old QR after regenerate').toBe(410);
    expect((await old.json()).why).toBe('burned');
    const c3 = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
    const neu = await redeemIn(c3, qr3.token, 'phone-c');
    expect(neu.status(), 'regenerated QR').toBe(200);
    // ... once only; the used first QR and the burned one stay dead
    expect((await redeemIn(c2, qr3.token, 'phone-y')).status()).toBe(410);
    expect((await redeemIn(c2, qr1.token, 'phone-y')).status()).toBe(410);
    expect((await redeemIn(c2, qr2.token, 'phone-y')).status()).toBe(410);
    // the console mints one too (trunk-ctl pair-qr) and it redeems
    const cq = consoleQr();
    expect(cq.role).toBe('member');
    expect((await redeemIn(c3, tokenOfQrUrl(cq.url), 'phone-console')).status(), 'console QR').toBe(200);
    // the admin's /pair page renders at 360 px
    await owner.goto('/pair');
    await expect(owner.locator('#p-qr')).toBeVisible({ timeout: 15_000 });
    await noOverflow360(owner, '/pair');
    await c2.close();
    await c3.close();
    await bCtx.close();
    record('S06', 'PASS', 'phone B by QR (member, lands in the app); 2nd scan 410 used; regenerate: old 410 burned, new works once; console pair-qr works');
  } catch (e) {
    record('S06', 'FAIL', String(e).slice(0, 160));
  }

  // ---- S07: a member device -> 403 on device revoke, kill and pair-code mint ----
  try {
    expect(phoneBCookie, 'S06 produced phone B').not.toBe('');
    const mh = asCookie(phoneBCookie);
    const before = await (await request.get(`${BASE}/t/devices`, { headers: adminHdr })).json();
    const del = await request.delete(`${BASE}/t/devices/${adminDid}`, { headers: mh });
    expect(del.status(), 'member revokes the admin device').toBe(403);
    expect((await del.json()).why).toBe('role');
    const kill = await request.post(`${BASE}/t/kill`, { headers: mh, data: { lockdown: true } });
    expect(kill.status(), 'member pulls the kill switch').toBe(403);
    const mint = await request.post(`${BASE}/t/pair/qr`, { headers: mh, data: {} });
    expect(mint.status(), 'member mints a pair code').toBe(403);
    expect((await request.patch(`${BASE}/t/devices/${phoneBDid}`, { headers: mh, data: { role: 'admin' } })).status(), 'member promotes itself').toBe(403);
    expect((await request.get(`${BASE}/t/audit`, { headers: mh })).status(), 'member reads the audit').toBe(403);
    const after = await (await request.get(`${BASE}/t/devices`, { headers: adminHdr })).json();
    expect(after.kill_epoch).toBe(before.kill_epoch);
    expect(after.lockdown).toBe(false);
    const adminDev = after.devices.find((d: { id: string }) => d.id === adminDid);
    expect(adminDev.revoked_at, 'admin device untouched').toBeNull();
    const mine = await (await request.get(`${BASE}/t/devices`, { headers: mh })).json();
    expect(mine.devices.length, 'a member sees only itself').toBe(1);
    record('S07', 'PASS', 'member: 403 on device revoke, kill, pair-code mint (+ role change, audit); nothing changed');
  } catch (e) {
    record('S07', 'FAIL', String(e).slice(0, 160));
  }

  // ---- S08: device revoke <=1 s x5: next call 401 login + the live relayed stream cut ----
  try {
    const sever: number[] = [];
    const refuse: number[] = [];
    const modes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const viaConsole = i >= 3;
      modes.push(viaConsole ? 'console' : 'http');
      const token = viaConsole ? tokenOfQrUrl(consoleQr().url) : (await mintQr()).token;
      const ctx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
      const rr = await redeemIn(ctx, token, `phone-r${i}`);
      expect(rr.status(), `round ${i}: redeem`).toBe(200);
      const did = (await rr.json()).device.id as string;
      const cookie = await deviceCookie(ctx);
      const ok = await request.get(`${BASE}/api/build`, { headers: { cookie: `bifrost_device=${cookie}` } });
      expect(ok.status(), `round ${i}: relayed call before the revoke`).toBe(200);
      // its live channel: a relayed SSE stream to the door root's app
      const stream = openStream(`/api/run-events?slug=${SLUG}`, cookie);
      const f = await within(stream.first, 10_000, `round ${i}: stream's first chunk`);
      expect(f.status, `round ${i}: stream status (${f.body.slice(0, 60)})`).toBe(200);
      // the revoke; the clock starts when the call returns
      let t0: number;
      if (viaConsole) {
        execFileSync(BIN, ['trunk-ctl', '--sock', ctlSock, 'devices', 'revoke', did, '--why', 'g36'], { encoding: 'utf8' });
        t0 = performance.now();
      } else {
        const d = await request.delete(`${BASE}/t/devices/${did}`, { headers: adminHdr });
        t0 = performance.now();
        expect(d.status(), `round ${i}: DELETE /t/devices/:id`).toBe(200);
      }
      // next call refused: 401 with reauth=login (through the door)
      let refuseMs = -1;
      let last = '';
      while (performance.now() - t0 < 3000) {
        const r = await request.get(`${BASE}/api/build`, { headers: { cookie: `bifrost_device=${cookie}` } });
        const txt = await r.text();
        last = `${r.status()} ${txt.slice(0, 80)}`;
        if (r.status() === 401) {
          refuseMs = performance.now() - t0;
          expect(txt, `round ${i}: refusal body`).toContain('"reauth":"login"');
          break;
        }
        await new Promise((r2) => setTimeout(r2, 5));
      }
      expect(refuseMs, `round ${i}: next call refused (last: ${last})`).toBeGreaterThanOrEqual(0);
      const me = await request.get(`${BASE}/t/me`, { headers: { cookie: `bifrost_device=${cookie}` } });
      expect(me.status(), `round ${i}: /t/me after revoke`).toBe(401);
      const end = await within(stream.ended, 5_000, `round ${i}: live stream never ended after the revoke`).catch((e) => {
        stream.destroy();
        throw e;
      });
      refuse.push(Math.round(refuseMs));
      sever.push(Math.round(Math.max(0, end.at - t0)));
      await ctx.close();
    }
    appendFileSync(join(STATE, 'timings.txt'), `S08 modes=${modes} refuse_ms=${JSON.stringify(refuse)} sever_ms=${JSON.stringify(sever)}\n`);
    expect(Math.max(...sever), `live channel severed <=1000 ms: ${sever}`).toBeLessThanOrEqual(1000);
    expect(Math.max(...refuse), `next call refused <=1000 ms: ${refuse}`).toBeLessThanOrEqual(1000);
    record('S08', 'PASS', `device revoke x5 (${modes.join('/')}): next call 401 login ${JSON.stringify(refuse)} ms, live stream cut ${JSON.stringify(sever)} ms (<=1000)`);
  } catch (e) {
    record('S08', 'FAIL', String(e).slice(0, 160));
  }

  // ---- S09: root revoke: WireGuard cut <=1.5 s (WIRE M2 — merged!) ----
  try {
    const wgUrl = `http://127.0.0.1:${ports.home.wgHttp}/_wg/_roots`;
    const pinnedBefore = await waitFor(async () => {
      const r = await request.get(wgUrl);
      if (!r.ok()) return false;
      const list = (await r.json()) as Array<{ id: string }>;
      return list.some((x) => x.id === roots.lab.id);
    }, 15_000);
    expect(pinnedBefore).toBe(true);

    const t0 = Date.now();
    const del = await request.delete(`${BASE}/t/roots/${roots.lab.id}`, { headers: adminHdr });
    expect(del.status()).toBe(200);
    const gone = await waitFor(async () => {
      const r = await request.get(wgUrl);
      if (!r.ok()) return false;
      const list = (await r.json()) as Array<{ id: string }>;
      return !list.some((x) => x.id === roots.lab.id);
    }, 5_000, 25);
    const cutMs = Date.now() - t0;
    expect(gone).toBe(true);
    expect(cutMs).toBeLessThanOrEqual(1500);
    record('S09', 'PASS', `root revoke: WireGuard cut in ${cutMs} ms (<=1500 ms)`);
  } catch (e) {
    record('S09', 'FAIL', String(e).slice(0, 120));
  }

  // ---- S10: kill + lockdown: every device out, sign-ins refused while locked, unlock brings the admin back ----
  try {
    // a member phone with a live channel when the kill comes
    const qrK = await mintQr();
    const kCtx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
    expect((await redeemIn(kCtx, qrK.token, 'phone-k')).status()).toBe(200);
    const kCookie = await deviceCookie(kCtx);
    const phoneACookie = await deviceCookie(phoneCtx);
    const kStream = openStream(`/api/run-events?slug=${SLUG}`, kCookie);
    expect((await within(kStream.first, 10_000, 'S10 stream first chunk')).status).toBe(200);
    const openQr = await mintQr(); // an open QR: the kill burns it
    for (const c of [adminCookie, phoneACookie, kCookie]) {
      expect((await request.get(`${BASE}/t/me`, { headers: asCookie(c) })).status(), 'every device is in before the kill').toBe(200);
    }
    expect((await (await request.get(`${BASE}/t/state`)).json()).lockdown).toBe(false);

    const k = await request.post(`${BASE}/t/kill`, { headers: adminHdr, data: { lockdown: true } });
    const tK = performance.now(); // the clock starts when the kill call returns
    expect(k.status(), 'POST /t/kill {lockdown}').toBe(200);
    const kj = await k.json();
    expect(kj.lockdown).toBe(true);
    expect(kj.devices_revoked).toBeGreaterThanOrEqual(3);
    expect(kj.pairs_burned).toBeGreaterThanOrEqual(1);

    // every device is out: the admin's own, phone A, the member phone, phone B — on the trunk and through the door
    for (const [who, c] of [['admin', adminCookie], ['phone A', phoneACookie], ['member', kCookie], ['phone B', phoneBCookie]] as const) {
      expect((await request.get(`${BASE}/t/me`, { headers: asCookie(c) })).status(), `${who} /t/me after kill`).toBe(401);
      expect((await request.get(`${BASE}/api/build`, { headers: asCookie(c) })).status(), `${who} through the door after kill`).toBe(401);
    }
    // the live channel of a killed device is cut <= 1 s after the kill call returns
    const killedEnd = await within(kStream.ended, 5_000, 'live stream of a killed device never ended').catch((e) => {
      kStream.destroy();
      throw e;
    });
    const killSeverMs = Math.round(Math.max(0, killedEnd.at - tK));
    expect(killSeverMs, `killed device's live stream cut <=1000 ms (${killSeverMs})`).toBeLessThanOrEqual(1000);
    // the open QR is dead
    const cB = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
    const dead = await redeemIn(cB, openQr.token, 'phone-late');
    expect([403, 410], 'a QR burned by the kill (or refused by the lockdown)').toContain(dead.status());
    expect((await cB.cookies()).some((c) => c.name === 'bifrost_device')).toBe(false);

    // lockdown: /t/state says so; password sign-in, mfa and QR redeem are refused
    expect((await (await request.get(`${BASE}/t/state`)).json()).lockdown).toBe(true);
    const lockedLogin = await request.post(`${BASE}/t/auth/login`, { headers: { origin: BASE }, data: { email, password } });
    expect(lockedLogin.status(), 'login while locked').toBe(403);
    expect((await lockedLogin.json()).why).toBe('lockdown');
    const lockedMfa = await request.post(`${BASE}/t/auth/mfa`, { headers: { origin: BASE }, data: { mfa_ticket: 'x', recovery: recoveryCodes[recNext] } });
    expect(lockedMfa.status(), 'mfa while locked').toBe(403);
    const lockedQr = await redeemIn(cB, tokenOfQrUrl(consoleQr().url), 'phone-locked');
    expect(lockedQr.status(), 'QR redeem while locked').toBe(403);
    expect((await lockedQr.json()).why).toBe('lockdown');
    expect((await request.get(`${BASE}/login`)).status(), 'the login page still loads').toBe(200);

    // the documented unlock path: `trunk-ctl unlock` on the server, then a normal sign-in
    const un = execFileSync(BIN, ['trunk-ctl', '--sock', ctlSock, 'unlock'], { encoding: 'utf8' });
    expect(un.toLowerCase()).toContain('lockdown lifted');
    expect((await (await request.get(`${BASE}/t/state`)).json()).lockdown).toBe(false);
    for (const c of [adminCookie, phoneACookie, kCookie, phoneBCookie]) {
      expect((await request.get(`${BASE}/t/me`, { headers: asCookie(c) })).status(), 'a killed device stays out after unlock').toBe(401);
    }
    const l1 = await request.post(`${BASE}/t/auth/login`, { headers: { origin: BASE }, data: { email, password } });
    expect(l1.status(), 'login after unlock').toBe(200);
    const l2 = await request.post(`${BASE}/t/auth/mfa`, { headers: { origin: BASE }, data: { mfa_ticket: (await l1.json()).mfa_ticket, recovery: recoveryCodes[recNext++] } });
    expect(l2.status(), 'mfa after unlock').toBe(200);
    const sc = l2.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value).find((v) => v.startsWith('bifrost_device='));
    adminCookie = decodeURIComponent(sc!.split(';')[0].split('=')[1]);
    adminHdr = { cookie: `bifrost_device=${adminCookie}`, origin: BASE };
    const me2 = await (await request.get(`${BASE}/t/me`, { headers: adminHdr })).json();
    expect(me2.account.role).toBe('admin');
    expect(me2.device.id).not.toBe(adminDid);
    // the new admin reaches the app through the door (the roots took the new epoch) and the audit saw the kill
    const viaDoor = await waitFor(async () => (await request.get(`${BASE}/api/build`, { headers: adminHdr })).status() === 200, 10_000, 200);
    expect(viaDoor, 'the new admin reaches the app through the door after unlock').toBe(true);
    const au = await (await request.get(`${BASE}/t/audit?action=kill.switch`, { headers: adminHdr })).json();
    expect(au.entries.length).toBeGreaterThanOrEqual(1);
    expect(au.chain_ok).toBe(true);
    await kCtx.close();
    await cB.close();
    record('S10', 'PASS', `kill+lockdown: ${kj.devices_revoked} devices out, ${kj.pairs_burned} QR burned, live stream of a killed device cut ${killSeverMs} ms (<=1000); login/mfa/QR 403 lockdown; trunk-ctl unlock -> admin signs in, reaches the app`);
  } catch (e) {
    try {
      execFileSync(BIN, ['trunk-ctl', '--sock', ctlSock, 'unlock'], { encoding: 'utf8' }); // never leave later steps locked out
    } catch {
      /* best effort */
    }
    record('S10', 'FAIL', String(e).slice(0, 160));
  }

  // ---- S11: trunk-ctl audit verify (IDP M1 — merged!) ----
  try {
    const out = execFileSync(BIN, ['trunk-ctl', '--sock', ctlSock, 'audit', 'verify'], { encoding: 'utf8' });
    expect(out.toLowerCase()).toMatch(/ok|valid|verified|intact/);
    record('S11', 'PASS', `trunk-ctl audit verify: ${out.trim().slice(0, 80)}`);
  } catch (e) {
    record('S11', 'FAIL', String(e).slice(0, 120));
  }

  // ---- S12: door failover (stop door -> /offline when no other app root -> bring mac up / switch door) ----
  try {
    // stop mac bridge first so stopping home leaves zero online app roots -> /offline
    if (roots.mac.bridgePid) process.kill(roots.mac.bridgePid, 'SIGTERM');
    if (roots.home.bridgePid) process.kill(roots.home.bridgePid, 'SIGTERM');
    const offline = await waitFor(async () => {
      const r = await request.get(`${BASE}/`, { headers: { cookie: `bifrost_device=${adminCookie}` }, maxRedirects: 0 });
      return r.status() === 503 || (r.status() === 302 && (r.headers().location || '').includes('/offline'));
    }, 10_000);
    expect(offline).toBe(true);
    // restart mac bridge -> pick mac as door -> reaches app again
    bg('bridge-mac-2', BIN, ['bridge', '-c', join(roots.mac.dir, 'bridge.toml')], {});
    const macBack = await waitFor(async () => {
      const r = await request.get(`${BASE}/t/me/roots`, { headers: adminHdr });
      if (!r.ok()) return false;
      const list = (await r.json()) as Array<{ id: string; online: boolean }>;
      return list.some((x) => x.id === roots.mac.id && x.online);
    }, 15_000);
    expect(macBack).toBe(true);
    const sw = await request.put(`${BASE}/t/me/door`, { headers: adminHdr, data: { root_id: roots.mac.id } });
    expect(sw.status()).toBe(200);
    const ok2 = await request.get(`${BASE}/api/build`, { headers: { cookie: `bifrost_device=${adminCookie}` } });
    expect(ok2.status()).toBe(200);
    record('S12', 'PASS', 'door failover: stop door -> /offline -> switch to mac -> 200');
  } catch (e) {
    record('S12', 'FAIL', String(e).slice(0, 120));
  }

  // ---- S13: pin-change alarm (APP M5 — merged!) ----
  let s13Page: import('@playwright/test').Page | null = null;
  try {
    const FP_A = 'sha-256 ' + 'AA:'.repeat(31) + 'AA';
    const FP_B = 'sha-256 ' + 'BB:'.repeat(31) + 'BB';
    const localBase = `http://127.0.0.1:${new URL(BASE).port}`;
    const l1 = await request.post(`${localBase}/t/auth/login`, {
      headers: { origin: BASE },
      data: { email, password },
    });
    expect(l1.status()).toBe(200);
    const { mfa_ticket } = await l1.json();
    const l2 = await request.post(`${localBase}/t/auth/mfa`, {
      headers: { origin: BASE },
      data: { mfa_ticket, recovery: recoveryCodes[1] },
    });
    expect(l2.status()).toBe(200);
    const sc = l2
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value)
      .find((v) => v.startsWith('bifrost_device='));
    const locTok = decodeURIComponent(sc!.split(';')[0].split('=')[1]);

    const pinCtx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: localBase });
    await pinCtx.addCookies([
      { name: 'bifrost_device', value: locTok, domain: '127.0.0.1', path: '/', httpOnly: true },
    ]);
    const pPage = await pinCtx.newPage();
    s13Page = pPage;
    await pPage.addInitScript(
      ([rid, fp]) => {
        localStorage.setItem('bifrost-door', 'v2');
        localStorage.setItem('bifrost-first-turn', '1');
        localStorage.setItem(
          'bifrost.trunk.pins',
          JSON.stringify({ [rid]: { fp, rootId: rid, rootName: 'mac', savedAt: '2026-11-25T00:00:00Z', door: true } })
        );
      },
      [roots.mac.id, FP_A]
    );
    await pPage.route('**/t/me/roots', (r) =>
      r.fulfill({
        json: [{ id: roots.mac.id, name: 'mac', online: true, has_app: true, has_voice: false, dtls_fp: FP_B, door: true }],
      })
    );
    await pPage.goto(`${localBase}/`);
    const badge = pPage.getByTestId('pin-state');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveAttribute('data-state', 'refused', { timeout: 15_000 });
    await expect(badge).toContainText("this computer's key changed");
    await pinCtx.close();
    record('S13', 'PASS', 'pin-change alarm: swapped dtls_fp -> refused + alarm');
  } catch (e) {
    // a flake must say what it saw: the badge's state and words, the error without colour codes
    const badgeNow = s13Page
      ? await s13Page
          .getByTestId('pin-state')
          .evaluate((el) => `data-state=${el.getAttribute('data-state')} text="${el.textContent}"`, undefined, { timeout: 2_000 })
          .catch(() => 'badge unreadable')
      : 'no page';
    const msg = String(e).replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ');
    record('S13', 'FAIL', `${msg.slice(0, 300)} — badge ${badgeNow}`);
    await s13Page?.context().close().catch(() => {});
  }

  // ---- S14: model form refused when not pinned (APP M5 — merged!) ----
  try {
    const mCtx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
    const u = new URL(BASE);
    await mCtx.addCookies([
      { name: 'bifrost_device', value: adminCookie, domain: u.hostname, path: '/', httpOnly: true },
    ]);
    const mPage = await mCtx.newPage();
    await mPage.route(`**/api/roots/${encodeURIComponent(roots.mac.id)}/settings`, async (r) => {
      const real = await (await r.fetch()).json();
      await r.fulfill({ json: { ...real, has_model: false, models: [] } });
    });
    await mPage.goto(`/roots/${encodeURIComponent(roots.mac.id)}/settings`);
    await expect(mPage.getByTestId('root-model-block')).toBeVisible({ timeout: 15_000 });
    await expect(mPage.getByTestId('model-pin-guard')).toBeVisible();
    await expect(mPage.getByTestId('model-save')).toBeDisabled();
    await mCtx.close();
    record('S14', 'PASS', 'model form disabled with pin guard when not pinned');
  } catch (e) {
    record('S14', 'FAIL', String(e).slice(0, 120));
  }

  // ---- S15: two voice roots dynamic ufrag routing (WIRE M5 — not merged yet -> MISSING) ----
  // HOOK: WIRE-2's two-voice-roots helper plugs in here (PW_S15_HELPER = executable taking
  // `<trunk base url> <state dir>`; exit 0 = a spoken turn reached each voice root).
  if (S15_HELPER) {
    try {
      const out = execFileSync(S15_HELPER, [BASE, STATE], { encoding: 'utf8', timeout: 240_000 });
      record('S15', 'PASS', `two voice roots: ${out.trim().split('\n').pop()?.slice(0, 100)}`);
    } catch (e) {
      record('S15', 'FAIL', String(e).slice(0, 160));
    }
  } else {
    record('S15', 'MISSING', 'two voice roots dynamic ufrag routing: no helper plugged in (set PW_S15_HELPER; WIRE-2 G3.2 helper pending)');
  }

  await ownerCtx.close();
  await phoneCtx.close();
  // keep unused import check happy
  void existsSync;
  void readFileSync;
});
