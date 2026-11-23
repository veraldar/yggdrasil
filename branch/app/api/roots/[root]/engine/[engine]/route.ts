/**
 * PUT {model} → sets an engine's default model on a specific root (`PUT /root/<root>/engine/<engine>`).
 */
import { NextResponse } from 'next/server';
import { badRoot, brain, gate, rootParam } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NAME = /^[a-z0-9_-]{1,32}$/;

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ root: string; engine: string }> }
) {
  const no = await gate(req);
  if (no) return no;
  const { root: rawRoot, engine } = await ctx.params;
  const root = await rootParam({ params: Promise.resolve({ root: rawRoot }) });
  if (!root) return badRoot();
  if (!NAME.test(engine)) {
    return NextResponse.json({ error: 'bad engine name' }, { status: 400 });
  }
  const body = (await req.json().catch(() => null)) as { model?: unknown } | null;
  if (!body || typeof body !== 'object' || !('model' in body)) {
    return NextResponse.json({ error: 'nothing to save: {model}' }, { status: 400 });
  }
  return brain(`/root/${encodeURIComponent(root)}/engine/${encodeURIComponent(engine)}`, {
    method: 'PUT',
    body: { model: body.model },
    timeoutMs: 12_000,
  });
}
