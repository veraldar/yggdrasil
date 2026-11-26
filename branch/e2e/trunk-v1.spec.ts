import { execFileSync, spawn } from 'child_process';
import { createHmac } from 'crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { type Page, devices, expect, test } from '@playwright/test';

/**
 * G3.6 · Storyboard end-to-end (spec §9 G3.6, 15 steps) inside sim/trunk-v1-e2e.sh's namespace.
 * Features not yet merged into trunk-v1 (IDP M3: QR/member/device-revoke/kill; WIRE M5: two voice
 * roots) record MISSING (never PASS, never SKIP) so the gate stays RED until they land.
 */
const STATE = process.env.PW_TRUNK_V1_STATE || '';
const BASE = process.env.PW_BASE_URL || '';
const BIN = process.env.PW_TRUNK_BIN || '';
const YGG_BIN = process.env.PW_YGG_BIN || '';
const MOCK_PORT = process.env.PW_MOCK_PORT || '';
const APP_DIR = process.env.PW_APP_DIR || '';

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
  const adminHdr = { cookie: `bifrost_device=${adminCookie}`, origin: BASE };

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
    await owner.goto(`${BASE}${sHome.approve_url}`);
    await noOverflow360(owner, '/auth/root');
    const approveBtn = owner.locator('button[type="submit"], button.ok, #approve-btn').first();
    await expect(approveBtn).toBeVisible({ timeout: 15_000 });
    await approveBtn.click();
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

  // ---- S06, S07, S08: IDP M3 (not merged yet -> MISSING) ----
  record('S06', 'MISSING', 'phone B by QR + second scan 410 + regenerate (IDP M3 not merged)');
  record('S07', 'MISSING', 'member -> 403 on revoke, kill and mint (IDP M3 not merged)');
  record('S08', 'MISSING', 'device revoke <=1s + channel/voice cut (IDP M3 not merged)');

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

  // ---- S10: kill + lockdown (IDP M3 — not merged yet -> MISSING) ----
  record('S10', 'MISSING', 'kill + lockdown (IDP M3 not merged)');

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
    record('S13', 'FAIL', String(e).slice(0, 120));
  }

  // ---- S14: model form refused when not pinned (APP M5 — merged!) ----
  try {
    const r = await request.put(`${BASE}/api/roots/${roots.mac.id}/model`, {
      headers: { cookie: `bifrost_device=${adminCookie}`, origin: BASE },
      data: { provider: 'openai', model: 'gpt-4o-mini', api_key: 'sk-test-unpinned' },
    });
    expect(r.status()).toBe(403);
    record('S14', 'PASS', 'model form PUT /api/roots/:id/model refused (403) when not pinned');
  } catch (e) {
    record('S14', 'FAIL', String(e).slice(0, 120));
  }

  // ---- S15: two voice roots dynamic ufrag routing (WIRE M5 — not merged yet -> MISSING) ----
  record('S15', 'MISSING', 'two voice roots dynamic ufrag routing (WIRE M5 not merged)');

  await ownerCtx.close();
  await phoneCtx.close();
  // keep unused import check happy
  void existsSync;
  void readFileSync;
});
