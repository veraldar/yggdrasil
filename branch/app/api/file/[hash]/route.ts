/** GET /api/file/<hash>?root=&mime=&name= → the brain's GET /file/<hash> (it pulls the file from
 *  `root` first when it does not have it), streamed through with its content-type. */
import { brainDown, inlineName, passJson } from '@/lib/brain-files';
import { HASH_RE, ROOT_RE } from '@/lib/file-ref';
import { ocRaw } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  if (!HASH_RE.test(hash)) return Response.json({ error: 'not found' }, { status: 404 });
  const q = new URL(req.url).searchParams;
  const fwd = new URLSearchParams();
  const root = q.get('root') || '';
  if (root && ROOT_RE.test(root)) fwd.set('root', root);
  const mime = q.get('mime') || '';
  if (mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)) fwd.set('mime', mime);
  const name = (q.get('name') || '').slice(0, 200);
  if (name) fwd.set('name', name);
  let r: Awaited<ReturnType<typeof ocRaw>>;
  try {
    r = await ocRaw(`/file/${hash}${fwd.size ? `?${fwd}` : ''}`);
  } catch {
    return brainDown();
  }
  if (!r.ok || !r.body) return passJson(r);
  const type = r.headers.get('content-type') || 'application/octet-stream';
  const headers: Record<string, string> = {
    'Content-Type': type,
    // a stored file never changes under its hash
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    // opened on its own (a new tab), a page or an svg must not run on the app's origin — the
    // artifact route's rule for html. A pdf keeps its viewer (a sandboxed pdf is blocked)
    ...(!/^application\/pdf/i.test(type) && { 'Content-Security-Policy': 'sandbox' }),
    ...(name && { 'Content-Disposition': inlineName(name) }),
  };
  const len = r.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  return new Response(r.body as unknown as ReadableStream<Uint8Array>, { headers });
}
