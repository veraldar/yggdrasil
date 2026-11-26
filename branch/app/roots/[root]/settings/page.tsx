'use client';

/** /roots/[root]/settings — one computer's settings, opened the way /settings opens from the
 *  home screen: a tap on the computer's name at the top of its own page (/roots/[root]), and
 *  `back` returns there. The /settings page's own header and blocks, scoped to that computer:
 *    world          the app's world list (components/world-picker), saved ON that computer
 *                   (each computer keeps its own); the home root's world is the app's
 *    roles          each role's engine and model there (inline editor)
 *    engines        each engine's default model there
 *    this computer  state, system, cpu, memory, models, joined
 *    remove         (not the home root; works while it is off too)
 *  A computer that is off keeps what home last knew of it, greyed and read-only. A save a
 *  computer cannot take says so in one line, never a bare error: a computer whose brain is
 *  older than the setting reads "<name> needs an update for this" (lib/root-outdated), and the
 *  pick goes back to what it was. */
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import { ProvidersBlock } from '@/components/providers-block';
import { HOME_ROOT_KEY } from '@/components/roots-sheet';
import { WorldPicker } from '@/components/world-picker';
import {
  type AgentRow,
  ENGINE_NOTE,
  type EngineRow,
  MORE_ENGINES,
  byRole,
  engineLabel,
  roleTag,
} from '@/lib/agents';
import { rootOfParam } from '@/lib/root-param';
import {
  type WorldId,
  cacheRootTheme,
  cachedRootTheme,
  chosenWorld,
  useScopedTheme,
} from '@/lib/worlds';

const POLL_MS = 5000;

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

export default function RootSettingsPage({ params }: { params: Promise<{ root: string }> }) {
  const root = rootOfParam(use(params).root);
  return <RootSettings key={root} rootId={root} />;
}

function RootSettings({ rootId }: { rootId: string }) {
  const router = useRouter();
  const enc = encodeURIComponent(rootId);
  const { theme: appTheme, setTheme: setHomeTheme } = useTheme();
  // next-themes only knows the stored theme after mount — no "current" marker before
  const [mounted, setMounted] = useState(false);
  const [settings, setSettings] = useState<RootSettingsResp | null>(null);
  const [cachedHome, setCachedHome] = useState('');
  const [busy, setBusy] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  const [openRole, setOpenRole] = useState('');
  const [openEng, setOpenEng] = useState('');
  const [engText, setEngText] = useState('');
  const [saveErr, setSaveErr] = useState('');

  useEffect(() => {
    setMounted(true);
    try {
      setCachedHome(localStorage.getItem(HOME_ROOT_KEY) || '');
    } catch {
      /* private mode */
    }
  }, []);
  const isHome = settings ? settings.home === true : !!cachedHome && cachedHome === rootId;
  // the home root is always here; another computer is on once it says so
  const reachable = isHome ? true : (settings?.reachable ?? false);

  // this computer's own world: only one picked for it (paint cache first, server always wins);
  // null = none picked → the page wears the app's world. Home's world IS the app's.
  const [world, setWorld] = useState<WorldId | null>(null);
  useEffect(() => {
    setWorld(isHome ? null : cachedRootTheme(rootId));
  }, [rootId, isHome]);
  useScopedTheme(world);

  // bumped by every save: an answer that left before it must not paint over it
  const editSeq = useRef(0);
  const loadInFlight = useRef(false);
  const load = useCallback(async () => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    const seq = editSeq.current;
    try {
      const r = await fetch(`/api/roots/${enc}/settings`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
      }).catch(() => null);
      if (!r?.ok) return;
      const s = (await r.json().catch(() => null)) as RootSettingsResp | null;
      if (!s || seq !== editSeq.current) return;
      setSettings(s);
      if (s.home) {
        // home's world is the app's: one picked for it (on another phone too) is adopted
        const hw = chosenWorld(s.theme, s.theme_rev);
        if (hw) setHomeTheme(hw);
      } else {
        const w = chosenWorld(s.theme, s.theme_rev);
        setWorld(w);
        cacheRootTheme(rootId, w);
      }
    } finally {
      loadInFlight.current = false;
    }
  }, [enc, rootId, setHomeTheme]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  /** one save: the brain's own line when it refuses (`error`), else the answer */
  async function put<T>(path: string, body: unknown): Promise<T | null> {
    setSaveErr('');
    editSeq.current += 1;
    try {
      const r = await fetch(`/api/roots/${enc}/${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
      if (!r.ok) {
        setSaveErr(d?.error || `${rootId} did not save it (${r.status})`);
        return null;
      }
      return d ?? ({} as T);
    } catch {
      setSaveErr(`${rootId} did not answer`);
      return null;
    } finally {
      editSeq.current += 1;
    }
  }

  // home: the app's world (as /settings does); another computer: its own world
  const pickWorld = async (next: WorldId) => {
    if (!reachable || busy) return;
    const prev = world;
    const prevApp = appTheme;
    if (isHome) setHomeTheme(next);
    else {
      setWorld(next);
      cacheRootTheme(rootId, next);
    }
    const d = await put<{ rev?: number }>('theme', { theme: next });
    if (!d) {
      if (isHome) {
        if (prevApp) setHomeTheme(prevApp);
      } else {
        setWorld(prev);
        cacheRootTheme(rootId, prev);
      }
      return;
    }
    setSettings((cur) =>
      cur ? { ...cur, theme: next, theme_rev: d.rev ?? (cur.theme_rev ?? 0) + 1 } : cur
    );
  };

  const saveRole = async (roleName: string, patch: { harness?: string; model?: string | null }) => {
    if (!reachable) return;
    const d = await put<AgentRow>(`agent/${encodeURIComponent(roleName)}`, patch);
    if (!d) return;
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
    const d = await put<EngineRow>(`engine/${encodeURIComponent(engName)}`, { model });
    if (!d) return;
    setSettings((cur) =>
      cur
        ? {
            ...cur,
            engines: (cur.engines ?? []).map((x) =>
              x.name === engName ? { ...x, ...(d.name === engName ? d : { model }) } : x
            ),
          }
        : cur
    );
    setOpenEng('');
  };

  const removeThisRoot = async () => {
    if (busy) return;
    setBusy(true);
    setSaveErr('');
    try {
      const r = await fetch(`/api/roots/${enc}/remove`, { method: 'POST' });
      if (!r.ok) return setSaveErr(`${rootId} was not removed (${r.status})`);
      router.push('/roots/');
    } catch {
      setSaveErr(`${rootId} was not removed`);
    } finally {
      setBusy(false);
    }
  };

  const hw = settings?.hardware ?? {};
  const seenMs = msOf(settings?.seen);
  const stateText = reachable ? 'on' : seenMs ? `last seen ${ago(seenMs)}` : 'off';
  const roles = useMemo(() => [...(settings?.roles ?? [])].sort(byRole), [settings?.roles]);
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
  const current = !mounted ? undefined : isHome ? appTheme : (world ?? appTheme);

  return (
    <main
      className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6"
      data-testid="root-settings"
      data-root={rootId}
      data-root-theme={world ?? undefined}
      data-reachable={reachable ? 'on' : 'off'}
    >
      {/* the /settings header: back (to this computer's page) · settings · whose */}
      <header className="oz-head justify-start gap-2.5">
        <Link href={`/roots/${enc}`} className="oz-k sm" data-testid="settings-back">
          <LineIcon name="back" size={13} /> back
        </Link>
        <span className="min-w-0 truncate text-[13px]">
          settings<span className="text-[var(--oz-dim)]"> · {rootId}</span>
        </span>
      </header>

      {saveErr && (
        <p
          role="alert"
          className="pb-2 text-[11px] text-[var(--oz-danger)]"
          data-testid="save-error"
        >
          {saveErr}
        </p>
      )}

      {/* world (saved for that computer) */}
      <section className={`oz-blk ${reachable ? '' : 'oz-gone'}`} data-testid="root-world-block">
        <h2>world</h2>
        <WorldPicker current={current} disabled={!reachable} onPick={(w) => void pickWorld(w)} />
      </section>

      {/* roles (saved on that computer) */}
      <section className={`oz-blk ${reachable ? '' : 'oz-gone'}`} data-testid="root-roles-block">
        <h2>roles</h2>
        {roles.length === 0 ? (
          <p className="text-[11px] text-[var(--oz-dim)]">{settings ? 'none' : '…'}</p>
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
                    : (engRow?.models ?? [])
                  : (engRow?.models ?? []);
              const mainEngChoices = mainEngines.length
                ? mainEngines
                : [
                    { name: 'root', label: 'root', model: null, models: [] },
                    { name: 'claude', label: 'Claude Code', model: null, models: [] },
                    { name: 'antigravity', label: 'Antigravity', model: null, models: [] },
                  ];
              return (
                <li key={r.name} className="eng" data-testid="root-role" data-role={r.name}>
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
                      <span className="tag" data-testid="role-engine">
                        {engineLabel(eng)}
                      </span>
                      <span className="m" data-testid="role-model">
                        {model} {!locked && reachable ? (isOpen ? '▲' : '›') : ''}
                      </span>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pt-1 pb-2.5">
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
                            onClick={() => void saveRole(r.name, { harness: e.name, model: null })}
                          >
                            {e.label || engineLabel(e.name)}
                          </button>
                        ))}
                      </div>
                      {offered.length > 0 &&
                        !(offered.length === 1 && offered[0] === 'default') && (
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

      {/* engines */}
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
                <li key={e.name} className="eng" data-testid="root-engine" data-engine={e.name}>
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
                      <span className="m" data-testid="engine-model">
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
                            x.key === 'Enter' && void saveEngine(e.name, engText.trim() || null)
                          }
                          placeholder="empty = its default"
                          aria-label={`${label} default model`}
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
                            data-testid={`engine-${e.name}-model-${m}`}
                            onClick={() => void saveEngine(e.name, m === 'default' ? null : m)}
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

      {/* providers (per root: z.ai, Ollama on LAN, OpenRouter, …) */}
      <ProvidersBlock rootId={rootId} isHome={isHome} disabled={!reachable} />

      {/* this computer */}
      <section className="oz-blk" data-testid="root-info-block">
        <h2>this computer</h2>
        <ul className="oz-kv">
          <li>
            <span>state</span>
            <span
              data-testid="roots-state"
              style={{ color: reachable ? 'var(--oz-success)' : 'var(--oz-dim)' }}
            >
              {settings || isHome ? stateText : '…'}
            </span>
            <span />
          </li>
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

      {/* remove: another computer only (works while it is off too) */}
      {!isHome && (settings || cachedHome) && (
        <section className="oz-blk danger" data-testid="root-danger-block">
          {askRemove ? (
            <div
              className="flex flex-col gap-2"
              role="alertdialog"
              aria-label={`Remove ${rootId}?`}
            >
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
    </main>
  );
}
