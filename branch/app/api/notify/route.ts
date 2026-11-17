/** GET /api/notify?slug=… → {slug, on, default} · PUT {slug, on} — may this session notify the phone?
 *  Off by default, on for MAIN (lib/notify-sessions.ts). */
import { NextResponse } from 'next/server';
import { notifyDefault, notifyOn, setNotify } from '@/lib/notify-sessions';

export const dynamic = 'force-dynamic';

const SLUG = /^[a-z0-9_-]{1,60}$/;

export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get('slug') || '';
  if (!SLUG.test(slug)) return NextResponse.json({ error: 'slug' }, { status: 400 });
  return NextResponse.json({ slug, on: await notifyOn(slug), default: notifyDefault(slug) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { slug?: unknown; on?: unknown } | null;
  const slug = typeof body?.slug === 'string' ? body.slug : '';
  if (!SLUG.test(slug) || typeof body?.on !== 'boolean') {
    return NextResponse.json({ error: '{slug, on: true|false}' }, { status: 400 });
  }
  await setNotify(slug, body.on);
  return NextResponse.json({ slug, on: body.on });
}
