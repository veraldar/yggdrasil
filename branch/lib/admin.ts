/**
 * Who may administer pairing (single source so the pair routes cannot drift).
 *
 *   admin  — Bearer BIFROST_ADMIN_TOKEN, or — presenting NOTHING — network
 *            trust: the declared tailnet (legacy, no admin token configured)
 *            or the box's own console = a loopback peer, which is provable
 *            only behind server.mjs (lib/region.ts).
 *   device — a live access token (Bearer or the bifrost_device cookie).
 *
 * A presented credential must be valid on its own: network trust never
 * upgrades a garbage or stale token (e2e: auth.spec).
 */
import { timingSafeEqual } from 'crypto';
import { type Device, checkAccess } from '@/lib/devices';
import { regionOfReq } from '@/lib/region';
import { type Why as TrunkWhy, checkTrunkAccess } from '@/lib/trunk-auth';

const trunkMode = () => process.env.BIFROST_AUTH === 'trunk';

/**
 * The signed-in device a request speaks for, in either device mode: devices (v0.9 registry) or trunk
 * (a v1 access token, lib/trunk-auth.ts). `kep` = the token's kill epoch (trunk mode only), for
 * watchers that re-check the device later (lib/voice-revoke.ts). Never the admin token or the console
 * (neither is a device token: both are refused here).
 */
export async function signedInDevice(
  req: Request
): Promise<{ ok: true; id: string; kep?: number } | { ok: false; why: string }> {
  const raw = bearerOf(req) || cookieOf(req, 'bifrost_device');
  if (trunkMode()) {
    const v = checkTrunkAccess(raw, regionOfReq(req));
    return v.ok ? { ok: true, id: v.claims.did, kep: v.claims.kep } : { ok: false, why: v.why };
  }
  const gate = await checkAccess(raw, regionOfReq(req));
  return gate.ok ? { ok: true, id: gate.device.id } : { ok: false, why: gate.why };
}

export const bearerOf = (req: Request) =>
  req.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim() || '';

export function cookieOf(req: Request, name: string): string {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function adminOk(req: Request): boolean {
  const expected = process.env.BIFROST_ADMIN_TOKEN || '';
  const presented = bearerOf(req);
  if (presented) return !!expected && same(presented, expected);
  if (!expected && process.env.BIFROST_AUTH === 'tailnet') return true;
  return process.env.BIFROST_PAIR_LOCAL !== '0' && regionOfReq(req) === 'loopback';
}

export async function adminOrDevice(req: Request): Promise<'admin' | 'device' | null> {
  const presented = bearerOf(req);
  const expected = process.env.BIFROST_ADMIN_TOKEN || '';
  if (presented && expected && same(presented, expected)) return 'admin';
  const raw = presented || cookieOf(req, 'bifrost_device');
  if (raw && trunkMode()) return checkTrunkAccess(raw, regionOfReq(req)).ok ? 'device' : null;
  if (raw) return (await checkAccess(raw, regionOfReq(req))).ok ? 'device' : null;
  return adminOk(req) ? 'admin' : null;
}

/**
 * A live DEVICE only — never the admin token, the console or the tailnet. For
 * actions that must name the device that took them (a join approval: its id
 * becomes the dev claim of the root's link tokens).
 */
export async function deviceOf(req: Request): Promise<Device | null> {
  const expected = process.env.BIFROST_ADMIN_TOKEN || '';
  const presented = bearerOf(req);
  const raw = presented && !(expected && same(presented, expected)) ? presented : '';
  const token = raw || cookieOf(req, 'bifrost_device');
  if (!token) return null;
  const gate = await checkAccess(token, regionOfReq(req));
  return gate.ok ? gate.device : null;
}

/**
 * The roots sheet's gate (GET /api/roots and /api/roots/<root>/{sessions,adopt,remove}).
 * Devices mode: a live DEVICE (deviceOf). The box console and the admin token — which the
 * middleware lets through with no device — get a plain 403 there, never a `reauth` 401 (the
 * console has no device to pair: a 401 would send its home page to /pair). Tailnet mode: the
 * tailnet is the gate, as for every session route (middleware.ts) — the :8447 front door.
 */
export async function rootsGate(req: Request): Promise<'ok' | 401 | 403> {
  if (trunkMode()) {
    const t = await trunkRootsGate(req);
    return t === null ? 'ok' : t === 403 ? 403 : 401;
  }
  if (process.env.BIFROST_AUTH !== 'devices') return 'ok';
  if (await deviceOf(req)) return 'ok';
  const expected = process.env.BIFROST_ADMIN_TOKEN || '';
  const presented = bearerOf(req);
  if (presented && expected && same(presented, expected)) return 403;
  if (!presented && !cookieOf(req, 'bifrost_device') && adminOk(req)) return 403;
  return 401;
}

/** rootsGate in trunk mode: null = a signed-in device; 403 the console / admin token; else the 401 why. */
export async function trunkRootsGate(req: Request): Promise<null | 403 | TrunkWhy> {
  const expected = process.env.BIFROST_ADMIN_TOKEN || '';
  const presented = bearerOf(req);
  if (presented && expected && same(presented, expected)) return 403;
  if (!presented && !cookieOf(req, 'bifrost_device') && adminOk(req)) return 403;
  const v = checkTrunkAccess(presented || cookieOf(req, 'bifrost_device'), regionOfReq(req));
  return v.ok ? null : v.why;
}
