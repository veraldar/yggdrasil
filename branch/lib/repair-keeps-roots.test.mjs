// A phone re-pair hands the old device's roots to the new one (lib/devices.ts claimPairCode,
// lib/roots.ts handOverRoots) instead of cutting them.
// Run: node --test lib/repair-keeps-roots.test.mjs
//
// 2026-11-23 11:41:17Z: the owner's phone re-paired, the old device was revoked, and with it the
// hub's WireGuard node dropped mac-studio — a joined root is pinned only while its approving
// device (roots.json `dev`) is live in devices.json (trunk/src/wg.rs Source::read), refill mints
// with that same dev claim, and the bridge refuses a link token whose dev is revoked.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/lib/')) {
      return next(new URL(`./${spec.slice(6)}.ts`, import.meta.url).href, ctx);
    }
    return next(spec, ctx);
  },
});

const home = mkdtempSync(path.join(tmpdir(), 'repair-keeps-roots-'));
const stateDir = path.join(home, 'state');
mkdirSync(stateDir, { recursive: true });
const stubBin = path.join(home, 'bifrost-net-stub');
writeFileSync(
  stubBin,
  `#!/usr/bin/env node
const crypto = require('crypto');
const body = Buffer.from(JSON.stringify({ v: 1, jti: crypto.randomBytes(8).toString('hex') })).toString('base64url');
process.stdout.write(body + '.' + crypto.randomBytes(16).toString('base64url') + '\\n');
`,
  { mode: 0o755 }
);
const secretFile = path.join(stateDir, 'rl-secret');
writeFileSync(secretFile, 'test-rootlink-secret\n', { mode: 0o600 });
const wgPubHub = path.join(stateDir, 'wg-hub.pub');
writeFileSync(wgPubHub, Buffer.alloc(32, 0xaa).toString('base64') + '\n', { mode: 0o600 });

const DEVICES = path.join(stateDir, 'devices.json');
const ROOTS = path.join(stateDir, 'roots.json');
process.env.BIFROST_DEVICES_FILE = DEVICES;
process.env.BIFROST_ROOTS_FILE = ROOTS;
process.env.BIFROST_NET_BIN = stubBin;
process.env.BIFROST_ROOTLINK_SECRET_FILE = secretFile;
process.env.BIFROST_WG_PUB_FILE = wgPubHub;
process.env.BIFROST_AUTH = 'devices';
process.env.YGG_ROOT_NAME = 'home';
process.env.OPENCODE_URL = 'http://127.0.0.1:1'; // unreachable: the brain is never asked

const devices = await import('./devices.ts');
const roots = await import('./roots.ts');

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const deviceById = (id) => readJson(DEVICES).devices.find((d) => d.id === id);
const rootById = (id) => readJson(ROOTS).roots.find((r) => r.id === id);

/** The hub's WireGuard law (trunk/src/wg.rs Source::read): pinned while not removed and its
 *  approving device is live. */
function wgPins(id) {
  const r = rootById(id);
  if (!r || r.revoked || !r.wg_pub || !r.wg_ip) return false;
  return deviceById(r.dev)?.revoked === false;
}

async function pair(name, prevRefresh) {
  const { code } = await devices.mintPairCode(name);
  // what POST /api/pair/claim does (app/api/pair/claim/route.ts)
  const r = await devices.claimPairCode(code, name, 'loopback', prevRefresh, roots.handOverRoots);
  assert.equal(r.ok, true, `pairing ${name}: ${JSON.stringify(r)}`);
  return r;
}

let n = 0;
/** join + approve + collect, the way join.sh and the approve page do it */
async function joinRoot(name, approver) {
  n += 1;
  const j = roots.createJoin(
    { name, os: 'linux', host: name, wgPub: Buffer.alloc(32, n).toString('base64') },
    `10.0.0.${n}`
  );
  assert.ok(j);
  const ok = await roots.approveJoin(j.req, approver);
  assert.equal(ok.http, 200, JSON.stringify(ok.body));
  const got = await roots.pollJoin(j.req, j.secret);
  assert.equal(got.http, 200);
  return { id: got.body.root_id, secret: got.body.root_secret };
}

test('a phone re-pair hands its approved roots to the new device: the hub keeps them pinned', async () => {
  const a = await pair('Android');
  const mac = await joinRoot('mac-studio', a.id);
  assert.equal(mac.id, 'mac-studio');
  assert.ok(wgPins('mac-studio'), 'pinned after the approval');
  assert.equal((await roots.refillTokens('mac-studio', mac.secret)).http, 200);

  // the phone scans a fresh QR while it still holds A's refresh cookie
  const b = await pair('Android', a.refreshToken);
  assert.notEqual(b.id, a.id);

  const oldDev = deviceById(a.id);
  assert.equal(oldDev.revoked, true, 'revoke-on-repair still retires the old device');
  assert.equal(oldDev.revokedWhy, 're-paired');
  assert.equal(deviceById(b.id).revoked, false);
  assert.deepEqual(
    deviceById(b.id).roots,
    ['mac-studio'],
    "the new device carries the old one's allowlist"
  );
  assert.equal(
    rootById('mac-studio').dev,
    b.id,
    "roots.json names the new device as mac-studio's approver"
  );
  assert.ok(wgPins('mac-studio'), 'the hub still pins mac-studio after the re-pair');

  const refill = await roots.refillTokens('mac-studio', mac.secret);
  assert.equal(refill.http, 200, `refill after the re-pair: ${JSON.stringify(refill.body)}`);

  // and again: a second re-pair passes them on once more (11-23 had two in a row)
  const c = await pair('Android', b.refreshToken);
  assert.equal(deviceById(b.id).revoked, true);
  assert.equal(rootById('mac-studio').dev, c.id);
  assert.deepEqual(deviceById(c.id).roots, ['mac-studio']);
  assert.ok(wgPins('mac-studio'), 'pinned after a second re-pair');
});

test("a re-pair moves only the retiring device's roots; another phone's roots stay with it", async () => {
  const phone = await pair('Android');
  const other = await pair('tablet');
  const lab = await joinRoot('lab', phone.id);
  const box = await joinRoot('box', other.id);
  const again = await pair('Android', phone.refreshToken);
  assert.equal(rootById(lab.id).dev, again.id);
  assert.equal(rootById(box.id).dev, other.id, "the tablet's root is not touched");
  assert.deepEqual(deviceById(other.id).roots, [box.id]);
  assert.deepEqual(deviceById(again.id).roots, [lab.id]);
  assert.ok(wgPins(lab.id) && wgPins(box.id));
});

test('a device already revoked (device list, theft signal) hands nothing over on a re-pair', async () => {
  const p = await pair('Android');
  const r = await joinRoot('old-box', p.id);
  assert.equal(await devices.revokeDevice(p.id), true);
  assert.equal(
    wgPins(r.id),
    false,
    'revoking the approver from the device list still cuts its root'
  );
  const q = await pair('Android', p.refreshToken);
  assert.equal(
    rootById(r.id).dev,
    p.id,
    'an owner-revoked approval is not resurrected by a re-pair'
  );
  assert.equal(deviceById(q.id).roots, undefined);
  assert.equal(wgPins(r.id), false);
  assert.equal(deviceById(p.id).revokedWhy, 'revoked from the device list');
});

test('a first pairing (no old cookie) hands nothing over', async () => {
  const p = await pair('fresh-phone');
  assert.equal(deviceById(p.id).roots, undefined);
});

test('no instant of the re-pair shows the hub a root whose approver is not live', async () => {
  // a second thread reads the files the way the hub's WireGuard node does every second
  // (roots.json, then devices.json) as fast as it can, while the phone re-pairs 25 times
  const p0 = await pair('Android');
  await joinRoot('watched', p0.id);
  const watcher = new Worker(
    `const { readFileSync } = require('node:fs');
     const { parentPort, workerData: { roots, devices } } = require('node:worker_threads');
     let stop = false, seen = 0, gaps = [];
     parentPort.on('message', () => { stop = true; });
     (function loop() {
       for (let i = 0; i < 200 && !stop; i++) {
         let r, d;
         try { r = JSON.parse(readFileSync(roots, 'utf8')); d = JSON.parse(readFileSync(devices, 'utf8')); }
         catch { continue; } // a torn read cannot happen (atomic rename), but never count one
         const rec = r.roots.find((x) => x.id === 'watched');
         const dev = d.devices.find((x) => x.id === rec.dev);
         seen++;
         if (!dev || dev.revoked) gaps.push(rec.dev);
       }
       if (stop) parentPort.postMessage({ seen, gaps }); else setImmediate(loop);
     })();`,
    { eval: true, workerData: { roots: ROOTS, devices: DEVICES } }
  );
  let p = p0;
  for (let i = 0; i < 25; i++) p = await pair('Android', p.refreshToken);
  const out = await new Promise((resolve) => {
    watcher.once('message', resolve);
    watcher.postMessage('stop');
  });
  await watcher.terminate();
  assert.ok(out.seen > 50, `the watcher read the files ${out.seen} times`);
  assert.deepEqual(
    out.gaps,
    [],
    `the hub would have dropped the root ${out.gaps.length}× of ${out.seen}`
  );
  assert.equal(rootById('watched').dev, p.id);
});
