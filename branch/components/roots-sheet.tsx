'use client';

/** The roots sheet (E2 · the whole tree): every computer of the tree, this one first.
 *    list   one row per computer: name, home tag, world swatch, state (on · last seen … · off),
 *           os, how many run
 *    tap    opens that computer's own page (/roots/<id>)
 *    hold   (not home) → "Remove <name>?" · Remove / Keep
 *  Labels and state only (the owner's rule: no help text). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import { cacheRootTheme, cacheTreeThemes, defaultWorldFor, isWorld } from '@/lib/worlds';

/** a press this long on a row (not home) asks to remove it */
const HOLD_MS = 500;
/** localStorage: the home root's name (the list's computer tag leaves it out) */
export const HOME_ROOT_KEY = 'oz-home-root';
const POLL_MS = 5000;

type Home = {
  name: string;
  os?: string | null;
  arch?: string | null;
  cpus?: number | null;
  mem_gb?: number | null;
  running?: number;
  theme?: string | null;
  main?: string | null;
};
type Root = {
  id: string;
  name: string;
  os?: string | null;
  arch?: string | null;
  cpus?: number | null;
  mem_gb?: number | null;
  reachable?: boolean;
  seen?: number | null;
  running?: number;
  theme?: string | null;
  main?: string | null;
  main_proxy?: string | null;
};
export type Tree = { home: Home | null; roots: Root[] };
type Row = Root & { home?: boolean };

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
  /** every fresh answer of GET /api/roots (the home list learns the home root's name + themes) */
  onTree?: (t: Tree) => void;
}) {
  const router = useRouter();
  const [tree, setTree] = useState<Tree | null>(null);
  const [ask, setAsk] = useState<string | null>(null); // "Remove <name>?"
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
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
      cacheTreeThemes(t);
      treeCb.current?.(t);
    } catch {
      /* transient — keep the last answer */
    }
  }, []);

  useEffect(() => {
    void loadTree();
    const t = setInterval(() => {
      if (!document.hidden) void loadTree();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loadTree]);

  const rows: Row[] = [
    ...(tree?.home?.name
      ? [
          {
            id: tree.home.name,
            name: tree.home.name,
            os: tree.home.os,
            arch: tree.home.arch,
            cpus: tree.home.cpus,
            mem_gb: tree.home.mem_gb,
            reachable: true,
            running: tree.home.running,
            theme: tree.home.theme,
            main: tree.home.main,
            home: true,
          },
        ]
      : []),
    ...(tree?.roots ?? []),
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (ask) setAsk(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ask, onClose]);

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

  const remove = (id: string) =>
    go(async () => {
      const r = await fetch(`/api/roots/${encodeURIComponent(id)}/remove`, { method: 'POST' });
      if (!r.ok) return setFailed('failed');
      setAsk(null);
      setTree((t) => (t ? { ...t, roots: t.roots.filter((x) => x.id !== id) } : t));
      void loadTree();
    });

  // ── press: tap opens the computer's page; hold (not home) asks to remove it ──
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
        <button
          type="button"
          className="oz-k sm"
          aria-label="close"
          data-testid="roots-close"
          onClick={onClose}
        >
          <LineIcon name="close" size={14} />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium" data-testid="roots-title">
          roots
        </h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <ul className="flex flex-col gap-1" data-testid="roots-list">
          {!tree && (
            <li className="pt-6 text-center text-xs" style={dim}>
              …
            </li>
          )}
          {rows.map((r) => {
            const on = !!r.reachable;
            const theme = isWorld(r.theme) ? r.theme : defaultWorldFor(r.id, !!r.home);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className="oz-row"
                  data-testid="root-row"
                  data-root={r.id}
                  data-state={on ? 'on' : 'off'}
                  data-root-theme={theme}
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
                    cacheRootTheme(r.id, theme);
                    onClose();
                    router.push(`/roots/${encodeURIComponent(r.id)}`);
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
                      className="oz-swt"
                      data-theme={theme}
                      data-testid="root-swatch"
                      aria-hidden="true"
                    >
                      <i style={{ background: 'var(--oz-bg)' }} />
                      <i style={{ background: 'var(--oz-success)' }} />
                      <i style={{ background: 'var(--oz-info)' }} />
                    </span>
                    <span
                      className="oz-st"
                      data-testid="root-state"
                      style={{ color: on ? 'var(--oz-success)' : 'var(--oz-dim)' }}
                    >
                      {stateOf(r)}
                    </span>
                  </div>
                  <div className="oz-r2">
                    {[r.os, on && r.running ? `${r.running} running` : '']
                      .filter(Boolean)
                      .join(' · ') || '\u00a0'}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
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
