// TRUNK-OBS — the app's token-lifecycle events (lib/obs.ts + the taps in lib/devices.ts).
// Run: node --test lib/obs.test.mjs   (node ≥ 23.6 strips the .ts types itself)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// devices.ts imports '@/lib/obs' (the app's alias): map it to this folder's .ts files
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/lib/')) return next(new URL(`./${spec.slice(6)}.ts`, import.meta.url).href, ctx);
    return next(spec, ctx);
  },
});

const home = mkdtempSync(path.join(tmpdir(), 'obs-test-'));
process.env.BIFROST_DEVICES_FILE = path.join(home, 'state', 'devices.json');
process.env.BIFROST_ROTATE_GRACE_S = '1';
process.env.BIFROST_AUTH = 'devices';
delete process.env.BIFROST_OBS_DIR;
delete process.env.BIFROST_OBS;
const { mkdirSync } = await import('node:fs');
mkdirSync(path.join(home, 'state'), { recursive: true });

const obs = await import('./obs.ts');
const devices = await import('./devices.ts');

const lines = () => {
  const dir = path.join(home, 'obs');
  return readdirSync(dir)
    .filter((f) => f.startsWith('app-events-'))
    .flatMap((f) => readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
    .map((l) => JSON.parse(l));
};

test('the folder is beside the devices file, like the bridge’s', () => {
  assert.equal(path.resolve(obs.obsDir()), path.join(home, 'obs'));
});

test('pairing, refresh (how early), a harmless race, theft, revoke, kill — as events, no secrets', async () => {
  const { code } = await devices.mintPairCode('phone');
  const bad = await devices.claimPairCode('bfnp-nonsense-nonsense', 'phone', 'net:1.2.0.0/16');
  assert.equal(bad.ok, false);
  const first = await devices.claimPairCode(code, 'phone', 'net:1.2.0.0/16');
  assert.equal(first.ok, true);
  // a roam: the same phone refreshes from another network
  const r1 = await devices.refreshDevice(first.refreshToken, 'net:5.6.0.0/16');
  assert.equal(r1.ok, true);
  assert.equal(r1.regionChanged, true);
  // a second tab with the old refresh token within the grace: a race, not theft
  const race = await devices.refreshDevice(first.refreshToken, 'net:5.6.0.0/16');
  assert.equal(race.ok, true);
  // past the grace: theft → the device is revoked
  await new Promise((r) => setTimeout(r, 1200));
  const theft = await devices.refreshDevice(first.refreshToken, 'net:5.6.0.0/16');
  assert.deepEqual(theft, { ok: false, why: 'reuse' });
  // a refusal at the gate carries the device (an expired/revoked/region token is known)
  const denied = await devices.checkAccess(r1.accessToken, 'net:5.6.0.0/16');
  assert.equal(denied.ok, false);
  assert.equal(denied.device, first.id);
  // a re-pair from the same phone: the claim names the device it replaced
  const { code: code2 } = await devices.mintPairCode('phone');
  const again = await devices.claimPairCode(code2, 'phone', 'net:5.6.0.0/16', race.refreshToken);
  assert.equal(again.ok, true);
  await devices.killSwitch();
  await obs.flush();

  const ev = lines();
  const kinds = ev.map((e) => e.kind);
  for (const k of ['pair.code', 'pair.claim', 'refresh', 'reuse', 'revoke', 'kill']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
  const claims = ev.filter((e) => e.kind === 'pair.claim');
  assert.deepEqual(claims.map((c) => c.ok), [false, true, true]);
  assert.equal(claims[0].why, 'invalid');
  // the re-pair names the phone's previous device (even one the theft signal revoked): the
  // report links this QR reconnect to what forced it
  assert.equal(claims[2].from, first.id);
  const ok = ev.find((e) => e.kind === 'refresh' && e.ok);
  assert.equal(ok.device, first.id);
  assert.equal(ok.region_changed, true);
  assert.ok(ok.lead_s > 800 && ok.lead_s <= 900, `lead_s ${ok.lead_s} (a fresh 15-min token)`);
  const reuses = ev.filter((e) => e.kind === 'reuse');
  assert.deepEqual(reuses.map((r) => r.theft), [false, true]);
  assert.ok(ev.some((e) => e.kind === 'revoke' && e.why === 'refresh token replayed (theft signal)'));
  assert.ok(ev.some((e) => e.kind === 'kill' && e.epoch === 1));
  assert.ok(ev.every((e) => e.door === 'public' && typeof e.ts === 'number'));
  // nothing secret: no token, code or hash text anywhere in the lines
  const text = JSON.stringify(ev);
  for (const secret of [code, code2, first.accessToken, first.refreshToken, r1.refreshToken]) {
    assert.ok(!text.includes(secret), 'a credential leaked into the events');
  }
  assert.ok(!/[0-9a-f]{64}/.test(text), 'a hash leaked into the events');
});

test('BIFROST_OBS=off writes nothing; a full queue drops instead of growing', async () => {
  process.env.BIFROST_OBS = 'off';
  obs.event('x', {});
  assert.equal(await obs.flush(), 0);
  delete process.env.BIFROST_OBS;
  for (let i = 0; i < 2100; i++) obs.event('flood', { i });
  assert.equal(await obs.flush(), 2000);
  obs.event('after', {});
  await obs.flush();
  const after = lines().find((e) => e.kind === 'after');
  assert.equal(after.obs_dropped, 100, 'the drops are reported on the next line');
});

test('regionKind keeps only the kind', () => {
  assert.equal(obs.regionKind('net:5.6.0.0/16'), 'net');
  assert.equal(obs.regionKind('lan:192.168.1.0/24'), 'lan');
});
