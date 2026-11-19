/** DELETE /api/memory/fact/[id] (phase 2): the Memory tab's ✕ on a fact row. The brain
 *  reaches the librarian's internal `forget` (ext::call_internal) — the memory answers 200
 *  even when the extension is down, as an error JSON. */
import { NextResponse } from 'next/server';
import { ocFetch } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'the fact id is a number' }, { status: 400 });
  }
  try {
    const body = await ocFetch(`/memory/fact/${id}`, { method: 'DELETE' }).then((r) => r.json());
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 200 });
  }
}
