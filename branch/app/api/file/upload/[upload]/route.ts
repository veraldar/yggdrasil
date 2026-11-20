/** PUT /api/file/upload/<upload>?offset=N (raw bytes, one piece) → the brain's
 *  PUT /file/upload/<upload>?offset=N: `{have}`, the last piece `{have, file: REF}`, 409 `{have}`.
 *  A piece is at most 1 MiB: nothing on the way (Next's 10 MB middleware copy, the access
 *  point's frame, the tunnel) ever cuts one short — a bigger body is refused here, not trimmed. */
import type { NextRequest } from 'next/server';
import { brainDown, passJson } from '@/lib/brain-files';
import { deviceGate, passed } from '@/lib/gate';
import { PIECE_MAX } from '@/lib/file-ref';
import { ocRaw } from '@/lib/oc';

export const dynamic = 'force-dynamic';

/** a piece plus a little slack; anything above is refused whole */
const BODY_MAX = PIECE_MAX + 16 * 1024;

const tooBig = () => Response.json({ error: 'a piece is over 1 MB' }, { status: 413 });

/** the body, or null once it runs past BODY_MAX (reading stops there) */
async function readCapped(req: Request): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > BODY_MAX) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ upload: string }> }) {
  // the middleware does not run here (lib/gate.ts says why): the same gate, here
  const gate = await deviceGate(req);
  if (!passed(gate)) return gate;
  const { upload } = await ctx.params;
  const offset = new URL(req.url).searchParams.get('offset') || '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(upload) || !/^\d{1,15}$/.test(offset)) {
    return Response.json({ error: 'no such upload' }, { status: 400 });
  }
  if (Number(req.headers.get('content-length') || 0) > BODY_MAX) return tooBig();
  const body = await readCapped(req);
  if (!body) return tooBig();
  try {
    const r = await ocRaw(`/file/upload/${upload}?offset=${offset}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    return passJson(r);
  } catch {
    return brainDown();
  }
}
