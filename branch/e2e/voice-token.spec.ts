import { type ChildProcess, spawn } from 'child_process';
import { createHash, createHmac } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { expect, test } from '@playwright/test';

/**
 * /api/token per mode, against the BUILT app (`node server.mjs` on a free loopback port, its
 * own env — nothing live is touched, no LiveKit needed: a mock answers its Twirp API):
 *   tailnet + LIVEKIT_* → mints exactly as before: a JWT for the room (HS256, the API secret),
 *     the voice agent dispatched (the mock sees CreateDispatch); GET says available
 *   tailnet, no LIVEKIT_* → 503 {error:"voice-unavailable"} — JSON, never an empty 500
 *   devices (a phone paired through the trunk) + LIVEKIT_* → mints for a PAIRED DEVICE only (the
 *     device gate is the auth): the JWT names the device (attribute), the agent is dispatched,
 *     the trunk's ICE-TCP address rides along (BIFROST_TRUNK_ICE); the box console (no device)
 *     gets 503 voice-unavailable and nothing is minted; a garbage credential is still 401 at the
 *     edge; revoking the device removes its participant from the room (lib/voice-revoke)
 *   unreadable or room-less bodies → a JSON 400, never an empty answer
 */
const APP = resolve(__dirname, '..');
test.skip(!existsSync(join(APP, '.next/BUILD_ID')), 'needs the built app (npm run build)');
test.describe.configure({ mode: 'serial' });

const SECRET = 'lk-test-secret-0123456789abcdef0123456789';
const LK_ENV = {
  LIVEKIT_URL: 'wss://lk.test',
  LIVEKIT_API_KEY: 'lk-test-key',
  LIVEKIT_API_SECRET: SECRET,
};

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = net.createServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => done(port));
    });
  });
}

/** a LiveKit server API that records every call and answers `{}` — or, for GetParticipant,
 *  the participant `holder` says is in the room (its token's attributes) */
async function mockLiveKit(holder: () => Record<string, unknown> | null = () => null) {
  const calls: Array<{ url: string; auth: string; body: string }> = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ url: req.url || '', auth: String(req.headers.authorization || ''), body });
      const who = (req.url || '').endsWith('/GetParticipant') ? holder() : {};
      if (!who) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"code":"not_found","msg":"participant not found"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(who));
    });
  });
  await new Promise<void>((done) => srv.listen(port, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${port}`, calls, close: () => srv.close() };
}

/** the built app, its own process and env (env -i style: nothing from this shell leaks in) */
async function serve(env: Record<string, string>) {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: APP,
    env: {
      PATH: process.env.PATH || '',
      HOME: mkdtempSync(join(tmpdir(), 'voice-token-home-')),
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      OPENCODE_URL: 'http://127.0.0.1:9', // no brain: the token route never needs one
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${base}/api/ping`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 60_000, message: `the app did not come up:\n${log}` }
    )
    .toBeGreaterThan(0);
  return { base, stop: () => child.kill('SIGTERM'), log: () => log };
}

async function call(base: string, init: { method?: string; body?: string; bearer?: string } = {}) {
  const r = await fetch(`${base}/api/token`, {
    method: init.method || 'POST',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.body,
  });
  const text = await r.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — every case below fails on it */
  }
  return { status: r.status, type: r.headers.get('content-type') || '', text, json };
}

/** HS256, checked by hand: the token is LiveKit's, signed with the API secret */
function verifyJwt(token: string, secret: string): Record<string, unknown> {
  const [h, p, sig] = token.split('.');
  const want = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  expect(sig, 'the JWT signature (HS256, LIVEKIT_API_SECRET)').toBe(want);
  return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
}

test('tailnet + LIVEKIT_* (mocked): /api/token still mints and dispatches the agent', async () => {
  const lk = await mockLiveKit();
  const app = await serve({ BIFROST_AUTH: 'tailnet', ...LK_ENV, LIVEKIT_API_URL: lk.url });
  try {
    const r = await call(app.base, { body: JSON.stringify({ room: 'main' }) });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({
      serverUrl: 'wss://lk.test',
      roomName: 'main',
      participantName: 'user',
    });
    const claims = verifyJwt(String(r.json!.participantToken), SECRET);
    expect(claims).toMatchObject({ iss: 'lk-test-key', sub: 'user_main' });
    expect(claims.video).toMatchObject({ room: 'main', roomJoin: true, canPublish: true });
    // the agent was dispatched to the room, as before
    expect(lk.calls.map((c) => c.url)).toEqual([
      '/twirp/livekit.AgentDispatchService/CreateDispatch',
    ]);
    expect(JSON.parse(lk.calls[0].body)).toMatchObject({ room: 'main', agentName: 'bifrost' });
    // can voice work here? yes — and asking mints nothing
    const g = await call(app.base, { method: 'GET' });
    expect(g.status).toBe(200);
    expect(g.json).toEqual({ voice: 'available' });
    expect(lk.calls).toHaveLength(1);
    // bad bodies answer JSON, never an empty 500
    for (const body of ['{}', 'not json', '']) {
      const b = await call(app.base, { body });
      expect(b.status, `${JSON.stringify(body)} → ${b.text}`).toBe(400);
      expect(b.json).toEqual({ error: 'room required' });
    }
  } finally {
    app.stop();
    lk.close();
  }
});

test('tailnet without LIVEKIT_*: 503 voice-unavailable, as JSON', async () => {
  const app = await serve({ BIFROST_AUTH: 'tailnet' });
  try {
    for (const method of ['POST', 'GET']) {
      const r = await call(app.base, {
        method,
        body: method === 'POST' ? '{"room":"main"}' : undefined,
      });
      expect(r.status, r.text).toBe(503);
      expect(r.type).toContain('application/json');
      expect(r.json).toMatchObject({ error: 'voice-unavailable' });
      expect(String(r.json!.why)).toContain('LiveKit');
    }
  } finally {
    app.stop();
  }
});

/** a paired device in the registry (v2 record): its access token, issued in the region a
 *  loopback client has */
function pairedDevice(file: string, id: string) {
  const raw = `bfnd-test-${id}-0123456789abcdef`;
  const sha = (x: string) => createHash('sha256').update(x).digest('hex');
  const reg = {
    version: 2,
    killEpoch: 0,
    codes: [],
    devices: [
      {
        id,
        name: 'phone',
        created: new Date().toISOString(),
        revoked: false,
        region: 'loopback',
        lastRegion: 'loopback',
        regionChanges: 0,
        lastSeen: '',
        refreshHash: sha(`refresh-${id}`),
        refreshExp: Date.now() + 86_400_000,
        prevRefresh: [],
        access: [{ hash: sha(raw), exp: Date.now() + 3_600_000, region: 'loopback' }],
      },
    ],
  };
  writeFileSync(file, JSON.stringify(reg));
  return {
    raw,
    revoke: () => {
      const r = JSON.parse(readFileSync(file, 'utf8'));
      r.devices[0].revoked = true;
      writeFileSync(file, JSON.stringify(r));
    },
  };
}

test('devices mode (the trunk): mints for a paired device only, names the trunk ICE, revoke removes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-token-dev-'));
  const file = join(dir, 'devices.json');
  const dev = pairedDevice(file, 'dev_phone1');
  let inRoom = false;
  const lk = await mockLiveKit(() =>
    inRoom ? { identity: 'user_main', attributes: { device: 'dev_phone1' } } : null
  );
  const app = await serve({
    BIFROST_AUTH: 'devices',
    BIFROST_DEVICES_FILE: file,
    ...LK_ENV,
    LIVEKIT_API_URL: lk.url,
    BIFROST_TRUNK_ICE: '198.51.100.7:443,[2001:db8::7]:443',
    BIFROST_VOICE_SWEEP_MS: '200',
  });
  try {
    // the box's own console (loopback, no credential) clears the gate — and gets no token
    for (const method of ['POST', 'GET']) {
      const r = await call(app.base, {
        method,
        body: method === 'POST' ? '{"room":"main"}' : undefined,
      });
      expect(r.status, r.text).toBe(503);
      expect(r.json).toMatchObject({ error: 'voice-unavailable' });
      expect(String(r.json!.why)).toContain('paired');
      expect(r.json).not.toHaveProperty('participantToken');
    }
    expect(lk.calls, 'no dispatch, no LiveKit call at all').toEqual([]);
    // a presented credential must stand on its own: garbage is refused at the edge, as before
    const bad = await call(app.base, { body: '{"room":"main"}', bearer: 'bfnd-not-a-real-token' });
    expect(bad.status).toBe(401);
    expect(bad.json).toMatchObject({ why: 'invalid', reauth: 'pair' });

    // the paired device: voice is available, and the mint names the device and the trunk's ICE
    const g = await call(app.base, { method: 'GET', bearer: dev.raw });
    expect(g.status, g.text).toBe(200);
    expect(g.json).toEqual({ voice: 'available' });
    const r = await call(app.base, { body: '{"room":"main"}', bearer: dev.raw });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ serverUrl: 'wss://lk.test', roomName: 'main' });
    expect(r.json!.iceTcp).toEqual([
      { ip: '198.51.100.7', port: 443 },
      { ip: '2001:db8::7', port: 443 },
    ]);
    const claims = verifyJwt(String(r.json!.participantToken), SECRET);
    expect(claims).toMatchObject({ sub: 'user_main', attributes: { device: 'dev_phone1' } });
    expect(claims.video).toMatchObject({ room: 'main', roomJoin: true, canPublish: true });
    expect(claims.video).not.toHaveProperty('canUpdateOwnMetadata');
    expect(lk.calls.map((c) => c.url)).toContain(
      '/twirp/livekit.AgentDispatchService/CreateDispatch'
    );

    // it joins; then it is revoked: the sweep removes it from the room, the gate refuses it
    inRoom = true;
    await new Promise((d) => setTimeout(d, 600));
    expect(lk.calls.some((c) => c.url.endsWith('/RemoveParticipant'))).toBe(false);
    dev.revoke();
    await expect
      .poll(() => lk.calls.filter((c) => c.url.endsWith('/RemoveParticipant')).length, {
        timeout: 5_000,
      })
      .toBeGreaterThan(0);
    const rm = lk.calls.find((c) => c.url.endsWith('/RemoveParticipant'))!;
    expect(JSON.parse(rm.body)).toMatchObject({ room: 'main', identity: 'user_main' });
    const after = await call(app.base, { body: '{"room":"main"}', bearer: dev.raw });
    expect(after.status).toBe(401);
    expect(after.json).toMatchObject({ why: 'revoked' });
  } finally {
    app.stop();
    lk.close();
  }
});
