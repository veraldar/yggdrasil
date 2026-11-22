/** /api/engines/[name] → the brain's /engine/:name — PUT {model} sets that engine's default
 *  model and answers the row. The brain's refusal (400 + one human sentence: a model it doesn't
 *  offer, an unknown engine) comes back with its status — the roles page says it where the user
 *  tapped. */
import { NextResponse } from 'next/server';
import { OC } from '@/lib/oc';

export const dynamic = 'force-dynamic';

const NAME = /^[a-z0-9_-]+$/;

async function relay(name: string, method: string, body?: unknown) {
  if (!NAME.test(name)) {
    return NextResponse.json({ error: `no engine ${name}` }, { status: 400 });
  }
  try {
    const r = await fetch(`${OC}/engine/${name}`, {
      method,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const why = d?.error || `brain ${r.status} on /engine/${name}`;
      return NextResponse.json({ error: String(why) }, { status: r.status < 500 ? r.status : 502 });
    }
    return NextResponse.json(d);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

type Ctx = { params: Promise<{ name: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('model' in body)) {
    return NextResponse.json({ error: 'nothing to save: {model}' }, { status: 400 });
  }
  return relay((await ctx.params).name, 'PUT', { model: (body as { model: unknown }).model });
}
