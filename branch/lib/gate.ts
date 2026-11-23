/** The device gate (S1 seam), shared: the middleware runs it in front of /api/*, and a route the
 *  middleware must not touch (an upload piece: Next copies a body the middleware sees, and a copy of
 *  a body still streaming in over the trunk's channel broke the route — package 2) runs it itself.
 *  `NextResponse.next()` = pass. */
import { type NextRequest, NextResponse } from 'next/server';
import { adminOk } from '@/lib/admin';
import { type Deny, checkAccess } from '@/lib/devices';
import { event as obsEvent } from '@/lib/obs';
import { rateTake } from '@/lib/ratelimit';
import { peerOf, regionOfReq } from '@/lib/region';

const REAUTH: Record<Deny, 'refresh' | 'pair'> = {
  expired: 'refresh',
  region: 'refresh',
  missing: 'pair',
  invalid: 'pair',
  revoked: 'pair',
  used: 'pair',
  reuse: 'pair',
};

const PAIR_BURST = Number(process.env.BIFROST_PAIR_BURST) || 60;

// a joining machine holds no device token: these carry their own credential
// (or, for the join itself, none — rate-limited per address in the route)
const JOIN_OPEN: Array<[string, RegExp]> = [
  ['POST', /^\/api\/roots\/join$/],
  ['GET', /^\/api\/roots\/join\/[A-Za-z0-9_-]{8,64}$/],
  ['POST', /^\/api\/roots\/[a-z0-9][a-z0-9-]{0,40}\/tokens$/],
];

const tooMany = (retryAfter: number) =>
  NextResponse.json(
    { error: 'rate limited' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  );

export async function deviceGate(req: NextRequest): Promise<NextResponse> {
  if (process.env.BIFROST_AUTH !== 'devices') {
    return NextResponse.next();
  }

  const path = req.nextUrl.pathname;
  if (path.startsWith('/api/pair')) {
    const rl = rateTake(`peer:${peerOf(req) || 'unknown'}`, PAIR_BURST, 1);
    return rl.ok ? NextResponse.next() : tooMany(rl.retryAfter);
  }

  if (JOIN_OPEN.some(([m, re]) => req.method === m && re.test(path))) {
    const rl = rateTake(`join-peer:${peerOf(req) || 'unknown'}`, PAIR_BURST, 1);
    return rl.ok ? NextResponse.next() : tooMany(rl.retryAfter);
  }

  // the box's own console (loopback behind server.mjs) or the admin token
  // presents no device credential and needs none — the /api/pair rule. It
  // grants nothing new: opencode itself is unauthenticated on loopback.
  if (!req.cookies.get('bifrost_device')?.value && adminOk(req)) {
    return NextResponse.next();
  }

  const raw =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    req.cookies.get('bifrost_device')?.value ||
    '';
  const region = regionOfReq(req);
  const gate = await checkAccess(raw, region);
  if (!gate.ok) {
    // the meter: a refusal and the hint it sends back (a bare missing token is a stranger:
    // not an event)
    if (gate.why !== 'missing') {
      obsEvent('deny', { src: 'app', why: gate.why, hint: REAUTH[gate.why], device: gate.device, region, path: routeClass(path) });
    }
    return NextResponse.json(
      { error: 'device token required', why: gate.why, reauth: REAUTH[gate.why] },
      { status: 401 }
    );
  }
  const rl = rateTake(`dev:${gate.device.id}`);
  return rl.ok ? NextResponse.next() : tooMany(rl.retryAfter);
}

/** A path's class for the meter: a fixed name, never ids or a query (trunk meter.rs route_class). */
export function routeClass(p: string): string {
  const seg = p.split(/[?#]/)[0].split('/').filter(Boolean);
  if (seg[0] !== 'api') return 'page';
  if (seg[1] === 'session') return seg.length === 2 ? 'api.session' : seg[3] === 'messages' ? 'api.session.messages' : 'api.session.one';
  return seg[1] ? `api.${seg[1].replace(/[^a-z0-9-]/gi, '').slice(0, 24)}` : 'api';
}

/** true when the gate lets the request through */
export function passed(r: NextResponse): boolean {
  return r.headers.get('x-middleware-next') === '1';
}
