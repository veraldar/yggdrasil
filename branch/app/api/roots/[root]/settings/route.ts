/**
 * GET → one root's settings (world, roles, engines, hardware, models, joined_at), live when
 * reachable or from home's persisted snapshot when off.
 */
import { NextResponse } from 'next/server';
import { fetch as undiciFetch } from 'undici';
import { OC } from '@/lib/oc';
import { NO_STORE } from '@/lib/pairing';
import { rootRecord } from '@/lib/roots';
import { badRoot, gate, rootParam } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ root: string }> }) {
  const no = await gate(req);
  if (no) return no;
  const root = await rootParam(ctx);
  if (!root) return badRoot();
  const [rec, res] = await Promise.all([
    rootRecord(root),
    undiciFetch(`${OC}/root/${encodeURIComponent(root)}/settings`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null),
  ]);
  if (!res) {
    return NextResponse.json({ error: 'the brain did not answer' }, { status: 502, headers: NO_STORE });
  }
  const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return NextResponse.json(d, { status: res.status, headers: NO_STORE });
  }
  return NextResponse.json(
    { ...d, joined_at: rec?.joined_at ?? null },
    { status: 200, headers: NO_STORE }
  );
}
