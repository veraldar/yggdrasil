'use client';

/** The roots sheet (E2 · the whole tree): every computer of the tree, this one first.
 *    list   one row per computer: name, state (on · last seen … · off), os, how many run
 *    tap    that computer: its MAIN on top, then its sessions; ＋ starts one there
 *    hold   (not home) → "Remove <name>?" · Remove / Keep
 *  Labels and state only (the owner's rule: no help text). The context sheet's .oz-film
 *  column: header, one scrolling pane. Data: GET /api/roots, /api/roots/<root>/sessions;
 *  a session there without a proxy here is adopted first (POST /api/roots/<root>/adopt). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import { CARD_ST } from '@/lib/card';
import { slugify } from '@/lib/slug';
import { MAIN_SLUG, isMainSlug } from '@/lib/tree-first';

/** a press this long on a row (not home) asks to remove it */
const HOLD_MS = 500;
/** localStorage: the home root's name (the list's computer tag leaves it out) */
export const HOME_ROOT_KEY = 'oz-home-root';
const POLL_MS = 5000;

type Home = {
  name: string;
  os?: string | null;
  running?: number;
  main?: string | null;
};
type Root = {
  id: string;
  name: string;
  os?: string | null;
  reachable?: boolean;
  seen?: number | null;
  running?: number;
  main?: string | null;
  main_proxy?: string | null;
};
/** a join waiting for the owner's tap (the newest per machine, from GET /api/roots `joins`) */
type Join = {
  req: string;
  name: string;
  os: string;
  host: string;
  code: string;
  wg_fp: string | null;
  model?: 'home' | null;
  status: string;
  expires_at: string;
  root_id?: string | null;
};
export type Tree = { home: Home | null; roots: Root[]; joins?: Join[] };
type Row = Root & { home?: boolean };
type RSess = {
  id: string;
  title?: string;
  status?: string | null;
  updated?: number | null;
  busy?: boolean;
  proxy?: string | null;
};
type RView = {
  root?: string;
  reachable?: boolean;
  main?: { id: string; proxy?: string | null; title?: string | null } | null;
  sessions?: RSess[];
};

const msOf = (t?: number | null) => (!t ? 0 : t < 1e12 ? t * 1000 : t);

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const stateOf = (r: Row) =>
  r.reachable ? 'on' : r.seen ? `last seen ${ago(msOf(r.seen))}` : 'off';

/** the list's stamp: clock time today, a short date before */
function stamp(t?: number | null): string {
  const m = msOf(t);
  if (!m) return '';
  const d = new Date(m);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** a session's one word and its colour (working is green, the rest as the list's cards) */
function wordOf(s: RSess): { w: string; c: string } {
  if (s.busy || s.status === 'working') return { w: 'working', c: 'var(--oz-success)' };
  const st = CARD_ST[s.status || ''];
  return st ? { w: st.w, c: st.c } : { w: '', c: 'var(--oz-dim)' };
}

const NO_SELECT = {
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
} as const;

export function RootsSheet({
  onClose,
  onTree,
}: {
  onClose: () => void;
  /** every fresh answer of GET /api/roots (the home list learns the home root's name) */
  onTree?: (t: Tree) => void;
}) {
  const router = useRouter();
  const [tree, setTree] = useState<Tree | null>(null);
  const [at, setAt] = useState<string | null>(null); // the computer opened
  const [view, setView] = useState<RView | null>(null);
  const [ask, setAsk] = useState<string | null>(null); // "Remove <name>?"
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [failed, setFailed] = useState('');
  const [joins, setJoins] = useState<Join[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const held = useRef(false);
  const treeCb = useRef(onTree);
  treeCb.current = onTree;

  const loadTree = useCallback(async () => {
    try {
      const r = await fetch('/api/roots', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return;
      const t = (await r.json()) as Tree;
      setTree(t);
      treeCb.current?.(t);
      setJoins(t.joins ?? []);
    } catch {
      /* transient — keep the last answer */
    }
  }, []);

  /** a machine asked to join: Add → the /join page's own call; Refuse → forget it */
  const decide = useCallback(
    async (req: string, what: 'approve' | 'refuse') => {
      setBusy(true);
      setFailed('');
      try {
        const r = await fetch(`/api/roots/join/${encodeURIComponent(req)}/${what}`, {
          method: 'POST',
        });
        const v = (await r.json().catch(() => ({}))) as { error?: string; status?: string };
        if (!r.ok) {
          setFailed(v.error || 'the request has run out — wait for the next one');
        } else if (what === 'refuse') {
          setJoins((js) => js.filter((j) => j.req !== req));
        } else {
          // approved: drop the row now; the poll brings the joined machine in as a root
          setJoins((js) => js.filter((j) => j.req !== req));
          void loadTree();
        }
      } catch {
        setFailed('could not reach the box');
      } finally {
        setBusy(false);
      }
    },
    [loadTree]
  );

  const loadView = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/roots/${encodeURIComponent(id)}/sessions`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
      });
      const v = (await r.json().catch(() => null)) as RView | null;
      if (r.ok && v) setView(v);
      else setView((old) => old ?? { reachable: false, main: null, sessions: [] });
    } catch {
      setView((old) => old ?? { reachable: false, main: null, sessions: [] });
    }
  }, []);

  useEffect(() => {
    void loadTree();
    // the joins' countdowns tick while the sheet is open
    if (joins.length) {
      const c = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(c);
    }
  }, [loadTree, joins.length]);

  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) void loadTree();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loadTree]);

  useEffect(() => {
    if (!at) return;
    void loadView(at);
    const t = setInterval(() => {
      if (!document.hidden) void loadView(at);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [at, loadView]);

  const rows: Row[] = [
    ...(tree?.home?.name
      ? [
          {
            id: tree.home.name,
            name: tree.home.name,
            os: tree.home.os,
            reachable: true,
            running: tree.home.running,
            main: tree.home.main,
            home: true,
          },
        ]
      : []),
    ...(tree?.roots ?? []),
  ];
  const row = at ? rows.find((r) => r.id === at) : undefined;

  function back() {
    setAt(null);
    setView(null);
    setCreating(false);
    setName('');
    setFailed('');
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (ask) setAsk(null);
      else if (at) back();
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ask, at, onClose]);

  const open = (id: string, title?: string | null) =>
    router.push(`/session/${slugify(title || id)}?id=${encodeURIComponent(id)}`);

  /** a session that lives there: its proxy here (adopted first when there is none) */
  async function reach(root: string, id: string, proxy?: string | null, title?: string | null) {
    if (proxy) return { proxy, title };
    const r = await fetch(`/api/roots/${encodeURIComponent(root)}/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = (await r.json().catch(() => ({}))) as { proxy?: string; title?: string };
    return r.ok && d.proxy ? { proxy: d.proxy, title: d.title || title } : null;
  }

  async function go(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFailed('');
    try {
      await fn();
    } catch {
      setFailed('failed');
    } finally {
      setBusy(false);
    }
  }

  const openMain = (r: Row) =>
    go(async () => {
      if (r.home) {
        router.push(`/session/${MAIN_SLUG}`);
        return;
      }
      const m = view?.main;
      const id = m?.id || r.main;
      if (!id) return;
      const p = await reach(r.id, id, m?.proxy || r.main_proxy, m?.title);
      if (!p) return setFailed('failed');
      // never the slug `main`: that is this root's own MAIN, with its own page
      const t = p.title && !isMainSlug(slugify(p.title)) ? p.title : `[MAIN] ${r.id}`;
      open(p.proxy, t);
    });

  const openSess = (r: Row, s: RSess) =>
    go(async () => {
      if (r.home) {
        if (isMainSlug(slugify(s.title || ''))) router.push(`/session/${MAIN_SLUG}`);
        else open(s.proxy || s.id, s.title);
        return;
      }
      const p = await reach(r.id, s.id, s.proxy, s.title);
      if (!p) return setFailed('failed');
      open(p.proxy, p.title || s.title);
    });

  const create = (r: Row) =>
    go(async () => {
      const title = name.trim() || `session ${new Date().toLocaleString()}`;
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r.home ? { name: title } : { name: title, root: r.id }),
      });
      const s = (await res.json().catch(() => ({}))) as { id?: string; title?: string };
      if (!s.id) return setFailed('failed');
      setCreating(false);
      setName('');
      open(s.id, s.title || title);
    });

  const remove = (id: string) =>
    go(async () => {
      const r = await fetch(`/api/roots/${encodeURIComponent(id)}/remove`, { method: 'POST' });
      if (!r.ok) return setFailed('failed');
      setAsk(null);
      setTree((t) => (t ? { ...t, roots: t.roots.filter((x) => x.id !== id) } : t));
      void loadTree();
    });

  // ── press: tap opens the computer; hold (not home) asks to remove it ──
  function down(e: React.PointerEvent, r: Row) {
    held.current = false;
    if (!e.isPrimary || r.home) return;
    const x = e.clientX;
    const y = e.clientY;
    hold.current = {
      x,
      y,
      timer: setTimeout(() => {
        hold.current = null;
        held.current = true;
        navigator.vibrate?.(12);
        setAsk(r.id);
      }, HOLD_MS),
    };
  }
  function up() {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  }
  function move(e: React.PointerEvent) {
    const h = hold.current;
    if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 10) up(); // a scroll, not a hold
  }

  const dim = { color: 'var(--oz-dim)' };
  const grey = (on?: boolean) => (on ? undefined : { opacity: 0.5 });

  return (
    <div className="oz-film ctx-sheet" role="dialog" aria-label="roots" data-testid="roots-sheet">
      <header className="flex items-center gap-2 px-3 pt-[calc(10px+env(safe-area-inset-top))]">
        {row ? (
          <button
            type="button"
            className="oz-k sm"
            aria-label="back"
            data-testid="roots-back"
            onClick={back}
          >
            <LineIcon name="back" size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="oz-k sm"
            aria-label="close"
            data-testid="roots-close"
            onClick={onClose}
          >
            <LineIcon name="close" size={14} />
          </button>
        )}
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium" data-testid="roots-title">
          {row ? row.id : 'roots'}
        </h2>
        {row && (
          <>
            <span
              className="flex-none text-[10px]"
              style={{ color: row.reachable ? 'var(--oz-success)' : 'var(--oz-dim)' }}
              data-testid="roots-state"
            >
              {stateOf(row)}
            </span>
            <button
              type="button"
              className="oz-k sm"
              aria-label="new session"
              data-testid="roots-new"
              onClick={() => setCreating((c) => !c)}
            >
              <LineIcon name="plus" size={14} />
            </button>
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!row && joins.length > 0 && (
          <div className="mb-3" data-testid="joins-list">
            <p className="px-1 pb-1 text-[10px]" style={dim}>
              wants to join
            </p>
            <ul className="flex flex-col gap-1">
              {joins.map((j) => {
                const left = Math.max(0, Math.round((Date.parse(j.expires_at) - now) / 1000));
                const mm = Math.floor(left / 60);
                const ss = String(left % 60).padStart(2, '0');
                return (
                  <li
                    key={j.req}
                    className="oz-box p-2.5"
                    data-testid="join-row"
                    data-join={j.name}
                  >
                    <div className="oz-r1">
                      <span aria-hidden="true" style={{ color: 'var(--oz-warn, #e6a23c)' }}>
                        ●
                      </span>
                      <span className="t">{j.name}</span>
                      <span
                        className="oz-st"
                        data-testid="join-left"
                        style={{ color: left > 0 ? undefined : 'var(--oz-danger)' }}
                      >
                        {left > 0 ? `${mm}:${ss}` : 'expired'}
                      </span>
                    </div>
                    <div className="oz-r2">{[j.os, j.host].filter(Boolean).join(' · ')}</div>
                    <div className="flex items-center justify-between pt-1.5">
                      <span className="font-mono text-[15px] tracking-[0.15em]">{j.code}</span>
                      <span className="flex gap-1.5">
                        <button
                          type="button"
                          className="oz-k"
                          disabled={busy}
                          data-testid="join-add"
                          onClick={() => decide(j.req, 'approve')}
                        >
                          Add to my tree
                        </button>
                        <button
                          type="button"
                          className="oz-k red"
                          disabled={busy}
                          data-testid="join-refuse"
                          onClick={() => decide(j.req, 'refuse')}
                        >
                          Refuse
                        </button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {failed && (
              <p role="alert" className="px-1 pt-1.5 text-[11px] text-[var(--oz-danger)]">
                {failed}
              </p>
            )}
          </div>
        )}
        {!row && (
          <ul className="flex flex-col gap-1" data-testid="roots-list">
            {!tree && (
              <li className="pt-6 text-center text-xs" style={dim}>
                …
              </li>
            )}
            {rows.map((r) => {
              const on = !!r.reachable;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className="oz-row"
                    data-testid="root-row"
                    data-root={r.id}
                    data-state={on ? 'on' : 'off'}
                    style={{ ...NO_SELECT, ...grey(on) }}
                    onPointerDown={(e) => down(e, r)}
                    onPointerUp={up}
                    onPointerCancel={up}
                    onPointerLeave={up}
                    onPointerMove={move}
                    onContextMenu={(e) => e.preventDefault()}
                    onClick={() => {
                      if (held.current) {
                        held.current = false;
                        return;
                      }
                      setView(null);
                      setAt(r.id);
                    }}
                  >
                    <div className="oz-r1">
                      <span
                        aria-hidden="true"
                        style={{ color: on ? 'var(--oz-success)' : 'var(--oz-dim)' }}
                      >
                        ●
                      </span>
                      <span className="t">{r.id}</span>
                      {r.home && <span className="oz-subs">home</span>}
                      <span
                        className="oz-st"
                        data-testid="root-state"
                        style={{ color: on ? 'var(--oz-success)' : 'var(--oz-dim)' }}
                      >
                        {stateOf(r)}
                      </span>
                    </div>
                    <div className="oz-r2">
                      {[r.os, r.running ? `${r.running} running` : '']
                        .filter(Boolean)
                        .join(' · ') || ' '}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {row && (
          <div className="flex flex-col gap-1" data-testid="root-view" data-root={row.id}>
            {creating && (
              <div className="oz-box mb-1 p-3">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && create(row)}
                  placeholder="session name…"
                  className="oz-field mb-2.5"
                  data-testid="roots-new-name"
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={() => create(row)}
                    className="oz-k ok flex-1"
                    disabled={busy}
                    data-testid="roots-create"
                  >
                    create & open
                  </button>
                  <button onClick={() => setCreating(false)} className="oz-k px-4">
                    cancel
                  </button>
                </div>
              </div>
            )}
            {failed && (
              <p role="alert" className="py-1 text-[11px] text-[var(--oz-danger)]">
                {failed}
              </p>
            )}
            {!view && (
              <p className="pt-6 text-center text-xs" style={dim}>
                …
              </p>
            )}
            {view && (row.home || view.main || row.main) && (
              <button
                type="button"
                className="oz-row"
                data-testid="root-main"
                style={grey(row.home || view.reachable)}
                onClick={() => openMain(row)}
              >
                <div className="oz-r1">
                  <span className="t font-medium">MAIN</span>
                </div>
              </button>
            )}
            {view &&
              (view.sessions ?? [])
                .filter((s) => s.id !== (view.main?.id || row.main))
                .map((s) => {
                  const st = wordOf(s);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className="oz-row"
                      data-testid="root-sess"
                      data-id={s.id}
                      style={grey(row.home || view.reachable)}
                      onClick={() => openSess(row, s)}
                    >
                      <div className="oz-r1">
                        {st.w === 'working' && (
                          <span className="oz-breathe" style={{ color: st.c }} aria-hidden="true">
                            ●
                          </span>
                        )}
                        <span className="t">{s.title || s.id}</span>
                        {st.w && (
                          <span className="oz-st" style={{ color: st.c }}>
                            {st.w}
                          </span>
                        )}
                        <time>{stamp(s.updated)}</time>
                      </div>
                    </button>
                  );
                })}
          </div>
        )}
      </div>

      {ask && (
        <div
          className="oz-box mx-3 mb-[calc(10px+env(safe-area-inset-bottom))] p-3"
          role="alertdialog"
          aria-label={`Remove ${ask}?`}
          data-testid="root-confirm"
        >
          <p className="mb-2.5 truncate text-[13px]">Remove {ask}?</p>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="oz-k red flex-1"
              disabled={busy}
              data-testid="root-remove"
              onClick={() => remove(ask)}
            >
              Remove
            </button>
            <button
              type="button"
              className="oz-k flex-1"
              data-testid="root-keep"
              onClick={() => setAsk(null)}
            >
              Keep
            </button>
          </div>
          {failed && (
            <p role="alert" className="pt-2 text-[11px] text-[var(--oz-danger)]">
              {failed}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
