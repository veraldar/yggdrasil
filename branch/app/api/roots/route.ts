/**
 * GET → the whole tree: `home` (this hub's own root: name, os, cpus, mem_gb, running, main — the
 * brain's GET /root) and `roots`, the others: the machines joined to this hub (id, name, os, host,
 * joined_at, delivered_at, wg_fp; removed ones left out) with the brain's word on each merged in
 * (reachable, seen, running, models, main, main_proxy), then the roots only the brain knows
 * (static peers). The gate: lib/admin.ts rootsGate.
 */
import { NextResponse } from 'next/server';
import { NO_STORE } from '@/lib/pairing';
import { listPendingJoins, rootsOverview } from '@/lib/roots';
import { gate } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const no = await gate(req);
  if (no) return no;
  return NextResponse.json(
    { ...(await rootsOverview()), joins: listPendingJoins() },
    { headers: NO_STORE }
  );
}
