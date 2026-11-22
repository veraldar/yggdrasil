/**
 * Proxy to the opencode server (127.0.0.1:4096) — the single source of truth
 * for sessions. Keeps opencode unexposed; the phone only ever talks to this.
 *
 * Routes:
 *   GET    /api/session                 → enriched session list (title + preview, cached 60s)
 *   POST   /api/session                 → {name, root?, agent?, engine?} create session (title =
 *                                          name; `root`: on that computer — a proxy of it here,
 *                                          card.root; `agent` the role, `engine` what runs it)
 *                                          {attach: {id, cwd}} continue a Claude Code session
 *   GET    /api/session/[id]/messages   → transcript
 *   POST   /api/session/[id]/prompt     → {text, images?: string[](dataURL), files?: {name, content}[]}
 *   DELETE /api/session/[id]            → delete
 */
import { NextResponse } from 'next/server';
import { engineOf } from '@/lib/agents';
import { bustCache, cacheGen, getCache, setCache } from '@/lib/oc-cache';
import { isRunLive } from '@/lib/oc-live';
import { STALL_MS, ensureWatchdog, lastEventAt } from '@/lib/oc-watchdog';
import { PENDING_TTL_MS } from '@/lib/pending-ttl';
import { ROOT_NAME } from '@/lib/roots';
import { runState } from '@/lib/run-state';
import { slugify } from '@/lib/slug';
import { MAIN_SLUG } from '@/lib/tree-first';

export const dynamic = 'force-dynamic';

const OC = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';

async function ocFetch(path: string, init?: RequestInit) {
  const r = await fetch(`${OC}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`opencode ${r.status} on ${path}`);
  return r.json();
}

function textOf(parts: Array<{ type?: string; text?: string }> | undefined) {
  return (parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join(' ')
    .trim();
}

/** a brain session info, as far as this list reads it */
type BrainSession = {
  id: string;
  title?: string;
  parentID?: string | null;
  time?: { created?: number; updated?: number; user?: number };
  state?: Parameters<typeof runState>[0];
  agent?: unknown;
  engine?: unknown;
  card?: unknown;
  archived?: unknown;
  harness?: unknown;
};

/** root-coord tree fields off a brain session info — absent on opencode */
function treeFields(s: {
  agent?: unknown;
  engine?: unknown;
  card?: unknown;
  archived?: unknown;
  harness?: unknown;
}) {
  const h =
    s.harness && typeof s.harness === 'object' ? (s.harness as Record<string, unknown>) : null;
  return {
    // the role (the badge); the brain keeps the field name `agent`
    agent: s.agent || null,
    // what runs it (the grey word): root · claude · antigravity · opencode · codex
    engine: engineOf(s),
    // the owner's own terminal conversation continued here: its kind (badge [TRM]), else null
    harness: h && h.attached === true && typeof h.kind === 'string' ? h.kind : null,
    card: s.card && typeof s.card === 'object' ? s.card : null,
    archived: s.archived === true,
  };
}

export async function GET() {
  try {
    // arms the opencode event stream (idempotent, one per process): its
    // busts keep this list's working dots live for voice runs, which never
    // pass through this proxy's run tracker
    ensureWatchdog();
    const cached = getCache();
    if (cached) return NextResponse.json(cached);
    const gen = cacheGen();
    const sessions = (await ocFetch('/session')) as BrainSession[];
    // enrich with last-message preview (LAN-local, fast; cached 60s)
    const enriched = await Promise.all(
      sessions.slice(0, 50).map(async (s) => {
        try {
          // NOTE: /messages (plural) is the SPA catch-all HTML page, not an
          // API — r.json() throws and every session silently enriched empty
          const msgs = (await ocFetch(`/session/${s.id}/message`)) as Array<{
            role?: string;
            info?: {
              role?: string;
              time?: { created?: number; completed?: number };
              meta?: { auto?: boolean; internal?: boolean; origin?: string };
            };
            parts?: Array<{ type?: string; text?: string }>;
          }>;
          const last = [...msgs].reverse().find((m) => textOf(m.parts));
          // the owner's own newest message orders the list (owner 11-17): a reply, a report or
          // another session's message never moves a session up (the brain's owner_at)
          const mine = [...msgs]
            .reverse()
            .find(
              (m) =>
                m.info?.role === 'user' &&
                !m.info?.meta?.auto &&
                !m.info?.meta?.internal &&
                !m.info?.meta?.origin &&
                !(m.parts || []).some((p) => p.type === 'compaction')
            );
          const userAt = mine?.info?.time?.created || s.time?.user || s.time?.created || 0;
          const lastRole = last?.info?.role || '';
          const lastText = textOf(last?.parts);
          // mid-run detection on the RAW last message (may be a tool-only
          // step with no text): user msg last, or assistant step still
          // streaming (no completed time) — a run is in flight even when a
          // text reply already landed mid-run (restart wiped the live map)
          const lastRaw = msgs[msgs.length - 1];
          const rawRole = lastRaw?.info?.role || lastRaw?.role || '';
          const rawCreated = lastRaw?.info?.time?.created || 0;
          const midRun =
            rawRole === 'user' || (rawRole === 'assistant' && !lastRaw?.info?.time?.completed);
          // herdr triad (§1.1/§1.2): the brain's declaration first, then the
          // proxy's in-flight record, the detector only for a brain that
          // declares nothing (lib/run-state). UI chips ride the next build.
          const rs = runState(
            s.state,
            isRunLive(s.id),
            midRun && rawCreated > Date.now() - PENDING_TTL_MS,
            lastEventAt(s.id),
            STALL_MS
          );
          return {
            id: s.id,
            title: s.title || s.id,
            // sub-sessions (created by an agent task inside another session)
            // carry the parent link — the home list nests them under it
            parentId: s.parentID || null,
            // root-coord: the brain's card (status/headline/needs) for the
            // sessions it manages, and closed ones (hidden behind a toggle)
            ...treeFields(s),
            updated: s.time?.updated || 0,
            userAt,
            preview: lastText.slice(0, 80),
            lastRole,
            // full-text question check — the client only sees an 80-char
            // preview, which usually cuts off before the actual questions
            lastHasQ: lastText.includes('?'),
            // when the last visible message landed — the client compares it
            // against its local read marks to badge unread replies
            lastAt: last?.info?.time?.created || 0,
            // how much transcript this session holds — surfaced on the
            // delete-undo toast so a fat session announces itself while
            // it can still be restored
            msgs: msgs.length,
            // awaiting an answer: a run is live right now (definitive, tracked
            // in-flight by the proxy — survives restarts via disk), or the
            // transcript itself shows a run in flight AND it's fresh —
            // aborted/failed prompts stay that way forever and must not pin
            // the session as thinking. A brain-declared run counts too (voice
            // runs never pass the proxy)
            pending:
              rs.state === 'working' ||
              isRunLive(s.id) ||
              (midRun && rawCreated > Date.now() - PENDING_TTL_MS),
            state: rs.state,
            stateReason: rs.reason,
            stateSource: rs.source,
          };
        } catch {
          const rs = runState(s.state, isRunLive(s.id), false, 0, STALL_MS);
          return {
            id: s.id,
            title: s.title || s.id,
            parentId: s.parentID || null,
            ...treeFields(s),
            updated: s.time?.updated || 0,
            userAt: s.time?.user || s.time?.created || 0,
            preview: '',
            lastRole: '',
            lastHasQ: false,
            lastAt: 0,
            msgs: 0,
            pending: rs.state === 'working',
            state: rs.state,
            stateReason: rs.reason,
            stateSource: rs.source,
          };
        }
      })
    );
    enriched.sort((a, b) => (b.userAt || 0) - (a.userAt || 0));
    // never pin an empty list: a transient opencode scope/failure window must
    // not get cached as "no sessions" — the next poll retries instead
    if (enriched.length) setCache(enriched, gen);
    return NextResponse.json(enriched);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    // continue a terminal's conversation here: {attach: {kind, id, cwd, title?}} → THE bifrost
    // session on it (the same conversation both ways; the brain returns the one that exists,
    // picks the agent for the harness, checks the id and the folder and says plainly what is wrong)
    if (body?.attach?.id) {
      const r = await fetch(`${OC}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          harness: { kind: String(body.attach.kind || 'claude'), id: String(body.attach.id) },
          cwd: String(body.attach.cwd || ''),
          ...(body.attach.title ? { title: String(body.attach.title).slice(0, 80) } : {}),
          // a copy ("continue in a new session"): the original stays the terminal's
          ...(body.attach.fork ? { fork: true } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok)
        return NextResponse.json({ error: d.error || `brain ${r.status}` }, { status: r.status });
      bustCache();
      return NextResponse.json({ id: d.id, title: d.title });
    }
    const { name } = body;
    const title = String(name || '').slice(0, 80) || 'session';
    // slug `main` is reserved for THE MAIN session (/api/onboard creates it)
    if (slugify(title) === MAIN_SLUG) {
      return NextResponse.json({ error: 'the name "main" is reserved' }, { status: 409 });
    }
    // the roots sheet's ＋ on another computer: the brain makes it there, a proxy here
    const root = typeof body?.root === 'string' ? body.root.trim() : '';
    if (root && !ROOT_NAME.test(root)) {
      return NextResponse.json({ error: 'not a root name' }, { status: 400 });
    }
    // a role and an engine, when the client names them (without: the brain's default role, on
    // that role's default engine); the brain refuses an unknown one — its reason comes back
    const pick = (k: 'agent' | 'engine') =>
      typeof body?.[k] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body[k].trim())
        ? { [k]: body[k].trim() }
        : {};
    const r = await fetch(`${OC}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        ...(root ? { root } : {}),
        ...pick('agent'),
        ...pick('engine'),
      }),
    });
    const s = await r.json().catch(() => ({}));
    if (!r.ok) {
      const why = s?.error || `brain ${r.status} on /session`;
      return NextResponse.json({ error: String(why) }, { status: r.status < 500 ? r.status : 502 });
    }
    bustCache();
    return NextResponse.json({ id: s.id, title: s.title });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
