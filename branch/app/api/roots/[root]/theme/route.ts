/**
 * PUT {theme} → sets this root's visual world on that computer (`data/root.json`) and updates
 * home's cached copy. Never queues while offline. A computer whose brain is older than this
 * route answers 409 {"error":"<root> needs an update for this"} (lib/roots-route brainSave).
 */
import { NextResponse } from 'next/server';
import { badRoot, brainSave, gate, rootParam } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PUT(req: Request, ctx: { params: Promise<{ root: string }> }) {
  const no = await gate(req);
  if (no) return no;
  const root = await rootParam(ctx);
  if (!root) return badRoot();
  const body = (await req.json().catch(() => null)) as { theme?: unknown } | null;
  const theme = typeof body?.theme === 'string' ? body.theme.trim() : '';
  if (!theme) return NextResponse.json({ error: 'theme required' }, { status: 400 });
  return brainSave(root, `/root/${encodeURIComponent(root)}/theme`, {
    method: 'PUT',
    body: { theme },
    timeoutMs: 12_000,
  });
}
