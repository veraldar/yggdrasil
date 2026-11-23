'use client';

/** /roots/[root] — A page for every computer (root-detail-proposal.html & root-detail-mockup.html).
 *  The home screen, scoped to one computer — its design, not a look of its own (owner 11-23
 *  22:19: "keep the same design, the ux should be the same between root as is our current
 *  root"): the app's world (a computer wears its own only once one was picked for it,
 *  lib/worlds.ts), the home screen's band, new-session key and rows, the app's tab strip
 *  (.oz-tabs, as /artifacts), its artifact rows and its world list (components/world-picker).
 *    header   ‹ (back to roots list) · name (+ home tag) · ● on / ○ last seen … / ○ off
 *    sub      os · arch · cpus · mem · N running
 *    band     the home screen's tree band; its chip filters to the working rows
 *    tabs     sessions · artifacts · settings
 *    sessions ＋ new session + the exact same rows as the home screen (nested sub-sessions, role
 *             badges, status dots + "working", engine words, asks/headline/preview)
 *    artifacts files made on that computer (inline viewer for non-html, direct open for html)
 *    settings world (the app's world list, saved on that computer) · roles (inline runs-on +
 *             model editor) ·
 *             engines · this computer · remove (non-home, works offline too)
 *    bottom   its MAIN bar (home: full MainBar with hold-to-talk; remote: tap opens its MAIN)
 *  When offline: keeps its world, last-seen time, last known rows, artifacts, and settings from
 *  home's persisted snapshot, dimmed and read-only. Nothing is queued. Remove still works. */

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { Streamdown } from 'streamdown';
import { LineIcon } from '@/components/line-icon';
import { MainBar, type MainBarRow } from '@/components/main-bar';
import { HOME_ROOT_KEY, type Tree } from '@/components/roots-sheet';
import { WorldPicker } from '@/components/world-picker';
import { BAND_VIEWBOX, YggRoots, YggTree } from '@/components/ygg';
import {
  type AgentRow,
  ENGINE_NOTE,
  type EngineRow,
  MORE_ENGINES,
  byRole,
  engineLabel,
  engineWord,
  roleOf,
  roleTag,
  sessionTag,
} from '@/lib/agents';
import { glyphOf, kindOf } from '@/lib/artifact-kind';
import { CARD_ST, type Card } from '@/lib/card';
import { lastRead } from '@/lib/read';
import { slugify } from '@/lib/slug';
import { MAIN_SLUG, isMainSlug, isOnboardPrompt } from '@/lib/tree-first';
import {
  type WorldId,
  cacheRootTheme,
  cacheTreeThemes,
  cachedRootTheme,
  chosenWorld,
  useScopedTheme,
} from '@/lib/worlds';

const POLL_MS = 5000;
const OPEN_QUESTION_TTL_MS = 48 * 60 * 60 * 1000;
const TREE_OPEN_KEY = 'oz-tree-open';

type Tab = 'sessions' | 'artifacts' | 'settings';

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

type RootSettingsResp = {
  root: string;
  home?: boolean;
  reachable?: boolean;
  seen?: number | null;
  theme?: string | null;
  theme_rev?: number;
  hardware?: {
    os?: string | null;
    arch?: string | null;
    cpus?: number | null;
    mem_gb?: number | null;
  };
  models?: string[];
  roles?: AgentRow[];
  engines?: EngineRow[];
  joined_at?: string | null;
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

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

function fmtJoined(iso?: string | null): string {
  if (!iso) return '';
  const m = Date.parse(iso);
  if (!Number.isFinite(m)) return '';
  return new Date(m).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

function ArtifactViewer({
  file,
  root,
  isHome,
}: {
  file: RootArtifact;
  root: string;
  isHome: boolean;
}) {
  const kind = kindOf(file.name);
  const src = `/api/artifact/${encodeURIComponent(file.name)}${
    isHome ? '' : `?root=${encodeURIComponent(root)}`
  }`;
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
        className="max-h-[calc(100dvh-14rem)] w-full border border-[var(--oz-border)] object-contain"
      />
    );
  }
  if (kind === 'audio') return <audio controls src={src} className="w-full" preload="metadata" />;
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
    <div className="oz-box max-h-[calc(100dvh-14rem)] overflow-auto px-2 py-1">
      {kind === 'md' ? (
        <div className="text-sm">
          <Streamdown>{body}</Streamdown>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words text-xs text-[var(--oz-text)]/85">
          {body}
        </pre>
      )}
    </div>
  );
}

export default function RootDetailPage({ params }: { params: Promise<{ root: string }> }) {
  const { root: rawRoot } = use(params);
  const rootId = useMemo(() => {
    try {
      return decodeURIComponent(rawRoot);
    } catch {
      return rawRoot;
    }
  }, [rawRoot]);

  const router = useRouter();
  const { theme: appTheme, setTheme: setHomeTheme } = useTheme();

  const [tab, setTab] = useState<Tab>('sessions');
  const [tree, setTree] = useState<Tree | null>(null);
  const [sessView, setSessView] = useState<RootSessionsResp | null>(null);
  const [homeSessions, setHomeSessions] = useState<RootSess[] | null>(null);
  const [settings, setSettings] = useState<RootSettingsResp | null>(null);
  const [artifacts, setArtifacts] = useState<RootArtifact[] | null>(null);
  const [openArt, setOpenArt] = useState<RootArtifact | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [askRemove, setAskRemove] = useState(false);
  // the band's chip: only the working rows (and the parents they hang from), as on home
  const [onlyWorking, setOnlyWorking] = useState(false);

  // inline role & engine editor state in Settings tab
  const [openRole, setOpenRole] = useState('');
  const [openEng, setOpenEng] = useState('');
  const [engText, setEngText] = useState('');
  const [saveErr, setSaveErr] = useState('');

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
  const isHome = settings?.home === true || (!!homeName && homeName === rootId);

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

  const loadInFlight = useRef(false);
  // bumped by every world pick: a load that started before it must not undo it
  const pickSeq = useRef(0);
  const loadAll = useCallback(async () => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    const seq = pickSeq.current;
    const enc = encodeURIComponent(rootId);
    try {
      const [rTree, rSess, rSet, rArt] = await Promise.all([
        fetch('/api/roots', { cache: 'no-store', signal: AbortSignal.timeout(10_000) }).catch(
          () => null
        ),
        fetch(`/api/roots/${enc}/sessions`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(12_000),
        }).catch(() => null),
        fetch(`/api/roots/${enc}/settings`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
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
          setTree(t);
          cacheTreeThemes(t);
          if (t.home?.name) {
            detectedHome = t.home.name;
            try {
              localStorage.setItem(HOME_ROOT_KEY, t.home.name);
            } catch {
              /* private mode */
            }
          }
          if (seq !== pickSeq.current) {
            /* a pick landed meanwhile: this answer predates it */
          } else if (t.home?.name === rootId) {
            // home's world is the app's: a world picked for it (on another phone too) is adopted
            // as the app's, exactly as the home screen does — an unpicked one never is
            const hw = chosenWorld(t.home.theme, t.home.theme_rev);
            if (hw) setHomeTheme(hw);
          } else {
            const r = t.roots.find((x) => x.id === rootId);
            if (r) setWorld(chosenWorld(r.theme, r.theme_rev));
          }
        }
      }

      if (rSess?.ok) {
        const v = (await rSess.json().catch(() => null)) as RootSessionsResp | null;
        if (v) setSessView(v);
      } else {
        setSessView((old) => old ?? { root: rootId, reachable: false, main: null, sessions: [] });
      }

      if (rSet?.ok) {
        const s = (await rSet.json().catch(() => null)) as RootSettingsResp | null;
        if (s) {
          setSettings(s);
          if (!s.home && seq === pickSeq.current) {
            const w = chosenWorld(s.theme, s.theme_rev);
            setWorld(w);
            cacheRootTheme(rootId, w);
          }
        }
      }

      if (rArt?.ok) {
        const a = (await rArt.json().catch(() => null)) as { artifacts?: RootArtifact[] } | null;
        if (a && Array.isArray(a.artifacts)) setArtifacts(a.artifacts);
      } else {
        setArtifacts((old) => old ?? []);
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
    }
  }, [rootId, homeName, setHomeTheme]);

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

  const reachable = isHome
    ? true
    : settings?.reachable ?? sessView?.reachable ?? treeEntry?.reachable ?? false;
  const seenMs = msOf(settings?.seen ?? treeEntry?.seen);
  const hw = {
    os: settings?.hardware?.os ?? treeEntry?.os ?? null,
    arch: settings?.hardware?.arch ?? treeEntry?.arch ?? null,
    cpus: settings?.hardware?.cpus ?? treeEntry?.cpus ?? null,
    mem_gb: settings?.hardware?.mem_gb ?? treeEntry?.mem_gb ?? null,
  };

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
        (s) => s.id !== mainId && !isMainSlug(slugify(s.title || '')) && s.card?.kind !== 'root-main'
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

  const openCount = useMemo(
    () => displaySessions.filter((s) => !s.archived).length,
    [displaySessions]
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
      const s = (await res.json().catch(() => ({}))) as { id?: string; title?: string; error?: string };
      if (!s.id) return setErr(s.error || 'failed');
      setCreating(false);
      setNewName('');
      openSessionUrl(s.id, s.title || title);
    });
  };

  // home: the app's world (as /settings does); another computer: its own world
  const pickWorld = async (next: WorldId) => {
    if (!reachable || busy) return;
    setSaveErr('');
    pickSeq.current += 1;
    const prev = world;
    const prevApp = appTheme;
    const undo = () => {
      if (isHome) {
        if (prevApp) setHomeTheme(prevApp);
        return;
      }
      setWorld(prev);
      cacheRootTheme(rootId, prev);
    };
    if (isHome) setHomeTheme(next);
    else {
      setWorld(next);
      cacheRootTheme(rootId, next);
    }
    try {
      const r = await fetch(`/api/roots/${encodeURIComponent(rootId)}/theme`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      });
      const d = (await r.json().catch(() => ({}))) as { theme?: string; rev?: number; error?: string };
      if (!r.ok) {
        undo();
        setSaveErr(d.error || `save failed (${r.status})`);
      } else {
        setSettings((cur) =>
          cur ? { ...cur, theme: next, theme_rev: d.rev ?? (cur.theme_rev ?? 0) + 1 } : cur
        );
      }
    } catch {
      undo();
      setSaveErr('could not reach computer');
    }
  };

  const saveRole = async (roleName: string, patch: { harness?: string; model?: string | null }) => {
    if (!reachable) return;
    setSaveErr('');
    const r = await fetch(
      `/api/roots/${encodeURIComponent(rootId)}/agent/${encodeURIComponent(roleName)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }
    ).catch(() => null);
    const d = (await r?.json().catch(() => null)) as { error?: string; harness?: string; model?: string | null } | null;
    if (!r?.ok) {
      setSaveErr(d?.error || `save failed (${r?.status ?? 'offline'})`);
      return;
    }
    setSettings((cur) =>
      cur
        ? {
            ...cur,
            roles: (cur.roles ?? []).map((x) =>
              x.name === roleName
                ? {
                    ...x,
                    ...(patch.harness !== undefined
                      ? { harness: patch.harness === 'root' ? null : patch.harness }
                      : {}),
                    ...(patch.model !== undefined ? { model: patch.model } : {}),
                  }
                : x
            ),
          }
        : cur
    );
  };

  const saveEngine = async (engName: string, model: string | null) => {
    if (!reachable) return;
    setSaveErr('');
    const r = await fetch(
      `/api/roots/${encodeURIComponent(rootId)}/engine/${encodeURIComponent(engName)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      }
    ).catch(() => null);
    const d = (await r?.json().catch(() => null)) as (EngineRow & { error?: string }) | null;
    if (!r?.ok) {
      setSaveErr(d?.error || `save failed (${r?.status ?? 'offline'})`);
      return;
    }
    setSettings((cur) =>
      cur
        ? {
            ...cur,
            engines: (cur.engines ?? []).map((x) =>
              x.name === engName ? { ...x, ...(d?.name === engName ? d : { model }) } : x
            ),
          }
        : cur
    );
    setOpenEng('');
  };

  const removeThisRoot = () =>
    runAction(async () => {
      const r = await fetch(`/api/roots/${encodeURIComponent(rootId)}/remove`, {
        method: 'POST',
      });
      if (!r.ok) return setErr('failed');
      router.push('/?roots=1');
    });

  // ── session row renderer (same rows as the home screen) ──────────────────
  const isUnread = (s: RootSess) =>
    isHome &&
    s.lastRole === 'assistant' &&
    (s.lastAt || 0) > lastRead(slugify(s.title || s.id));

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
      <div key={s.id}>
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
          <div className="oz-kids">{renderGroup(kids, `root-closed:${rootId}:${s.id}`, depth + 1, !liveKids)}</div>
        )}
      </div>
    );
  }

  function renderGroup(list: RootSess[], key: string, depth = 0, showClosed = false) {
    const open = list.filter((s) => !s.archived);
    const closed = list.filter((s) => s.archived);
    const shown = showClosed || !!subsOpen[key];
    return (
      <>
        {open.map((s) => renderBranch(s, depth))}
        {closed.length > 0 && !showClosed && (
          <div>
            <button
              type="button"
              aria-expanded={shown}
              onClick={() => toggleSubs(key, false)}
              className={`oz-closed ${shown ? 'open' : ''}`}
            >
              {closed.length} closed
            </button>
          </div>
        )}
        {shown && closed.map((s) => renderBranch(s, depth))}
      </>
    );
  }

  // state text & subtitle
  const stateText = reachable
    ? '● on'
    : seenMs
      ? `○ last seen ${
          Date.now() - seenMs < 6 * 3600_000 ? ago(seenMs) : fmtListTime(seenMs)
        }`
      : '○ off';

  const subtitle = [
    hw.os,
    hw.arch,
    hw.cpus ? `${hw.cpus} cpu` : '',
    hw.mem_gb ? `${hw.mem_gb} GB` : '',
    reachable && runningCount ? `${runningCount} running` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const roles = useMemo(
    () => [...(settings?.roles ?? [])].sort(byRole),
    [settings?.roles]
  );
  const engines = useMemo(() => settings?.engines ?? [], [settings?.engines]);
  const mainEngines = useMemo(
    () => engines.filter((e) => !(e.more ?? MORE_ENGINES.has(e.name))),
    [engines]
  );
  const moreEngines = useMemo(
    () => engines.filter((e) => e.more ?? MORE_ENGINES.has(e.name)),
    [engines]
  );
  const engineModel = (e: string) => engines.find((x) => x.name === e)?.model || null;

  return (
    <div data-theme={world ?? undefined} className="min-h-dvh bg-[var(--oz-bg)] text-[var(--oz-text)]">
      <main
        className="relative mx-auto flex min-h-dvh max-w-md flex-col px-3"
        style={{ paddingBottom: 'calc(var(--oz-roots-h) + 16px + env(safe-area-inset-bottom))' }}
        data-testid="root-view"
        data-root={rootId}
        data-root-theme={world ?? undefined}
        data-reachable={reachable ? 'on' : 'off'}
      >
        {/* header: ‹ · computer name (+ home) · status */}
        <header className="oz-head justify-start gap-2">
          <button
            type="button"
            className="oz-k sm"
            aria-label="back to roots"
            data-testid="roots-back"
            onClick={() => router.push('/?roots=1')}
          >
            <LineIcon name="back" size={14} />
          </button>
          <h1
            className={`min-w-0 truncate text-[13px] font-bold tracking-[.04em] ${
              reachable ? '' : 'oz-gone'
            }`}
            data-testid="roots-title"
          >
            {rootId}
          </h1>
          {isHome && <span className="oz-subs">home</span>}
          <span
            className="ml-auto flex-none text-[10px] tracking-[.02em]"
            style={{ color: reachable ? 'var(--oz-success)' : 'var(--oz-dim)' }}
            data-testid="roots-state"
          >
            {stateText}
          </span>
        </header>

        {subtitle && (
          <p
            className={`-mt-1.5 mb-2.5 truncate text-[11px] text-[var(--oz-dim)] ${reachable ? '' : 'oz-gone'}`}
            data-testid="root-sub"
          >
            {subtitle}
          </p>
        )}

        {/* the home screen's band, for this computer: still unless something works there; the
            chip taps to a working-only list, again to clear */}
        <figure
          className={`oz-band oz-ygg -mx-3 mb-2.5 ${runningCount ? 'live' : ''} ${branchWorking ? 'walk' : ''}`}
          aria-label={
            runningCount ? `${rootId} — ${runningCount} working` : `${rootId} — nothing working`
          }
          data-testid="root-band"
        >
          <YggTree viewBox={BAND_VIEWBOX} slice />
          <button
            type="button"
            onClick={() => runningCount > 0 && setOnlyWorking((v) => !v)}
            aria-pressed={onlyWorking}
            aria-label={
              runningCount
                ? `${runningCount} working — ${onlyWorking ? 'show every session' : 'show only the working'}`
                : `${rootId} — nothing working`
            }
            data-testid="working-filter"
            className={`oz-cap ${onlyWorking ? 'on' : ''}`}
          >
            <i />
            {runningCount ? `${runningCount} working` : 'all quiet'}
          </button>
        </figure>

        {/* three tabs: sessions · artifacts · settings — the app's tab strip (as /artifacts) */}
        <div className="mb-2 flex items-center gap-2">
          <div className="oz-tabs" role="tablist" aria-label={`${rootId} sections`} data-testid="root-tabs">
            <button
              type="button"
              aria-pressed={tab === 'sessions'}
              data-testid="tab-sessions"
              onClick={() => {
                setTab('sessions');
                setOpenArt(null);
              }}
            >
              sessions{openCount > 0 && ` ${openCount}`}
            </button>
            <button
              type="button"
              aria-pressed={tab === 'artifacts'}
              data-testid="tab-artifacts"
              onClick={() => setTab('artifacts')}
            >
              artifacts{artifacts && artifacts.length > 0 && ` ${artifacts.length}`}
            </button>
            <button
              type="button"
              aria-pressed={tab === 'settings'}
              data-testid="tab-settings"
              onClick={() => {
                setTab('settings');
                setOpenArt(null);
              }}
            >
              settings
            </button>
          </div>
        </div>

        {err && (
          <p role="alert" className="pb-2 text-[11px] text-[var(--oz-danger)]">
            {err}
          </p>
        )}

        {/* ── TAB 1: SESSIONS ── */}
        {tab === 'sessions' && (
          <section className="flex flex-col gap-2" data-testid="root-sessions-tab">
            {/* the home screen's new-session key */}
            <div className="flex items-stretch gap-1.5">
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
              <div className="oz-box p-3">
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
                  <button
                    type="button"
                    onClick={() => setCreating(false)}
                    className="oz-k px-4"
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1" data-testid="root-sessions-list">
              {!sessView && !(isHome && homeSessions) ? (
                <p className="pt-6 text-center text-xs text-[var(--oz-dim)]">…</p>
              ) : shownTops.length === 0 ? (
                <p className="pt-6 text-center text-xs text-[var(--oz-dim)]">
                  {reachable ? 'no sessions yet' : 'offline · no cached sessions'}
                </p>
              ) : (
                renderGroup(shownTops, `root-closed:${rootId}:top`)
              )}
              {!reachable && topSessions.length > 0 && (
                <div
                  className="mt-1 border border-dashed border-[var(--oz-border)] py-1.5 text-center text-[11px] text-[var(--oz-dim)]"
                  data-testid="root-readonly-note"
                >
                  read-only
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── TAB 2: ARTIFACTS ── */}
        {tab === 'artifacts' && (
          <section className="flex flex-col gap-2" data-testid="root-artifacts-tab">
            {openArt ? (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setOpenArt(null)}
                  className="oz-k sm w-fit"
                  data-testid="artifact-back"
                >
                  <LineIcon name="back" size={11} /> back to list
                </button>
                <div className="truncate px-0.5 text-xs text-[var(--oz-dim)]">
                  {openArt.name} · {fmtListTime(openArt.mtime)} · {fmtSize(openArt.size)}
                </div>
                <ArtifactViewer file={openArt} root={rootId} isHome={isHome} />
              </div>
            ) : !artifacts ? (
              <p className="pt-6 text-center text-xs text-[var(--oz-dim)]">…</p>
            ) : artifacts.length === 0 ? (
              <p className="pt-6 text-center text-xs text-[var(--oz-dim)]">
                {reachable ? 'no artifacts yet' : 'offline · no cached artifacts'}
              </p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="root-artifacts-list">
                {artifacts.map((a) => {
                  const canOpen = reachable || isHome;
                  return (
                    <li key={a.name}>
                      <button
                        type="button"
                        className={`oz-row ${canOpen ? '' : 'oz-gone'}`}
                        disabled={!canOpen}
                        data-testid="root-artifact"
                        data-name={a.name}
                        onClick={() => {
                          if (!canOpen) return;
                          if (kindOf(a.name) === 'html') {
                            window.location.assign(
                              `/api/artifact/${encodeURIComponent(a.name)}${
                                isHome ? '' : `?root=${encodeURIComponent(rootId)}`
                              }`
                            );
                          } else {
                            setOpenArt(a);
                          }
                        }}
                      >
                        {/* the artifacts page's row: glyph · name · provenance · time · size */}
                        <div className="oz-r1">
                          <span
                            className="w-4 shrink-0 text-center text-[var(--oz-dim)]"
                            aria-hidden="true"
                          >
                            {glyphOf(a.name)}
                          </span>
                          <span className="t opacity-80">{a.name}</span>
                          {a.source && a.source !== 'local' && (
                            <span className="shrink-0 text-[10px] text-[var(--oz-dim)]">
                              {a.source}
                            </span>
                          )}
                          <time>
                            {fmtListTime(a.mtime)} · {fmtSize(a.size)}
                          </time>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {/* ── TAB 3: SETTINGS ── */}
        {tab === 'settings' && (
          <section className="flex flex-col" data-testid="root-settings-tab">
            {saveErr && (
              <p role="alert" className="pb-2 text-[11px] text-[var(--oz-danger)]">
                {saveErr}
              </p>
            )}

            {/* World picker (saved on that computer) */}
            <section className={`oz-blk ${reachable ? '' : 'oz-gone'}`} data-testid="root-world-block">
              <h2>world</h2>
              <WorldPicker
                current={isHome ? appTheme : world ?? appTheme}
                disabled={!reachable}
                onPick={(w) => void pickWorld(w)}
              />
            </section>

            {/* Roles (saved on that computer) */}
            <section className={`oz-blk ${reachable ? '' : 'oz-gone'}`} data-testid="root-roles-block">
              <h2>roles</h2>
              {roles.length === 0 ? (
                <p className="text-[11px] text-[var(--oz-dim)]">
                  {settings ? 'no roles reported' : 'loading…'}
                </p>
              ) : (
                <ul className="oz-alist">
                  {roles.map((r) => {
                    const eng = r.harness || 'root';
                    const model = r.model || engineModel(eng) || 'default';
                    const locked = r.name === 'coordinator';
                    const isOpen = reachable && !locked && openRole === r.name;
                    const engRow = engines.find((e) => e.name === eng);
                    const offered =
                      eng === 'root'
                        ? settings?.models?.length
                          ? settings.models
                          : engRow?.models ?? []
                        : engRow?.models ?? [];
                    const mainEngChoices = mainEngines.length
                      ? mainEngines
                      : [
                          { name: 'root', label: 'root', model: null, models: [] },
                          { name: 'claude', label: 'Claude Code', model: null, models: [] },
                          { name: 'antigravity', label: 'Antigravity', model: null, models: [] },
                        ];
                    return (
                      <li
                        key={r.name}
                        className="eng"
                        data-testid="root-role"
                        data-role={r.name}
                      >
                        <button
                          type="button"
                          disabled={!reachable || locked}
                          aria-expanded={isOpen}
                          onClick={() => setOpenRole(isOpen ? '' : r.name)}
                        >
                          <span className="r1">
                            <span className="truncate">
                              <span className="mr-1 opacity-60" aria-hidden="true">
                                [{roleTag(r.name)}]
                              </span>
                              {r.name === 'coordinator' ? 'main' : r.name}
                            </span>
                            <span className="tag">{engineLabel(eng)}</span>
                            <span className="m">
                              {model} {!locked && reachable ? (isOpen ? '▲' : '›') : ''}
                            </span>
                          </span>
                        </button>
                        {isOpen && (
                          <div className="pb-2.5 pt-1">
                            <div className="mb-1 text-[10px] tracking-[.1em] text-[var(--oz-dim)]">
                              runs on
                            </div>
                            <div className="oz-chips mb-2.5">
                              {mainEngChoices.map((e) => (
                                <button
                                  key={e.name}
                                  type="button"
                                  aria-pressed={eng === e.name}
                                  data-testid={`role-${r.name}-eng-${e.name}`}
                                  onClick={() =>
                                    void saveRole(r.name, { harness: e.name, model: null })
                                  }
                                >
                                  {e.label || engineLabel(e.name)}
                                </button>
                              ))}
                            </div>
                            {offered.length > 0 && !(offered.length === 1 && offered[0] === 'default') && (
                              <>
                                <div className="mb-1 text-[10px] tracking-[.1em] text-[var(--oz-dim)]">
                                  model
                                </div>
                                <div className="oz-chips">
                                  {offered.slice(0, 8).map((m) => (
                                    <button
                                      key={m}
                                      type="button"
                                      aria-pressed={model === m}
                                      data-testid={`role-${r.name}-model-${m}`}
                                      onClick={() =>
                                        void saveRole(r.name, {
                                          harness: eng,
                                          model: m === 'default' ? null : m,
                                        })
                                      }
                                    >
                                      {m}
                                    </button>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Engines */}
            {engines.length > 0 && (
              <section
                className={`oz-blk ${reachable ? '' : 'oz-gone'}`}
                data-testid="root-engines-block"
              >
                <h2>engines</h2>
                <ul className="oz-alist">
                  {mainEngines.map((e) => {
                    const label = e.label || engineLabel(e.name);
                    const isOpen = reachable && openEng === e.name;
                    const cur = e.model || 'default';
                    const free =
                      !e.models?.length || (e.models.length === 1 && e.models[0] === 'default');
                    return (
                      <li
                        key={e.name}
                        className="eng"
                        data-testid="root-engine"
                        data-engine={e.name}
                      >
                        <button
                          type="button"
                          disabled={!reachable}
                          aria-expanded={isOpen}
                          onClick={() => {
                            setOpenEng(isOpen ? '' : e.name);
                            setEngText(e.model || '');
                          }}
                        >
                          <span className="r1">
                            <span className="truncate">{label}</span>
                            <span className="m">
                              {e.model || 'its default'} {reachable ? (isOpen ? '▲' : '›') : ''}
                            </span>
                          </span>
                          {ENGINE_NOTE[e.name] && <span className="r2">{ENGINE_NOTE[e.name]}</span>}
                        </button>
                        {isOpen &&
                          (free ? (
                            <div className="flex gap-1.5 pb-2">
                              <input
                                value={engText}
                                onChange={(x) => setEngText(x.target.value)}
                                onKeyDown={(x) =>
                                  x.key === 'Enter' &&
                                  void saveEngine(e.name, engText.trim() || null)
                                }
                                placeholder="empty = its default"
                                className="oz-field"
                              />
                              <button
                                type="button"
                                onClick={() => void saveEngine(e.name, engText.trim() || null)}
                                className="oz-k ok px-3"
                              >
                                save
                              </button>
                            </div>
                          ) : (
                            <div className="oz-chips pb-2">
                              {e.models.slice(0, 8).map((m) => (
                                <button
                                  key={m}
                                  type="button"
                                  aria-pressed={cur === m}
                                  onClick={() =>
                                    void saveEngine(e.name, m === 'default' ? null : m)
                                  }
                                >
                                  {m}
                                </button>
                              ))}
                            </div>
                          ))}
                      </li>
                    );
                  })}
                </ul>
                {moreEngines.length > 0 && reachable && (
                  <details className="pt-0">
                    <summary className="cursor-pointer text-[11px] text-[var(--oz-dim)]">
                      more engines
                    </summary>
                    <ul className="oz-alist mt-1">
                      {moreEngines.map((e) => (
                        <li key={e.name} className="eng">
                          <div className="py-2 text-[12px]">
                            <span className="r1">
                              <span className="truncate">{e.label || engineLabel(e.name)}</span>
                              <span className="m">{e.model || 'its default'}</span>
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            )}

            {/* This computer */}
            <section className="oz-blk" data-testid="root-info-block">
              <h2>this computer</h2>
              <ul className="oz-kv">
                {(hw.os || hw.arch) && (
                  <li>
                    <span>system</span>
                    <span>{[hw.os, hw.arch].filter(Boolean).join(' · ')}</span>
                    <span />
                  </li>
                )}
                {hw.cpus ? (
                  <li>
                    <span>cpu</span>
                    <span>{hw.cpus}</span>
                    <span />
                  </li>
                ) : null}
                {hw.mem_gb ? (
                  <li>
                    <span>memory</span>
                    <span>{hw.mem_gb} GB</span>
                    <span />
                  </li>
                ) : null}
                {settings?.models && settings.models.length > 0 && (
                  <li>
                    <span>models</span>
                    <span className="break-words">{settings.models.join(' · ')}</span>
                    <span />
                  </li>
                )}
                {!isHome && settings?.joined_at && (
                  <li>
                    <span>joined</span>
                    <span>{fmtJoined(settings.joined_at)}</span>
                    <span />
                  </li>
                )}
              </ul>
            </section>

            {/* Danger zone: non-home roots only (works offline too) */}
            {!isHome && (
              <section className="oz-blk danger" data-testid="root-danger-block">
                {askRemove ? (
                  <div className="flex flex-col gap-2" role="alertdialog" aria-label={`Remove ${rootId}?`}>
                    <p className="text-[12.5px]">Remove {rootId}?</p>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        className="oz-k red flex-1"
                        disabled={busy}
                        data-testid="root-remove"
                        onClick={() => void removeThisRoot()}
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        className="oz-k flex-1"
                        data-testid="root-keep"
                        onClick={() => setAskRemove(false)}
                      >
                        Keep
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <button
                      type="button"
                      className="oz-k red h-11 w-full"
                      data-testid="root-remove-btn"
                      onClick={() => setAskRemove(true)}
                    >
                      remove {rootId}
                    </button>
                  </div>
                )}
              </section>
            )}
          </section>
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
            aria-label={
              reachable ? `main · ${rootId} — tap to open` : `main · ${rootId} — offline`
            }
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
