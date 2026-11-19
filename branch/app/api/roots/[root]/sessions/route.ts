/**
 * GET → one root's sessions, as the hub brain sees them (GET /root/<root>/sessions):
 * { root, reachable, main: {id, proxy, title} | null, sessions: [{id, title, agent, status,
 * headline, updated, busy, proxy}] }. The home root's own name gives its local sessions.
 */
import { badRoot, brain, gate, rootParam } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ root: string }> }) {
  const no = await gate(req);
  if (no) return no;
  const root = await rootParam(ctx);
  if (!root) return badRoot();
  return brain(`/root/${encodeURIComponent(root)}/sessions`, { timeoutMs: 10_000 });
}
