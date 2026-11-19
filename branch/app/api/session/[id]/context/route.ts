/** GET /api/session/[id]/context — the context viewer's proxy (phase 1, plan G1):
 *  what this session's model was last sent, MAIN's view of it, the librarian's memory
 *  of it, and what its harness holds. Read-only end to end: the brain's handler only
 *  takes locks (never with_session / take_events / persist), so opening the sheet
 *  never moves the session or eats MAIN's pending reports. `?part=` and `?preview=1`
 *  pass through untouched; auth comes from middleware.ts (/api/:path*). */
import { NextResponse } from 'next/server';
import { ocFetch, PIN_HEADER, resolveId, sessionGone } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sid = await resolveId(id, req.headers.get(PIN_HEADER));
    const search = new URL(req.url).search || '';
    const data = await ocFetch(`/session/${sid}/context${search}`);
    return NextResponse.json(data);
  } catch (e) {
    return sessionGone(e) ?? NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
