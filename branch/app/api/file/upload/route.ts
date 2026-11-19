/** POST /api/file/upload {name, mime, size} → the brain's POST /file/upload: `{upload, piece}`,
 *  or its 413 `{error, limit}` (the composer shows that error word for word). */
import { brainDown, passJson } from '@/lib/brain-files';
import { ocRaw } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const size = b?.size;
  if (!b || typeof b.name !== 'string' || typeof size !== 'number' || !(size >= 0)) {
    return Response.json({ error: 'a file needs a name and a size' }, { status: 400 });
  }
  try {
    const r = await ocRaw('/file/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: b.name.slice(0, 200),
        mime: typeof b.mime === 'string' && b.mime ? b.mime : 'application/octet-stream',
        size,
      }),
    });
    return passJson(r);
  } catch {
    return brainDown();
  }
}
