'use client';

/** /roots/[root] — the home screen of one computer (owner 11-24: "the button should be at the
 *  same place … I want the same layout"). The tree's home screen (`/`) and this page are built
 *  from the same parts (components/app/home-parts), in the same places:
 *    header   the computer's name where BIFROST sits (tap → its settings, /roots/[root]/settings,
 *             as BIFROST → /settings) · roots (the sheet: every computer) · artifacts (its own,
 *             /roots/[root]/artifacts, as /artifacts) · refresh
 *    band     the home screen's tree band; its chip filters to the working rows
 *    rows     ＋ new session (made on that computer) and the home screen's rows (nested
 *             sub-sessions, role badges, status dots + "working", engine words)
 *    bottom   its MAIN bar (home: the full MainBar with hold-to-talk; another computer: a tap
 *             opens its MAIN)
 *  No tab strip, no line of its own: settings and artifacts are pages, as on home. It wears
 *  the app's world unless one was picked for this computer (lib/worlds.ts).
 *  A computer that is off keeps its world, its last known rows (greyed, read-only) and says
 *  when it was last seen in its MAIN bar. Nothing is queued. */
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { HomeBand, HomeHead } from '@/components/app/home-parts';
import { LineIcon } from '@/components/line-icon';
import { MainBar, type MainBarRow } from '@/components/main-bar';
import { HOME_ROOT_KEY, type Tree } from '@/components/roots-sheet';
import { ROOTS_PATH } from '@/lib/home-path';
import { YggRoots } from '@/components/ygg';
import { engineWord, roleOf, sessionTag } from '@/lib/agents';
import { countUnseen, forRoot, seenInit } from '@/lib/artifact-read';
import { CARD_ST, type Card } from '@/lib/card';
import { lastRead } from '@/lib/read';
import { rootOfParam } from '@/lib/root-param';
import { slugify } from '@/lib/slug';
import { MAIN_SLUG, isMainSlug, isOnboardPrompt } from '@/lib/tree-first';
import {
  type WorldId,
  cacheTreeThemes,
  cachedRootTheme,
  chosenWorld,
  useScopedTheme,
} from '@/lib/worlds';

const POLL_MS = 5000;
const OPEN_QUESTION_TTL_MS = 48 * 60 * 60 * 1000;
const TREE_OPEN_KEY = 'oz-tree-open';

type RootSess = {
  id: string;
  title?: string;
  parentId?: string | null;
  agent?: string | null;
  engine?: string | null;
  harness?: string | null;
  card?: Card | null;
  archived?: boolean;
  status?: string | null;
  headline?: string | null;
  preview?: string;
  busy?: boolean;
  pending?: boolean;
  updated?: number | null;
  userAt?: number | null;
  lastRole?: string;
  lastAt?: number;
  lastHasQ?: boolean;
  proxy?: string | null;
};

type RootMain = {
  id: string;
  proxy?: string | null;
  title?: string | null;
  preview?: string | null;
  busy?: boolean;
};

type RootSessionsResp = {
  root?: string;
  reachable?: boolean;
  main?: RootMain | null;
  sessions?: RootSess[];
};

type RootArtifact = {
  name: string;
  mtime: number;
  size: number;
  ext?: string;
  type?: string;
  source?: string;
};

const msOf = (t?: number | null) => (!t ? 0 : t < 1e12 ? t * 1000 : t);

function fmtListTime(t?: number | null): string {
  const m = msOf(t);
  if (!m) return '';
  const d = new Date(m);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const byOwner = (s: { userAt?: number | null; updated?: number | null }) =>
  msOf(s.userAt) || msOf(s.updated) || 0;

const isWorking = (s: RootSess) =>
  !!s.busy || !!s.pending || s.status === 'working' || s.card?.status === 'working';

export default function RootPage({ params }: { params: Promise<{ root: string }> }) {
  const root = rootOfParam(use(params).root);
  // another computer (the roots sheet, from here) is another page: nothing of this one stays
  return <RootHome key={root} rootId={root} />;
}

function RootHome({ rootId }: { rootId: string }) {
  const router = useRouter();
  const enc = encodeURIComponent(rootId);
  const { setTheme: setHomeTheme } = useTheme();

  const [tree, setTree] = useState<Tree | null>(null);
  const [sessView, setSessView] = useState<RootSessionsResp | null>(null);
  const [homeSessions, setHomeSessions] = useState<RootSess[] | null>(null);
  // artifacts made there that this phone has not opened — the header key's badge, as on home
  const [unseenArts, setUnseenArts] = useState(0);
  // the refresh key reads "…" for the first load and a tap, never for the quiet poll
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // the band's chip: only the working rows (and the parents they hang from), as on home
  const [onlyWorking, setOnlyWorking] = useState(false);

  // determine home vs remote
  const [cachedHome, setCachedHome] = useState('');
  useEffect(() => {
    try {
      setCachedHome(localStorage.getItem(HOME_ROOT_KEY) || '');
    } catch {
      /* private mode */
    }
  }, []);
  const homeName = tree?.home?.name || cachedHome;
  const isHome = !!homeName && homeName === rootId;

  // this computer's own world: only one picked for it (paint cache first, server always wins);
  // null = none picked → the page wears the app's world like every other page. Home's world
  // IS the app's (the home screen and /settings keep them one), so home never paints over it.
  const [world, setWorld] = useState<WorldId | null>(null);
  useEffect(() => {
    setWorld(isHome ? null : cachedRootTheme(rootId));
  }, [rootId, isHome]);
  useScopedTheme(world);

  // expandable sub-sessions state (shared key with home list)
  const [subsOpen, setSubsOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(TREE_OPEN_KEY) || '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  function toggleSubs(id: string, dflt: boolean) {
    setSubsOpen((o) => {
      const next = { ...o, [id]: !(o[id] ?? dflt) };
      try {
        localStorage.setItem(TREE_OPEN_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  }

  // the tree's word, from the poll here and from the roots sheet while it is open
  const onTree = useCallback(
    (t: Tree) => {
      setTree(t);
      cacheTreeThemes(t);
      if (t.home?.name) {
        try {
          localStorage.setItem(HOME_ROOT_KEY, t.home.name);
        } catch {
          /* private mode */
        }
      }
      if (t.home?.name === rootId) {
        // home's world is the app's: a world picked for it (on another phone too) is adopted
        // as the app's, exactly as the home screen does — an unpicked one never is
        const hw = chosenWorld(t.home.theme, t.home.theme_rev);
        if (hw) setHomeTheme(hw);
      } else {
        const r = t.roots.find((x) => x.id === rootId);
        if (r) setWorld(chosenWorld(r.theme, r.theme_rev));
      }
    },
    [rootId, setHomeTheme]
  );

  const loadInFlight = useRef(false);
  const loadAll = useCallback(async () => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    try {
      const [rTree, rSess, rArt] = await Promise.all([
        fetch('/api/roots', { cache: 'no-store', signal: AbortSignal.timeout(10_000) }).catch(
          () => null
        ),
        fetch(`/api/roots/${enc}/sessions`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(12_000),
        }).catch(() => null),
        fetch(`/api/roots/${enc}/artifacts`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null),
      ]);

      let detectedHome = homeName;
      if (rTree?.ok) {
        const t = (await rTree.json().catch(() => null)) as Tree | null;
        if (t) {
          onTree(t);
          if (t.home?.name) detectedHome = t.home.name;
        }
      }

      if (rSess?.ok) {
        const v = (await rSess.json().catch(() => null)) as RootSessionsResp | null;
        if (v) setSessView(v);
      } else {
        setSessView((old) => old ?? { root: rootId, reachable: false, main: null, sessions: [] });
      }

      // the artifacts key's badge: what this phone has not opened of that computer's files
      // (the first meeting counts everything there as seen — lib/artifact-read)
      if (rArt?.ok) {
        const a = (await rArt.json().catch(() => null)) as {
          home?: boolean;
          artifacts?: RootArtifact[];
        } | null;
        if (a && Array.isArray(a.artifacts)) {
          const seen = forRoot(a.home === true ? null : rootId, a.artifacts);
          seenInit(seen);
          setUnseenArts(countUnseen(seen));
        }
      }

      // for home root, also read the enriched /api/session list so rows & MAIN bar carry full
      // unread/preview/sub-tree parity with the home screen (filtered to home's own sessions only)
      if (detectedHome && detectedHome === rootId) {
        const rs = await fetch('/api/session', {
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        if (rs?.ok) {
          const all = (await rs.json().catch(() => null)) as RootSess[] | null;
          if (Array.isArray(all)) {
            setHomeSessions(
              all.filter(
                (x) =>
                  x.card?.kind !== 'root-main' && (!x.card?.root || x.card.root === detectedHome)
              )
            );
          }
        }
      }
    } finally {
      loadInFlight.current = false;
      setLoading(false);
    }
  }, [enc, rootId, homeName, onTree]);

  useEffect(() => {
    void loadAll();
    const t = setInterval(() => {
      if (!document.hidden) void loadAll();
    }, POLL_MS);
    const onVis = () => {
      if (!document.hidden) void loadAll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [loadAll]);

  // derived root summary
  const treeEntry = useMemo(() => {
    if (isHome && tree?.home) {
      return {
        reachable: true,
        seen: Date.now(),
        os: tree.home.os,
        arch: tree.home.arch,
        cpus: tree.home.cpus,
        mem_gb: tree.home.mem_gb,
        running: tree.home.running ?? 0,
        main: tree.home.main,
        main_proxy: tree.home.main,
      };
    }
    const r = tree?.roots.find((x) => x.id === rootId);
    if (!r) return null;
    return {
      reachable: !!r.reachable,
      seen: r.seen ?? null,
      os: r.os,
      arch: r.arch,
      cpus: r.cpus,
      mem_gb: r.mem_gb,
      running: r.running ?? 0,
      main: r.main,
      main_proxy: r.main_proxy,
    };
  }, [isHome, tree, rootId]);

  const reachable = isHome ? true : (sessView?.reachable ?? treeEntry?.reachable ?? false);
  const seenMs = msOf(treeEntry?.seen);

  // sessions list for this computer (excluding MAIN, which lives in the bottom MAIN bar)
  const rawSessions: RootSess[] = useMemo(() => {
    if (isHome && homeSessions) return homeSessions;
    return sessView?.sessions ?? [];
  }, [isHome, homeSessions, sessView]);

  const homeMainRow: MainBarRow | undefined = useMemo(() => {
    if (!isHome || !homeSessions) return undefined;
    const m = homeSessions.find((s) => isMainSlug(slugify(s.title || '')));
    if (!m) return undefined;
    return {
      id: m.id,
      title: m.title || '[MAIN]',
      preview: m.preview || '',
      lastRole: m.lastRole,
      lastAt: m.lastAt,
      lastHasQ: m.lastHasQ,
      pending: m.pending,
    };
  }, [isHome, homeSessions]);

  const mainId = sessView?.main?.id || treeEntry?.main || homeMainRow?.id || null;

  const displaySessions = useMemo(
    () =>
      rawSessions.filter(
        (s) =>
          s.id !== mainId && !isMainSlug(slugify(s.title || '')) && s.card?.kind !== 'root-main'
      ),
    [rawSessions, mainId]
  );

  // sub-session nesting (exact same tree logic as app/page.tsx)
  const byId = useMemo(() => new Map(displaySessions.map((s) => [s.id, s])), [displaySessions]);
  const kidsById = useMemo(() => {
    const m = new Map<string, RootSess[]>();
    for (const s of displaySessions) {
      if (!s.parentId || !byId.has(s.parentId)) continue;
      const arr = m.get(s.parentId);
      if (arr) arr.push(s);
      else m.set(s.parentId, [s]);
    }
    for (const arr of m.values()) arr.sort((a, b) => byOwner(b) - byOwner(a));
    return m;
  }, [displaySessions, byId]);

  const below = useMemo(() => {
    const work = new Set<string>();
    const hot = new Set<string>();
    for (const s of displaySessions) {
      if (s.archived) continue;
      const st = s.card?.status || s.status;
      const w = isWorking(s);
      if (!w && st !== 'blocked') continue;
      const seen = new Set<string>();
      for (let p = s.parentId; p && !seen.has(p); p = byId.get(p)?.parentId) {
        seen.add(p);
        hot.add(p);
        if (w) work.add(p);
      }
    }
    return { work, hot };
  }, [displaySessions, byId]);

  const topSessions = useMemo(
    () =>
      displaySessions
        .filter((s) => !s.parentId || !byId.has(s.parentId))
        .sort((a, b) => byOwner(b) - byOwner(a)),
    [displaySessions, byId]
  );

  const runningCount = useMemo(() => {
    if (!reachable) return 0;
    const fromRows = displaySessions.filter(isWorking).length + (sessView?.main?.busy ? 1 : 0);
    return Math.max(fromRows, treeEntry?.running ?? 0);
  }, [reachable, displaySessions, sessView, treeEntry]);

  // the band's chip, as on home: nothing working → the filter lifts itself
  const branchWorking = reachable && displaySessions.some(isWorking);
  useEffect(() => {
    if (onlyWorking && runningCount === 0) setOnlyWorking(false);
  }, [onlyWorking, runningCount]);
  const shownTops = useMemo(() => {
    if (!onlyWorking) return topSessions;
    const keep = new Set<string>();
    for (const s of displaySessions) {
      if (!isWorking(s)) continue;
      keep.add(s.id);
      for (let p = s.parentId; p && !keep.has(p); p = byId.get(p)?.parentId) keep.add(p);
    }
    return topSessions.filter((s) => keep.has(s.id));
  }, [onlyWorking, topSessions, displaySessions, byId]);

  // ── actions ──────────────────────────────────────────────────────────────
  const openSessionUrl = (id: string, title?: string | null) =>
    router.push(`/session/${slugify(title || id)}?id=${encodeURIComponent(id)}`);

  async function adoptIfNeeded(id: string, proxy?: string | null, title?: string | null) {
    if (proxy) return { proxy, title };
    const r = await fetch(`/api/roots/${encodeURIComponent(rootId)}/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = (await r.json().catch(() => ({}))) as { proxy?: string; title?: string };
    return r.ok && d.proxy ? { proxy: d.proxy, title: d.title || title } : null;
  }

  async function runAction(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch {
      setErr('failed');
    } finally {
      setBusy(false);
    }
  }

  const openSess = (s: RootSess) => {
    if (!reachable && !isHome && !s.proxy) return;
    void runAction(async () => {
      if (isHome) {
        if (isMainSlug(slugify(s.title || ''))) router.push(`/session/${MAIN_SLUG}`);
        else openSessionUrl(s.proxy || s.id, s.title);
        return;
      }
      const p = await adoptIfNeeded(s.id, s.proxy, s.title);
      if (!p) return setErr('failed');
      openSessionUrl(p.proxy, p.title || s.title);
    });
  };

  const openRemoteMain = () => {
    if (!reachable) return;
    void runAction(async () => {
      const m = sessView?.main;
      const id = m?.id || treeEntry?.main;
      if (!id) return;
      const p = await adoptIfNeeded(id, m?.proxy || treeEntry?.main_proxy, m?.title);
      if (!p) return setErr('failed');
      const t = p.title && !isMainSlug(slugify(p.title)) ? p.title : `[MAIN] ${rootId}`;
      openSessionUrl(p.proxy, t);
    });
  };

  const createSession = () => {
    if (!reachable) return;
    void runAction(async () => {
      const title = newName.trim() || `session ${new Date().toLocaleString()}`;
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isHome ? { name: title } : { name: title, root: rootId }),
      });
      const s = (await res.json().catch(() => ({}))) as {
        id?: string;
        title?: string;
        error?: string;
      };
      if (!s.id) return setErr(s.error || 'failed');
      setCreating(false);
      setNewName('');
      openSessionUrl(s.id, s.title || title);
    });
  };

  // ── session row renderer (same rows as the home screen) ──────────────────
  const isUnread = (s: RootSess) =>
    isHome && s.lastRole === 'assistant' && (s.lastAt || 0) > lastRead(slugify(s.title || s.id));

  function renderBranch(s: RootSess, depth: number) {
    const kids = kidsById.get(s.id) || [];
    const liveKids = kids.filter((k) => !k.archived).length;
    const isOpen = kids.length > 0 && (subsOpen[s.id] ?? below.hot.has(s.id));
    const kidLive = below.work.has(s.id);
    const unread = isUnread(s);
    const openQ =
      s.lastRole === 'assistant' &&
      !s.pending &&
      !s.busy &&
      !!s.lastHasQ &&
      Date.now() - (s.lastAt || 0) < OPEN_QUESTION_TTL_MS;
    const statusKey = s.archived ? 'archived' : s.card?.status || s.status || '';
    const st = CARD_ST[statusKey];
    const working = reachable && isWorking(s);
    const needs = (s.card?.needs || '').trim();
    const sub = needs ? (
      <>
        <span className="oz-asks">asks:</span> {needs}
      </>
    ) : (
      s.card?.headline ||
      s.headline ||
      (isOnboardPrompt(s.preview || '') ? 'setup' : s.preview || '')
    );
    const dot = depth ? 'text-[10px]' : '';
    const canOpen = reachable || isHome || !!s.proxy;
    const eng = engineWord(s.engine);

    return (
      <>
        <button
          type="button"
          className={`oz-row ${depth > 0 ? 'compact' : ''} ${unread ? 'unread' : ''}`}
          data-testid="root-sess"
          data-id={s.id}
          disabled={!canOpen || busy}
          style={!reachable ? { opacity: 0.5 } : undefined}
          onClick={() => openSess(s)}
        >
          <div className="oz-r1">
            {working ? (
              <span className={`oz-breathe ${dot} text-[var(--oz-success)]`} aria-label="working">
                ●
              </span>
            ) : st?.dot && reachable ? (
              <span className={dot} style={{ color: st.c }} aria-hidden="true">
                ●
              </span>
            ) : openQ && reachable ? (
              <span aria-label="open question">○</span>
            ) : unread && reachable ? (
              <span className={dot} aria-label="unread">
                ●
              </span>
            ) : null}
            <span className={`t ${depth ? 'opacity-85' : ''}`}>
              <span
                className="mr-1 opacity-60"
                aria-hidden="true"
                title={s.harness ? 'your terminal conversation' : roleOf(s.agent)}
              >
                [{sessionTag(s, false)}]
              </span>
              {s.title || s.id}
            </span>
            {kids.length > 0 && (
              <span
                role="button"
                aria-expanded={isOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSubs(s.id, below.hot.has(s.id));
                }}
                className={`oz-subs ${isOpen ? 'open' : kidLive && reachable ? 'live' : ''}`}
              >
                {liveKids ? `${liveKids} sub${liveKids === 1 ? '' : 's'}` : `${kids.length} closed`}
                {kidLive && reachable && !isOpen ? ' ●' : ''}
              </span>
            )}
            {/* one status word, as on home (owner 11-17): "working" while it works — the
                rest is the dot's color */}
            {working && (
              <span className="oz-st" style={{ color: 'var(--oz-success)' }}>
                working
              </span>
            )}
            {eng && (
              <span className="oz-eng" data-testid="engine-word">
                {eng}
              </span>
            )}
            <time>{fmtListTime(byOwner(s))}</time>
          </div>
          {(sub || !depth) && <div className="oz-r2">{sub || '\u00a0'}</div>}
        </button>
        {isOpen && (
          <div className="oz-kids">
            {renderGroup(kids, `root-closed:${rootId}:${s.id}`, depth + 1, !liveKids)}
          </div>
        )}
      </>
    );
  }

  function renderGroup(list: RootSess[], key: string, depth = 0, showClosed = false) {
    const open = list.filter((s) => !s.archived);
    const closed = list.filter((s) => s.archived);
    const shown = showClosed || !!subsOpen[key];
    // as on home: top level rows are <li>s; nested ones sit in their parent's .oz-kids
    const Item = depth ? 'div' : 'li';
    return (
      <>
        {open.map((s) => (
          <Item key={s.id}>{renderBranch(s, depth)}</Item>
        ))}
        {closed.length > 0 && !showClosed && (
          <Item>
            <button
              type="button"
              aria-expanded={shown}
              onClick={() => toggleSubs(key, false)}
              className={`oz-closed ${shown ? 'open' : ''}`}
            >
              {closed.length} closed
            </button>
          </Item>
        )}
        {shown && closed.map((s) => <Item key={s.id}>{renderBranch(s, depth)}</Item>)}
      </>
    );
  }

  const refresh = () => {
    setLoading(true);
    void loadAll();
  };

  return (
    <div
      data-theme={world ?? undefined}
      className="min-h-dvh bg-[var(--oz-bg)] text-[var(--oz-text)]"
    >
      {/* the last row scrolls clear of the roots (84 px + the safe area) */}
      <main
        className="relative mx-auto flex min-h-dvh max-w-md flex-col px-3"
        style={{ paddingBottom: 'calc(var(--oz-roots-h) + 16px + env(safe-area-inset-bottom))' }}
        data-testid="root-view"
        data-root={rootId}
        data-root-theme={world ?? undefined}
        data-reachable={reachable ? 'on' : 'off'}
      >
        {/* the home screen's header and band, for this computer: its name is the way into
            its settings, the artifacts key opens its own files, the roots key every computer */}
        <HomeHead
          title={rootId}
          settingsHref={`/roots/${enc}/settings`}
          artifactsHref={`/roots/${enc}/artifacts`}
          unseen={unseenArts}
          joins={tree?.joins?.length ?? 0}
          behind={tree?.roots.filter((r) => r.behind).length ?? 0}
          loading={loading}
          gone={!!tree && !reachable}
          onRoots={() => router.push(ROOTS_PATH)}
          onRefresh={refresh}
        />
        <HomeBand
          name={rootId}
          working={runningCount}
          walk={branchWorking}
          only={onlyWorking}
          onToggle={() => setOnlyWorking((v) => !v)}
          testId="root-band"
        />

        {/* the home screen's new-session key: the session is made on this computer */}
        <div className="mb-2 flex items-stretch gap-1.5">
          <button
            type="button"
            className={`oz-k ok h-11 flex-1 justify-start px-3 text-[13px] ${
              reachable ? '' : 'oz-gone'
            }`}
            disabled={!reachable || busy}
            data-testid="roots-new"
            onClick={() => setCreating((c) => !c)}
          >
            <LineIcon name="plus" size={14} /> new session
          </button>
        </div>

        {creating && reachable && (
          <div className="oz-box mb-2 p-3">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createSession()}
              placeholder="session name…"
              className="oz-field mb-2.5"
              data-testid="roots-new-name"
            />
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={createSession}
                className="oz-k ok flex-1"
                disabled={busy}
                data-testid="roots-create"
              >
                create & open
              </button>
              <button type="button" onClick={() => setCreating(false)} className="oz-k px-4">
                cancel
              </button>
            </div>
          </div>
        )}

        {err && (
          <p role="alert" className="pb-2 text-[11px] text-[var(--oz-danger)]">
            {err}
          </p>
        )}

        {!sessView && !(isHome && homeSessions) ? (
          <p className="pt-6 text-center text-xs text-[var(--oz-dim)]">…</p>
        ) : shownTops.length === 0 ? (
          <p className="pt-6 text-center text-xs text-[var(--oz-dim)]">
            {reachable ? 'no sessions yet' : 'no sessions'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="root-sessions-list">
            {renderGroup(shownTops, `root-closed:${rootId}:top`)}
          </ul>
        )}
        {!reachable && topSessions.length > 0 && (
          <div
            className="mt-1 border border-dashed border-[var(--oz-border)] py-1.5 text-center text-[11px] text-[var(--oz-dim)]"
            data-testid="root-readonly-note"
          >
            read-only
          </div>
        )}
      </main>

      {/* Bottom MAIN bar: home keeps full MainBar (hold-to-talk); remote opens that computer's MAIN */}
      {isHome ? (
        <MainBar
          main={homeMainRow}
          branchWorking={displaySessions.some(isWorking)}
          onSettled={loadAll}
          testId="root-main"
        />
      ) : (
        <div
          className="oz-roots oz-ygg"
          data-testid="root-main"
          data-s={sessView?.main?.busy && reachable ? 'working' : 'idle'}
        >
          <button
            type="button"
            className="oz-roots-hit"
            disabled={!reachable || busy}
            aria-label={reachable ? `main · ${rootId} — tap to open` : `main · ${rootId} — offline`}
            onClick={openRemoteMain}
            style={!reachable ? { cursor: 'default' } : undefined}
          >
            <YggRoots />
            <span className="lbl">
              <span className={`nm ${reachable ? '' : 'oz-gone'}`}>
                <span
                  aria-hidden="true"
                  style={{ color: reachable ? 'var(--oz-success)' : 'var(--oz-dim)' }}
                >
                  {reachable ? '●' : '○'}
                </span>
                main · {rootId}
              </span>
              <span className="ln">
                {reachable
                  ? sessView?.main?.preview || `talk to ${rootId}`
                  : seenMs
                    ? `last seen ${
                        Date.now() - seenMs < 6 * 3600_000 ? ago(seenMs) : fmtListTime(seenMs)
                      }`
                    : 'off'}
              </span>
            </span>
          </button>
        </div>
      )}

    </div>
  );
}
