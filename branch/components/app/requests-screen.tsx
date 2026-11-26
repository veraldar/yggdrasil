'use client';

/** /requests — everything the owner asked, one card each: the words as typed, when, who has it,
 *  how it stands (needs you / stalled / working / not started / done / answered), and for a done
 *  one the branch + commit it landed in. Read from the brain's GET /asks (root/src/asks.rs holds
 *  the status rules); nothing here is typed in by hand. Plain words, no ids, no logs. */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { LineIcon } from '@/components/line-icon';
import {
  type Ask,
  askedAt,
  groupAsks,
  landed,
  parseAsks,
  sessionLabel,
  shortSha,
} from '@/lib/asks';
import { slugify } from '@/lib/slug';

const TONE: Record<string, string> = {
  blocked: 'var(--oz-danger)',
  stalled: 'var(--oz-active)',
  running: 'var(--oz-success)',
  asked: 'var(--oz-dim)',
  done: 'var(--oz-text)',
  answered: 'var(--oz-dim)',
};
const WORD: Record<string, string> = {
  blocked: 'needs you',
  stalled: 'stalled',
  running: 'working',
  asked: 'not started',
  done: 'done',
  answered: 'answered',
};
/** a long ask shows its first lines; a tap opens the rest */
const CLAMP = 280;
/** a group shows this many cards, then a "show more" */
const PAGE = 25;

function Card({ a }: { a: Ask }) {
  const [full, setFull] = useState(false);
  const long = a.text.length > CLAMP;
  const shown = long && !full ? `${a.text.slice(0, CLAMP).trimEnd()}…` : a.text;
  const who = sessionLabel(a.session);
  return (
    <li
      className="oz-box px-2.5 py-2"
      style={{ borderLeft: `3px solid ${TONE[a.status]}` }}
      data-testid="ask-card"
      data-status={a.status}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-[var(--oz-dim)]">
        <span
          className="font-bold tracking-wider uppercase"
          style={{ color: TONE[a.status] }}
          data-testid="ask-status"
        >
          {WORD[a.status]}
        </span>
        <time dateTime={new Date(a.created).toISOString()} data-testid="ask-when">
          asked {askedAt(a.created)}
        </time>
      </div>
      <p
        className="text-[13px] leading-snug break-words whitespace-pre-wrap"
        data-testid="ask-text"
      >
        {shown}
      </p>
      {long && (
        <button
          onClick={() => setFull(!full)}
          className="mt-1 text-[11px] text-[var(--oz-info)] underline"
        >
          {full ? 'show less' : 'show all'}
        </button>
      )}
      <div className="mt-1.5 flex flex-col gap-0.5 text-[11px] text-[var(--oz-dim)]">
        <div className="min-w-0 truncate">
          {a.status === 'answered' || a.session.id === a.home.id ? 'in ' : 'handled by '}
          <Link
            href={`/session/${slugify(who) || a.session.id}?id=${a.session.id}`}
            className="text-[var(--oz-text)] underline"
            data-testid="ask-session"
          >
            {who}
          </Link>
        </div>
        <div>{a.why}</div>
        {a.note && <div className="break-words">{a.note}</div>}
        {landed(a) && (
          <div className="min-w-0 break-all text-[var(--oz-text)]" data-testid="ask-git">
            landed in <b>{a.branch}</b> · <code>{shortSha(a.commit)}</code>
          </div>
        )}
      </div>
    </li>
  );
}

export function RequestsScreen() {
  const [asks, setAsks] = useState<Ask[] | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState<Record<string, number>>({});
  const [openG, setOpenG] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/asks', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      setAsks(parseAsks(await r.json()));
      setErr('');
    } catch {
      setErr("can't reach the brain's list of asks — pull to try again");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const groups = groupAsks(asks ?? []);

  return (
    <main
      className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-8"
      data-testid="requests-view"
    >
      <header className="oz-head">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2.5"
          aria-label="back to sessions"
          data-testid="requests-back"
        >
          <span className="oz-k sm">
            <LineIcon name="back" size={13} />
          </span>
          <h1 className="truncate text-[13px]">requests</h1>
        </Link>
        <button
          onClick={() => void load()}
          aria-label="refresh requests"
          className={`oz-k sm ${loading ? 'ok' : ''}`}
        >
          <LineIcon name="refresh" size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      <p className="mb-2 text-[11px] text-[var(--oz-dim)]">
        Everything you asked, in your words, newest first within each group.
      </p>
      {err && (
        <div className="oz-box mb-2 px-2.5 py-2 text-xs text-[var(--oz-danger)]" role="alert">
          {err}
        </div>
      )}
      {asks === null && !err && (
        <div className="pt-6 text-center text-xs text-[var(--oz-dim)]">loading…</div>
      )}
      {asks?.length === 0 && (
        <div className="pt-6 text-center text-xs text-[var(--oz-dim)]">nothing asked yet</div>
      )}

      {groups
        .filter((g) => g.asks.length > 0)
        .map((g) => {
          const open = openG[g.status] ?? g.open;
          const n = more[g.status] ?? PAGE;
          return (
            <section key={g.status} className="mb-3" data-testid={`group-${g.status}`}>
              <button
                onClick={() => setOpenG({ ...openG, [g.status]: !open })}
                aria-expanded={open}
                className="mb-1.5 flex w-full items-baseline justify-between gap-2 text-left"
                data-testid={`group-head-${g.status}`}
              >
                <span
                  className="text-[12px] font-bold tracking-wider whitespace-nowrap uppercase"
                  style={{
                    color: TONE[g.status],
                  }}
                >
                  {g.title} · {g.asks.length}
                </span>
                <span className="text-[10px] text-[var(--oz-dim)]">
                  {open ? g.hint : 'tap to open'}
                </span>
              </button>
              {open && (
                <>
                  <ul className="flex flex-col gap-1.5">
                    {g.asks.slice(0, n).map((a) => (
                      <Card key={a.id} a={a} />
                    ))}
                  </ul>
                  {g.asks.length > n && (
                    <button
                      onClick={() => setMore({ ...more, [g.status]: n + PAGE })}
                      className="oz-k sm mt-1.5 w-full"
                    >
                      show {Math.min(PAGE, g.asks.length - n)} more
                    </button>
                  )}
                </>
              )}
            </section>
          );
        })}
    </main>
  );
}
