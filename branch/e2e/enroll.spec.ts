import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { expect, test } from '@playwright/test';

/**
 * G2.1 · enroll (v1 port of e2e/join.spec.ts):
 * POST /t/roots/enroll (desktop + headless), pending card, admin approve, poll delivers once
 * then 410, duplicate key → 409, refuse → 410, root revoke DELETE /t/roots/:id, no v0.9 files.
 */
const STATE = process.env.PW_V1_STATE || '';
const BASE = process.env.PW_BASE_URL || '';
const BIN = process.env.PW_TRUNK_BIN || '';

test.skip(!STATE || !BASE || !BIN, 'needs scripts/v1-ladder.sh');

const admin = () => JSON.parse(readFileSync(join(STATE, 'admin.json'), 'utf8'));

function genKeys(prefix: string) {
  const rk = execFileSync(BIN, ['root-key', join(STATE, `${prefix}.root.key`)], { encoding: 'utf8' });
  const wk = execFileSync(BIN, ['wg-key', join(STATE, `${prefix}.wg.key`)], { encoding: 'utf8' });
  const pub = (s: string) => s.match(/public_key = "([^"]+)"/)![1];
  return { root_pub: pub(rk), wg_pub: pub(wk) };
}

test('enroll lifecycle: enroll → pending → approve → poll once (410 second) → duplicate 409 → revoke', async ({
  request,
}) => {
  const a = admin();
  const hdr = { cookie: `bifrost_device=${a.cookies.bifrost_device}`, origin: BASE };
  const keys = genKeys('enroll-mac');

  // 1. start enrollment
  const e1 = await request.post('/t/roots/enroll', {
    data: { hostname: 'mac-box', os: 'macos', arch: 'arm64', ...keys, has_app: false, has_voice: false },
  });
  expect(e1.status()).toBe(200);
  const start = await e1.json();
  expect(start.id).toBeTruthy();
  expect(start.code).toMatch(/^[A-Z0-9-]{4,}$/);
  expect(start.approve_url).toContain(`/auth/root?e=${start.id}`);

  // 2. pending list shows it, poll says pending
  const pend = await request.get('/t/roots/pending', { headers: hdr });
  expect(pend.status()).toBe(200);
  const plist = (await pend.json()) as Array<{ id: string }>;
  expect(plist.some((x) => x.id === start.id)).toBe(true);

  const p0 = await request.post(`/t/roots/enroll/${start.id}/poll`, { data: { secret: start.poll_secret } });
  expect(p0.status()).toBe(200);
  expect((await p0.json()).status).toBe('pending');

  // 3. approve by-code lookup works (headless flow)
  const byCode = await request.post('/t/roots/enroll/by-code', { headers: hdr, data: { code: start.code } });
  expect(byCode.status()).toBe(200);
  expect((await byCode.json()).id).toBe(start.id);

  // 4. approve requires Origin
  const noOrig = await request.post(`/t/roots/enroll/${start.id}/approve`, {
    headers: { cookie: hdr.cookie },
    data: { name: 'mac-box' },
  });
  expect(noOrig.status()).toBe(403);

  const appr = await request.post(`/t/roots/enroll/${start.id}/approve`, {
    headers: hdr,
    data: { name: 'mac-box' },
  });
  expect(appr.status()).toBe(200);

  // 5. poll delivers once, then 410 delivered
  const p1 = await request.post(`/t/roots/enroll/${start.id}/poll`, { data: { secret: start.poll_secret } });
  expect(p1.status()).toBe(200);
  const got = await p1.json();
  expect(got.status).toBe('approved');
  expect(got.root_id).toMatch(/^rt_/);
  expect(got.peer_token).toMatch(/^ygp-/);

  const p2 = await request.post(`/t/roots/enroll/${start.id}/poll`, { data: { secret: start.poll_secret } });
  expect(p2.status()).toBe(410);

  // 6. re-enrolling with the same key → 409
  const dup = await request.post('/t/roots/enroll', {
    data: { hostname: 'mac-box', os: 'macos', arch: 'arm64', ...keys, has_app: false, has_voice: false },
  });
  expect(dup.status()).toBe(409);

  // 7. revoke removes it from /t/me/roots
  const del = await request.delete(`/t/roots/${got.root_id}`, { headers: hdr });
  expect(del.status()).toBe(200);
  const meRoots = (await (await request.get('/t/me/roots', { headers: hdr })).json()) as Array<{ id: string }>;
  expect(meRoots.some((r) => r.id === got.root_id)).toBe(false);

  // 8. refuse flow
  const keys2 = genKeys('enroll-ref');
  const e2 = await request.post('/t/roots/enroll', {
    data: { hostname: 'ref-box', os: 'linux', arch: 'x86_64', ...keys2, has_app: false, has_voice: false },
  });
  expect(e2.status()).toBe(200);
  const s2 = await e2.json();
  const ref = await request.post(`/t/roots/enroll/${s2.id}/refuse`, { headers: hdr, data: {} });
  expect(ref.status()).toBe(200);
  const pRef = await request.post(`/t/roots/enroll/${s2.id}/poll`, { data: { secret: s2.poll_secret } });
  expect((await pRef.json()).status).toBe('refused');

  // 9. v1 never writes v0.9 files
  expect(existsSync(join(STATE, 'home', 'devices.json'))).toBe(false);
  expect(existsSync(join(STATE, 'home', 'roots.json'))).toBe(false);
});
