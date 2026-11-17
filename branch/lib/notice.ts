/** What a notification says (owner 11-17): a short digest of the session's last reply — its name,
 *  what happened (or the question it waits on) — never "reply ready" or a raw dump. The brain makes
 *  the digest (GET /session/{id}/notice: the turn's status, headline and question, one small pass
 *  per reply); the words on the phone are put together here. Both the push (lib/push.ts) and the
 *  in-page notification (lib/notify.ts, through /api/notify?notice=1) use it. */
import { OC, resolveId } from './oc';
import { isMainSlug } from './tree-first';

export type Notice = { title: string; body: string };
type Digest = { title?: string; status?: string; headline?: string; needs?: string };

const MAX = 180;

/** One line a lock screen can show: no markdown marks, no line breaks, clipped. */
export function plain(s: string, max = MAX): string {
  const t = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+>]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|\*|`|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/[`*]/g, '')
    .replace(/#{2,}\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const word = cut.lastIndexOf(' '); // a whole word last, when there is one not too far back
  return `${(word > max * 0.7 ? cut.slice(0, word) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** The words for one digest: the session's name (with "needs you" / "failed" / "stopped" when it
 *  is that), then the question it waits on, else what happened. */
export function compose(slug: string, d: Digest): Notice {
  const name = isMainSlug(slug) ? 'MAIN' : plain(d.title || slug, 60);
  const needs = plain(d.needs || '');
  const what = plain(d.headline || '');
  const state = needs
    ? 'needs you'
    : d.status === 'failed'
      ? 'failed'
      : d.status === 'aborted'
        ? 'stopped'
        : '';
  return { title: state ? `${name} · ${state}` : name, body: needs || what || 'replied' };
}

// one digest per session at a time: the push and the in-page notification of one reply share it
const inflight = new Map<string, Promise<Notice>>();

export function noticeFor(slug: string, sid?: string): Promise<Notice> {
  const hit = inflight.get(slug);
  if (hit) return hit;
  const p = (async (): Promise<Notice> => {
    try {
      const id = sid || (await resolveId(slug));
      const r = await fetch(`${OC}/session/${encodeURIComponent(id)}/notice`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(45_000),
      });
      if (r.ok) return compose(slug, (await r.json()) as Digest);
    } catch {
      /* the brain has no digest (an older one, or it is down): the plain words */
    }
    return compose(slug, {});
  })();
  inflight.set(slug, p);
  void p.finally(() => setTimeout(() => inflight.delete(slug), 5_000));
  return p;
}
