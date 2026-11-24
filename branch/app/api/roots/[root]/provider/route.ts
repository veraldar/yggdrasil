/**
 * GET / PUT → one root's providers (`/root/<root>/provider`, falling back to `/provider`
 * for the home root). GET degrades gracefully on 404 so older roots show the empty state
 * with zero console errors.
 */
import { NextResponse } from 'next/server';
import { fetch as undiciFetch } from 'undici';
import { OC } from '@/lib/oc';
import { NO_STORE } from '@/lib/pairing';
import { badRoot, brainSave, gate, rootParam } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ root: string }> }) {
  const no = await gate(req);
  if (no) return no;
  const root = await rootParam(ctx);
  if (!root) return badRoot();
  try {
    const res = await undiciFetch(`${OC}/root/${encodeURIComponent(root)}/provider`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res || res.status === 404 || res.status === 405 || res.status === 501) {
      return NextResponse.json(
        { available: false, providers: [], health: {} },
        { status: 200, headers: NO_STORE }
      );
    }
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { available: false, providers: [], health: {} },
        { status: 200, headers: NO_STORE }
      );
    }
    const out =
      d && typeof d === 'object' && !Array.isArray(d)
        ? { available: true, ...d }
        : { available: true, providers: Array.isArray(d) ? d : [] };
    return NextResponse.json(out, { status: 200, headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { available: false, providers: [], health: {} },
      { status: 200, headers: NO_STORE }
    );
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ root: string }> }) {
  const no = await gate(req);
  if (no) return no;
  const root = await rootParam(ctx);
  if (!root) return badRoot();
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'nothing to save' }, { status: 400 });
  }
  return brainSave(root, `/root/${encodeURIComponent(root)}/provider`, {
    method: 'PUT',
    body,
    timeoutMs: 12_000,
  });
}
