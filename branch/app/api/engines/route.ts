/** GET /api/engines → the brain's GET /engine: what can run a session — root · Claude Code ·
 *  Antigravity · opencode · Codex, each with its default model and its choices
 *  ([{name, label, word, model, models, labels, more}]). The roles page's engines block and the
 *  session settings' "runs on" read it. A brain without /engine (an older root) answers its 404:
 *  the pages then fall back to what they know. */
import { NextResponse } from 'next/server';
import { OC } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const r = await fetch(`${OC}/engine`, { cache: 'no-store' });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const why = d?.error || `brain ${r.status} on /engine`;
      return NextResponse.json({ error: String(why) }, { status: r.status < 500 ? r.status : 502 });
    }
    return NextResponse.json(Array.isArray(d) ? d : [], {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
