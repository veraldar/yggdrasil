/**
 * POST {id} → a proxy here for a session that lives on that root, so the phone can open it
 * (the brain's POST /root/<root>/adopt → {proxy, title}; idempotent).
 */
import { NextResponse } from 'next/server';
import { bustCache } from '@/lib/oc-cache';
import { badRoot, brain, gate, rootParam } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, ctx: { params: Promise<{ root: string }> }) {
  const no = await gate(req);
  if (no) return no;
  const root = await rootParam(ctx);
  if (!root) return badRoot();
  const id = (await req.json().catch(() => null))?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(id)) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }
  const out = await brain(`/root/${encodeURIComponent(root)}/adopt`, {
    method: 'POST',
    body: { id },
    timeoutMs: 15_000,
  });
  if (out.ok) bustCache(); // the new proxy is a session of this list
  return out;
}
