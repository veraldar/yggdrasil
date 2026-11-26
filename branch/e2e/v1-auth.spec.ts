import { readFileSync } from 'fs';
import { join } from 'path';
import { expect, test } from '@playwright/test';

/**
 * G2.1 · v1 auth seam (port of e2e/auth.spec.ts):
 * PASETO v4.public token gate, C3 401 {why, reauth}, region binding + refresh rebind,
 * refresh rotation + theft detection, logout revocation, and moved v0.9 routes → 404.
 * Driven by scripts/v1-ladder.sh inside a private netns.
 */
const STATE = process.env.PW_V1_STATE || '';
const BASE = process.env.PW_BASE_URL || '';
const LOCAL = process.env.PW_LOCAL_TRUNK || '';

test.skip(!STATE || !BASE || !LOCAL, 'needs scripts/v1-ladder.sh');

type Admin = {
  email: string;
  password: string;
  totp_secret: string;
  recovery_codes: string[];
  cookies: { bifrost_device: string; bifrost_refresh: string };
};

const admin = (): Admin => JSON.parse(readFileSync(join(STATE, 'admin.json'), 'utf8'));

function parseCookies(headers: Record<string, string> | Array<{ name: string; value: string }>) {
  const out: Record<string, string> = {};
  const list = Array.isArray(headers)
    ? headers.filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value)
    : (headers['set-cookie'] || '').split('\n');
  for (const raw of list) {
    const first = raw.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) out[first.slice(0, i).trim()] = decodeURIComponent(first.slice(i + 1));
  }
  return out;
}

test('unauthenticated callers get 302 /login on pages and C3 401 login on /api', async ({ request }) => {
  for (const p of ['/', '/settings', '/agents']) {
    const r = await request.get(p, { maxRedirects: 0, headers: { accept: 'text/html' } });
    expect(r.status(), p).toBe(302);
    expect(r.headers().location, p).toMatch(/^\/login/);
  }
  const api = await request.get('/api/session');
  expect(api.status()).toBe(401);
  expect(await api.json()).toEqual({ why: 'missing', reauth: 'login' });

  const bad = await request.get('/api/session', {
    headers: { cookie: 'bifrost_device=v4.public.not-a-real-token' },
  });
  expect(bad.status()).toBe(401);
  expect(await bad.json()).toEqual({ why: 'invalid', reauth: 'login' });
});

test('sign-in with recovery code → valid PASETO → region roam → refresh rebinds → logout revokes', async ({
  playwright,
}) => {
  const a = admin();
  const lan = await playwright.request.newContext({ baseURL: BASE });
  const loc = await playwright.request.newContext({ baseURL: LOCAL });

  // sign in from LAN (192.168.77.2 -> lan:192.168.77.0/24)
  const r1 = await lan.post('/t/auth/login', {
    headers: { origin: BASE },
    data: { email: a.email, password: a.password },
  });
  expect(r1.status()).toBe(200);
  const { mfa_ticket } = await r1.json();

  const r2 = await lan.post('/t/auth/mfa', {
    headers: { origin: BASE },
    data: { mfa_ticket, recovery: a.recovery_codes[0] },
  });
  expect(r2.status()).toBe(200);
  const c1 = parseCookies(r2.headersArray());
  expect(c1.bifrost_device).toMatch(/^v4\.public\./);
  expect(c1.bifrost_refresh).toMatch(/^bfnr-/);

  // works from LAN
  const okLan = await lan.get('/api/build', { headers: { cookie: `bifrost_device=${c1.bifrost_device}` } });
  expect(okLan.status()).toBe(200);
  expect((await okLan.json()).auth).toBe('trunk');

  // same token from loopback (different region) -> 401 region + reauth: refresh
  const moved = await loc.get('/api/build', { headers: { cookie: `bifrost_device=${c1.bifrost_device}` } });
  expect(moved.status()).toBe(401);
  expect(await moved.json()).toEqual({ why: 'region', reauth: 'refresh' });

  // refresh from loopback rebinds to loopback
  const ref = await loc.post('/t/auth/refresh', {
    headers: { origin: BASE, cookie: `bifrost_refresh=${c1.bifrost_refresh}` },
  });
  expect(ref.status()).toBe(200);
  const c2 = parseCookies(ref.headersArray());
  expect(c2.bifrost_device).toMatch(/^v4\.public\./);
  const okLoc = await loc.get('/api/build', { headers: { cookie: `bifrost_device=${c2.bifrost_device}` } });
  expect(okLoc.status()).toBe(200);

  // logout revokes the device immediately
  const lo = await loc.post('/t/auth/logout', {
    headers: { origin: BASE, cookie: `bifrost_device=${c2.bifrost_device}` },
  });
  expect(lo.status()).toBe(200);
  const dead = await loc.get('/api/build', { headers: { cookie: `bifrost_device=${c2.bifrost_device}` } });
  expect(dead.status()).toBe(401);
  expect(await dead.json()).toMatchObject({ why: 'revoked', reauth: 'login' });

  await lan.dispose();
  await loc.dispose();
});

test('moved v0.9 routes answer 404 in trunk mode', async ({ request }) => {
  const a = admin();
  const h = { cookie: `bifrost_device=${a.cookies.bifrost_device}`, origin: BASE };
  for (const p of ['/pair', '/devices', '/join']) {
    const r = await request.get(p, { headers: h, maxRedirects: 0 });
    expect(r.status(), p).toBe(404);
  }
  for (const p of ['/api/pair/claim', '/api/pair/code', '/api/roots/join']) {
    const r = await request.post(p, { headers: h, data: {} });
    expect(r.status(), p).toBe(404);
  }
});
