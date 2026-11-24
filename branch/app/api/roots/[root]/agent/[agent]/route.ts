/**
 * PUT → edits a role on a specific root (`PUT /root/<root>/agent/<agent>`).
 */
import { NextResponse } from 'next/server';
import { badRoot, brainSave, gate, rootParam } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NAME = /^[A-Za-z0-9_-]{1,40}$/;

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ root: string; agent: string }> }
) {
  const no = await gate(req);
  if (no) return no;
  const { root: rawRoot, agent } = await ctx.params;
  const root = await rootParam({ params: Promise.resolve({ root: rawRoot }) });
  if (!root) return badRoot();
  if (!NAME.test(agent)) {
    return NextResponse.json({ error: 'bad role name' }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'nothing to save' }, { status: 400 });
  }
  return brainSave(root, `/root/${encodeURIComponent(root)}/agent/${encodeURIComponent(agent)}`, {
    method: 'PUT',
    body,
    timeoutMs: 12_000,
  });
}
