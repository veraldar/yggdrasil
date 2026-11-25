/**
 * PUT {base_url, style, model, api_key?, models?, vision?} | {same_as}
 * → updates this root's upstream model (writes its 0600 env file and restarts its brain).
 * For another root, the home brain forwards it over WireGuard. Keys are never logged.
 */
import { NextResponse } from 'next/server';
import { badRoot, brainSave, gate, rootParam } from '@/lib/roots-route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PUT(req: Request, ctx: { params: Promise<{ root: string }> }) {
  const no = await gate(req);
  if (no) return no;
  const root = await rootParam(ctx);
  if (!root) return badRoot();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'json body required' }, { status: 400 });
  }
  const sameAs = typeof body.same_as === 'string' ? body.same_as.trim() : '';
  if (sameAs) {
    return brainSave(root, `/root/${encodeURIComponent(root)}/model`, {
      method: 'PUT',
      body: { same_as: sameAs },
      timeoutMs: 15_000,
    });
  }
  const base_url = typeof body.base_url === 'string' ? body.base_url.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const style = typeof body.style === 'string' ? body.style.trim().toLowerCase() : 'openai';
  const api_key = typeof body.api_key === 'string' ? body.api_key : '';
  const models = typeof body.models === 'string' ? body.models.trim() : undefined;
  const vision = typeof body.vision === 'string' ? body.vision.trim() : undefined;
  if (!/^https?:\/\/.+/.test(base_url)) {
    return NextResponse.json({ error: 'base_url must start with https:// or http://' }, { status: 400 });
  }
  if (!model) {
    return NextResponse.json({ error: 'model required' }, { status: 400 });
  }
  if (style !== 'openai' && style !== 'anthropic') {
    return NextResponse.json({ error: 'style must be openai or anthropic' }, { status: 400 });
  }
  return brainSave(root, `/root/${encodeURIComponent(root)}/model`, {
    method: 'PUT',
    body: {
      base_url,
      style,
      model,
      api_key,
      ...(models ? { models } : {}),
      ...(vision ? { vision } : {}),
    },
    timeoutMs: 15_000,
  });
}
