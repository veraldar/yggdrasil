// BIFROST_AUTH=trunk at the app's door (lib/gate.ts + lib/admin.ts, middleware.ts): /api answers C3's
// 401 {why, reauth}, pages without a token 302 to /login, the box's console and the admin token keep
// their way in (B20/B21), what moved to the trunk answers 404 — and tailnet / devices do not move.
// Run: node --test lib/trunk-gate.test.mjs   (node ≥ 23.6 strips the .ts types itself)
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// the app's alias, and next/server for plain-node ESM (Next has no exports map)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/lib/')) return next(new URL(`./${spec.slice(6)}.ts`, import.meta.url).href, ctx);
    if (spec === 'next/server') return next('next/server.js', ctx);
    return next(spec, ctx);
  },
});

const home = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'trunk-gate-'));
const STATE = path.join(home, 'trunk-state.json');
process.env.BIFROST_TRUNK_STATE = STATE;
process.env.BIFROST_DEVICES_FILE = path.join(home, 'devices.json');
process.env.BIFROST_OBS = 'off';
process.env.BIFROST_PEER_STAMP = 'server.mjs'; // as server.mjs marks its process: x-bifrost-peer is real
process.env.BIFROST_ADMIN_TOKEN = 'admin-token-for-the-test-0123456789';
after(() => rmSync(home, { recursive: true, force: true }));

const { NextRequest } = await import('next/server');
const gate = await import('./gate.ts');
const admin = await import('./admin.ts');
const ta = await import('./trunk-auth.ts');

const PHONE = '203.0.113.9';
const RGN = 'net:203.0.0.0/16';
const key = ta.secretKeyFromSeed(Buffer.alloc(32, 9));
const pubRaw = ta.rawPublic(key);
const writeState = (over = {}) => {
  const s = {
    version: 1,
    trunk: { url: 'https://ljoolq.veraldar.org', trunk_id: 'trk_t', trunk_key: 'k' },
    root: { id: 'rt_t', name: 'twin' },
    link: { state: 'up', since: Date.now(), written: Date.now() },
    keys: [{ kid: ta.kidOf(pubRaw), alg: 'ed25519', public: pubRaw.toString('base64url'), retired_at: null }],
    kill_epoch: 1,
    lockdown: false,
    deny: [],
    directory: { seq: 1, issued_at: Date.now(), sig: '', roots: [] },
    vapid_public: null,
    ...over,
  };
  writeFileSync(`${STATE}.tmp`, JSON.stringify(s));
  renameSync(`${STATE}.tmp`, STATE);
};
writeState();
const settle = () => new Promise((r) => setTimeout(r, ta.STATE_CHECK_MS + 20));

const token = (claims = {}, opts = {}) => ta.mintToken(key, { did: 'dev_phone', rgn: RGN, kep: 1, ...claims }, opts);
const req = (url, { peer = PHONE, cookie, bearer, method = 'GET' } = {}) => {
  const headers = new Headers({ 'x-bifrost-peer': peer });
  if (cookie) headers.set('cookie', `bifrost_device=${cookie}`);
  if (bearer) headers.set('authorization', `Bearer ${bearer}`);
  return new NextRequest(`http://localhost:8250${url}`, { headers, method });
};
const passed = (r) => r.headers.get('x-middleware-next') === '1';
const body = async (r) => JSON.parse(await r.text());
const mode = (m) => (process.env.BIFROST_AUTH = m);

test('trunk /api: no token → 401 {why:missing, reauth:login} (C3 body exactly)', async () => {
  mode('trunk');
  const r = await gate.deviceGate(req('/api/session'));
  assert.equal(r.status, 401);
  assert.deepEqual(await body(r), { why: 'missing', reauth: 'login' });
});

test('trunk /api: a good token from the cookie or Bearer passes', async () => {
  mode('trunk');
  assert.ok(passed(await gate.deviceGate(req('/api/session', { cookie: token() }))));
  assert.ok(passed(await gate.deviceGate(req('/api/session/abc/message', { bearer: token(), method: 'POST' }))));
});

test('trunk /api: expired / region → refresh; invalid / revoked → login', async () => {
  mode('trunk');
  const cases = [
    [token({}, { now: Date.now() - 16 * 60_000 }), { why: 'expired', reauth: 'refresh' }, PHONE],
    [token(), { why: 'region', reauth: 'refresh' }, '198.51.100.7'],
    [token({ kep: 0 }), { why: 'revoked', reauth: 'login' }, PHONE],
    [token().slice(0, -3) + 'AAA', { why: 'invalid', reauth: 'login' }, PHONE],
    ['bfnd-' + 'x'.repeat(40), { why: 'invalid', reauth: 'login' }, PHONE],
  ];
  for (const [tok, want, peer] of cases) {
    const r = await gate.deviceGate(req('/api/session', { cookie: tok, peer }));
    assert.equal(r.status, 401, want.why);
    assert.deepEqual(await body(r), want);
  }
});

test('trunk: a revoke written by the bridge lands on the next call (within the state check)', async () => {
  mode('trunk');
  const tok = token({ did: 'dev_soon_gone' });
  assert.ok(passed(await gate.deviceGate(req('/api/session', { cookie: tok }))));
  writeState({ deny: [{ did: 'dev_soon_gone', until: Date.now() + 60_000 }] });
  await settle();
  const r = await gate.deviceGate(req('/api/session', { cookie: tok }));
  assert.deepEqual(await body(r), { why: 'revoked', reauth: 'login' });
  writeState({ kill_epoch: 2 });
  await settle();
  assert.equal((await gate.deviceGate(req('/api/session', { cookie: token() }))).status, 401, 'kill epoch moved past kep 1');
  writeState();
  await settle();
});

test('trunk: the box console (loopback, nothing presented) and the admin token keep their way in', async () => {
  mode('trunk');
  assert.ok(passed(await gate.deviceGate(req('/api/session', { peer: '127.0.0.1' }))));
  assert.ok(passed(await gate.pageGate(req('/', { peer: '127.0.0.1' }))));
  assert.ok(passed(await gate.deviceGate(req('/api/session', { bearer: process.env.BIFROST_ADMIN_TOKEN }))));
  // a presented credential stands on its own: loopback never upgrades a bad one (§4.3 invariant 4)
  const bad = await gate.deviceGate(req('/api/session', { peer: '127.0.0.1', cookie: 'garbage-garbage-garbage' }));
  assert.equal(bad.status, 401);
  assert.equal((await gate.deviceGate(req('/api/session', { bearer: 'not-the-admin-token-0000000000' }))).status, 401);
});

test('trunk pages: no token → 302 /login (no-store); expired/region → the page; good → the page', async () => {
  mode('trunk');
  for (const p of ['/', '/session/main', '/settings', '/roots/lab/settings', '/pairing']) {
    const r = await gate.pageGate(req(p));
    assert.equal(r.status, 302, p);
    // absolute on the request's own origin here; Next's adapter relativizes it to `/login` on the wire
    // (checked against `node server.mjs`, behind any Host header)
    assert.equal(r.headers.get('location'), 'http://localhost:8250/login', p);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(await r.text(), '', 'not one byte of the app');
  }
  assert.equal((await gate.pageGate(req('/', { cookie: token({ kep: 0 }) }))).status, 302, 'revoked');
  assert.ok(passed(await gate.pageGate(req('/', { cookie: token() }))));
  assert.ok(passed(await gate.pageGate(req('/', { cookie: token({}, { now: Date.now() - 20 * 60_000 }) }))), 'expired: refreshes on its first call');
  assert.ok(passed(await gate.pageGate(req('/', { cookie: token(), peer: '198.51.100.7' }))), 'roamed');
});

test('trunk: what moved to the trunk (and the trunk’s own paths) answers 404 here, signed in or not', async () => {
  mode('trunk');
  const pages = ['/pair', '/pair/x', '/devices', '/join', '/login', '/account', '/add-root', '/auth/root', '/audit', '/offline', '/claim', '/t/auth/refresh'];
  for (const p of pages) {
    for (const cookie of [undefined, token()]) {
      const r = await gate.pageGate(req(p, { cookie }));
      assert.equal(r.status, 404, p);
      assert.match(r.headers.get('content-type'), /text\/plain/);
    }
  }
  const apis = ['/api/pair', '/api/pair/claim', '/api/pair/refresh', '/api/pair/devices', '/api/pair/kill', '/api/roots/join', '/api/roots/join/abcdefgh12', '/api/roots/join/abcdefgh12/approve'];
  for (const p of apis) {
    for (const cookie of [undefined, token()]) assert.equal((await gate.deviceGate(req(p, { cookie, method: 'POST' }))).status, 404, p);
  }
  // not moved: the per-root routes and the refill path are plain device-gated routes now
  assert.equal((await gate.deviceGate(req('/api/roots/lab/tokens', { method: 'POST' }))).status, 401);
  assert.ok(passed(await gate.deviceGate(req('/api/roots', { cookie: token() }))));
  assert.ok(passed(await gate.pageGate(req('/roots/lab', { cookie: token() }))));
});

test('trunk: plain `next start` (no stamped peer) fails closed — region unknown (B30)', async () => {
  mode('trunk');
  delete process.env.BIFROST_PEER_STAMP;
  try {
    const r = await gate.deviceGate(req('/api/session', { cookie: token(), peer: PHONE }));
    assert.deepEqual(await body(r), { why: 'region', reauth: 'refresh' });
    // and no console either: a client-sent x-bifrost-peer is not believed
    assert.equal((await gate.deviceGate(req('/api/session', { peer: '127.0.0.1' }))).status, 401);
  } finally {
    process.env.BIFROST_PEER_STAMP = 'server.mjs';
  }
});

test('trunk: the roots gate and the voice device (lib/admin.ts)', async () => {
  mode('trunk');
  assert.equal(await admin.rootsGate(req('/api/roots', { cookie: token() })), 'ok');
  assert.equal(await admin.rootsGate(req('/api/roots', { peer: '127.0.0.1' })), 403, 'the console has no device');
  assert.equal(await admin.rootsGate(req('/api/roots', { bearer: process.env.BIFROST_ADMIN_TOKEN })), 403);
  assert.equal(await admin.rootsGate(req('/api/roots', { cookie: token({ kep: 0 }) })), 401);
  assert.equal(await admin.trunkRootsGate(req('/api/roots', { cookie: token({ kep: 0 }) })), 'revoked');
  assert.deepEqual(await admin.signedInDevice(req('/api/token', { cookie: token({ did: 'dev_voice', kep: 1 }) })), {
    ok: true,
    id: 'dev_voice',
    kep: 1,
  });
  assert.equal((await admin.signedInDevice(req('/api/token', { peer: '127.0.0.1' }))).ok, false, 'the console gets no voice');
  assert.equal(await admin.adminOrDevice(req('/api/ice', { cookie: token() })), 'device');
  assert.equal(await admin.adminOrDevice(req('/api/ice', { cookie: token({ kep: 0 }) })), null);
});

test('tailnet: nothing is gated, /pair included (W2)', async () => {
  mode('tailnet');
  for (const p of ['/', '/pair', '/devices', '/login']) assert.ok(passed(await gate.pageGate(req(p))), p);
  for (const p of ['/api/session', '/api/pair/claim', '/api/roots/join']) assert.ok(passed(await gate.deviceGate(req(p))), p);
  assert.equal(await admin.rootsGate(req('/api/roots')), 'ok');
});

test('devices: /pair still passes; a stranger’s /api still gets the v0.9 body; a v1 token means nothing', async () => {
  mode('devices');
  assert.ok(passed(await gate.pageGate(req('/pair'))));
  assert.ok(passed(await gate.pageGate(req('/pair', { cookie: token() }))));
  const r = await gate.deviceGate(req('/api/session'));
  assert.equal(r.status, 401);
  assert.deepEqual(await body(r), { error: 'device token required', why: 'missing', reauth: 'pair' });
  const v1 = await gate.deviceGate(req('/api/session', { cookie: token() }));
  assert.deepEqual(await body(v1), { error: 'device token required', why: 'invalid', reauth: 'pair' });
  // a stranger's page is the /pair page in its place (a rewrite), not a 302 to /login
  const p = await gate.pageGate(req('/'));
  assert.equal(p.status, 200);
  assert.match(p.headers.get('x-middleware-rewrite') || '', /\/pair\?unpaired=1$/);
  assert.ok(passed(await gate.deviceGate(req('/api/pair/claim', { method: 'POST' }))), 'pair routes authenticate themselves');
});
