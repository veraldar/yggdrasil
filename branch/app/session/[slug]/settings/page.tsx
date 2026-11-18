'use client';

/** Session settings — name / model / think / agent blocks (shared theme
 *  CSS: .oz-blk + oz tokens). Instant-apply:
 *  no save button, every control commits on tap/blur, like the header mode
 *  toggle. All writes go through PATCH /api/session/[id], which routes title
 *  to the session update and model/agent to opencode's v2 switch endpoints —
 *  server-side per-session state, so text AND voice turns both use it. The
 *  current think level is whatever the session records; 'default' means no
 *  explicit level set. DELETE at the bottom removes the session (opencode
 *  cascades sub-sessions) and returns to the list. Reaching this page: tap
 *  the session name in the chat header; leaving: system back gesture. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ErrorBox } from '@/components/app/error-box';
import { type AgentDetail, agentDiff } from '@/lib/agents';
import {
  checkKey,
  getStatus,
  loadKey,
  saveKey,
  setGrant,
  type AccessStatus,
} from '@/lib/full-access';
import { slugify } from '@/lib/slug';
import { isMainSlug } from '@/lib/tree-first';

/** sessions on these run another agent harness; their models are the harness's own */
const HARNESSES = new Set(['claude', 'opencode', 'codex', 'antigravity']);

type ModelRef = {
  providerID: string;
  modelID: string;
  variant: string | null;
  variants: string[];
};
type SessionInfo = {
  id: string;
  title: string;
  agent: string | null;
  model: ModelRef | null;
  /** what a model-less session runs on — the brain's default (null: the
   * brain didn't say) */
  defaultModel?: ModelRef | null;
  /** a session on another harness: which one, its conversation there, and
   * whether it continues a terminal's conversation (full access applies
   * only to that kind) */
  harness?: { kind: string | null; id: string | null; attached: boolean };
};
type ProviderRow = {
  id: string;
  name: string;
  models: { id: string; name: string; variants: string[] }[];
};
/** one of the brain's agents (/api/agents) — what it is for, in its words */
type Agent = { name: string; description: string };
type Block = 'name' | 'model' | 'think' | 'agent';
type Res = 'session' | 'models' | 'agents';
/** root-coord: MAIN's own agent — never offered to another session */
const COORD = 'coordinator';

/** One settings resource: its body, or why it didn't come (HTTP status +
 *  the proxy's error, or the network failure) — never a silent miss. */
async function grab(url: string): Promise<{ data: any } | { err: string }> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const d = await r.json().catch(() => null);
    if (!r.ok) return { err: d?.error || `HTTP ${r.status}` };
    return { data: d };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

const MAIN_REFUSAL = "MAIN can't be renamed — it keeps its name, the tree door finds it by it";

/** A refused write, said in the block the user touched (house .note, danger
 *  ink) — a refusal is an answer, not a crash for the ErrorBox's 'fix this'. */
function Refusal({ msg }: { msg: string }) {
  return (
    <p role="alert" className="note text-[var(--oz-danger)]!">
      {msg}
    </p>
  );
}

/** FULL ACCESS (owner 11-17) — a conversation continued from the terminal may run its turns
 *  outside the sandbox (ssh, gh, the release key, the build tools) for a while. Only the owner
 *  grants that, here, with the enrollment code typed once (it stays on this phone; grants go
 *  out as HMACs — lib/full-access.ts). Off by default; a grant runs out on its own; switching
 *  off needs no key. The box holds the matching key file (full-access-enroll.sh, at the
 *  computer, outside every sandbox) and re-checks every run — a grant never rides to a copy.
 *  Shown only where it can apply: a Claude Code / Antigravity session continuing a terminal's
 *  conversation. */
function FullAccessBlock({ h, title }: { h: SessionInfo['harness']; title: string }) {
  const key = `${h?.kind || ''}:${h?.id || ''}`;
  const applicable =
    (h?.kind === 'claude' || h?.kind === 'antigravity') && h?.attached === true && !!h?.id;
  const [st, setSt] = useState<AccessStatus | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState('');
  const [pending, setPending] = useState<number | null>(null); // the grant waiting for its yes (s)
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(() => {
    setNow(Date.now());
    void getStatus().then((d) => setSt(d));
  }, []);
  useEffect(() => {
    refresh();
    setHasKey(!!loadKey());
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [refresh]);
  if (!applicable) {
    return h?.kind === 'claude' || h?.kind === 'antigravity' ? (
      <section className="oz-blk">
        <h2>full access</h2>
        <p className="note pt-3!">
          for a conversation continued from the terminal — this one runs in the sandbox
        </p>
      </section>
    ) : null;
  }
  const until = st?.grants?.[key];
  const on = !!until && until > now;
  const save = async () => {
    const c = code.trim();
    if (!c || busy) return;
    setBusy(true);
    setRefused('');
    if (await checkKey(c)) {
      saveKey(c);
      setHasKey(true);
      setCode('');
    } else {
      setRefused('the box did not recognize this code');
    }
    setBusy(false);
  };
  const flip = async (s: number) => {
    if (busy) return;
    setBusy(true);
    setRefused('');
    const r = await setGrant(key, s > 0, s);
    if (!r.ok) setRefused(r.error || 'the box refused that');
    refresh();
    setBusy(false);
  };
  const hhmm = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <section className="oz-blk" data-testid="fa-block">
      <h2>full access</h2>
      {st === null ? (
        <p className="note pt-3!">checking the box&hellip;</p>
      ) : !st.enabled ? (
        <p className="note pt-3!">not set up on this box</p>
      ) : !st.enrolled || hasKey === null || !hasKey ? (
        <div>
          <div>
            <input
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setRefused('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder="the enrollment code"
              aria-label="full access enrollment code"
              data-testid="fa-code"
              className="oz-field"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="mt-2.5 flex gap-1.5">
            <button onClick={() => void save()} disabled={busy || !code.trim()} className="oz-k ok flex-1" data-testid="fa-save">
              {busy ? 'checking…' : 'save key'}
            </button>
          </div>
          <p className="note">
            type the code from full-access-enroll.sh once — it stays on this phone
          </p>
        </div>
      ) : (
        <>
          <div className="oz-chips">
            <button
              aria-pressed={!on}
              disabled={busy}
              data-testid="fa-off"
              onClick={() => void flip(0)}
            >
              off
            </button>
            {[3600, 4 * 3600].map((s) => (
              <button
                key={s}
                aria-pressed={false}
                disabled={busy}
                data-testid={s === 3600 ? 'fa-1h' : 'fa-4h'}
                onClick={() => setPending(s)}
              >
                {s === 3600 ? '1 h' : '4 h'}
              </button>
            ))}
          </div>
          <p className="note" data-testid="fa-status">
            {on
              ? `on until ${hhmm(until!)} — its turns run outside the sandbox`
              : 'off — its turns run in the sandbox'}
          </p>
          {pending !== null && (
            <div data-testid="fa-confirm">
              <p className="text-[11px] text-[var(--oz-text)]">
                full access for “{title}”? its turns run on the machine outside the sandbox, with
                the whole home: ssh keys, the GitHub login, the release key. only this conversation
                — not MAIN, not the sessions it starts. off by itself in{' '}
                {pending === 3600 ? '1 hour' : '4 hours'}.
              </p>
              <div className="mt-2.5 flex gap-1.5">
                <button
                  onClick={() => {
                    const s = pending;
                    setPending(null);
                    void flip(s);
                  }}
                  className="oz-k ok flex-1"
                  data-testid="fa-yes"
                >
                  turn on
                </button>
                <button onClick={() => setPending(null)} className="oz-k px-4" data-testid="fa-cancel">
                  cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {refused && <Refusal msg={refused} />}
    </section>
  );
}

export default function SessionSettingsView() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug || '';
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [nameInput, setNameInput] = useState(slug);
  // null = not landed yet (loading, or failed — loadErr says which)
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  // may this session notify the phone (off by default, MAIN on): null until known
  const [notify, setNotify] = useState<boolean | null>(null);
  useEffect(() => {
    fetch(`/api/notify?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setNotify(d?.on === true))
      .catch(() => setNotify(false));
  }, [slug]);
  const saveNotify = async (on: boolean) => {
    const was = notify;
    setNotify(on);
    const r = await fetch('/api/notify', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, on }),
    }).catch(() => null);
    if (!r?.ok) setNotify(was);
  };
  // the models each harness offers (+ labels): a session on Claude Code / opencode / Codex
  // picks from its harness, not from the root's upstream
  const [harnessModels, setHarnessModels] = useState<Record<string, string[]>>({});
  const [modelLabels, setModelLabels] = useState<Record<string, Record<string, string>>>({});
  // the agent whose meaning shows under the list — the last one tapped
  // (null: the session's own)
  const [about, setAbout] = useState<string | null>(null);
  // a switch waiting for its yes: what taking that agent changes, first
  const [pending, setPending] = useState<{ to: string; rows: [string, string][] } | null>(null);
  const tapRef = useRef(''); // the last agent tapped — an older answer is stale
  const [loadErr, setLoadErr] = useState<Partial<Record<Res, string>>>({});
  const [pickOpen, setPickOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [refused, setRefused] = useState<{ block: Block; msg: string } | null>(null);
  const [live, setLive] = useState(false);
  // two-tap confirm: first tap arms, second deletes — no modal on mobile
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const title = info?.title || slug;

  // fresh state per slug (rename swaps the slug → refetch follows)
  useEffect(() => {
    setInfo(null);
    setNameInput(slug);
    setPickOpen(false);
    setLoadErr({});
  }, [slug]);

  const load = useCallback(async () => {
    if (!slug) return;
    // independent settles, not Promise.all: one flaky fetch (phone on
    // tailnet, opencode busy with concurrent runs — 2026-09-29 net-fail
    // storm) must not blank the MODEL tile into 'tap to choose' when the
    // session record itself is fine
    // A failure is kept per resource and SHOWN in its block (10-19: a
    // failed load read as 'no model' / 'no models' / invented agents)
    const [sr, mr, ar, hr] = await Promise.all([
      grab(`/api/session/${slug}`),
      grab('/api/models'),
      grab('/api/agents'),
      grab('/api/agents/build'),
    ]);
    if ('data' in hr) {
      const d = hr.data as {
        models_by_harness?: Record<string, string[]>;
        model_labels?: Record<string, Record<string, string>>;
      };
      setHarnessModels(d.models_by_harness || {});
      setModelLabels(d.model_labels || {});
    }
    if ('data' in sr) {
      setInfo(sr.data);
      // fill the name field only while it's still pristine — the fetch
      // must never clobber a value the user already started typing
      setNameInput((prev) => (prev === slug ? sr.data.title || slug : prev));
    }
    if ('data' in mr) setProviders(mr.data);
    if ('data' in ar) setAgents(ar.data as Agent[]);
    setLoadErr({
      ...('err' in sr && { session: sr.err }),
      ...('err' in mr && { models: mr.err }),
      ...('err' in ar && { agents: ar.err }),
    });
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // a failed load self-heals: keep retrying while any block still lacks its
  // data (it used to mark itself 'loaded' even on failure — never retried)
  const missing = !info || !providers || !agents;
  useEffect(() => {
    if (!missing) return;
    const t = setInterval(() => !document.hidden && void load(), 2000);
    return () => clearInterval(t);
  }, [missing, load]);

  // busy dot — same live-run flag the chat header uses
  useEffect(() => {
    if (!slug) return;
    let stop = false;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch(`/api/session/${slug}/messages?limit=1`, { cache: 'no-store' });
        if (r.ok && !stop) setLive(r.headers.get('X-Run-Live') === '1');
      } catch {
        /* transient */
      }
    };
    poll();
    const t = setInterval(poll, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [slug]);

  const model = info?.model ?? null;
  // the model turns actually run on: the session's own pick, else the
  // brain's default — shown AS the default ('shown, not asked', like the door)
  const run = model ?? info?.defaultModel ?? null;
  const onDefault = !!info && !model;
  const agent = info?.agent ?? '';
  const modelKey = (m: ModelRef) => `${m.providerID}/${m.modelID}`;
  const isMain = isMainSlug(slug);
  // the coordinator is MAIN's alone: offered on MAIN (and shown where it
  // already runs), never to another session
  const agentList = (agents || []).filter((a) => a.name !== COORD || isMain || agent === COORD);
  const aboutAgent = agentList.find((a) => a.name === (about ?? agent));

  const agentNote = !agents
    ? loadErr.agents
      ? `couldn't load agents — ${loadErr.agents} · retrying`
      : 'loading agents…'
    : !agents.length
      ? 'the brain offers no agents'
      : isMain
        ? 'MAIN always runs the coordinator — tap another to read what it does'
        : info && !agent
          ? "none pinned — the brain's default agent runs"
          : '';

  /** a tap shows what the agent means, then what switching to it changes
   *  (harness, model, thinking, tools, instructions) — 'switch' applies it.
   *  MAIN only ever goes back to the coordinator */
  async function pickAgent(a: string) {
    setAbout(a);
    setPending(null);
    tapRef.current = a;
    if (a === agent || (isMain && a !== COORD)) return;
    if (isMain) return void patch({ agent: a }, 'agent');
    const get = (n: string): Promise<AgentDetail | null> =>
      fetch(`/api/agents/${n}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    // an unpinned session still runs an agent — the brain's default, which
    // its tree row names
    const effective =
      agent ||
      (await fetch('/api/tree', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : []))
        .then(
          (rows: { id: string; agent?: string }[]) => rows.find((r) => r.id === info?.id)?.agent
        )
        .catch(() => ''));
    const [cur, to] = await Promise.all([effective ? get(effective) : null, get(a)]);
    if (tapRef.current === a) setPending({ to: a, rows: to ? agentDiff(cur, to, run) : [] });
  }

  const shownVariant = run?.variant && run.variant !== 'default' ? run.variant : '';

  const onHarness = run && HARNESSES.has(run.providerID) ? run.providerID : '';
  const modelList = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = onHarness
      ? (harnessModels[onHarness] || []).map((id) => ({
          id,
          name: modelLabels[onHarness]?.[id] || '',
          variants: [] as string[],
          providerID: onHarness,
        }))
      : (providers || []).flatMap((p) => p.models.map((m) => ({ ...m, providerID: p.id })));
    return rows.filter((m) => !q || `${m.providerID}/${m.id} ${m.name}`.toLowerCase().includes(q));
  }, [providers, filter, onHarness, harnessModels, modelLabels]);

  const patch = useCallback(
    async (body: Record<string, unknown>, block: Block) => {
      setRefused(null);
      try {
        const r = await fetch(`/api/session/${slug}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        // the body can come back empty (proxy hiccup / service restart mid-
        // request) — parse defensively instead of dying on 'Unexpected end
        // of JSON input' (user hit this picking a model)
        const d = await r.json().catch(() => ({}));
        // 4xx = the proxy or the brain said no (MAIN's name, unknown model/
        // agent): shown where the user tapped, with the reason — never silent
        if (r.status >= 400 && r.status < 500) {
          setRefused({ block, msg: d.error || `refused (${r.status})` });
          void load();
          return null;
        }
        if (!r.ok) throw new Error(d.error || `save failed (${r.status})`);
        if (!d.id) throw new Error(`save failed (${r.status}, empty response)`);
        setInfo(d);
        return d;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        void load();
        return null;
      }
    },
    [slug, load]
  );

  async function commitName() {
    const t = nameInput.trim();
    if (!t || t === title) {
      setNameInput(title);
      return;
    }
    const d = await patch({ title: t }, 'name');
    // refused/failed: the field goes back to the name the session really
    // has — a typed name that never applied must not sit there as if it did
    if (!d) setNameInput(title);
    if (d?.title) {
      setNameInput(d.title);
      // the URL IS the slug — follow the rename so sends/rooms keep matching
      router.replace(`/session/${slugify(d.title)}/settings`);
    }
  }

  async function deleteSession() {
    setDeleting(true);
    try {
      const r = await fetch(`/api/session/${slug}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `delete failed (${r.status})`);
      try {
        localStorage.removeItem('oz-draft:' + slug);
      } catch {
        /* private mode */
      }
      // prune the deleted family from the list seed so the home page renders
      // clean on arrival instead of flashing the dead row until its poll
      try {
        const arr = JSON.parse(sessionStorage.getItem('oz-sessions') || '[]');
        const doomed = new Set<string>(info?.id ? [info.id] : []);
        let grew = true;
        while (grew) {
          grew = false;
          for (const s of arr) {
            if (s.parentId && doomed.has(s.parentId) && !doomed.has(s.id)) {
              doomed.add(s.id);
              grew = true;
            }
          }
        }
        sessionStorage.setItem(
          'oz-sessions',
          JSON.stringify(arr.filter((s: { id: string }) => !doomed.has(s.id)))
        );
      } catch {
        /* no seed — the list fetches fresh anyway */
      }
      router.push('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setArmed(false);
    }
  }

  return (
    <main className="mx-auto h-dvh max-w-md overflow-y-auto px-3">
      {/* header — same shape as the chat header; no back chrome */}
      <header className="oz-head justify-start text-[13px]">
        <span className="truncate">{title}</span>
        {live && (
          <span className="oz-breathe text-[11px] text-[var(--oz-success)]" aria-label="working">
            ●
          </span>
        )}
      </header>

      {error && <ErrorBox error={error} onDismiss={() => setError('')} slug={slug} />}

      <section className="oz-blk">
        <h2>name</h2>
        <div>
          <input
            value={nameInput}
            onChange={(e) => {
              setNameInput(e.target.value);
              if (refused?.block === 'name') setRefused(null);
            }}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            // MAIN's field stays locked (the proxy 409s a rename anyway), but
            // a tap on it gets the refusal said out loud — a locked field
            // that just ignores the tap read as 'rename silently does
            // nothing' (user, 10-19)
            onClick={() => isMainSlug(slug) && setRefused({ block: 'name', msg: MAIN_REFUSAL })}
            aria-label="session name"
            className="oz-field"
            readOnly={isMainSlug(slug)}
          />
        </div>
        {refused?.block === 'name' ? (
          <Refusal msg={refused.msg} />
        ) : (
          <p className="note">
            {isMainSlug(slug)
              ? 'MAIN keeps its name — the tree door finds it by it'
              : 'url + voice room follow the name'}
          </p>
        )}
      </section>

      <section className="oz-blk">
        <h2>model</h2>
        <div>
          <button
            aria-expanded={pickOpen}
            onClick={() => {
              setPickOpen((o) => !o);
              setFilter('');
            }}
            className="oz-pick"
          >
            <span className="truncate">
              {run
                ? `${modelKey(run)}${onDefault ? ' · default' : ''}`
                : onDefault
                  ? 'brain default · not reported'
                  : loadErr.session
                    ? "couldn't load this session — retrying"
                    : 'loading…'}
            </span>
            <span>{pickOpen ? '▲' : '›'}</span>
          </button>
        </div>
        {onDefault && !pickOpen && (
          <p className="note">
            {run
              ? "the brain's default, set on the box — pick one to pin this session"
              : "the brain didn't report its default model — pick one to pin this session"}
          </p>
        )}
        {pickOpen && (
          <div className="pt-0">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="/ filter…"
              aria-label="filter models"
              className="oz-field h-9 text-xs"
            />
            <ul className="oz-mlist mt-1.5 max-h-64 overflow-y-auto">
              {modelList.map((m) => {
                const active = !!model && modelKey(model) === `${m.providerID}/${m.id}`;
                return (
                  <li key={`${m.providerID}/${m.id}`}>
                    <button
                      aria-pressed={active}
                      onClick={() => {
                        // keep the chosen think level only if the new model
                        // has it too; otherwise fall to the model default
                        const keep = run?.variant && m.variants.includes(run.variant);
                        void patch(
                          {
                            model: {
                              providerID: m.providerID,
                              modelID: m.id,
                              variant: keep ? run!.variant : undefined,
                            },
                          },
                          'model'
                        );
                        setPickOpen(false);
                      }}
                    >
                      <span className="truncate">
                        {m.providerID}/{m.id}
                        {onHarness && m.name && (
                          <span className="text-[var(--oz-dim)]"> · {m.name}</span>
                        )}
                        {info?.defaultModel &&
                          modelKey(info.defaultModel) === `${m.providerID}/${m.id}` &&
                          ' · default'}
                      </span>
                    </button>
                  </li>
                );
              })}
              {!modelList.length && (
                <li className="px-0.5 py-2 text-[11px] text-[var(--oz-dim)]">
                  {!providers
                    ? loadErr.models
                      ? `couldn't load models — ${loadErr.models} · retrying`
                      : 'loading models…'
                    : filter.trim()
                      ? `no model matches “${filter.trim()}”`
                      : 'the brain offers no models'}
                </li>
              )}
            </ul>
          </div>
        )}
        {refused?.block === 'model' && <Refusal msg={refused.msg} />}
      </section>

      {/* THINK — the selected model's real levels; the session's current one
          is highlighted, tapping it again falls back to the model default */}
      <section className="oz-blk">
        <h2>think</h2>
        {run && run.variants.length ? (
          <>
            <div className="oz-chips">
              {run.variants.map((v) => (
                <button
                  key={v}
                  aria-pressed={shownVariant === v}
                  onClick={() =>
                    void patch(
                      {
                        model: {
                          providerID: run.providerID,
                          modelID: run.modelID,
                          variant: shownVariant === v ? undefined : v,
                        },
                      },
                      'think'
                    )
                  }
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="note">current — {shownVariant || 'model default'}</p>
          </>
        ) : (
          <p className="note pt-3!">
            {run
              ? 'no think levels configured for this model'
              : 'pick a model to see its thinking levels'}
          </p>
        )}
        {refused?.block === 'think' && <Refusal msg={refused.msg} />}
      </section>

      <section className="oz-blk">
        <h2>agent</h2>
        {/* the brain's own list — no stand-in names while it's missing */}
        {agentList.length ? (
          <div className="oz-chips">
            {agentList.map((a) => (
              <button
                key={a.name}
                aria-pressed={agent === a.name}
                onClick={() => pickAgent(a.name)}
              >
                {a.name}
              </button>
            ))}
          </div>
        ) : null}
        {pending && (
          <div data-testid="agent-diff">
            <p className="text-[11px] text-[var(--oz-text)]">switching to {pending.to} changes</p>
            <ul className="oz-kv oz-diff mt-1.5">
              {pending.rows.map(([k, v]) => (
                <li key={k}>
                  <span>{k}</span>
                  <span>{v}</span>
                </li>
              ))}
              {!pending.rows.length && (
                <li>
                  <span>—</span>
                  <span>nothing else changes</span>
                </li>
              )}
            </ul>
            <div className="mt-2.5 flex gap-1.5">
              <button
                onClick={() => {
                  const to = pending.to;
                  setPending(null);
                  void patch({ agent: to }, 'agent');
                }}
                className="oz-k ok flex-1"
              >
                switch
              </button>
              <button onClick={() => setPending(null)} className="oz-k px-4">
                cancel
              </button>
            </div>
          </div>
        )}
        {aboutAgent?.description && (
          <p className="note" data-testid="agent-about">
            <span className="text-[var(--oz-text)]">{aboutAgent.name}</span> —{' '}
            {aboutAgent.description}
          </p>
        )}
        {agentNote && <p className={`note ${agentList.length ? '' : 'pt-3!'}`}>{agentNote}</p>}
        <p className="note">
          {isMain ? (
            <Link href="/agents">agents ›</Link>
          ) : (
            agent && <Link href={`/agents/${agent}`}>customize {agent} ›</Link>
          )}
        </p>
        {refused?.block === 'agent' && <Refusal msg={refused.msg} />}
      </section>

      <p className="px-0.5 pb-2.5 text-[10.5px] leading-relaxed text-[var(--oz-dim)]">
        changes apply from the next message in this session
      </p>

      {/* NOTIFICATIONS — may this session wake the phone when a reply is ready? Off by default,
          on for MAIN (owner 11-17); the push and the in-page notification both ask it */}
      <section className="oz-blk" data-testid="notify-block">
        <h2>notifications</h2>
        <div className="oz-chips">
          {([true, false] as const).map((v) => (
            <button
              key={String(v)}
              aria-pressed={notify === v}
              disabled={notify === null}
              data-testid={v ? 'notify-on' : 'notify-off'}
              onClick={() => void saveNotify(v)}
            >
              {v ? 'on' : 'off'}
            </button>
          ))}
        </div>
      </section>

      {/* FULL ACCESS — the owner grants a terminal-continued conversation a run outside the
          sandbox (off by default, ≤4 h, signed from this phone); nothing here for the rest */}
      <FullAccessBlock h={info?.harness} title={title} />

      {/* DELETE — two taps; sub-sessions cascade server-side, then back to
          the list (which no longer shows the deleted row). MAIN has none:
          the proxy refuses it (403), the page doesn't offer it */}
      {!isMainSlug(slug) && (
        <section className="oz-blk danger mb-6">
          <h2>session</h2>
          <div>
            <button
              disabled={deleting}
              onClick={() => (armed ? void deleteSession() : setArmed(true))}
              className={`oz-del ${armed ? 'armed' : ''}`}
            >
              {deleting ? 'deleting…' : armed ? 'tap again to delete' : 'delete session'}
            </button>
          </div>
          <p className="note">
            {armed
              ? 'this cannot be undone — sub-sessions go too'
              : 'removes the session and its sub-sessions'}
          </p>
        </section>
      )}
    </main>
  );
}
