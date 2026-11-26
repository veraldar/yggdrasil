/**
 * POST /api/session/[id]/approve — the owner's Approve button for a session's open question.
 *
 * Only a PAIRED DEVICE can press it: the device's own credential rides to the brain, which checks it
 * against its registry and writes the approval itself (root/src/owner.rs). The box console, the admin
 * token and tailnet trust never reach it (they are 403 here and the brain would refuse them anyway):
 * that is where an agent's tools run. No agent tool calls this route, and none has the credential.
 */
import { NextResponse } from 'next/server';
import { OC, PIN_HEADER, resolveId, sessionGone } from '@/lib/oc';
import { DEVICE_HEADER, ownerToken } from '@/lib/owner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const token = await ownerToken(req);
  if (!token) {
    return NextResponse.json(
      { error: 'approving needs this device to be paired (the app on your phone)' },
      { status: 403 }
    );
  }
  try {
    const sid = await resolveId((await ctx.params).id, req.headers.get(PIN_HEADER));
    const r = await fetch(`${OC}/session/${encodeURIComponent(sid)}/owner-approve`, {
      method: 'POST',
      cache: 'no-store',
      headers: { [DEVICE_HEADER]: token },
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      return NextResponse.json(
        { error: String(d?.error || `the brain said ${r.status}`) },
        { status: r.status < 500 ? r.status : 502 }
      );
    }
    return NextResponse.json(d);
  } catch (e) {
    return sessionGone(e) ?? NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
