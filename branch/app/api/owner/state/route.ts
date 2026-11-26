/** GET /api/owner/state → {paired}: whether THIS client is a paired device (the only kind that can answer
 *  a question as the owner). The cards show buttons when it is, one line when it is not. */
import { NextResponse } from 'next/server';
import { ownerToken } from '@/lib/owner';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return NextResponse.json({ paired: !!(await ownerToken(req)) });
}
