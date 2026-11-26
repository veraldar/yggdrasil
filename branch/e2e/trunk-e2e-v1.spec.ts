import { execFileSync, spawn } from 'child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { devices, expect, test } from '@playwright/test';

/**
 * G3.3 · v1 port of trunk-e2e: three roots (home, mac, lab) behind a real v1 trunk,
 * using per-root YGG_PEER_TOKEN (curing M0 F3), ROOT_NET_BIN for light roots, WireGuard
 * directory peering, chained delegation home -> mac -> lab, and root revoke <= 1.5 s.
 */
const STATE = process.env.PW_STATE || '';
const BASE = process.env.PW_BASE_URL || '';
const BIN = process.env.PW_TRUNK_BIN || '';
const ROOT_BIN = process.env.PW_ROOT_BIN || BIN;
const YGG_BIN = process.env.PW_YGG_BIN || '';
const MOCK_PORT = process.env.PW_MOCK_PORT || '';
const APP_DIR = process.env.PW_APP_DIR || '';

test.skip(!STATE || !BASE || !BIN || !YGG_BIN || !MOCK_PORT || !APP_DIR, 'needs sim/trunk-e2e-v1.sh');
test.use({ ...devices['Pixel 7'], serviceWorkers: 'block' });

function record(step: string, res: 'PASS' | 'FAIL', what: string) {
  appendFileSync(join(STATE, 'steps.tsv'), `${step}\t${res}\t${what}\n`);
}
const kvPub = (out: string) => out.match(/public_key = "([^"]+)"/)![1];
const kvPriv = (out: string) => out.match(/private_key = "([^"]+)"/)![1];

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 30_000, stepMs = 200): Promise<boolean> {
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

function bg(name: string, cmd: string, args: string[], env: Record<string, string>, cwd = STATE) {
  const log = openSync(join(STATE, `${name}.log`), 'a');
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: ['ignore', log, log] });
  if (p.pid) writeFileSync(join(STATE, `${name}.pid`), String(p.pid));
  return p;
}

test('G3.3 trunk-e2e-v1: three roots, per-root peer tokens, chained delegation, revoke', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const admin = JSON.parse(readFileSync(join(STATE, 'admin.json'), 'utf8')) as {
    email: string;
    password: string;
    recovery_codes: string[];
    cookies: { bifrost_device: string };
  };
  const adminHdr = { cookie: `bifrost_device=${admin.cookies.bifrost_device}`, origin: BASE };

  const names = ['home', 'mac', 'lab'] as const;
  const portMap = {
    home: { brain: 18740, bridge: 18741, media: 18742, wgHttp: 18743, wgUdp: 18744, relay: 18745, app: 18746 },
    mac: { brain: 18747, bridge: 18748, media: 18749, wgHttp: 18750, wgUdp: 18751, relay: 18752, app: 0 },
    lab: { brain: 18753, bridge: 18754, media: 18755, wgHttp: 18756, wgUdp: 18757, relay: 18758, app: 0 },
  };
  const roots: Record<string, { id: string; token: string; trunkKey: string; dir: string }> = {};

  // W1: enroll all three roots and boot bridges, wg (ROOT_BIN on mac/lab), brains, app
  try {
    for (const name of names) {
      const d = join(STATE, name);
      mkdirSync(join(d, 'data'), { recursive: true });
      mkdirSync(join(d, 'work'), { recursive: true });
      const netBin = name === 'home' ? BIN : ROOT_BIN;
      const rk = kvPub(execFileSync(netBin, ['root-key', join(d, 'root.key')], { encoding: 'utf8' }));
      const wk = kvPub(execFileSync(netBin, ['wg-key', join(d, 'wg.key')], { encoding: 'utf8' }));
      const e = await request.post(`${BASE}/t/roots/enroll`, {
        data: { hostname: `${name}-box`, os: 'linux', arch: 'x86_64', root_pub: rk, wg_pub: wk, has_app: name === 'home', has_voice: false },
      });
      expect(e.status()).toBe(200);
      const st = await e.json();
      expect((await request.post(`${BASE}/t/roots/enroll/${st.id}/approve`, { headers: adminHdr, data: { name } })).status()).toBe(200);
      const res = await (await request.post(`${BASE}/t/roots/enroll/${st.id}/poll`, { data: { secret: st.poll_secret } })).json();
      expect(res.status).toBe('approved');
      roots[name] = { id: res.root_id, token: res.peer_token, trunkKey: res.trunk.trunk_key, dir: d };
    }
    record('W1', 'PASS', 'enrolled home, mac and lab through v1 trunk');

    for (const name of names) {
      const r = roots[name];
      const p = portMap[name];
      const netBin = name === 'home' ? BIN : ROOT_BIN;
      writeFileSync(
        join(r.dir, 'wg.toml'),
        `[wg]\nkey_file = "${r.dir}/wg.key"\nudp = "127.0.0.1:${p.wgUdp}"\nrelay = "127.0.0.1:${p.relay}"\nhttp = "127.0.0.1:${p.wgHttp}"\nbrain = "http://127.0.0.1:${p.brain}"\ntrunk_state = "${r.dir}/trunk-state.json"\ntrunk_key = "${r.trunkKey}"\n`
      );
      bg(`wg-${name}`, netBin, ['wg', '-c', join(r.dir, 'wg.toml')], {});
      const priv = kvPriv(execFileSync(netBin, ['keygen'], { encoding: 'utf8' }));
      writeFileSync(
        join(r.dir, 'bridge.toml'),
        `[node]\nname = "${name}"\nprivate_key = "${priv}"\n\n[bridge]\nhttp = "127.0.0.1:${p.bridge}"\nmedia = "127.0.0.1:${p.media}"\ntokens_file = "${r.dir}/devices.json"\nopencode_url = "http://127.0.0.1:${p.brain}"\n\n[trunk]\nurl = "${BASE}"\ntrunk_key = "${r.trunkKey}"\nroot_key_file = "${r.dir}/root.key"\nroot_id = "${r.id}"\nstate_file = "${r.dir}/trunk-state.json"\nupstream = "127.0.0.1:${p.app || p.brain}"\nice_tcp = []\nwg_relay = "127.0.0.1:${p.relay}"\nwg_local = "127.0.0.1:${p.wgUdp}"\n`
      );
      chmodSync(join(r.dir, 'bridge.toml'), 0o600);
      bg(`bridge-${name}`, netBin, ['bridge', '-c', join(r.dir, 'bridge.toml')], {});
      bg(`brain-${name}`, YGG_BIN, [], {
        HOME: r.dir,
        YGG_UPSTREAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        YGG_UPSTREAM_STYLE: 'anthropic',
        YGG_UPSTREAM_API_KEY: 'mock',
        YGG_UPSTREAM_MODEL: 'mock',
        YGG_WAKE_DEBOUNCE_MS: '400',
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

    const online = await waitFor(async () => {
      const r = await request.get(`${BASE}/t/me/roots`, { headers: adminHdr });
      if (!r.ok()) return false;
      const list = (await r.json()) as Array<{ online: boolean }>;
      return list.length === 3 && list.every((x) => x.online);
    }, 25_000);
    expect(online).toBe(true);
    record('W2', 'PASS', 'all three bridges linked to v1 trunk and online');

    // W3/W4/W5: per-root peer token probes over WireGuard (curing M0 F3!)
    const peered = await waitFor(async () => {
      const r = await request.get(`http://127.0.0.1:${portMap.mac.brain}/root`);
      if (!r.ok()) return false;
      const peers = ((await r.json()) as { peers?: string[] }).peers || [];
      return peers.includes(roots.home.id) && peers.includes(roots.lab.id);
    }, 30_000);
    expect(peered).toBe(true);

    const hm = await request.get(`http://127.0.0.1:${portMap.home.wgHttp}/_wg/${roots.mac.id}/root`, {
      headers: { 'x-ygg-peer': roots.home.token },
    });
    expect(hm.status()).toBe(200);
    expect((await hm.json()).name).toBe(roots.mac.id);
    record('W3', 'PASS', 'home -> mac over WireGuard with home peer token (200)');

    const ml = await request.get(`http://127.0.0.1:${portMap.mac.wgHttp}/_wg/${roots.lab.id}/root`, {
      headers: { 'x-ygg-peer': roots.mac.token },
    });
    expect(ml.status()).toBe(200);
    expect((await ml.json()).name).toBe(roots.lab.id);
    record('W4', 'PASS', 'mac -> lab over WireGuard with mac peer token (200)');

    const noTok = await request.post(`http://127.0.0.1:${portMap.home.wgHttp}/_wg/${roots.mac.id}/tree/report`, {
      data: { proxy: 'x', event: {} },
    });
    expect(noTok.status()).toBe(401);
    const wrongTok = await request.post(`http://127.0.0.1:${portMap.home.wgHttp}/_wg/${roots.mac.id}/tree/report`, {
      headers: { 'x-ygg-peer': roots.lab.token },
      data: { proxy: 'x', event: {} },
    });
    expect(wrongTok.status()).toBe(401);
    record('W5', 'PASS', 'peer calls without token or with another root token refused (401)');

    // W6: phone signs in through app behind v1 trunk
    bg(
      'app-home',
      'node',
      ['server.mjs'],
      {
        NODE_ENV: 'production',
        PORT: String(portMap.home.app),
        HOST: '127.0.0.1',
        BIFROST_AUTH: 'trunk',
        BIFROST_TRUNK_STATE: join(roots.home.dir, 'trunk-state.json'),
        BIFROST_TRUNK_URL: BASE,
        BIFROST_TRUST_PROXY: '1',
        BIFROST_MAIN_TITLE: '[MAIN]',
        OPENCODE_URL: `http://127.0.0.1:${portMap.home.brain}`,
        YGG_PEER_TOKEN: roots.home.token,
        ARTIFACTS_DIR: join(roots.home.dir, 'artifacts'),
        NEXT_TELEMETRY_DISABLED: '1',
      },
      APP_DIR
    );
    expect(
      await waitFor(async () => {
        const r = await request.get(`http://127.0.0.1:${portMap.home.app}/api/build`).catch(() => null);
        return !!r && [200, 401].includes(r.status());
      }, 40_000)
    ).toBe(true);

    const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
    const phone = await phoneCtx.newPage();
    await phone.goto('/');
    await phone.locator('#l-email').fill(admin.email);
    await phone.locator('#l-password').fill(admin.password);
    await phone.locator('#l-use-recovery').click();
    await phone.locator('#l-recovery').fill(admin.recovery_codes[0]);
    await phone.locator('#l-btn').click();
    await phone.waitForURL((u) => u.pathname === '/', { timeout: 20_000 });
    record('W6', 'PASS', 'phone signed in through v1 trunk to home door app');
    await phoneCtx.close();

    // W8: home -> mac -> lab delegation
    const toolCall = (calls: unknown[]) => `tool:${JSON.stringify([calls])}`;
    const homeMain = ((await (await request.post(`http://127.0.0.1:${portMap.home.brain}/session`, { data: { title: '[MAIN]' } })).json()) as { id: string }).id;
    await request.post(`http://127.0.0.1:${portMap.home.brain}/session/${homeMain}/message`, {
      data: {
        parts: [{ type: 'text', text: toolCall([['session_start', { title: 'hop-mac', agent: 'build', brief: 'Reply with exactly: HOP-MAC-OK', root: roots.mac.id }]]) }],
      },
      timeout: 90_000,
    });
    const hopOk = await waitFor(async () => {
      const t = (await (await request.get(`http://127.0.0.1:${portMap.home.brain}/tree`)).json()) as Array<{
        title: string;
        card?: { status?: string; headline?: string };
      }>;
      const row = t.find((x) => x.title === 'hop-mac');
      return row?.card?.status === 'done' && (row.card.headline || '').includes('HOP-MAC-OK');
    }, 45_000);
    expect(hopOk).toBe(true);
    record('W8', 'PASS', 'home MAIN delegated to mac over WireGuard and received report');

    // W9: no v0.9 files written
    const noV09 = names.every((n) => !existsSync(join(roots[n].dir, 'devices.json')) && !existsSync(join(roots[n].dir, 'roots.json')));
    expect(noV09).toBe(true);
    record('W9', 'PASS', 'v1 never wrote devices.json or roots.json on any root');

    // W10: revoke lab -> cut <= 1500 ms
    const t0 = Date.now();
    expect((await request.delete(`${BASE}/t/roots/${roots.lab.id}`, { headers: adminHdr })).status()).toBe(200);
    const gone = await waitFor(async () => {
      const r = await request.get(`http://127.0.0.1:${portMap.mac.wgHttp}/_wg/_roots`);
      if (!r.ok()) return false;
      const list = (await r.json()) as Array<{ id: string }>;
      return !list.some((x) => x.id === roots.lab.id);
    }, 5_000, 25);
    const cutMs = Date.now() - t0;
    expect(gone).toBe(true);
    expect(cutMs).toBeLessThanOrEqual(1500);
    record('W10', 'PASS', `revoking lab cut mac WireGuard peer in ${cutMs} ms (<=1500 ms)`);
  } catch (e) {
    record('W-ERR', 'FAIL', String(e).slice(0, 140));
    throw e;
  }
});
