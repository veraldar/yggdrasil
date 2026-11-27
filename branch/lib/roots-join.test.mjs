// Stable join approvals across renewals + sibling-process disk sync (lib/roots.ts).
// Run: node --test lib/roots-join.test.mjs
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/lib/')) {
      return next(new URL(`./${spec.slice(6)}.ts`, import.meta.url).href, ctx);
    }
    return next(spec, ctx);
  },
});

const home = mkdtempSync(path.join(tmpdir(), 'roots-join-test-'));
const stateDir = path.join(home, 'state');
mkdirSync(stateDir, { recursive: true });

// Stub bifrost-net `rootlink mint` so approveJoin works without a live trunk binary
const stubBin = path.join(home, 'bifrost-net-stub');
writeFileSync(
  stubBin,
  `#!/usr/bin/env node
const crypto = require('crypto');
const body = Buffer.from(JSON.stringify({ v: 1, jti: crypto.randomBytes(8).toString('hex') })).toString('base64url');
const sig = crypto.randomBytes(16).toString('base64url');
process.stdout.write(body + '.' + sig + '\\n');
`,
  { mode: 0o755 }
);
const secretFile = path.join(stateDir, 'rl-secret');
writeFileSync(secretFile, 'test-rootlink-secret\n', { mode: 0o600 });
const wgPubHub = path.join(stateDir, 'wg-hub.pub');
const HUB_WG = Buffer.alloc(32, 0xaa).toString('base64');
writeFileSync(wgPubHub, HUB_WG + '\n', { mode: 0o600 });

process.env.BIFROST_DEVICES_FILE = path.join(stateDir, 'devices.json');
process.env.BIFROST_ROOTS_FILE = path.join(stateDir, 'roots.json');
process.env.BIFROST_NET_BIN = stubBin;
process.env.BIFROST_ROOTLINK_SECRET_FILE = secretFile;
process.env.BIFROST_WG_PUB_FILE = wgPubHub;
process.env.BIFROST_JOIN_TTL_S = '1';
process.env.BIFROST_AUTH = 'devices';
process.env.YGG_ROOT_NAME = 'home';
process.env.OPENCODE_URL = 'http://127.0.0.1:1'; // unreachable -> falls back to YGG_ROOT_NAME

const devices = await import('./devices.ts');
const roots = await import('./roots.ts');

const RIG_WG = Buffer.alloc(32, 0x11).toString('base64');
const RIG2_WG = Buffer.alloc(32, 0x22).toString('base64');

const { code: pairCode } = await devices.mintPairCode('phone');
const paired = await devices.claimPairCode(pairCode, 'phone', 'loopback');
assert.equal(paired.ok, true);
const devId = paired.id;

test('renewal after expiry keeps the same req id and code, and the pre-renewal link still approves', async () => {
  const first = roots.createJoin(
    {
      name: 'omarchy-lab',
      os: 'linux',
      host: 'omarchy',
      wgPub: RIG_WG,
      approveBase: 'https://ap.veraldar.org',
    },
    '10.0.0.5'
  );
  assert.ok(first);
  const originalReq = first.req;
  const originalCode = first.code;

  // Wait for the 1s TTL to expire
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(roots.viewJoin(originalReq)?.status, 'expired');
  const expiredPoll = await roots.pollJoin(originalReq, first.secret);
  assert.equal(expiredPoll.http, 410);
  assert.equal(roots.listPendingJoins().length, 0);

  // Rig renews with the same WireGuard public key
  const renewed = roots.createJoin(
    {
      name: 'omarchy-lab',
      os: 'linux',
      host: 'omarchy',
      wgPub: RIG_WG,
      approveBase: 'https://ap.veraldar.org',
    },
    '10.0.0.5'
  );
  assert.ok(renewed);
  assert.equal(renewed.req, originalReq, 'req id must stay identical across renewal');
  assert.equal(renewed.code, originalCode, 'comparison code must stay identical across renewal');
  assert.notEqual(renewed.secret, first.secret, 'new joiner gets a fresh poll secret');

  // Old joiner secret is invalidated; new joiner polls 202 pending
  assert.equal((await roots.pollJoin(originalReq, first.secret)).http, 401);
  assert.equal((await roots.pollJoin(originalReq, renewed.secret)).http, 202);

  // The link minted BEFORE renewal still renders pending and approves AFTER renewal
  const view = roots.viewJoin(originalReq);
  assert.equal(view?.status, 'pending');
  assert.equal(view?.approve_url, `https://ap.veraldar.org/join?r=${originalReq}`);
  assert.equal(roots.listPendingJoins().length, 1);
  assert.equal(roots.listPendingJoins()[0].req, originalReq);

  const approved = await roots.approveJoin(originalReq, devId);
  assert.equal(approved.http, 200);
  assert.equal(approved.body.root_id, 'omarchy-lab');

  // New joiner collects credentials once; roots.json pins wg_pub
  const collected = await roots.pollJoin(originalReq, renewed.secret);
  assert.equal(collected.http, 200);
  assert.equal(collected.body.status, 'approved');
  assert.equal(collected.body.root_id, 'omarchy-lab');
  assert.equal((await roots.pollJoin(originalReq, renewed.secret)).http, 410);

  const savedRoots = JSON.parse(readFileSync(roots.ROOTS_FILE, 'utf8'));
  const pinned = savedRoots.roots.find((r) => r.id === 'omarchy-lab');
  assert.equal(pinned?.wg_pub, RIG_WG);
  assert.ok(pinned?.wg_ip);
});

test('renewal while still live keeps req id; refused request is never reopened', async () => {
  const a = roots.createJoin(
    { name: 'debian-box', os: 'linux', host: 'debian-box', wgPub: RIG2_WG },
    '10.0.0.6'
  );
  assert.ok(a);
  const b = roots.createJoin(
    { name: 'debian-box', os: 'linux', host: 'debian-box', wgPub: RIG2_WG },
    '10.0.0.7'
  );
  assert.ok(b);
  assert.equal(b.req, a.req, 'live renewal keeps the same req id');
  assert.equal(b.code, a.code);

  // Refuse it
  const ref = await roots.refuseJoin(a.req, devId);
  assert.equal(ref.http, 200);
  assert.equal(roots.viewJoin(a.req)?.status, 'refused');

  // Next join after refusal gets a brand-new req id (refused is terminal)
  const c = roots.createJoin(
    { name: 'debian-box', os: 'linux', host: 'debian-box', wgPub: RIG2_WG },
    '10.0.0.7'
  );
  assert.ok(c);
  assert.notEqual(c.req, a.req);
});

test('joins-pending.json written by a sibling process (hub-app -> hub-app-tailnet) is picked up live', async () => {
  // Wait for any queued saveJoins write to flush
  await new Promise((r) => setTimeout(r, 100));
  const disk = JSON.parse(readFileSync(roots.JOINS_FILE, 'utf8'));
  const siblingReq = 'SiblingProcReq12345678';
  const now = Date.now();
  disk.joins.push({
    req: siblingReq,
    secretHash: 'a'.repeat(64),
    code: 'ABCD-2345',
    name: 'mac-mini',
    os: 'macos',
    host: 'mac-mini.local',
    peer: '10.0.0.9',
    approveUrl: `https://ap.veraldar.org/join?r=${siblingReq}`,
    created: now,
    exp: now + 600_000,
    status: 'pending',
  });
  writeFileSync(roots.JOINS_FILE, JSON.stringify(disk, null, 2) + '\n', { mode: 0o600 });
  chmodSync(roots.JOINS_FILE, 0o600);
  // Advance mtime explicitly so filesystem granularity never hides the write
  const future = new Date(Date.now() + 5000);
  utimesSync(roots.JOINS_FILE, future, future);

  const list = roots.listPendingJoins();
  const hit = list.find((j) => j.req === siblingReq);
  assert.ok(hit, 'sibling process join must appear in listPendingJoins()');
  assert.equal(hit.name, 'mac-mini');
  assert.equal(hit.approve_url, `https://ap.veraldar.org/join?r=${siblingReq}`);
});
