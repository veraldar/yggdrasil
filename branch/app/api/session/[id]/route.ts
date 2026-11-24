import { NextResponse } from 'next/server';
import { engineOf } from '@/lib/agents';
import { brainDefault } from '@/lib/brain-default';
import { OC, ocFetch, resolveId } from '@/lib/oc';
import { bustCache } from '@/lib/oc-cache';
import { purgeQueue } from '@/lib/oc-queue';
import { slugify } from '@/lib/slug';
import { MAIN_SLUG } from '@/lib/tree-first';

export const dynamic = 'force-dynamic';

/** THE MAIN session (slug `main`) is reserved: no delete, no rename. */
async function isMain(idOrSlug: string, sid: string): Promise<boolean> {
  if (idOrSlug === MAIN_SLUG) return true;
  const s = (await ocFetch(`/session/${sid}`)) as { title?: string };
  return slugify(s.title || '') === MAIN_SLUG;
}

type ModelRef = { providerID: string; modelID: string; variant: string | null };

/** Think levels ride a naming convention on model IDs defined in
 *  opencode.json: `<modelID>-think-<level>` (config model carries
 *  options.reasoningEffort). Validated on the wire against a recording
 *  provider: v1.18's prompt API drops `variant` (body, session record and
 *  v2 prompt all fail), but the modelID — and its options — reach the
 *  provider call. So a level IS a model here. */
const THINK_RE = /^(.+)-think-([a-z]+)$/;

function splitThink(modelID: string) {
  const m = THINK_RE.exec(modelID);
  return m ? { base: m[1], level: m[2] } : { base: modelID, level: null };
}

/** Levels actually available for a model = derived models that exist in the
 *  provider config. Resolved server-side so the client can't drift. */
async function thinkLevels(providerID: string, modelID: string): Promise<string[]> {
  try {
    const r = await fetch(`${OC}/config/providers`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    const p = (d.providers || []).find((x: { id: string }) => x.id === providerID);
    if (!p) return [];
    return Object.keys(p.models || {})
      .map((id) => splitThink(id))
      .filter((s) => s.base === modelID && s.level)
      .map((s) => s.level!);
  } catch {
    return [];
  }
}

/** A raw provider/model id (maybe a derived think model) → the settings
 *  shape: base model + level + the levels configured for it. */
async function modelRef(providerID: string, raw: string) {
  const { base, level } = splitThink(raw);
  return {
    providerID,
    modelID: base,
    variant: level || null, // null = model default
    variants: await thinkLevels(providerID, base),
  };
}

/** Session summary — title + run config (agent / model / think level) that
 *  subsequent turns use, with the levels available for the model resolved.
 *  No explicit model (never set — e.g. MAIN before any voice seed) → the
 *  session runs on the brain's default: reported as `defaultModel`, apart
 *  from `model`, so the page shows it AS the default; null = the brain
 *  didn't say (shown as unknown, never guessed). `agent` is the role,
 *  `engine` what runs it; a harness session adds `harness` (kind /
 *  conversation id / attached); fork/origin and cwd stay server-side. */
/** a brain session info, as far as the summary reads it */
type BrainSession = {
  id: string;
  title?: string;
  agent?: string | null;
  engine?: unknown;
  steps?: unknown;
  model?: { id?: string; modelID?: string; providerID: string } | null;
  harness?: { kind?: string | null; id?: string | null; attached?: boolean } | null;
  card?: { root?: string | null; kind?: string | null } | null;
  instructions?: unknown;
  agent_was?: unknown;
};

async function summary(s: BrainSession) {
  const raw = s.model ? s.model.id || s.model.modelID : null;
  const model = raw && s.model ? await modelRef(s.model.providerID, raw) : null;
  const d = model ? null : await brainDefault();
  return {
    id: s.id,
    title: s.title || s.id,
    agent: s.agent || null,
    // the computer this session lives on (null = this home root)
    root: typeof s.card?.root === 'string' && s.card.root ? s.card.root : null,
    // the step cap of this session's turns; null = none (the default)
    steps: typeof s.steps === 'number' && s.steps > 0 ? s.steps : null,
    model,
    defaultModel: d ? await modelRef(d.providerID, d.modelID) : null,
    // what runs it — root · claude · antigravity · opencode · codex (an older root: from harness)
    engine: engineOf(s),
    harness: s.harness
      ? {
          kind: s.harness.kind ?? null,
          id: s.harness.id ?? null,
          attached: s.harness.attached === true,
        }
      : undefined,
    // "shared" = it reads only the shared prompt, no role text (a relabelled old session, a
    // terminal conversation); null = its role's instructions
    instructions: typeof s.instructions === 'string' ? s.instructions : null,
    // a relabelled session's old agent name (claude | agy), kept for undo
    agent_was: typeof s.agent_was === 'string' ? s.agent_was : null,
  };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const sid = await resolveId(id);
    return NextResponse.json(await summary((await ocFetch(`/session/${sid}`)) as BrainSession));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** One settings write upstream. A refusal (4xx — unknown agent/model, gone
 *  session) is an answer, not a crash: its status + the brain's own reason
 *  come back as the response, so the page says why instead of a bare
 *  'opencode 400 on …' 500. null = written. */
async function ocWrite(path: string, method: string, body: unknown) {
  const r = await fetch(`${OC}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(`[oc] ${method} ${path} → ${r.status}`);
  if (r.ok) return null;
  const d = await r.json().catch(() => ({}));
  const why = d.error || d.data?.message || d.message || `brain ${r.status} on ${path}`;
  return NextResponse.json({ error: String(why) }, { status: r.status < 500 ? r.status : 502 });
}

/** Settings writes. title → session PATCH; model+think → v2 model switch
 *  onto the derived think model (the only variant carrier that survives
 *  v1.18 runs — see splitThink); agent → the role switch; engine → the
 *  engine switch (a harness engine starts a fresh conversation there). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const sid = await resolveId(id);
    const body = await req.json();

    if (body.title !== undefined) {
      const t = String(body.title || '')
        .trim()
        .slice(0, 80);
      if (!t) return NextResponse.json({ error: 'empty title' }, { status: 400 });
      // MAIN keeps its name (the door finds it by slug) and nothing else takes it
      if ((await isMain(id, sid)) || slugify(t) === MAIN_SLUG) {
        return NextResponse.json(
          { error: 'MAIN is reserved — it keeps its name' },
          { status: 409 }
        );
      }
      const no = await ocWrite(`/session/${sid}`, 'PATCH', { title: t });
      if (no) return no;
    }

    if (body.model !== undefined) {
      const m = body.model as { providerID: string; modelID: string; variant?: string | null };
      if (!m?.providerID || !m?.modelID)
        return NextResponse.json({ error: 'model needs providerID + modelID' }, { status: 400 });
      // a harness session (Claude Code / opencode / Codex / Antigravity) picks from its harness's models:
      // the brain validates those against what the harness offers
      if (['claude', 'opencode', 'codex', 'antigravity'].includes(m.providerID)) {
        const no = await ocWrite(`/api/session/${sid}/model`, 'POST', {
          model: { id: m.modelID, providerID: m.providerID },
        });
        if (no) return no;
      } else {
        const level = m.variant && m.variant !== 'default' ? m.variant : null;
        const target = level ? `${m.modelID}-think-${level}` : m.modelID;
        // the target must exist — never switch a session onto a dead modelID
        const r = await fetch(`${OC}/config/providers`, { cache: 'no-store' });
        const d = r.ok ? await r.json() : { providers: [] };
        const p = (d.providers || []).find((x: { id: string }) => x.id === m.providerID);
        let known = !!p?.models?.[target];
        if (!known) {
          // also check /provider (registry + discovered models from any root provider)
          const pr = await fetch(`${OC}/provider`, { cache: 'no-store' }).catch(() => null);
          const pd = pr?.ok ? await pr.json().catch(() => null) : null;
          const plist = Array.isArray(pd?.providers) ? pd.providers : [];
          const hit = plist.find(
            (x: { id?: string; name?: string }) => x.id === m.providerID || x.name === m.providerID
          );
          if (hit) {
            const ms = [
              ...(Array.isArray(hit.models) ? hit.models : []),
              ...(Array.isArray(hit.discovered) ? hit.discovered : []),
            ];
            known = ms.some((x: unknown) =>
              typeof x === 'string' ? x === target : (x as { id?: string })?.id === target
            );
          }
        }
        if (!known)
          return NextResponse.json(
            { error: `unknown model ${m.providerID}/${target}` },
            { status: 400 }
          );
        const no = await ocWrite(`/api/session/${sid}/model`, 'POST', {
          model: { id: target, providerID: m.providerID },
        });
        if (no) return no;
      }
    }

    if (body.steps !== undefined) {
      const n = body.steps === null ? null : Number(body.steps);
      if (n !== null && !(Number.isInteger(n) && n > 0 && n <= 100_000))
        return NextResponse.json(
          { error: 'steps: a whole number, or null for no cap' },
          { status: 400 }
        );
      const no = await ocWrite(`/session/${sid}`, 'PATCH', { steps: n });
      if (no) return no;
    }

    // the ROLE only: the engine and the model stay
    if (body.agent !== undefined) {
      if (!body.agent) return NextResponse.json({ error: 'empty role' }, { status: 400 });
      const no = await ocWrite(`/api/session/${sid}/agent`, 'POST', { agent: String(body.agent) });
      if (no) return no;
    }

    // the ENGINE only: the role stays; the brain picks the model (the role's own on its default
    // engine, else the engine's default) and refuses MAIN, a terminal conversation, an unknown one
    if (body.engine !== undefined) {
      if (!body.engine || typeof body.engine !== 'string')
        return NextResponse.json({ error: 'empty engine' }, { status: 400 });
      const no = await ocWrite(`/api/session/${sid}/engine`, 'POST', { engine: body.engine });
      if (no) return no;
    }

    bustCache(); // home list reflects a rename on its next poll
    return NextResponse.json(await summary((await ocFetch(`/session/${sid}`)) as BrainSession));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const sid = await resolveId(id); // accepts slug or session id
    // belt and suspenders: the list never offers MAIN's delete, and the
    // proxy — the phone's only way to the brain — refuses it too
    if (await isMain(id, sid)) {
      return NextResponse.json(
        { error: 'MAIN is reserved — it cannot be deleted' },
        { status: 403 }
      );
    }
    // identity-pinned waits (herdr §1.4): the queue dies with its session —
    // nothing queued under it may ever be forwarded
    purgeQueue(sid);
    const r = await ocFetch(`/session/${sid}`, { method: 'DELETE' });
    bustCache(); // next list poll rebuilds instead of showing the deleted row
    return NextResponse.json(r ?? { ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
