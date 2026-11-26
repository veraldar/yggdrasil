import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { devices, expect, test } from '@playwright/test';

/**
 * G3.1 · v1 port of trunk-full-e2e (+ --scenario s17).
 * Drives the real v1 trunk, bridges [trunk], wg nodes (trunk_state), real yggdrasil brains with
 * per-root peer tokens, real app (BIFROST_AUTH=trunk), and Pixel 7 Playwright phone.
 */
const STATE = process.env.PW_STATE || '';
const BASE = process.env.PW_BASE_URL || '';
const BIN = process.env.PW_TRUNK_BIN || '';
const YGG_BIN = process.env.PW_YGG_BIN || '';
const MOCK_PORT = process.env.PW_MOCK_PORT || '';
const CCM_PORT = process.env.PW_CCM_PORT || '';
const APP_DIR = process.env.PW_APP_DIR || '';
const SCENARIO = process.env.PW_SCENARIO || 'full';
const REPO = process.env.PW_REPO || '';

test.skip(!STATE || !BASE || !BIN || !YGG_BIN || !MOCK_PORT || !APP_DIR, 'needs sim/trunk-full-v1-e2e.sh');
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

test(`trunk-full-v1 (${SCENARIO})`, async ({ browser, request }) => {
  test.setTimeout(360_000);
  const admin = JSON.parse(readFileSync(join(STATE, 'admin.json'), 'utf8')) as {
    email: string;
    password: string;
    recovery_codes: string[];
    cookies: { bifrost_device: string };
  };
  const adminHdr = { cookie: `bifrost_device=${admin.cookies.bifrost_device}`, origin: BASE };

  const names = SCENARIO === 's17' ? (['home', 'lab'] as const) : (['home', 'mac', 'lab'] as const);
  const portMap = {
    home: { brain: 18755, bridge: 18756, media: 18757, wgHttp: 18758, wgUdp: 18759, relay: 18760, app: 18761 },
    mac: { brain: 18762, bridge: 18763, media: 18764, wgHttp: 18765, wgUdp: 18766, relay: 18767, app: 0 },
    lab: { brain: 18768, bridge: 18769, media: 18770, wgHttp: 18771, wgUdp: 18772, relay: 18773, app: 0 },
  };
  const roots: Record<string, { id: string; token: string; trunkKey: string; dir: string }> = {};

  // ---- Step 1: enroll roots via /t/roots/enroll + boot bridges, wg, brains, app ----
  try {
    for (const name of names) {
      const d = join(STATE, name);
      mkdirSync(join(d, 'data'), { recursive: true });
      mkdirSync(join(d, 'work'), { recursive: true });
      mkdirSync(join(d, 'artifacts'), { recursive: true });
      const rk = kvPub(execFileSync(BIN, ['root-key', join(d, 'root.key')], { encoding: 'utf8' }));
      const wk = kvPub(execFileSync(BIN, ['wg-key', join(d, 'wg.key')], { encoding: 'utf8' }));
      const e = await request.post(`${BASE}/t/roots/enroll`, {
        data: { hostname: `${name}-box`, os: 'linux', arch: 'x86_64', root_pub: rk, wg_pub: wk, has_app: name === 'home', has_voice: false },
      });
      expect(e.status()).toBe(200);
      const st = await e.json();
      const ap = await request.post(`${BASE}/t/roots/enroll/${st.id}/approve`, { headers: adminHdr, data: { name } });
      expect(ap.status()).toBe(200);
      const poll = await request.post(`${BASE}/t/roots/enroll/${st.id}/poll`, { data: { secret: st.poll_secret } });
      expect(poll.status()).toBe(200);
      const res = await poll.json();
      expect(res.status).toBe('approved');
      roots[name] = { id: res.root_id, token: res.peer_token, trunkKey: res.trunk.trunk_key, dir: d };
    }

    if (SCENARIO === 's17') {
      const labArt = join(roots.lab.dir, 'artifacts');
      writeFileSync(
        join(roots.lab.dir, 'work', 'CLAUDE.md'),
        `# Workspace (root lab)\n\nThis computer's work area is ${join(roots.lab.dir, 'work')}.\n` +
          `Files for the owner go in the artifacts folder: ${labArt}/ — link each one as [name](/api/artifact/<name>); it opens on their phone.\n`
      );
    }

    for (const name of names) {
      const r = roots[name];
      const p = portMap[name];
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
      bg(`bridge-${name}`, BIN, ['bridge', '-c', join(r.dir, 'bridge.toml')], {});

      const brainEnv: Record<string, string> = {
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
      };
      if (SCENARIO === 's17' && name === 'lab') {
        brainEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${CCM_PORT}`;
        brainEnv.ANTHROPIC_API_KEY = 'cc-rig-key';
        brainEnv.IS_SANDBOX = '1';
      }
      bg(`brain-${name}`, YGG_BIN, [], brainEnv);
    }

    const online = await waitFor(async () => {
      const r = await request.get(`${BASE}/t/me/roots`, { headers: adminHdr });
      if (!r.ok()) return false;
      const list = (await r.json()) as Array<{ online: boolean }>;
      return list.length === names.length && list.every((x) => x.online);
    }, 25_000);
    expect(online).toBe(true);

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
    const appUp = await waitFor(async () => {
      const r = await request.get(`http://127.0.0.1:${portMap.home.app}/api/build`).catch(() => null);
      return !!r && [200, 401].includes(r.status());
    }, 40_000);
    expect(appUp).toBe(true);

    const peered = await waitFor(async () => {
      const r = await request.get(`http://127.0.0.1:${portMap.home.brain}/root`);
      if (!r.ok()) return false;
      const j = (await r.json()) as { peers?: string[] };
      return names.filter((n) => n !== 'home').every((n) => (j.peers || []).includes(roots[n].id));
    }, 30_000);
    expect(peered).toBe(true);
    record('F1', 'PASS', `v1 trunk + ${names.join('/')} enrolled, linked and peered over WireGuard`);
  } catch (e) {
    record('F1', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // ---- Step 2: phone signs in through the v1 trunk ----
  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', baseURL: BASE });
  const phone = await phoneCtx.newPage();
  let mainId = '';
  try {
    await phone.goto('/');
    await expect(phone).toHaveURL(/\/login/);
    await phone.locator('#l-email').fill(admin.email);
    await phone.locator('#l-password').fill(admin.password);
    await phone.locator('#l-use-recovery').click();
    await phone.locator('#l-recovery').fill(admin.recovery_codes[0]);
    await phone.locator('#l-btn').click();
    await phone.waitForURL((u) => u.pathname === '/', { timeout: 20_000 });
    await phone.evaluate(() => {
      localStorage.setItem('bifrost-door', 'v2');
      localStorage.setItem('bifrost-first-turn', '1');
    });
    await phone.reload();
    await expect(phone.getByRole('button', { name: 'new session', exact: true })).toBeVisible({ timeout: 20_000 });
    const mainRes = await request.post(`http://127.0.0.1:${portMap.home.brain}/session`, { data: { title: '[MAIN]' } });
    mainId = ((await mainRes.json()) as { id: string }).id;
    record('F2', 'PASS', `phone signed in through v1 trunk (MAIN ${mainId})`);
  } catch (e) {
    record('F2', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  if (SCENARIO === 's17') {
    // ---- S17: 6.4 MB PDF over WireGuard to real Claude Code on lab ----
    try {
      const pdf = JSON.parse(
        execFileSync('python3', [join(REPO, 'sim/reach/make_pdf.py'), join(STATE, 'report.pdf'), '--mb', '6.4'], {
          encoding: 'utf8',
        })
      ) as { path: string; size: number; marker: string; sha256: string };
      const pdfBytes = readFileSync(pdf.path);

      // MAIN starts "pdf reader" (agent claude) on root lab
      const toolMsg = `tool:${JSON.stringify([[['session_start', { title: 'pdf reader', agent: 'claude', brief: 'Wait for the user.', root: roots.lab.id }]]])}`;
      const rStart = await request.post(`http://127.0.0.1:${portMap.home.brain}/session/${mainId}/message`, {
        data: { parts: [{ type: 'text', text: toolMsg }] },
        timeout: 60_000,
      });
      expect(rStart.status()).toBe(200);
      const tree = (await (await request.get(`http://127.0.0.1:${portMap.home.brain}/tree`)).json()) as Array<{
        id: string;
        title: string;
        remote?: { session?: string };
      }>;
      const proxy = tree.find((x) => x.title === 'pdf reader');
      expect(proxy?.id).toBeTruthy();
      record('S17.3', 'PASS', `MAIN started "pdf reader" on lab (${proxy!.id})`);

      // open the proxy on the phone, attach the 6.4 MB PDF, ask for marker word
      await phone.goto(`/session/pdf-reader?id=${encodeURIComponent(proxy!.id)}`);
      const [chooser] = await Promise.all([
        phone.waitForEvent('filechooser', { timeout: 15_000 }),
        phone.getByRole('button', { name: 'attach' }).tap(),
      ]);
      await chooser.setFiles(pdf.path);
      await phone.waitForTimeout(500);
      const box = phone.getByPlaceholder('message…');
      await box.fill('what is the marker word in this pdf');
      await phone.getByRole('button', { name: 'send', exact: true }).tap();

      const blobPath = join(roots.lab.dir, 'data', 'files', 'blobs', pdf.sha256);
      const arrived = await waitFor(async () => existsSync(blobPath) && readFileSync(blobPath).length === pdfBytes.length, 90_000, 500);
      expect(arrived).toBe(true);
      expect(createHash('sha256').update(readFileSync(blobPath)).digest('hex')).toBe(pdf.sha256);
      record('S17.4', 'PASS', `6.4 MB PDF arrived on lab over WireGuard (sha256 ${pdf.sha256.slice(0, 12)})`);

      await expect(phone.getByText(pdf.marker)).toBeVisible({ timeout: 120_000 });
      record('S17.6', 'PASS', `Claude Code on lab replied with marker word ${pdf.marker}`);

      // write marker.html and tap the link
      await box.fill('now write marker.html into your artifacts folder with the marker word and link it');
      await phone.getByRole('button', { name: 'send', exact: true }).tap();
      const artFile = join(roots.lab.dir, 'artifacts', 'marker.html');
      const artOk = await waitFor(async () => existsSync(artFile) && readFileSync(artFile, 'utf8').includes(pdf.marker), 90_000, 500);
      expect(artOk).toBe(true);
      record('S17.7', 'PASS', 'lab wrote marker.html with marker word');
    } catch (e) {
      record('S17', 'FAIL', String(e).slice(0, 140));
      throw e;
    }
    await phoneCtx.close();
    return;
  }

  // ---- Default full scenario: F3 delegation home -> mac, F4 mac -> lab, F5 per-root UI, F6 revoke lab ----
  try {
    const toolCall = (calls: unknown[]) => `tool:${JSON.stringify([calls])}`;
    const rMac = await request.post(`http://127.0.0.1:${portMap.home.brain}/session/${mainId}/message`, {
      data: {
        parts: [{ type: 'text', text: toolCall([['session_start', { title: 'on mac', agent: 'build', brief: 'Reply with exactly: FULL-MAC-OK', root: roots.mac.id }]]) }],
      },
      timeout: 90_000,
    });
    expect(rMac.status()).toBe(200);
    const macDone = await waitFor(async () => {
      const t = (await (await request.get(`http://127.0.0.1:${portMap.home.brain}/tree`)).json()) as Array<{
        title: string;
        card?: { status?: string; headline?: string };
      }>;
      const row = t.find((x) => x.title === 'on mac');
      return row?.card?.status === 'done' && (row.card.headline || '').includes('FULL-MAC-OK');
    }, 45_000);
    expect(macDone).toBe(true);
    record('F3', 'PASS', 'MAIN delegated to mac over v1 WireGuard relay; report came home');

    // mac -> lab
    const macMain = ((await (await request.post(`http://127.0.0.1:${portMap.mac.brain}/session`, { data: { title: '[MAIN]' } })).json()) as { id: string }).id;
    const rLab = await request.post(`http://127.0.0.1:${portMap.mac.brain}/session/${macMain}/message`, {
      data: {
        parts: [{ type: 'text', text: toolCall([['session_start', { title: 'on lab', agent: 'build', brief: 'Reply with exactly: FULL-LAB-OK', root: roots.lab.id }]]) }],
      },
      timeout: 90_000,
    });
    expect(rLab.status()).toBe(200);
    const labDone = await waitFor(async () => {
      const t = (await (await request.get(`http://127.0.0.1:${portMap.mac.brain}/tree`)).json()) as Array<{
        title: string;
        card?: { status?: string; headline?: string };
      }>;
      const row = t.find((x) => x.title === 'on lab');
      return row?.card?.status === 'done' && (row.card.headline || '').includes('FULL-LAB-OK');
    }, 45_000);
    expect(labDone).toBe(true);
    record('F4', 'PASS', 'mac delegated to lab over v1 WireGuard relay; report returned to mac');

    // phone opens /roots/<mac>
    await phone.goto(`/roots/${roots.mac.id}`);
    await expect(phone.getByTestId('root-view')).toHaveAttribute('data-root', roots.mac.id, { timeout: 20_000 });
    record('F5', 'PASS', `phone opened /roots/${roots.mac.id} through the v1 trunk`);

    // revoke lab -> cut <= 1500 ms
    const t0 = Date.now();
    const del = await request.delete(`${BASE}/t/roots/${roots.lab.id}`, { headers: adminHdr });
    expect(del.status()).toBe(200);
    const gone = await waitFor(async () => {
      const r = await request.get(`http://127.0.0.1:${portMap.mac.wgHttp}/_wg/_roots`);
      if (!r.ok()) return false;
      const list = (await r.json()) as Array<{ id: string }>;
      return !list.some((x) => x.id === roots.lab.id);
    }, 5_000, 25);
    const cutMs = Date.now() - t0;
    expect(gone).toBe(true);
    expect(cutMs).toBeLessThanOrEqual(1500);
    record('F6', 'PASS', `DELETE /t/roots/${roots.lab.id} cut WireGuard peer in ${cutMs} ms (<=1500 ms)`);
  } catch (e) {
    record('F-ERR', 'FAIL', String(e).slice(0, 140));
    throw e;
  }

  await phoneCtx.close();
});
