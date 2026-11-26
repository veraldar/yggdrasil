/** GET /api/owner/grants → the standing permissions and whether each is on (the brain's /owner/grants). */
import { NextResponse } from 'next/server';
import { OC } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const r = await fetch(`${OC}/owner/grants`, { cache: 'no-store' });
    return NextResponse.json(await r.json(), { status: r.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
