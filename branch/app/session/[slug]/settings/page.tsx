'use client';

/** Session settings — name / role / runs on / model / think blocks (shared
 *  theme CSS: .oz-blk + oz tokens). Instant-apply:
 *  no save button, every control commits on tap/blur, like the header mode
 *  toggle — a role or an engine switch says first what it changes ("what
 *  changes", then switch / keep). All writes go through PATCH
 *  /api/session/[id], which routes title to the session update and
 *  model/role/engine to the brain's switch endpoints —
 *  server-side per-session state, so text AND voice turns both use it. The
 *  current think level is whatever the session records; 'default' means no
 *  explicit level set. DELETE at the bottom removes the session (opencode
 *  cascades sub-sessions) and returns to the list. Reaching this page: tap
 *  the session name in the chat header; leaving: system back gesture. */
import { cachedHomePath } from '@/lib/home-path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ErrorBox } from '@/components/app/error-box';
import {
  type AgentDetail,
  type AgentRow,
  ENGINES,
  ENGINE_FRESH,
  type EngineRow,
  MORE_ENGINES,
  byRole,
  engineDiff,
  engineLabel,
  parseFallbackChain,
  roleDiff,
  roleOf,
  roleTag,
} from '@/lib/agents';
import {
  type ProviderInfo,
  type UsageState,
  normalizeProvidersResponse,
  normalizeUsageResponse,
  providerForModel,
  usageTone,
} from '@/lib/providers';
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
  /** the step cap of this session's turns; null = none (the default) */
  steps?: number | null;
  model: ModelRef | null;
  /** what a model-less session runs on — the brain's default (null: the
   * brain didn't say) */
  defaultModel?: ModelRef | null;
  /** what runs it: root · claude · antigravity · opencode · codex */
  engine?: string;
  /** a session on another harness: which one, its conversation there, and
   * whether it continues the owner's own terminal conversation (no role) */
  harness?: { kind: string | null; id: string | null; attached: boolean };
  /** "shared" = it reads only the shared prompt, no role text */
  instructions?: string | null;
  /** a relabelled session's old agent name (claude | agy) */
  agent_was?: string | null;
};
type ProviderRow = {
  id: string;
  name: string;
  models: { id: string; name: string; variants: string[] }[];
};
type Block = 'name' | 'model' | 'think' | 'role' | 'engine' | 'steps';
type Res = 'session' | 'models' | 'agents';
/** root-coord: MAIN's own role — never offered to another session */
const COORD = 'coordinator';
/** a switch waiting for its yes: what taking that role / that engine changes, first */
type Pending = { kind: 'role' | 'engine'; to: string; rows: [string, string][] };

const getRole = (n: string): Promise<AgentDetail | null> =>
  fetch(`/api/agents/${n}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

/** One settings resource: its body, or why it didn't come (HTTP status +
 *  the proxy's error, or the network failure) — never a silent miss. */
async function grab<T>(url: string): Promise<{ data: T } | { err: string }> {
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

export default function SessionSettingsView() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug || '';
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [nameInput, setNameInput] = useState(slug);
  // null = not landed yet (loading, or failed — loadErr says which)
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  // the brain's roles (/api/agents): name, what it is for, its default engine + model
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  // the engines (/api/engines): their default models and choices; null = not landed (an older
  // brain has none — the chips then fall back to the five names)
  const [engines, setEngines] = useState<EngineRow[] | null>(null);
  // root providers (GET /provider) + live usage (GET /usage): degrade cleanly on 404
  const [rootProviders, setRootProviders] = useState<ProviderInfo[]>([]);
  const [usage, setUsage] = useState<UsageState | null>(null);
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
  // the role whose meaning shows under the chips — the last one tapped ('': the session's own)
  const [shown, setShown] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const tapRef = useRef(''); // the last role / engine tapped — an older answer is stale
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
    setShown('');
    setPending(null);
  }, [slug]);

  const load = useCallback(async () => {
    if (!slug) return;
    // independent settles, not Promise.all: one flaky fetch (phone on
    // tailnet, opencode busy with concurrent runs — 2026-09-29 net-fail
    // storm) must not blank the MODEL tile into 'tap to choose' when the
    // session record itself is fine
    // A failure is kept per resource and SHOWN in its block (10-19: a
    // failed load read as 'no model' / 'no models' / invented agents)
    const [sr, mr, ar, hr, er, pr, ur] = await Promise.all([
      grab<SessionInfo>(`/api/session/${slug}`),
      grab<ProviderRow[]>('/api/models'),
      grab<AgentRow[]>('/api/agents'),
      grab<{
        models_by_harness?: Record<string, string[]>;
        model_labels?: Record<string, Record<string, string>>;
      }>('/api/agents/build'),
      grab<EngineRow[]>('/api/engines'),
      grab<unknown>('/api/provider'),
      grab<unknown>('/api/usage'),
    ]);
    if ('data' in er && Array.isArray(er.data) && er.data.length) setEngines(er.data);
    if ('data' in pr) setRootProviders(normalizeProvidersResponse(pr.data).providers);
    if ('data' in ur) setUsage(normalizeUsageResponse(ur.data));
    if ('data' in hr) {
      const d = hr.data || {};
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
    if ('data' in ar) setAgents(ar.data);
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
  // the role (the brain's `agent`; an old root's `claude` / `agy` read as build)
  const agent = info?.agent ? roleOf(info.agent) : '';
  const modelKey = (m: ModelRef) => `${m.providerID}/${m.modelID}`;
  const isMain = isMainSlug(slug);
  // the owner's own terminal conversation: it runs on its own engine, and has no role until one
  // is picked (it reads only the shared prompt)
  const attached = info?.harness?.attached === true;
  const noRole = attached && info?.instructions === 'shared';
  const engine = info?.engine || (run && HARNESSES.has(run.providerID) ? run.providerID : 'root');
  const engineRow = (n: string) => engines?.find((e) => e.name === n) || null;
  // the coordinator is MAIN's alone: MAIN shows only it (locked), another session never gets it
  const roleList = (agents || [])
    .filter((a) => (isMain ? a.name === COORD : a.name !== COORD || agent === COORD))
    .sort(byRole);
  const roleRow = (n: string) => (agents || []).find((a) => a.name === n) || null;
  const shownRole = shown || (noRole ? '' : agent);

  // the engines in the brain's order; opencode and Codex behind a fold unless it runs on one
  const engineNames = engines?.map((e) => e.name) || [...ENGINES];
  const isMore = (n: string) => engineRow(n)?.more ?? MORE_ENGINES.has(n);
  const engineChips = engineNames.filter((n) => !isMore(n) || n === engine);
  const moreChips = engineNames.filter((n) => isMore(n) && n !== engine);
  const engineLocked = isMain || attached;
  // the role's default: its engine · its model (else that engine's default)
  const defaultOf = (n: string) => {
    const r = roleRow(n);
    if (!r) return '';
    const e = r.harness || 'root';
    return `${engineLabel(e)} · ${r.model || engineRow(e)?.model || 'default'}`;
  };
  const engineNote = !info
    ? ''
    : isMain
      ? 'locked: MAIN always runs on the root'
      : attached
        ? `locked: your terminal conversation runs on ${engineLabel(engine)}`
        : agent && defaultOf(agent)
          ? `the ${agent}'s default: ${defaultOf(agent)}`
          : '';
  // a review off the root is read-only because its instructions say so — the brain can't hold an
  // engine's own tools back (the switch waiting counts: it is what the session would become)
  const nextRole = pending?.kind === 'role' ? pending.to : agent;
  const nextEngine = pending?.kind === 'engine' ? pending.to : engine;
  const reviewOff = !noRole && nextRole === 'review' && nextEngine !== 'root';

  // ∞ (no cap, the default), a few caps, and the session's own when it is another number
  const STEPS = [50, 100, 200, 500];
  const stepChoices: (number | null)[] = [
    null,
    ...STEPS,
    ...(info?.steps && !STEPS.includes(info.steps) ? [info.steps] : []),
  ];

  const roleNote = !agents
    ? loadErr.agents
      ? `couldn't load roles — ${loadErr.agents} · retrying`
      : 'loading roles…'
    : !agents.length
      ? 'the brain offers no roles'
      : '';

  /** a tap says what the role is for and what switching to it changes (instructions, sessions,
   *  tools on the root; the model only when it runs on that role's default engine) — 'switch'
   *  applies it; the engine stays. MAIN is locked: the tap only explains */
  async function pickRole(a: string) {
    setPending(null);
    setRefused(null);
    setShown(a);
    tapRef.current = `role:${a}`;
    if (isMain || (a === agent && !noRole)) return;
    // an unpinned session still runs a role — the brain's default, which its tree row names
    const effective = noRole
      ? ''
      : agent ||
        (await fetch('/api/tree', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : []))
          .then(
            (rows: { id: string; agent?: string }[]) => rows.find((r) => r.id === info?.id)?.agent
          )
          .catch(() => ''));
    const [cur, to] = await Promise.all([effective ? getRole(effective) : null, getRole(a)]);
    if (tapRef.current !== `role:${a}`) return;
    setPending({
      kind: 'role',
      to: a,
      rows: to ? roleDiff(cur, to, engine, run, info?.instructions === 'shared') : [],
    });
  }

  /** a tap on another engine says what moving there changes (model, tools) — always with the
   *  fresh-start warning; 'switch' applies it, the role stays */
  async function pickEngine(x: string) {
    setPending(null);
    setRefused(null);
    tapRef.current = `engine:${x}`;
    if (engineLocked || x === engine) return;
    const role = noRole ? null : agent ? await getRole(agent) : null;
    if (tapRef.current !== `engine:${x}`) return;
    setPending({
      kind: 'engine',
      to: x,
      rows: engineDiff(
        role,
        noRole ? '' : agent,
        engine,
        x,
        run?.modelID || 'default',
        engines || []
      ),
    });
  }

  const shownVariant = run?.variant && run.variant !== 'default' ? run.variant : '';

  // the model follows the engine: a session on Claude Code / Antigravity / opencode / Codex picks
  // from that engine's own models, one on the root from /api/models + GET /provider
  const onHarness = HARNESSES.has(engine) ? engine : '';
  const modelList = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const eng = engines?.find((e) => e.name === onHarness);
    if (onHarness) {
      return (eng?.models?.length ? eng.models : harnessModels[onHarness] || [])
        .map((id) => ({
          id,
          name: eng?.labels?.[id] || modelLabels[onHarness]?.[id] || '',
          variants: [] as string[],
          providerID: onHarness,
          lan: false,
          noQuota: false,
          reachable: null as boolean | null,
        }))
        .filter((m) => !q || `${m.providerID}/${m.id} ${m.name}`.toLowerCase().includes(q));
    }
    const seen = new Set<string>();
    const rows: {
      id: string;
      name: string;
      variants: string[];
      providerID: string;
      lan: boolean;
      noQuota: boolean;
      reachable: boolean | null;
    }[] = [];
    for (const p of providers || []) {
      const rp = rootProviders.find((x) => x.id === p.id);
      for (const m of p.models) {
        const key = `${p.id}/${m.id}`;
        seen.add(key);
        rows.push({
          ...m,
          providerID: p.id,
          lan: rp?.lan ?? false,
          noQuota: rp?.noQuota ?? false,
          reachable: rp?.reachable ?? null,
        });
      }
    }
    for (const rp of rootProviders) {
      for (const id of rp.models) {
        const key = `${rp.id}/${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          id,
          name: id,
          variants: [],
          providerID: rp.id,
          lan: rp.lan,
          noQuota: rp.noQuota,
          reachable: rp.reachable,
        });
      }
    }
    return rows.filter((m) => !q || `${m.providerID}/${m.id} ${m.name}`.toLowerCase().includes(q));
  }, [providers, rootProviders, filter, onHarness, engines, harnessModels, modelLabels]);

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
      router.push(cachedHomePath());
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
        {refused?.block === 'name' && <Refusal msg={refused.msg} />}
      </section>

      {/* ROLE — the job (the badge): the brain's own list, no stand-in names while it's missing.
          A tap says what the role is for, then what switching changes; the engine stays */}
      <section className="oz-blk" data-testid="role-block">
        <h2>role</h2>
        {roleList.length ? (
          <div className="oz-chips">
            {roleList.map((a) => (
              <button
                key={a.name}
                aria-pressed={!noRole && agent === a.name}
                onClick={() => void pickRole(a.name)}
              >
                <span className="b" aria-hidden="true">
                  [{roleTag(a.name)}]
                </span>
                {a.name}
              </button>
            ))}
          </div>
        ) : null}
        {roleNote && <p className={`note ${roleList.length ? '' : 'pt-3!'}`}>{roleNote}</p>}
        {shownRole && roleRow(shownRole)?.description && (
          <p className="note" data-testid="role-desc">
            {roleRow(shownRole)!.description}
          </p>
        )}
        {isMain ? (
          <p className="note">locked: MAIN is the coordinator, on the root</p>
        ) : (
          noRole &&
          !shown && (
            <p className="note" data-testid="no-role">
              your terminal conversation: no role
            </p>
          )
        )}
        {(isMain || (agent && !noRole)) && (
          <p className="note">
            {isMain ? (
              <Link href="/agents">roles ›</Link>
            ) : (
              <Link href={`/agents/${agent}`}>customize {agent} ›</Link>
            )}
          </p>
        )}
        {refused?.block === 'role' && <Refusal msg={refused.msg} />}
      </section>

      {/* RUNS ON — the engine, apart from the role: harnesses + root providers grouped by provider
          (z.ai / mac-studio / … with reachability, LAN and no-quota chips from GET /provider). */}
      <section className="oz-blk" data-testid="engine-block">
        <h2>runs on</h2>
        <div className="oz-chips">
          {engineChips.map((x) => {
            const pct = usage?.byEngine[x]?.pct;
            return (
              <button
                key={x}
                aria-pressed={!!info && engine === x}
                disabled={!info || engineLocked}
                onClick={() => void pickEngine(x)}
              >
                {engineLabel(x)}
                {pct != null && <small className={usageTone(pct)}>{pct}%</small>}
              </button>
            );
          })}
        </div>
        {moreChips.length > 0 && !engineLocked && (
          <details className="pt-0" data-testid="more-engines">
            <summary className="cursor-pointer text-[11px] text-[var(--oz-dim)]">
              more engines
            </summary>
            <div className="oz-chips mt-2">
              {moreChips.map((x) => {
                const pct = usage?.byEngine[x]?.pct;
                return (
                  <button
                    key={x}
                    aria-pressed={false}
                    disabled={!info}
                    onClick={() => void pickEngine(x)}
                  >
                    {engineLabel(x)}
                    {pct != null && <small className={usageTone(pct)}>{pct}%</small>}
                  </button>
                );
              })}
            </div>
          </details>
        )}
        {rootProviders.length > 0 && (
          <div className="flex flex-col gap-2 pt-0" data-testid="runs-on-providers">
            {rootProviders.map((p) => {
              const isZai = p.type === 'zai' || p.id === 'zai' || p.id === 'yggdrasil';
              const zaiPct = isZai ? usage?.byEngine.root?.pct : null;
              const unreachable = p.reachable === false;
              const list = p.models.length
                ? p.models
                : (providers?.find((x) => x.id === p.id)?.models.map((m) => m.id) ?? []);
              return (
                <div
                  key={p.id}
                  className="oz-pgrp"
                  data-testid={`runs-on-group-${p.id}`}
                  data-reachable={p.reachable === true ? 'yes' : unreachable ? 'no' : 'unknown'}
                >
                  <div className="oz-pl">
                    <span>{p.name}</span>
                    {p.lan && <span className="oz-ptag">LAN</span>}
                    {p.noQuota && <span className="oz-ptag">no quota</span>}
                    {p.reachable === true && (
                      <span className="oz-ptag ok">
                        reachable{p.latencyMs != null ? ` ${p.latencyMs}ms` : ''}
                      </span>
                    )}
                    {unreachable && <span className="oz-ptag bad">unreachable</span>}
                    {zaiPct != null && (
                      <span className={`oz-ptag ${usageTone(zaiPct)}`}>{zaiPct}%</span>
                    )}
                  </div>
                  {list.length > 0 ? (
                    <div className="oz-chips">
                      {list.map((m) => {
                        const active =
                          engine === 'root' &&
                          !!run &&
                          (run.modelID === m ||
                            run.modelID === `${p.id}/${m}` ||
                            (run.providerID === p.id && run.modelID === m));
                        return (
                          <button
                            key={`${p.id}/${m}`}
                            type="button"
                            aria-pressed={active}
                            disabled={!info || unreachable || (engineLocked && engine !== 'root')}
                            onClick={() => {
                              if (engine !== 'root') {
                                void pickEngine('root');
                                return;
                              }
                              const pRow = providers?.find((x) => x.id === p.id);
                              const mRow = pRow?.models.find((x) => x.id === m);
                              const keep = run?.variant && mRow?.variants.includes(run.variant);
                              void patch(
                                {
                                  model: {
                                    providerID: p.id,
                                    modelID: m,
                                    variant: keep ? run!.variant : undefined,
                                  },
                                },
                                'model'
                              );
                            }}
                          >
                            {m}
                            {p.lan && <small>LAN</small>}
                            {unreachable && <small>unreachable</small>}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="text-[10.5px] text-[var(--oz-dim)]">
                      {unreachable ? 'unreachable from this computer' : 'no models discovered yet'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {engineNote && (
          <p className="note" data-testid="engine-note">
            {engineNote}
          </p>
        )}
        {reviewOff && !pending && (
          <p className="note text-[var(--oz-active)]!" data-testid="review-note">
            read-only by instruction, not by a lock
          </p>
        )}
        {refused?.block === 'engine' && <Refusal msg={refused.msg} />}
      </section>

      {/* IF IT RUNS OUT — the role's fallback chain (from GET /agent), read-only here with a
          link into the role editor */}
      {info && (
        <section className="oz-blk" data-testid="session-fallback-block">
          <h2>if it runs out</h2>
          {(() => {
            const rRow = !noRole && agent ? roleRow(agent) : null;
            const lockedChain = isMain || attached || rRow?.pinned === true;
            const chain = lockedChain ? [] : parseFallbackChain(rRow?.fallback);
            if (lockedChain) {
              return (
                <p className="note pt-3!">
                  {isMain
                    ? 'locked · coordinator never falls back'
                    : attached
                      ? 'locked · terminal conversation never falls back'
                      : 'locked · never falls back'}
                </p>
              );
            }
            return (
              <>
                {chain.length > 0 ? (
                  <div>
                    <div className="oz-fb mt-0!">
                      {chain.map((step, idx) => {
                        const prov =
                          step.engine === 'root'
                            ? providerForModel(step.model, rootProviders)
                            : null;
                        return (
                          <span key={`${step.engine}/${step.model || ''}`} className="oz-fc">
                            <b className="oz-badge">{idx + 1}</b>
                            {engineLabel(step.engine)}
                            {step.model && <em>{step.model}</em>}
                            {prov?.noQuota && <span>· no quota</span>}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="note pt-3!">automatic fallback</p>
                )}
                <p className="note">
                  the session&apos;s own choice runs first; when it runs out, the role&apos;s chain
                  takes over.
                  {agent && !noRole && (
                    <>
                      {' '}
                      <Link href={`/agents/${agent}#fallback`}>edit chain ›</Link>
                    </>
                  )}
                </p>
              </>
            );
          })()}
        </section>
      )}

      {/* WHAT CHANGES — a role or an engine switch, said before it applies; an engine switch
          always warns that the new engine starts fresh */}
      {pending && (
        <section
          className="oz-blk"
          data-testid={pending.kind === 'role' ? 'role-diff' : 'engine-diff'}
        >
          <h2>what changes</h2>
          <div>
            <ul className="oz-kv oz-diff">
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
          </div>
          {pending.kind === 'engine' && (
            <p className="note text-[var(--oz-active)]!" data-testid="engine-fresh">
              {ENGINE_FRESH}
            </p>
          )}
          {reviewOff && (
            <p className="note text-[var(--oz-active)]!" data-testid="review-note">
              read-only by instruction, not by a lock
            </p>
          )}
          <div className="flex gap-1.5">
            <button
              onClick={() => {
                const p = pending;
                setPending(null);
                void patch(p.kind === 'role' ? { agent: p.to } : { engine: p.to }, p.kind);
              }}
              className="oz-k ok flex-1"
            >
              switch
            </button>
            <button onClick={() => setPending(null)} className="oz-k px-4">
              keep
            </button>
          </div>
        </section>
      )}

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
                      disabled={m.reachable === false}
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
                        {m.lan && <span className="text-[var(--oz-dim)]"> · LAN</span>}
                        {m.noQuota && <span className="text-[var(--oz-dim)]"> · no quota</span>}
                        {m.reachable === false && (
                          <span className="text-[var(--oz-danger)]"> · unreachable</span>
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

      {/* THINK — the selected model's real levels (none: no block); the session's current one
          is highlighted, tapping it again falls back to the model default */}
      {run && run.variants.length > 0 && (
        <section className="oz-blk" data-testid="think-block">
          <h2>think</h2>
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
          {refused?.block === 'think' && <Refusal msg={refused.msg} />}
        </section>
      )}

      {/* STEPS — how many model calls one turn may make: none by default (∞, owner 11-19); a
          cap stops a turn that would run on (it ends failed, said so in the list) */}
      <section className="oz-blk" data-testid="steps-block">
        <h2>steps</h2>
        <div className="oz-chips">
          {stepChoices.map((n) => (
            <button
              key={String(n)}
              aria-pressed={!!info && (info.steps ?? null) === n}
              disabled={!info}
              data-steps={n ?? 'none'}
              onClick={() => void patch({ steps: n }, 'steps')}
            >
              {n ?? '∞'}
            </button>
          ))}
        </div>
        {refused?.block === 'steps' && <Refusal msg={refused.msg} />}
      </section>

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
        </section>
      )}
    </main>
  );
}
