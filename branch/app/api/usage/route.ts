/** /api/usage → the brain's GET /usage: per-engine {pct, resets_at, source}.
 *  Degrades gracefully on 404 (older brain) so the UI renders cleanly with 0 console errors. */
import { NextResponse } from 'next/server';
import { OC } from '@/lib/oc';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const r = await fetch(`${OC}/usage`, { cache: 'no-store' });
    if (r.status === 404 || r.status === 405 || r.status === 501) {
      return NextResponse.json(
        { available: false, usage: {} },
        { status: 200, headers: { ...NO_STORE, 'X-Brain-Status': String(r.status) } }
      );
    }
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      return NextResponse.json(
        { available: false, usage: {} },
        { status: 200, headers: { ...NO_STORE, 'X-Brain-Status': String(r.status) } }
      );
    }
    const out =
      d && typeof d === 'object' && !Array.isArray(d)
        ? { available: true, usage: d, ...d }
        : { available: true, usage: {} };
    return NextResponse.json(out, { headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { available: false, usage: {} },
      { status: 200, headers: { ...NO_STORE, 'X-Brain-Status': 'unreachable' } }
    );
  }
}
