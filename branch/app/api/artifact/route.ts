/** GET /api/artifact → every artifact the user can see, for the /artifacts
 *  gallery and the home bell: this checkout's artifacts/, the main tree's
 *  (from a worktree) and the app's built-ins, one row per name — name,
 *  mtime, size, served type, source. Newest first. */
import { maybeGzip } from '@/lib/artifact-gzip';
import { listArtifacts } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const list = await listArtifacts();
  const raw = new TextEncoder().encode(JSON.stringify(list));
  const gz = await maybeGzip(req.headers.get('accept-encoding'), 'application/json', raw);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  if (gz) {
    headers['Content-Encoding'] = 'gzip';
    return new Response(new Uint8Array(gz).buffer as ArrayBuffer, { headers });
  }
  return new Response(raw.buffer as ArrayBuffer, { headers });
}
