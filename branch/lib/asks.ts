/** The requests board (owner 11-26: "a board with card tool to remember what I have asked and when
 *  I asked; status can follow who what when, and if done, with git"). One card per owner ask.
 *  The brain's GET /asks does the work (root/src/asks.rs — the status rules live THERE, in one
 *  place); this file only names, orders and words what the brain sends. */

export type AskStatus = 'blocked' | 'stalled' | 'running' | 'asked' | 'done' | 'answered';

export type Ask = {
  id: string;
  /** the owner's own words, exact */
  text: string;
  /** ms since epoch */
  created: number;
  /** the session it was typed in */
  home: { id: string; title: string };
  /** the session that owns the work (the home one unless set) */
  session: { id: string; title: string };
  status: AskStatus;
  /** the brain's plain-words reason for the status */
  why: string;
  branch: string;
  commit: string;
  note: string;
  /** last activity of the owning session, ms (0 = unknown) */
  updated: number;
};

/** the order on the page: what needs you first, what is only a chat answer last */
export const GROUPS: { status: AskStatus; title: string; hint: string; open: boolean }[] = [
  { status: 'blocked', title: 'Needs you', hint: 'waiting on an answer or a fix', open: true },
  {
    status: 'stalled',
    title: 'Stalled',
    hint: 'busy, but nothing has moved for over 15 min',
    open: true,
  },
  { status: 'running', title: 'Working now', hint: 'someone is on it', open: true },
  { status: 'asked', title: 'Not started', hint: 'asked, no one has picked it up', open: true },
  { status: 'done', title: 'Done', hint: 'finished and landed in git', open: true },
  {
    status: 'answered',
    title: 'Answered in chat',
    hint: 'a reply came; nothing to build',
    open: false,
  },
];

export function groupAsks(
  asks: Ask[]
): { status: AskStatus; title: string; hint: string; open: boolean; asks: Ask[] }[] {
  return GROUPS.map((g) => ({ ...g, asks: asks.filter((a) => a.status === g.status) }));
}

/** "Nov 26, 21:36" — the day and the minute it was asked */
export function askedAt(ms: number, locale?: string): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day}, ${time}`;
}

export function shortSha(c: string): string {
  return c.slice(0, 8);
}

/** git was recorded for it: branch AND commit */
export function landed(a: Pick<Ask, 'branch' | 'commit'>): boolean {
  return !!a.branch && !!a.commit;
}

/** a title the owner would call it — the brain's default titles are session ids' tails */
export function sessionLabel(s: { id: string; title: string }): string {
  return s.title.trim() || `session ${s.id.slice(-6)}`;
}

export function parseAsks(raw: unknown): Ask[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is Ask =>
      !!a && typeof a.id === 'string' && typeof a.text === 'string' && typeof a.status === 'string'
  );
}
