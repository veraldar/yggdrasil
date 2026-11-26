/** GET /api/asks → the brain's GET /asks: every owner ask as a card row (see root/src/asks.rs).
 *  A brain without /asks (an older build) answers 502 — the page then says so. */
import { NextResponse } from 'next/server';
import { ocFetch } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const limit = new URL(req.url).searchParams.get('limit');
  try {
    const rows = await ocFetch(`/asks${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`);
    return NextResponse.json(Array.isArray(rows) ? rows : [], {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
