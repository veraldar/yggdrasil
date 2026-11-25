/** /api/provider → the brain's GET /provider and PUT /provider.
 *  GET degrades gracefully on 404 (older brain without /provider yet): returns 200 with
 *  { available: false, providers: [], health: {} } so the UI renders its empty state cleanly
 *  with zero browser 404 console errors. PUT relays writes and surfaces any brain refusal. */
import { NextResponse } from 'next/server';
import { OC } from '@/lib/oc';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const r = await fetch(`${OC}/provider`, { cache: 'no-store' });
    if (r.status === 404 || r.status === 405 || r.status === 501) {
      return NextResponse.json(
        { available: false, providers: [], health: {} },
        { status: 200, headers: { ...NO_STORE, 'X-Brain-Status': String(r.status) } }
      );
    }
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const why = d?.error || `brain ${r.status} on /provider`;
      return NextResponse.json(
        { available: false, providers: [], health: {}, error: String(why) },
        { status: 200, headers: { ...NO_STORE, 'X-Brain-Status': String(r.status) } }
      );
    }
    const out = d && typeof d === 'object' && !Array.isArray(d) ? { available: true, ...d } : { available: true, providers: Array.isArray(d) ? d : [] };
    return NextResponse.json(out, { headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { available: false, providers: [], health: {} },
      { status: 200, headers: { ...NO_STORE, 'X-Brain-Status': 'unreachable' } }
    );
  }
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'nothing to save' }, { status: 400 });
  }
  const name = typeof (body as { name?: unknown }).name === 'string' ? (body as { name: string }).name.trim() : '';
  if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    return NextResponse.json(
      { error: 'provider name: letters, digits, . - _ (64 max)' },
      { status: 400 }
    );
  }
  try {
    const r = await fetch(`${OC}/provider`, {
      method: 'PUT',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const why = d?.error || (r.status === 404 ? 'this brain does not support /provider yet' : `brain ${r.status} on /provider`);
      return NextResponse.json({ error: String(why) }, { status: r.status < 500 ? r.status : 502 });
    }
    return NextResponse.json(d ?? { ok: true }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
