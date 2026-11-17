/** /api/cc-live/… → the box's Claude Code live helper (lib/cc-live.ts): the running sessions,
 *  a session's history + live stream (SSE), and — for a background session only — typing into
 *  it, its keys, prompt answers and the raw terminal. Only the paths lib/cc-live.ts allows. */
import { allowed, ccForward, gated } from '@/lib/cc-live';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const shut = gated();
  if (shut) return shut;
  const path = (await ctx.params).path.join('/');
  if (!allowed(req.method, path)) return Response.json({ error: 'no such route' }, { status: 404 });
  const url = new URL(req.url);
  const body = req.method === 'POST' ? await req.text() : null;
  if (body && body.length > 256 * 1024)
    return Response.json({ error: 'too large' }, { status: 413 });
  const ac = new AbortController();
  req.signal.addEventListener('abort', () => ac.abort());
  try {
    const r = await ccForward(req.method, path, url.search, body, ac.signal);
    const type = r.headers.get('content-type') || 'application/json';
    if (type.startsWith('text/event-stream') && r.body) {
      // pass the stream through as it comes; the page's EventSource reconnects on its own
      return new Response(r.body as unknown as ReadableStream, {
        status: r.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }
    return new Response(await r.text(), {
      status: r.status,
      headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    if (ac.signal.aborted) return new Response(null, { status: 499 });
    return Response.json(
      {
        error: `the Claude Code live helper is not answering (${e instanceof Error ? e.message : String(e)})`,
        code: 'down',
      },
      { status: 502 }
    );
  }
}

export const GET = forward;
export const POST = forward;
