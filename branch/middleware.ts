/**
 * S1 seam (v0.9 no-tailscale): the ONE middleware in front of /api/*.
 *
 * Modes (BIFROST_AUTH):
 *   tailnet (default today) → behave exactly as before: no device tokens
 *     required; the tailnet is the gate. Zero behavior change for existing
 *     deployments.
 *   devices → every /api/* request requires a live, unexpired access token
 *     issued in the request's network region (Authorization: Bearer … or the
 *     bifrost_device cookie), rate-limited per device — except the box's own
 *     console (loopback behind server.mjs) and the admin token. /api/pair/* mints and
 *     rotates credentials and authenticates inside each route (fail-closed);
 *     here it only gets the per-peer brute-force guard. So do the three join
 *     endpoints a NEW machine calls (docs/spec-join.md) — join, poll with its
 *     join secret, refill with its root secret: exact method + path shapes
 *     only, everything else under /api/roots needs a device.
 *
 * 401 bodies say what the client must do next (`reauth`): `refresh` (expired
 * or region changed — present the refresh credential) or `pair` (scan again).
 * Revocation and the kill-switch land on the next call: devices.ts re-reads
 * the registry per request (no cache).
 */
import type { NextRequest } from 'next/server';
import { deviceGate } from '@/lib/gate';

export const config = {
  // every /api route but an upload piece (it runs the same gate itself: lib/gate.ts)
  matcher: '/api/((?!file/upload/[^/]+$).*)',
  // devices.ts uses node:crypto + fs — the registry check needs the node runtime
  runtime: 'nodejs',
};

export async function middleware(req: NextRequest) {
  return deviceGate(req);
}
