/**
 * POST → remove this root from the tree (the roots sheet's hold): roots.json marks it revoked,
 * the hub brain forgets it (lib/roots.ts removeRoot) → {ok: true}.
 */
import { NextResponse } from 'next/server';
import { bustCache } from '@/lib/oc-cache';
import { NO_STORE } from '@/lib/pairing';
import { removeRoot } from '@/lib/roots';
import { badRoot, gate, rootParam } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, ctx: { params: Promise<{ root: string }> }) {
  const no = await gate(req);
  if (no) return no;
  const root = await rootParam(ctx);
  if (!root) return badRoot();
  const out = await removeRoot(root);
  if (out.http === 200) bustCache(); // its proxies now read "root removed"
  return NextResponse.json(out.body, { status: out.http, headers: NO_STORE });
}
