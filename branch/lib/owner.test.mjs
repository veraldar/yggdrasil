// The answer cards' door and the owner's voucher: only a live PAIRED DEVICE gets through; the box
// console, the admin token, a hash, a guess and an expired token do not — and an agent's tool, which
// runs on the console, is none of them. (root/src/owner.rs checks the same credential on its side.)
// Run: node --test lib/owner.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/lib/')) return next(new URL(`./${spec.slice(6)}.ts`, import.meta.url).href, ctx);
    if (spec === 'next/server') return next('next/server.js', ctx);
    return next(spec, ctx);
  },
});

const home = mkdtempSync(path.join(tmpdir(), 'owner-approve-'));
process.env.BIFROST_DEVICES_FILE = path.join(home, 'devices.json');
process.env.BIFROST_AUTH = 'devices';
process.env.BIFROST_PEER_STAMP = 'server.mjs';
process.env.BIFROST_ADMIN_TOKEN = 'admin-token-0123456789abcdef';

// a stand-in brain: records what reaches it
const seen = [];
const brain = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => handle(req, res, raw ? JSON.parse(raw) : {}));
});
function handle(req, res, bodyOf) {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/session') return res.end(JSON.stringify([{ id: 'ses_abc', title: 'abc' }]));
  seen.push({ url: req.url, method: req.method, device: req.headers['x-ygg-device'], body: bodyOf });
  if (req.url === '/owner/voucher') return res.end(JSON.stringify({ voucher: 'ov_test' }));
  if (req.url.endsWith('/owner-answer')) { res.statusCode = bodyOf.ask === 'ask_old' ? 409 : 200; return res.end(JSON.stringify(bodyOf.ask === 'ask_old' ? { error: 'the question changed', ask: { id: 'ask_new', q: 'q?' } } : { turn_id: 'msg_1', status: 'queued' })); }
  if (req.url.endsWith('/owner-seen')) return res.end(JSON.stringify({ ok: true }));
  res.statusCode = 404;
  res.end('{}');
}
await new Promise((r) => brain.listen(0, '127.0.0.1', r));
process.env.OPENCODE_URL = `http://127.0.0.1:${brain.address().port}`;

const { mintDevice } = await import('./devices.ts');
const { ownerToken, mintVoucher } = await import('./owner.ts');
const { POST } = await import('../app/api/session/[id]/answer/route.ts');
const { POST: SEEN } = await import('../app/api/session/[id]/seen/route.ts');
const { GET: STATE } = await import('../app/api/owner/state/route.ts');
const { PUT: GRANT } = await import('../app/api/owner/grants/[kind]/route.ts');
after(() => brain.close());

const req = (headers = {}, peer = '100.64.1.2', body = { ask: 'ask_1', answer: 'yes' }, method = 'POST') =>
  new Request('http://app/api/session/abc/answer', { method, headers: { 'x-bifrost-peer': peer, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: 'ses_abc' }) };
let device;
before(async () => {
  device = await mintDevice('phone', 'cgnat:100.64.0.0/10');
});

test('a live paired device is the owner; nothing else is', async () => {
  const good = { authorization: `Bearer ${device.accessToken}` };
  assert.equal(await ownerToken(req(good)), device.accessToken);
  assert.equal(await ownerToken(req({ cookie: `bifrost_device=${device.accessToken}` })), device.accessToken);
  for (const [why, headers, peer] of [
    ['the box console (an agent\'s tools run here)', {}, '127.0.0.1'],
    ['the console with no token at all, from the tailnet', {}, '100.64.1.2'],
    ['the admin token', { authorization: 'Bearer admin-token-0123456789abcdef' }, '127.0.0.1'],
    ['a guess', { authorization: 'Bearer bfnd-guess-0123456789abcdef' }, '100.64.1.2'],
    ['a refresh token', { authorization: `Bearer ${device.refreshToken}` }, '100.64.1.2'],
    ['the right token from another region', good, '8.8.8.8'],
  ]) {
    assert.equal(await ownerToken(req(headers, peer)), '', why);
  }
});

test('the answer route refuses what is not a paired device and never reaches the brain for it', async () => {
  seen.length = 0;
  for (const r of [req({}, '127.0.0.1'), req({ authorization: 'Bearer admin-token-0123456789abcdef' }, '127.0.0.1'), req({ authorization: 'Bearer nope' })]) {
    assert.equal((await POST(r, ctx)).status, 403);
    assert.equal((await SEEN(r, ctx)).status, 403);
    assert.equal((await GRANT(r, { params: Promise.resolve({ kind: 'ship' }) })).status, 403);
  }
  assert.deepEqual(seen, [], 'nothing reached the brain');
  assert.deepEqual(await (await STATE(req({}, '127.0.0.1'))).json(), { paired: false });
});

test('a paired device\'s tap carries its own credential and the ask it saw to the brain', async () => {
  seen.length = 0;
  const good = { authorization: `Bearer ${device.accessToken}` };
  assert.deepEqual(await (await STATE(req(good))).json(), { paired: true });
  const res = await POST(req(good), ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ url: '/session/ses_abc/owner-answer', method: 'POST', device: device.accessToken, body: { ask: 'ask_1', answer: 'yes' } }]);
  // the question changed under the thumb: the brain's 409 comes back with the new question, never a silent yes
  const old = await POST(req(good, '100.64.1.2', { ask: 'ask_old', answer: 'yes' }), ctx);
  assert.equal(old.status, 409);
  assert.equal((await old.json()).ask.id, 'ask_new');
  assert.equal((await POST(req(good, '100.64.1.2', { answer: 'yes' }), ctx)).status, 400);
  assert.equal((await SEEN(req(good, '100.64.1.2', { ask: 'ask_1' }), ctx)).status, 200);
});

test('a voucher is minted only for a paired device', async () => {
  seen.length = 0;
  assert.equal(await mintVoucher(req({}, '127.0.0.1')), undefined);
  assert.deepEqual(seen, []);
  assert.equal(await mintVoucher(req({ authorization: `Bearer ${device.accessToken}` })), 'ov_test');
  assert.equal(seen[0].device, device.accessToken);
});
