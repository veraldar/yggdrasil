'use client';

/** /artifacts — everything the agents dropped (this checkout's artifacts/,
 *  plus the main tree's when served from a worktree — tagged "main") and
 *  the app's built-ins (tagged), newest first, day-grouped. Unread = file mtime newer than the version
 *  you last opened (phone-local watermarks, lib/artifact-read). Tapping a
 *  row opens the artifact right here — same rendering rules as the chat —
 *  and marks it seen, which drops the home bell badge.
 *
 *  Defaults to an html-only gallery with live thumbnails (the design
 *  mockups are what you come here for); "all" shows every file.
 *
 *  One screen for every computer (owner 11-24: a computer's artifacts open the way /artifacts
 *  opens from home): `/artifacts` is the tree's, `/roots/<name>/artifacts` shows `root`'s files
 *  — the same page, its list from GET /api/roots/<name>/artifacts, its files fetched from that
 *  computer (`?root=`), back to that computer's own page. A computer that is off keeps its
 *  last known list, greyed: nothing opens. */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Streamdown } from 'streamdown';
import { LineIcon } from '@/components/line-icon';
import { HOME_ROOT_KEY } from '@/components/roots-sheet';
import { glyphOf, kindOf } from '@/lib/artifact-kind';
import {
  countUnseen,
  forRoot,
  lastSeen,
  markAllSeen,
  markSeen,
  seenInit,
} from '@/lib/artifact-read';
import { type ThumbTicket, thumbQueue } from '@/lib/thumb-queue';
import { useRootWorld } from '@/lib/worlds';

/** a row of the gallery: the home list's ArtifactEntry, or what another computer lists */
type Entry = { name: string; mtime: number; size: number; type?: string; source?: string };

// instant paint on back-navigation, same trick as the sessions list
const CACHE_KEY = 'oz-artifacts';

/** provenance tag — this checkout's own files go untagged */
const SOURCE_TAG: Record<string, string> = { main: 'main', builtin: 'built-in' };

function SourceTag({ f }: { f: Entry }) {
  const tag = SOURCE_TAG[f.source || ''];
  if (!tag) return null;
  return (
    <span data-testid="artifact-source" className="shrink-0 text-[10px] text-[var(--oz-dim)]">
      {tag}
    </span>
  );
}

function fmtTime(t: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

function dayLabel(t: number): string {
  const d = new Date(t).toDateString();
  if (d === new Date().toDateString()) return 'today';
  if (d === new Date(Date.now() - 86400e3).toDateString()) return 'yesterday';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Full-page viewer for the non-html artifacts — rendering rules match the
 *  chat (session-message ArtifactView): md rendered, text fetched and
 *  capped, pdf a tap-out card, audio inline. Html goes straight to its
 *  raw URL (/api/artifact/<name>) — browser renders it full screen. */
function Viewer({ file, src }: { file: Entry; src: string }) {
  const kind = kindOf(file.name);
  const [text, setText] = useState<string | null>(null);
  const needsText = kind === 'md' || kind === 'text';

  useEffect(() => {
    if (!needsText) return;
    let live = true;
    fetch(src)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => live && setText(t))
      .catch(() => live && setText(null));
    return () => {
      live = false;
    };
  }, [src, needsText]);

  if (kind === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={file.name}
        className="max-h-[calc(100dvh-10rem)] w-full border border-[var(--oz-border)] object-contain"
      />
    );
  }
  if (kind === 'audio') {
    return <audio controls src={src} className="w-full" preload="metadata" />;
  }
  if (kind === 'pdf') {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="oz-chip text-[var(--oz-info)]">
        <LineIcon name="artifact" size={13} />
        {file.name} — tap to view
      </a>
    );
  }
  if (text === null) return <div className="text-xs text-[var(--oz-dim)]">loading…</div>;
  const body = text.length > 20000 ? `${text.slice(0, 20000)}…` : text;
  return (
    <div className="oz-box max-h-[calc(100dvh-10rem)] overflow-auto px-2 py-1">
      {kind === 'md' ? (
        <div className="text-sm">
          <Streamdown>{body}</Streamdown>
        </div>
      ) : (
        <pre className="text-xs break-words whitespace-pre-wrap text-[var(--oz-text)]/85">
          {body}
        </pre>
      )}
    </div>
  );
}

/** Live thumbnail for an html artifact: the real page in a scriptless
 *  iframe, scaled into a 3:2 card (top-left corner at 25%).
 *
 *  Viewport-gated (IntersectionObserver, 120px lookahead) + bounded concurrency
 *  (thumbQueue, max 4 in flight): Chromium's native loading="lazy" uses a
 *  ~2500px margin, which eagerly fired all 45+ cards (6.7 MB) at once on a
 *  360px phone and jammed the single ordered pinned DataChannel for 10+ s.
 *  Now only visible/imminent cards mount their iframe, 4 at a time, and cards
 *  scrolled past before starting drop out of the queue.
 *
 *  sandbox="allow-same-origin" keeps scripts off while letting sw.js carry the
 *  load over the pinned channel end-to-end. */
function HtmlThumb({ name, src }: { name: string; src: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const ticketRef = useRef<ThumbTicket | null>(null);
  const grantedRef = useRef(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (mounted) return;
    const el = hostRef.current;
    const enqueue = () => {
      if (ticketRef.current || grantedRef.current) return;
      ticketRef.current = thumbQueue.request(() => {
        grantedRef.current = true;
        setMounted(true);
      });
    };
    const dequeue = () => {
      if (!ticketRef.current || grantedRef.current) return;
      ticketRef.current.cancel();
      ticketRef.current = null;
    };
    if (!el || typeof IntersectionObserver === 'undefined') {
      enqueue();
      return dequeue;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) enqueue();
        else dequeue();
      },
      { rootMargin: '120px 0px' }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      dequeue();
    };
  }, [mounted]);

  useEffect(() => {
    return () => {
      ticketRef.current?.cancel();
      ticketRef.current = null;
    };
  }, []);

  const finish = () => {
    ticketRef.current?.done();
    ticketRef.current = null;
  };

  return (
    <div
      ref={hostRef}
      data-testid="artifact-thumb"
      data-thumb-mounted={mounted ? '1' : '0'}
      className="relative aspect-[3/2] w-full overflow-hidden bg-[var(--oz-surface-hover)]"
    >
      {mounted && (
        <iframe
          sandbox="allow-same-origin"
          scrolling="no"
          aria-hidden="true"
          tabIndex={-1}
          src={src}
          title={`${name} preview`}
          onLoad={finish}
          onError={finish}
          className="pointer-events-none absolute top-0 left-0 h-[400%] w-[400%] origin-top-left scale-[.25] border-0 bg-white"
        />
      )}
    </div>
  );
}

export function ArtifactsScreen({ root = '' }: { root?: string }) {
  // a computer's own page wears the world picked for it; the tree's page the app's
  return root ? <RootWorld root={root} /> : <Gallery root="" />;
}

function RootWorld({ root }: { root: string }) {
  useRootWorld(root);
  return <Gallery root={root} />;
}

function Gallery({ root }: { root: string }) {
  const cacheKey = root ? `${CACHE_KEY}:${root}` : CACHE_KEY;
  const [files, setFiles] = useState<Entry[]>(() => {
    try {
      const raw = sessionStorage.getItem(cacheKey);
      return raw ? (JSON.parse(raw) as Entry[]) : [];
    } catch {
      return [];
    }
  });
  // another computer (not the home root): its files come from there, its watermarks are its own
  const [remote, setRemote] = useState(() => {
    try {
      return !!root && localStorage.getItem(HOME_ROOT_KEY) !== root;
    } catch {
      return !!root;
    }
  });
  // off right now: the last known list, greyed — nothing opens (never true for the home root)
  const [off, setOff] = useState(false);
  const [open, setOpen] = useState<Entry | null>(null);
  // html-only gallery is the default — that's what agents make for you;
  // "all" reveals everything else (md, png, wav, diffs…)
  const [filter, setFilter] = useState<'html' | 'all'>('html');
  const loadInFlightRef = useRef(false);
  const there = remote ? root : null;
  const srcOf = (name: string) =>
    `/api/artifact/${encodeURIComponent(name)}${there ? `?root=${encodeURIComponent(there)}` : ''}`;
  /** the watermark's name for a file (lib/artifact-read forRoot) */
  const seenName = (name: string) => (there ? `${there}/${name}` : name);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    try {
      const r = await fetch(
        root ? `/api/roots/${encodeURIComponent(root)}/artifacts` : '/api/artifact',
        {
          cache: 'no-store',
          signal: AbortSignal.timeout(12_000),
        }
      );
      const d = (await r.json()) as
        Entry[] | { home?: boolean; reachable?: boolean; artifacts?: Entry[] };
      if (!r.ok) return;
      const list = Array.isArray(d) ? d : (d.artifacts ?? []);
      const isRemote = !!root && !Array.isArray(d) && d.home !== true;
      setRemote(isRemote);
      setOff(isRemote && !Array.isArray(d) && d.reachable === false);
      setFiles(list);
      // first run mercy: everything already on disk counts as seen
      seenInit(forRoot(isRemote ? root : null, list));
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify(list));
      } catch {
        /* quota — skip cache */
      }
    } catch {
      /* transient — keep showing the stale list */
    } finally {
      loadInFlightRef.current = false;
    }
  }, [root, cacheKey]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (!document.hidden && !open) void load();
    }, 8000);
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load, open]);

  // recompute unread after every seen-marking — watermarks live in
  // localStorage, so a tick is all the render needs
  const [, setTick] = useState(0);
  const touch = useCallback(() => setTick((n) => n + 1), []);
  // html goes to its raw URL — the browser IS the full-screen page; the
  // in-page viewer only handles the kinds the browser wouldn't render well
  const openArtifact = (f: Entry) => {
    if (off) return;
    markSeen(seenName(f.name), f.mtime);
    touch();
    if (kindOf(f.name) === 'html') window.location.assign(srcOf(f.name));
    else setOpen(f);
  };
  const seen = forRoot(there, files);
  const unread = countUnseen(seen);
  const isHtml = (f: Entry) => kindOf(f.name) === 'html';
  const rows = files.map((f) => ({ f, isUnread: f.mtime > lastSeen(seenName(f.name)) }));
  const viewRows = filter === 'html' ? rows.filter((r) => isHtml(r.f)) : rows;
  // a computer that is off shows its html files as plain rows: no page to draw a thumbnail from
  const grid = filter === 'html' && !off;
  const emptyMsg =
    filter === 'html'
      ? 'no html artifacts yet — switch to all for the rest'
      : 'no artifacts yet — agents drop files here and they show up in chat';

  return (
    <main
      className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6"
      data-testid="artifacts-view"
      data-root={root || undefined}
      data-reachable={off ? 'off' : 'on'}
    >
      <header className="oz-head">
        <Link
          href={root ? `/roots/${encodeURIComponent(root)}` : '/'}
          className="flex min-w-0 items-center gap-2.5"
          aria-label="back to sessions"
          data-testid="artifacts-back"
        >
          <span className="oz-k sm">
            <LineIcon name="back" size={13} />
          </span>
          <h1 className="truncate text-[13px]">
            artifacts
            {root && <span className="text-[var(--oz-dim)]"> · {root}</span>}
          </h1>
        </Link>
        {unread > 0 && (
          <button
            onClick={() => {
              markAllSeen(seen);
              touch();
            }}
            className="oz-k sm"
          >
            mark all read
          </button>
        )}
      </header>

      <div className="mb-2 flex items-center gap-2">
        <div className="oz-tabs" role="group" aria-label="filter">
          {(['html', 'all'] as const).map((f) => {
            const n = f === 'html' ? countUnseen(seen.filter(isHtml)) : countUnseen(seen);
            return (
              <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                {f}
                {n > 0 && <span className="font-bold text-[var(--oz-text)]"> {n}</span>}
              </button>
            );
          })}
        </div>
        <span className="ml-auto text-[10px] text-[var(--oz-dim)]">
          {viewRows.length} shown · {unread} unseen
        </span>
      </div>

      {open ? (
        <div className="flex flex-col gap-2">
          <button onClick={() => setOpen(null)} className="oz-k sm w-fit">
            <LineIcon name="back" size={11} /> back to list
          </button>
          <div className="truncate px-0.5 text-xs text-[var(--oz-dim)]">
            {open.name} · {fmtTime(open.mtime)} · {fmtSize(open.size)}
          </div>
          <Viewer file={open} src={srcOf(open.name)} />
        </div>
      ) : viewRows.length === 0 ? (
        <div className="pt-6 text-center text-xs text-[var(--oz-dim)]">{emptyMsg}</div>
      ) : grid ? (
        /* thumbnail cards — the design mockups speak for themselves.
           unseen = weight + a text-colored dot, same law as the session list */
        <div className="grid grid-cols-2 gap-1.5" data-testid="artifact-grid">
          {viewRows.map(({ f, isUnread }) => (
            <div key={f.name} className="relative">
              <button
                onClick={() => openArtifact(f)}
                aria-label={f.name}
                className="oz-row overflow-hidden p-0"
              >
                <HtmlThumb name={f.name} src={srcOf(f.name)} />
                <div className="flex items-center gap-1.5 border-t border-[var(--oz-border)] px-2 py-1.5">
                  {isUnread && (
                    <span className="text-[9px]" aria-label="unseen">
                      ●
                    </span>
                  )}
                  <span className={`truncate text-xs ${isUnread ? 'font-bold' : 'opacity-80'}`}>
                    {f.name}
                  </span>
                  <span className="ml-auto" />
                  <SourceTag f={f} />
                </div>
              </button>
              {/* both entries possible: tap = here, corner = new tab. Sibling
                  overlay — nested buttons are invalid and break the tap */}
              <button
                onClick={() => {
                  markSeen(seenName(f.name), f.mtime);
                  touch();
                  window.open(srcOf(f.name), '_blank', 'noopener');
                }}
                aria-label={`open ${f.name} in new tab`}
                className="oz-k sm absolute top-1.5 right-1.5 z-10 text-[var(--oz-text)]"
              >
                <LineIcon name="external" size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="artifact-list">
          {(() => {
            const out: React.ReactNode[] = [];
            let day = '';
            viewRows.forEach(({ f, isUnread }, i) => {
              const d = dayLabel(f.mtime);
              if (d !== day) {
                day = d;
                out.push(
                  <li key={`day-${i}`} className="oz-hd mt-3 mb-0.5 px-0.5 first:mt-0.5">
                    {d}
                  </li>
                );
              }
              out.push(
                <li key={f.name}>
                  <button
                    onClick={() => openArtifact(f)}
                    disabled={off}
                    data-testid="artifact-row"
                    data-name={f.name}
                    className={`oz-row ${isUnread ? 'unread' : ''} ${off ? 'oz-gone' : ''}`}
                  >
                    <div className="oz-r1">
                      <span
                        className="w-4 shrink-0 text-center text-[var(--oz-dim)]"
                        aria-hidden="true"
                      >
                        {glyphOf(f.name)}
                      </span>
                      {isUnread && <span aria-label="unseen">●</span>}
                      <span className={`t ${isUnread ? '' : 'opacity-80'}`}>{f.name}</span>
                      <SourceTag f={f} />
                      <time>
                        {fmtTime(f.mtime)} · {fmtSize(f.size)}
                      </time>
                    </div>
                  </button>
                </li>
              );
            });
            return out;
          })()}
        </ul>
      )}
    </main>
  );
}
