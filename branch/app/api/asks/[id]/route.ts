/** POST /api/asks/<id> {session?, branch?, commit?, note?} → the brain's POST /asks/<id>: who owns
 *  the ask and which branch + commit it landed in ("" clears a field). */
import { NextResponse } from 'next/server';
import { ocFetch } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^msg_[a-z0-9]+$/i.test(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  try {
    const body = await req.text();
    const rec = await ocFetch(`/asks/${id}`, { method: 'POST', body });
    return NextResponse.json(rec ?? {}, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const err = e as { message?: string; brainError?: string };
    const status = /\b404\b/.test(err.message || '')
      ? 404
      : /\b400\b/.test(err.message || '')
        ? 400
        : 502;
    return NextResponse.json({ error: err.brainError || String(e) }, { status });
  }
}
