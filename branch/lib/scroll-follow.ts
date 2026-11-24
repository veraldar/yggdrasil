/**
 * Chat-style follow for a transcript (owner 11-24): an arriving message scrolls the view ONLY
 * when the reader already sits at (or within FOLLOW_PX of) the bottom. Scrolled up, the text
 * being read stays exactly where it is on screen — even when the page's message window slides
 * (the newest 60: every arrival drops the oldest one off the top) — and a small "new messages ↓"
 * pill offers the jump. Pure helpers here; the DOM glue lives in app/session/[slug]/page.tsx.
 */

/** how close to the bottom still counts as "at the bottom" (px) */
export const FOLLOW_PX = 120;

export type ScrollBox = { scrollHeight: number; scrollTop: number; clientHeight: number };

/** the reader is at (or near) the bottom: arriving messages follow */
export function atBottom(b: ScrollBox, px = FOLLOW_PX): boolean {
  return b.scrollHeight - b.scrollTop - b.clientHeight < px;
}

type Keyed = { id?: string; time: number; role?: string; queued?: boolean };

/** A message's React key: its id. An index key made a sliding window repaint every row with its
 *  neighbour's message (the text under the reader moved). Local rows (an echo, a queued message:
 *  no id yet) key on their time, plus the index so two can never collide. */
export function msgKey(m: Keyed, i: number): string {
  return m.id || `${m.queued ? 'q' : 'e'}-${m.role || ''}-${m.time}-${i}`;
}

/** what identifies the newest message, to tell "a message arrived at the end" */
export function lastKey(list: Keyed[]): string {
  const m = list[list.length - 1];
  return m ? m.id || `${m.role || ''}-${m.time}` : '';
}

/** the reader's place: a message id and where its top sits below the scroller's top (px) */
export type Anchor = { id: string; y: number };

/** the first message still showing (its bottom below the view's top), in document order */
export function pickAnchor(
  items: Iterable<{ id: string; top: number; bottom: number }>,
  viewTop: number
): Anchor | null {
  for (const it of items) if (it.bottom > viewTop) return { id: it.id, y: it.top - viewTop };
  return null;
}

/** how far to scroll (px, + = down) so the anchor sits where it sat; 0 when it is gone */
export function anchorShift(a: Anchor, nowY: number | null): number {
  return nowY == null ? 0 : nowY - a.y;
}
