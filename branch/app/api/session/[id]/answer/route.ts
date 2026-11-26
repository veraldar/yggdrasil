/**
 * POST /api/session/[id]/answer {ask, answer} — the owner answers a session's open question on its card.
 * `answer` is "yes", "no" or a typed reply.
 *
 * Only a PAIRED DEVICE can: its own credential rides to the brain, which checks it against its registry,
 * ties the answer to the ask id the owner saw (409 when the question changed) and writes the words itself
 * (root/src/owner.rs). The box console, the admin token and tailnet trust never reach it (403 here; the
 * brain would refuse them anyway): that is where an agent's tools run. No agent tool calls this route.
 */
import { NextResponse } from 'next/server';
import { OC, PIN_HEADER, resolveId, sessionGone } from '@/lib/oc';
import { DEVICE_HEADER, ownerToken } from '@/lib/owner';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const token = await ownerToken(req);
  if (!token) {
    return NextResponse.json(
      { error: 'answering needs this device to be paired (the app on your phone)' },
      { status: 403 }
    );
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.ask !== 'string' || typeof body.answer !== 'string') {
    return NextResponse.json({ error: 'ask and answer required' }, { status: 400 });
  }
  try {
    const sid = await resolveId((await ctx.params).id, req.headers.get(PIN_HEADER));
    const r = await fetch(`${OC}/session/${encodeURIComponent(sid)}/owner-answer`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', [DEVICE_HEADER]: token },
      body: JSON.stringify({ ask: body.ask, answer: body.answer }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      return NextResponse.json(
        { ...(d && typeof d === 'object' ? d : {}), error: String(d?.error || `the brain said ${r.status}`) },
        { status: r.status < 500 ? r.status : 502 }
      );
    }
    return NextResponse.json(d);
  } catch (e) {
    return sessionGone(e) ?? NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
