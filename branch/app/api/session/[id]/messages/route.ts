/**
 * GET  /api/session/[id]/messages → transcript for one session
 * POST /api/session/[id]/prompt   → send text/images/files to the session
 */
import { NextResponse } from 'next/server';
import {
  FILES_PER_MESSAGE,
  HASH_RE,
  cleanRefs,
  fileUrl,
  isImageMime,
  refViews,
  urlHash,
} from '@/lib/file-ref';
import { ocFetch, PIN_HEADER, resolveId, sessionGone } from '@/lib/oc';
import { hideNarration, stripStationLine } from '@/lib/station-hide';
import { bustCache } from '@/lib/oc-cache';
import { buildParts, forward, runEnded } from '@/lib/oc-forward';
import { isRunLive, liveSince, runEndedAt } from '@/lib/oc-live';
import { enqueue, queuedItems } from '@/lib/oc-queue';
import { bustSearchResults, bustTranscript, stripCtx } from '@/lib/oc-transcript';
import { ensureWatchdog, lastEventAt } from '@/lib/oc-watchdog';
import { PENDING_TTL_MS } from '@/lib/pending-ttl';

export const dynamic = 'force-dynamic';

/** a stored file part's hash: the REF's own, or the one its `/file/<hash>` url names */
function partHash(p: any): string {
  return typeof p.hash === 'string' && HASH_RE.test(p.hash) ? p.hash : urlHash(String(p.url || ''));
}

/** what the phone shows for a message's file parts: images (a data URL as stored, a stored file
 *  as its /api/file url) and the other files the brain keeps, as chips that open them */
function fileViews(parts: any[]) {
  const images: (string | null)[] = [];
  const files: { name: string; mime: string; size: number; url: string }[] = [];
  for (const p of parts) {
    const hash = p.type === 'file' || p.type === 'image' ? partHash(p) : '';
    const root = typeof p.root === 'string' ? p.root : undefined;
    if (p.type === 'image' || isImageMime(p.mime)) {
      images.push(hash ? fileUrl({ hash, root, mime: p.mime }) : p.url || p.data || null);
    } else if (hash) {
      const name = String(p.filename || 'file');
      const mime = String(p.mime || 'application/octet-stream');
      files.push({
        name,
        mime,
        size: Number(p.size) || 0,
        url: fileUrl({ hash, root, mime, name }, true),
      });
    }
  }
  return { images, files };
}

/** full log: one tool call as a line — its name, the input's telling field,
 *  the agent it started (session_start), a status unless it completed:
 *  `session_start → "Wordfreq CLI" (build)` */
function toolLine(p: any): string {
  const st = p.state || {};
  const i = st.input || {};
  const fields = [i.title, i.description, i.filePath, i.path, i.command, i.query, i.url, i.id];
  const key = fields.find(Boolean) ?? st.title ?? '';
  const k = String(key).replace(/\s+/g, ' ').trim();
  return (
    `${p.tool || 'tool'}${k ? ` → "${k.length > 80 ? `${k.slice(0, 79)}…` : k}"` : ''}` +
    `${i.agent || i.profile ? ` (${i.agent || i.profile})` : ''}` +
    `${st.status && st.status !== 'completed' ? ` · ${st.status}` : ''}`
  );
}

/** The sender of a user message that the owner did not write: `{ from }` (a session — its id,
 *  title, and root when another root's), `{ auto: true }` (the brain itself), else nothing. */
function senderOf(meta: any): {
  from?: { session: string; title: string; root?: string };
  auto?: true;
} {
  const f = meta?.from;
  if (f && typeof f.session === 'string')
    return {
      from: {
        session: f.session,
        title: typeof f.title === 'string' ? f.title : '',
        ...(typeof f.root === 'string' && { root: f.root }),
      },
    };
  if (typeof meta?.origin === 'string') return { from: { session: meta.origin, title: '' } };
  if (meta?.auto === true) return { auto: true };
  return {};
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    ensureWatchdog(); // the event stream must be up for X-Run-Last-Event to mean anything
    const { id } = await ctx.params;
    const sid = await resolveId(id, req.headers.get(PIN_HEADER));
    // ?log=1: the full log — the brain's internal turns too (?internal=1) and
    // each message's tool calls as `log` lines. Default answer unchanged
    const log = new URL(req.url).searchParams.get('log') === '1';
    // ?errors=1: a turn that failed is listed too, with the brain's reason (`error`) — the live
    // page of a terminal's conversation says why a message sent from it never got there
    const errors = new URL(req.url).searchParams.get('errors') === '1';
    const msgs = await ocFetch(`/session/${sid}/message${log ? '?internal=1' : ''}`);
    const out = msgs.map((m: any) => {
      const text = stripStationLine(stripCtx(
        (m.parts || [])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text || '')
          .join('\n')
          .trim()
      ));
      // tool-only steps stay invisible on the phone: the busy indicator
      // already shows activity, ⚙ lines were just clutter (user req)
      return {
        id: m.info?.id,
        // a reply: the message it answers (with messages waiting, not the one just before it)
        parent: m.info?.parentID || undefined,
        role: m.info?.role || m.role,
        text,
        ...fileViews(m.parts || []),
        time: m.info?.time?.created || 0,
        modality: m.info?.modality === 'voice' ? 'voice' : undefined,
        firstDelta: m.info?.time?.first_delta,
        // assistant replies stream: time.completed only lands when the run
        // finished. The hands-free auto-listen must speak COMPLETE replies —
        // speaking a growing message mid-run reads out a fragment.
        done:
          (m.info?.role || m.role) === 'assistant' ? !!m.info?.time?.completed : undefined,
        autoReply: m.info?.meta?.autoReply === true ? true : undefined,
        // a run that was stopped or failed: its text is what was there when it ended (L16: a
        // held turn's partial answer is never said aloud)
        stopped: (m.info?.role || m.role) === 'assistant' && m.info?.error ? true : undefined,
        // who wrote it when not the owner: another session (here or on another root), or the
        // brain itself (a report, a wake-up). Older messages carry only the sender's id (origin)
        ...((m.info?.role || m.role) === 'user' && senderOf(m.info?.meta)),
        ...(errors && m.info?.error && { error: String(m.info.error?.data?.message || m.info.error?.name || 'error') }),
        ...(log && {
          internal: m.info?.meta?.internal === true ? true : undefined,
          log: (m.parts || []).filter((p: any) => p.type === 'tool').map(toolLine),
        }),
      };
    });
    // older messages name the sender by id only: its title, from the session list (one call)
    if (out.some((m: any) => m.from && !m.from.title)) {
      const list: any[] = await ocFetch('/session').catch(() => []);
      const titles = new Map(list.map((x: any) => [x.id, x.title || '']));
      for (const m of out) if (m.from && !m.from.title) m.from.title = titles.get(m.from.session) || '';
    }
    const all = out.filter(
      (m: any) =>
        !((m.role || m.info?.role) === 'assistant' && hideNarration(m.text)) &&
        (m.text || m.images.length || m.files.length || m.log?.length || m.error)
    );
    // run state for the busy indicator: opencode emits one assistant message
    // per step, so "an assistant message landed" ≠ "the run is done". The run
    // is done only when the last relevant message is an assistant message with
    // time.completed set (0 while a step is in progress or the last message
    // is the user's). State string lets the client detect "unchanged since
    // last poll" without trusting wall clocks.
    // The last RAW message alone lies when a follow-up prompt stacks on top
    // of an in-flight run: opencode persists the new user message instantly
    // and serializes its run behind the one still executing (voice turns
    // land seconds apart). Last-raw is then the stacked prompt (|0|user),
    // the client reads "runner never picked it up", and its 30s wedge guard
    // aborts a LIVE session — killing the in-flight run and the queued
    // prompt (opencode drops its queue on abort). Scan back for the last
    // assistant message: fresh and un-completed means a run is genuinely in
    // progress and IT is the true run state (|0|assistant). Stale debris
    // (crashed opencode) stays out via the same TTL the client arms with.
    let stateMsg = msgs[msgs.length - 1];
    for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 8; i--) {
      const m = msgs[i];
      if ((m.info?.role || m.role || '') !== 'assistant') continue;
      const done = m.info?.time?.completed || 0;
      if (
        !done &&
        (m.info?.time?.created || 0) > Date.now() - PENDING_TTL_MS
      ) {
        stateMsg = m;
      }
      break; // the LAST assistant message decides — older ones are history
    }
    const lastRole = stateMsg?.info?.role || stateMsg?.role || '';
    const lastDone = lastRole === 'assistant' ? stateMsg?.info?.time?.completed || 0 : 0;
    const runState = `${stateMsg?.info?.id || stateMsg?.id || 'none'}|${lastDone}|${lastRole}`;
    // self-heal zombie live entries: a proxy restart orphans the in-flight
    // POST, so nothing ever calls markRunEnd — blinking dot + "queued"
    // everything, forever. opencode serializes per session, so a last
    // assistant step completed >2min ago proves the run is over (live runs
    // legitimately pause between steps — the grace period guards those).
    if (!log && isRunLive(sid) && lastDone > 0 && Date.now() - lastDone > 120_000) {
      console.log(
        `[oc] zombie run entry healed ${sid} (idle ${Math.round((Date.now() - lastDone) / 1000)}s)`
      );
      runEnded(sid, id);
    }
    // long sessions: default to the latest window, older pages load on demand
    const limit = Number(new URL(req.url).searchParams.get('limit') || 0);
    const body = limit > 0 ? all.slice(-limit) : all;
    // messages waiting in the proxy queue render like the transcript (with
    // queued: true) — refresh-proof, no client-side echo needed
    const queued = queuedItems(sid).map((q) => {
      const v = refViews(q.refs || []);
      return {
        role: 'user',
        text: q.text,
        images: [...(q.images || []), ...v.images],
        files: v.files,
        time: q.at,
        queued: true,
      };
    });
    return NextResponse.json([...body, ...queued], {
      headers: {
        'X-Total-Count': String(all.length),
        'X-Run-State': runState,
        // definitive live-run flag: the proxy tracks its own in-flight async
        // prompts — the client can't tell "thinking between steps" from "done"
        'X-Run-Live': isRunLive(sid) ? '1' : '0',
        // epoch ms the live run started (true elapsed across page refreshes)
        'X-Run-Live-Since': String(liveSince(sid) || 0),
        // epoch ms the last run finished — an authoritative "the run you are
        // waiting on is over" even when opencode leaves completed=0 behind
        'X-Run-Ended': String(runEndedAt(sid) || 0),
        // epoch ms of the last opencode stream event — the client's wedge
        // escape keys off this: a busy session with NO events and NO live
        // prompt is a corpse, whatever role the last message claims
        'X-Run-Last-Event': String(lastEventAt(sid) || 0),
        // the session this slug resolved to — the page pins it and sends it
        // back as PIN_HEADER from then on (herdr §1.4)
        'X-Session-Id': sid,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return sessionGone(e) ?? NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    ensureWatchdog(); // global-guarded across module graphs (oc-watchdog)
    const { id } = await ctx.params;
    const sid = await resolveId(id, req.headers.get(PIN_HEADER));
    const body = await req.json();
    const async = body.async === true;
    // files the brain keeps ride as REFs (uploaded first, /api/file/upload)
    const refs = cleanRefs(body.refs);
    if (!refs) {
      const many = Array.isArray(body.refs) && body.refs.length > FILES_PER_MESSAGE;
      return NextResponse.json(
        {
          error: many
            ? `at most ${FILES_PER_MESSAGE} files in one message`
            : 'a file in this message is broken',
        },
        { status: 400 }
      );
    }
    body.refs = refs;
    const parts = buildParts(body);
    if (!parts.length) return NextResponse.json({ error: 'empty' }, { status: 400 });

      if (async) {
      if (isRunLive(sid)) {
        // a run is in flight: hold the message in the proxy queue. opencode's
        // own queue stalls forever after an abort — here the run's end
        // (abort included) automatically forwards the next queued message
        enqueue(sid, {
          text: String(body.text || ''),
          images: body.images || [],
          files: body.files || [],
          ...(refs.length && { refs }),
        });
        console.log(`[queue] enqueue ${sid} (depth ${queuedItems(sid).length})`);
        bustCache();
        bustTranscript(sid);
        bustSearchResults();
        return NextResponse.json({ queued: true });
      }
      // fire-and-forget: reply lands via transcript polling. The POST only
      // resolves when the whole run finishes — that window IS the live-run
      // flag, and its end fires Web Push (wakes a frozen phone) + cache bust
      forward(sid, id, body);
      bustCache();
      bustTranscript(sid);
      bustSearchResults();
      return NextResponse.json({ queued: true });
    }

    const reply = await ocFetch(`/session/${sid}/message`, {
      method: 'POST',
      body: JSON.stringify({
        parts,
        ...(body.modality === 'voice' ? { modality: 'voice' } : {}),
      }),
    });
    bustCache();
    bustTranscript(sid);
    bustSearchResults();
    const out = (reply.parts || [])
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('\n')
      .trim();
    return NextResponse.json({ text: out });
  } catch (e) {
    return sessionGone(e) ?? NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
