'use client';

/** The home screen's own parts, one drawing for every computer (owner 11-24: "the button should
 *  be at the same place … I want the same layout"): `/` is the home screen of the tree, and
 *  `/roots/<name>` is the home screen of that computer — the same header and the same band,
 *  from here, so they cannot drift apart.
 *    HomeHead  the name (tap → its settings) · roots (a mark: a computer is not up to date) ·
 *              artifacts (unseen count) · refresh
 *    HomeBand  the tree as a quiet band; its chip counts the working and filters to them */
import Link from 'next/link';
import { LineIcon } from '@/components/line-icon';
import { BAND_VIEWBOX, YggTree } from '@/components/ygg';

export function HomeHead({
  title,
  settingsHref,
  artifactsHref,
  unseen,
  joins,
  behind = 0,
  loading,
  gone = false,
  onRoots,
  onRefresh,
}: {
  /** what sits top left: BIFROST on the tree's home screen, a computer's name on its own */
  title: string;
  settingsHref: string;
  artifactsHref: string;
  /** artifacts not opened yet (the badge) */
  unseen: number;
  /** computers waiting to join (the badge on the roots key) */
  joins: number;
  /** computers that run another build than home (a square mark on the roots key) */
  behind?: number;
  loading: boolean;
  /** that computer is off: its name greys */
  gone?: boolean;
  onRoots: () => void;
  onRefresh: () => void;
}) {
  return (
    <header className="oz-head">
      {/* the name alone, full caps, no sign before it — it is the way into settings */}
      <Link
        href={settingsHref}
        className={`oz-brand min-w-0 truncate ${gone ? 'oz-gone' : ''}`}
        aria-label={`${title} — settings`}
        data-testid="home-title"
      >
        <h1 className="oz-brand truncate uppercase">{title}</h1>
      </Link>
      <div className="flex flex-none items-center gap-1.5">
        <button
          onClick={onRoots}
          aria-label="roots"
          className={`oz-k sm ${joins > 0 ? 'text-[var(--oz-text)]' : ''} ${behind > 0 ? 'mark' : ''}`}
          data-testid="roots-key"
          data-behind={behind || undefined}
        >
          <LineIcon name="roots" size={15} />
          {joins > 0 && (
            <span data-testid="joins-badge" className="oz-badge">
              {joins}
            </span>
          )}
        </button>
        <Link
          href={artifactsHref}
          aria-label={`artifacts — ${unseen} unseen`}
          className={`oz-k sm ${unseen > 0 ? 'text-[var(--oz-text)]' : ''}`}
          data-testid="artifacts-key"
        >
          <LineIcon name="artifact" size={15} />
          {unseen > 0 && (
            <span data-testid="artifact-badge" className="oz-badge">
              {unseen}
            </span>
          )}
        </Link>
        <button
          onClick={onRefresh}
          aria-label="refresh sessions"
          className={`oz-k sm ${loading ? 'ok' : ''}`}
          data-testid="refresh-key"
        >
          <LineIcon name="refresh" size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
    </header>
  );
}

/** The tree, once, as a quiet band — one thought walks it at a time while something works; it
 *  falls still when nothing does. The chip in its corner taps to a working-only list, again to
 *  clear (11-23); with the filter on the band's square goes amber — a held state. */
export function HomeBand({
  name,
  working,
  walk,
  shared = false,
  only,
  onToggle,
  testId,
}: {
  /** whose band: "your box" on the tree's home screen, a computer's name on its own */
  name: string;
  working: number;
  /** a branch works: the crown walks */
  walk: boolean;
  /** the roots walk too (MAIN works): the band shares their clock */
  shared?: boolean;
  only: boolean;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <figure
      className={`oz-band oz-ygg -mx-3 mb-2.5 ${working ? 'live' : ''} ${walk ? 'walk' : ''}`}
      data-shared={shared ? '' : undefined}
      aria-label={working ? `${name} — ${working} working` : `${name} — nothing working`}
      data-testid={testId}
    >
      <YggTree viewBox={BAND_VIEWBOX} slice />
      <button
        type="button"
        onClick={() => working > 0 && onToggle()}
        aria-pressed={only}
        aria-label={
          working
            ? `${working} working — ${only ? 'show every session' : 'show only the working'}`
            : `${name} — nothing working`
        }
        data-testid="working-filter"
        className={`oz-cap ${only ? 'on' : ''}`}
      >
        <i />
        {working ? `${working} working` : 'all quiet'}
      </button>
    </figure>
  );
}
