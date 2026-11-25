'use client';

/** The roots sheet (E2 · the whole tree): every computer of the tree, this one first.
 *    list   one row per computer: name, home tag, world swatch, state (on · last seen … · off),
 *           os, how many run, "not up to date" (it runs another build than home)
 *    tap    opens that computer's home screen: `/` for the home root (the tree's home screen
 *           IS its page), /roots/<id> for another — the sheet opens from every one of them
 *    hold   (not home) → "Remove <name>?" · Remove / Keep
 *  Labels and state only (the owner's rule: no help text). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import { useTrunkMode } from '@/lib/auth-mode';
import { cacheTreeThemes, chosenWorld } from '@/lib/worlds';

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
  /** how many times a world was picked for it (0: `theme` is the brain's unpicked default) */
  theme_rev?: number;
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
  theme_rev?: number;
  main?: string | null;
  main_proxy?: string | null;
  /** it runs another build than home (an older brain too); null: never answered */
  behind?: boolean | null;
};
/** a pending machine join waiting for the owner's tap (from GET /api/roots `joins`) */
export type PendingJoin = {
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
  approve_url?: string;
  /** v1: an enrollment pending on the trunk (pendingFromTrunk) */
  trunk?: boolean;
};
export type Tree = { home: Home | null; roots: Root[]; joins?: PendingJoin[] };

/**
 * v1 (trunk mode, spec §5.5, §13 C7/C8): the computers waiting to join come from the trunk
 * (GET /t/roots/pending, same origin, the device cookie rides it); "Add to my tree" opens the trunk's
 * own approval card (/auth/root?e=<id>: step-up, and the terminal code when the regions differ);
 * Refuse is POST /t/roots/enroll/<id>/refuse; hold-to-remove revokes the root on the trunk
 * (DELETE /t/roots/<trunk id>, the id from GET /t/me/roots by name). The fields read from a pending
 * enrollment, tolerant until the shape is pinned in CONTRACTS.md: id, name|hostname, os, host|hostname,
 * wg_fp|fingerprint, expires_at (RFC 3339 or unix ms).
 */
type TrunkPending = {
  id?: string;
  name?: string;
  hostname?: string;
  host?: string;
  os?: string;
  wg_fp?: string | null;
  fingerprint?: string | null;
  expires_at?: string | number;
};
const TRUNK_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function pendingFromTrunk(list: unknown): PendingJoin[] {
  if (!Array.isArray(list)) return [];
  return (list as TrunkPending[])
    .filter((p) => p && typeof p.id === 'string' && TRUNK_ID.test(p.id))
    .map((p) => ({
      req: p.id!,
      name: String(p.name || p.hostname || p.id),
      os: String(p.os || ''),
      host: String(p.host || p.hostname || ''),
      code: '',
      wg_fp: p.wg_fp ?? p.fingerprint ?? null,
      status: 'pending',
      expires_at:
        typeof p.expires_at === 'number' ? new Date(p.expires_at).toISOString() : String(p.expires_at || ''),
      approve_url: `/auth/root?e=${encodeURIComponent(p.id!)}`,
      trunk: true,
    }));
}
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
  const [joins, setJoins] = useState<PendingJoin[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const held = useRef(false);
  const treeCb = useRef(onTree);
  treeCb.current = onTree;
  // v1: behind a trunk the pending roots and the remove go to the trunk (pendingFromTrunk above)
  const trunk = useTrunkMode();
  const trunkRef = useRef(trunk);
  trunkRef.current = trunk;

  const loadTree = useCallback(async () => {
    try {
      const r = await fetch('/api/roots', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return;
      const t = (await r.json()) as Tree;
      setTree(t);
      if (!trunkRef.current) setJoins(t.joins ?? []);
      cacheTreeThemes(t);
      treeCb.current?.(t);
    } catch {
      /* transient — keep the last answer */
    }
  }, []);

  const loadPending = useCallback(async () => {
    try {
      const r = await fetch('/t/roots/pending', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (r.ok) setJoins(pendingFromTrunk(await r.json()));
    } catch {
      /* transient — keep the last answer */
    }
  }, []);

  useEffect(() => {
    const load = () => {
      void loadTree();
      if (trunk) void loadPending();
    };
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loadTree, loadPending, trunk]);

  /** Approve or refuse a pending machine join in-app; on a tailnet origin without a paired
   *  device cookie, hand off to the join's paired public approve URL instead of failing dead. */
  const decideJoin = useCallback(
    async (j: PendingJoin, what: 'approve' | 'refuse') => {
      if (j.trunk && what === 'approve' && j.approve_url) {
        window.location.assign(j.approve_url); // the trunk's card: step-up, then Connect root
        return;
      }
      setBusy(true);
      setFailed('');
      if (j.trunk) {
        try {
          const r = await fetch(`/t/roots/enroll/${encodeURIComponent(j.req)}/refuse`, { method: 'POST' });
          if (!r.ok) setFailed(r.status === 403 ? 'the admin refuses roots' : 'refuse failed');
          else setJoins((js) => js.filter((x) => x.req !== j.req));
          void loadPending();
        } catch {
          setFailed('could not reach the trunk');
        } finally {
          setBusy(false);
        }
        return;
      }
      try {
        const r = await fetch(`/api/roots/join/${encodeURIComponent(j.req)}/${what}`, {
          method: 'POST',
        });
        const v = (await r.json().catch(() => ({}))) as { error?: string };
        if (r.status === 401 && j.approve_url) {
          try {
            if (new URL(j.approve_url).origin !== window.location.origin) {
              window.location.assign(j.approve_url);
              return;
            }
          } catch {
            /* fall through to error */
          }
        }
        if (!r.ok) {
          setFailed(v.error || `${what} failed`);
          if (r.status === 404 || r.status === 409 || r.status === 410) void loadTree();
        } else {
          setJoins((js) => {
            const next = js.filter((x) => x.req !== j.req);
            if (tree) treeCb.current?.({ ...tree, joins: next });
            return next;
          });
          void loadTree();
        }
      } catch {
        setFailed('could not reach the box');
      } finally {
        setBusy(false);
      }
    },
    [loadTree, loadPending, tree]
  );

  const hasJoins = joins.length > 0;
  useEffect(() => {
    if (!hasJoins) return;
    setNow(Date.now());
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(c);
  }, [hasJoins]);

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
            theme_rev: tree.home.theme_rev,
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
      const r = trunk
        ? await removeOnTrunk(id)
        : await fetch(`/api/roots/${encodeURIComponent(id)}/remove`, { method: 'POST' });
      if (!r.ok) return setFailed(r.status === 403 ? 'the admin removes roots' : 'failed');
      setAsk(null);
      setTree((t) => (t ? { ...t, roots: t.roots.filter((x) => x.id !== id) } : t));
      void loadTree();
    });

  /** v1: revoke the root on the trunk — its trunk id by name from GET /t/me/roots (C6). */
  async function removeOnTrunk(id: string): Promise<{ ok: boolean; status: number }> {
    const names = new Set([id, rows.find((x) => x.id === id)?.name].filter(Boolean));
    const m = await fetch('/t/me/roots', { cache: 'no-store' });
    if (!m.ok) return { ok: false, status: m.status };
    const list = (await m.json().catch(() => [])) as Array<{ id?: string; name?: string }>;
    const hit = Array.isArray(list)
      ? list.find((x) => typeof x?.name === 'string' && names.has(x.name) && typeof x.id === 'string')
      : undefined;
    if (!hit?.id || !TRUNK_ID.test(hit.id)) return { ok: false, status: 404 };
    const r = await fetch(`/t/roots/${encodeURIComponent(hit.id)}`, { method: 'DELETE' });
    return { ok: r.ok, status: r.status };
  }

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
        {joins.length > 0 && (
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
                    data-req={j.req}
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
                    <div className="oz-r2">
                      {[j.os, j.host, j.wg_fp ? `key ${j.wg_fp}` : ''].filter(Boolean).join(' · ')}
                    </div>
                    {j.model === 'home' && (
                      <div className="oz-r2" data-testid="join-model">
                        shares home model &amp; key
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2 pt-1.5">
                      <span
                        className="font-mono text-[15px] tracking-[0.15em]"
                        data-testid="join-code"
                      >
                        {j.code}
                      </span>
                      <span className="flex gap-1.5">
                        <button
                          type="button"
                          className="oz-k"
                          disabled={busy}
                          data-testid="join-add"
                          onClick={() => decideJoin(j, 'approve')}
                        >
                          Add to my tree
                        </button>
                        <button
                          type="button"
                          className="oz-k red"
                          disabled={busy}
                          data-testid="join-refuse"
                          onClick={() => decideJoin(j, 'refuse')}
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
        <ul className="flex flex-col gap-1" data-testid="roots-list">
          {!tree && (
            <li className="pt-6 text-center text-xs" style={dim}>
              …
            </li>
          )}
          {rows.map((r) => {
            const on = !!r.reachable;
            // a computer's own world only if one was picked for it; else (and always for
            // home, whose world IS the app's) the swatch shows the app's own colours
            const theme = r.home ? null : chosenWorld(r.theme, r.theme_rev);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className="oz-row"
                  data-testid="root-row"
                  data-root={r.id}
                  data-state={on ? 'on' : 'off'}
                  data-root-theme={theme ?? undefined}
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
                    onClose();
                    router.push(r.home ? '/' : `/roots/${encodeURIComponent(r.id)}`);
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
                      data-theme={theme ?? undefined}
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
                      .join(' · ') || (r.behind ? '' : '\u00a0')}
                    {r.behind && (
                      <>
                        {r.os || (on && r.running) ? ' · ' : ''}
                        <span data-testid="root-behind" style={{ color: 'var(--oz-active)' }}>
                          not up to date
                        </span>
                      </>
                    )}
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
