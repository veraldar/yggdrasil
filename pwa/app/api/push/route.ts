/** Push subscription registry: the client POSTs its PushSubscription after
 *  granting notification permission; GET exposes the VAPID public key. */
import { NextResponse } from 'next/server';
import { readJsonBody } from '@/lib/body';
import { addSub, publicKey, removeSub } from '@/lib/push';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ publicKey: publicKey() });
}

export async function POST(req: Request) {
  try {
    const parsed = await readJsonBody(req, 'push');
    if (!parsed.ok) return parsed.response;
    await addSub(parsed.body as Parameters<typeof addSub>[0]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const parsed = await readJsonBody<{ endpoint?: string }>(req, 'push');
    if (!parsed.ok) return parsed.response;
    if (parsed.body.endpoint) await removeSub(parsed.body.endpoint);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
