/** GET /api/notify?slug=…[&notice=1] → {slug, on, default[, notice: {title, body}]} · PUT {slug, on} — may this session notify the phone?
 *  Off by default, on for MAIN (lib/notify-sessions.ts); `notice` = the words of a notification
 *  about the session's last reply, only when it is on (lib/notice.ts). */
import { NextResponse } from 'next/server';
import { noticeFor } from '@/lib/notice';
import { notifyDefault, notifyOn, setNotify } from '@/lib/notify-sessions';

export const dynamic = 'force-dynamic';

const SLUG = /^[a-z0-9_-]{1,60}$/;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const slug = q.get('slug') || '';
  if (!SLUG.test(slug)) return NextResponse.json({ error: 'slug' }, { status: 400 });
  const on = await notifyOn(slug);
  const notice = on && q.get('notice') === '1' ? await noticeFor(slug) : undefined;
  return NextResponse.json({ slug, on, default: notifyDefault(slug), ...(notice ? { notice } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
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
