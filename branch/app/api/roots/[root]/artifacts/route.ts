/**
 * GET → files made on one root. For the home root, serves the exact local gallery
 * (`lib/artifacts.ts listArtifacts`, marked `home: true`); for another root, asks the hub brain (`GET /root/<root>/artifacts`,
 * which caches the list for when that computer is off).
 */
import { NextResponse } from 'next/server';
import { listArtifacts } from '@/lib/artifacts';
import { NO_STORE } from '@/lib/pairing';
import { hubBrainName } from '@/lib/roots';
import { badRoot, brain, gate, rootParam } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ root: string }> }) {
  const no = await gate(req);
  if (no) return no;
  const root = await rootParam(ctx);
  if (!root) return badRoot();
  const home = await hubBrainName();
  if (root === home) {
    const list = await listArtifacts();
    return NextResponse.json(
      {
        root,
        home: true,
        reachable: true,
        artifacts: list.map((a) => ({
          name: a.name,
          mtime: a.mtime,
          size: a.size,
          ext: a.name.split('.').pop()?.toLowerCase() || '',
          type: a.type,
          source: a.source,
        })),
      },
      { headers: NO_STORE }
    );
  }
  return brain(`/root/${encodeURIComponent(root)}/artifacts`, { timeoutMs: 10_000 });
}
