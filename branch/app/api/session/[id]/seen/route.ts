/**
 * POST /api/session/[id]/seen {ask} — the question is on the owner's screen (a paired device): the brain
 * notes it, and a reply the owner writes afterwards counts as written having seen it. 403 without a device.
 */
import { NextResponse } from 'next/server';
import { OC, PIN_HEADER, resolveId, sessionGone } from '@/lib/oc';
import { DEVICE_HEADER, ownerToken } from '@/lib/owner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const token = await ownerToken(req);
  if (!token) return NextResponse.json({ error: 'paired device required' }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.ask !== 'string') {
    return NextResponse.json({ error: 'ask required' }, { status: 400 });
  }
  try {
    const sid = await resolveId((await ctx.params).id, req.headers.get(PIN_HEADER));
    const r = await fetch(`${OC}/session/${encodeURIComponent(sid)}/owner-seen`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', [DEVICE_HEADER]: token },
      body: JSON.stringify({ ask: body.ask }),
    });
    const d = await r.json().catch(() => null);
    return NextResponse.json(d ?? {}, { status: r.ok ? 200 : r.status < 500 ? r.status : 502 });
  } catch (e) {
    return sessionGone(e) ?? NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
