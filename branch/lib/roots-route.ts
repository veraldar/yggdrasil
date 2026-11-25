/** The roots sheet's routes, shared: the gate and the one call each makes to the hub brain. */
import { NextResponse } from 'next/server';
import { fetch as undiciFetch } from 'undici';
import { rootsGate, trunkRootsGate } from '@/lib/admin';
import { OC } from '@/lib/oc';
import { NO_STORE } from '@/lib/pairing';
import { needsUpdate, rootLacksRoute } from '@/lib/root-outdated';
import { ROOT_NAME } from '@/lib/roots';
import { REAUTH as TRUNK_REAUTH } from '@/lib/trunk-auth';

/** null = go on; else the refusal to answer with */
export async function gate(req: Request): Promise<NextResponse | null> {
  if (process.env.BIFROST_AUTH === 'trunk') {
    const t = await trunkRootsGate(req);
    if (t === null) return null;
    return t === 403
      ? NextResponse.json({ error: 'a signed-in device sees the roots' }, { status: 403 })
      : NextResponse.json({ why: t, reauth: TRUNK_REAUTH[t] }, { status: 401 });
  }
  const g = await rootsGate(req);
  if (g === 'ok') return null;
  return g === 403
    ? NextResponse.json({ error: 'a paired device sees the roots' }, { status: 403 })
    : NextResponse.json({ error: 'device token required', reauth: 'pair' }, { status: 401 });
}

/** the [root] segment: a plain root name, or null */
export async function rootParam(ctx: {
  params: Promise<{ root: string }>;
}): Promise<string | null> {
  let root = (await ctx.params).root || '';
  try {
    root = decodeURIComponent(root);
  } catch {
    return null;
  }
  return ROOT_NAME.test(root) ? root : null;
}

export const badRoot = () => NextResponse.json({ error: 'not a root name' }, { status: 400 });

/** One call to the hub brain; its status and JSON body passed on as they are. */
export async function brain(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs: number }
): Promise<NextResponse> {
  try {
    const r = await undiciFetch(`${OC}${path}`, {
      method: init.method || 'GET',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    const text = await r.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text.slice(0, 200) || `brain ${r.status}` };
    }
    return NextResponse.json(body, { status: r.status, headers: NO_STORE });
  } catch (e) {
    return NextResponse.json(
      { error: `the brain did not answer: ${(e as Error).message}` },
      { status: 502, headers: NO_STORE }
    );
  }
}

/** One save on `root` through the hub brain (its world, a role, an engine): the brain's answer
 *  as it is — except when that computer's brain is too old to have the route: then one plain
 *  line (409, `outdated`), never the bare "404 Not Found" (lib/root-outdated). */
export async function brainSave(
  root: string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs: number }
): Promise<NextResponse> {
  const res = await brain(path, init);
  if (res.status !== 502) return res;
  const d = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  if (!rootLacksRoute(res.status, d?.error)) return res;
  return NextResponse.json(
    { error: needsUpdate(root), outdated: true },
    { status: 409, headers: NO_STORE }
  );
}
