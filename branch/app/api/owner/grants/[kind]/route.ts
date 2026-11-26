/** PUT /api/owner/grants/[kind] {on} — the owner's switch for a standing permission. A paired device only:
 *  its credential rides to the brain, which fixes the text of each kind in code. */
import { NextResponse } from 'next/server';
import { OC } from '@/lib/oc';
import { DEVICE_HEADER, ownerToken } from '@/lib/owner';

export const dynamic = 'force-dynamic';

export async function PUT(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const token = await ownerToken(req);
  if (!token) {
    return NextResponse.json({ error: 'switching this needs a paired device' }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.on !== 'boolean') {
    return NextResponse.json({ error: 'on: true or false' }, { status: 400 });
  }
  const { kind } = await ctx.params;
  try {
    const r = await fetch(`${OC}/owner/grants/${encodeURIComponent(kind)}`, {
      method: 'PUT',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', [DEVICE_HEADER]: token },
      body: JSON.stringify({ on: body.on }),
    });
    const d = await r.json().catch(() => null);
    return NextResponse.json(d ?? {}, { status: r.ok ? 200 : r.status < 500 ? r.status : 502 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
