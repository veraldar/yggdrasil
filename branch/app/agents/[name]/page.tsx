'use client';

/** /agents/[name] — one ROLE, edited (the brain calls it an agent). Only what the brain says is
 *  `customizable` shows; a `locked` field shows disabled with the reason. "runs on by default"
 *  is the engine its sessions start on (a session can still take another in its own settings).
 *  On the root: description, model + thinking, instructions, tools, steps, manages sessions. On
 *  a harness (Claude Code / Antigravity / opencode / Codex): less — the harness brings its own
 *  tools. Save = PUT (creates a new one); the brain's refusal is said inline. A custom role
 *  deletes in two taps. */
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import {
  type AgentDetail,
  CUSTOMIZABLE,
  type FallbackStep,
  HARNESSES,
  MAX_FALLBACK_CHAIN,
  TOOLS,
  fallbackStepsEqual,
  formatFallbackStep,
  harnessLabel,
  parseFallbackChain,
} from '@/lib/agents';
import {
  type ProviderInfo,
  type UsageState,
  normalizeProvidersResponse,
  normalizeUsageResponse,
  providerForModel,
  usageTone,
} from '@/lib/providers';

type Draft = Pick<
  AgentDetail,
  'description' | 'harness' | 'model' | 'variant' | 'prompt' | 'steps' | 'sessions' | 'tools'
> & {
  fallback: FallbackStep[];
};
const FIELDS = ['description', 'model', 'variant', 'prompt', 'tools', 'steps', 'sessions'] as const;

const draftOf = (d: AgentDetail): Draft => ({
  description: d.description || '',
  harness: d.harness || 'root',
  model: d.model ?? null,
  variant: d.variant ?? null,
  prompt: d.prompt || '',
  steps: d.steps ?? null,
  sessions: Boolean(d.sessions),
  tools: d.tools && typeof d.tools === 'object' ? { ...d.tools } : {},
  fallback: parseFallbackChain(d.fallback),
});

export default function AgentEditor() {
  const router = useRouter();
  const name = useParams<{ name: string }>()?.name || '';
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  // every harness's own model list (the brain reads them: claude's aliases, `opencode models`…)
  const [byHarness, setByHarness] = useState<Record<string, string[]>>({});
  const [labels, setLabels] = useState<Record<string, Record<string, string>>>({});
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [addFallbackOpen, setAddFallbackOpen] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [err, setErr] = useState('');
  const [refused, setRefused] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!name) return;
    let stop = false;
    (async () => {
      const [r, pr, ur] = await Promise.all([
        fetch(`/api/agents/${name}`, { cache: 'no-store' }).catch(() => null),
        fetch('/api/provider', { cache: 'no-store' })
          .then((x) => (x.ok ? x.json() : null))
          .catch(() => null),
        fetch('/api/usage', { cache: 'no-store' })
          .then((x) => (x.ok ? x.json() : null))
          .catch(() => null),
      ]);
      const d = await r?.json().catch(() => null);
      if (stop) return;
      if (pr) setProviders(normalizeProvidersResponse(pr).providers);
      if (ur) setUsage(normalizeUsageResponse(ur));
      if (r?.ok && d) {
        setDetail(d);
        setDraft(draftOf(d));
        setModels(Array.isArray(d.models) ? d.models : []);
        setByHarness(d.models_by_harness || {});
        setLabels(d.model_labels || {});
        return;
      }
      // a name no role has yet, opened from '+ new role': an empty role on the root
      if (new URLSearchParams(location.search).get('new') === '1') {
        const b = await fetch('/api/agents/build', { cache: 'no-store' })
          .then((x) => (x.ok ? x.json() : null))
          .catch(() => null);
        if (stop) return;
        const served: string[] = b?.models || [];
        setModels(served);
        setByHarness(b?.models_by_harness || {});
        setLabels(b?.model_labels || {});
        setIsNew(true);
        setDraft({
          description: '',
          harness: 'root',
          model: served[0] || null,
          variant: null,
          prompt: '',
          steps: null,
          sessions: false,
          tools: Object.fromEntries(TOOLS.map((t) => [t, t === 'read'])),
          fallback: [],
        });
      } else setErr(d?.error || `couldn't load ${name}`);
    })();
    return () => {
      stop = true;
    };
  }, [name]);

  const h = draft?.harness || 'root';
  // the fields follow the harness picked: the brain's answer is for the saved one
  // (older brains without `customizable` / `locked` fall back safely instead of crashing)
  const custom =
    detail && !isNew && h === (detail.harness || 'root')
      ? (Array.isArray(detail.customizable) ? detail.customizable : CUSTOMIZABLE[h] ?? [])
      : CUSTOMIZABLE[h] ?? [];
  const locked = Array.isArray(detail?.locked) ? detail.locked : [];
  const shows = (f: string) => custom.includes(f) || locked.includes(f);
  const can = (f: string) => custom.includes(f) && !locked.includes(f);
  const lockNote = (f: string) => (
    <p className="note" data-testid={`locked-${f}`}>
      locked
    </p>
  );
  const set = (p: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setSaved(false);
    setRefused('');
  };

  const fallbackLocked =
    name === 'coordinator' || detail?.pinned === true || locked.includes('fallback');

  const moveFallback = (index: number, delta: -1 | 1) => {
    if (!draft) return;
    const next = [...draft.fallback];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    set({ fallback: next });
  };

  const removeFallback = (index: number) => {
    if (!draft) return;
    set({ fallback: draft.fallback.filter((_, i) => i !== index) });
  };

  const addFallbackStep = (step: FallbackStep) => {
    if (!draft || draft.fallback.length >= MAX_FALLBACK_CHAIN) return;
    if (draft.fallback.some((x) => x.engine === step.engine && (x.model || null) === (step.model || null))) {
      setAddFallbackOpen(false);
      return;
    }
    const next = [...draft.fallback, step];
    set({ fallback: next });
    setAddFallbackOpen(false);
  };

  async function save() {
    if (!draft) return;
    const moved = isNew || draft.harness !== (detail?.harness || 'root');
    const body: Record<string, unknown> = moved ? { harness: draft.harness } : {};
    for (const f of FIELDS) {
      if (!can(f)) continue;
      const v = draft[f];
      if (f === 'steps' && v === null) continue;
      if (isNew || JSON.stringify(v) !== JSON.stringify(detail ? draftOf(detail)[f] : undefined))
        body[f] = v;
    }
    if (!fallbackLocked) {
      const prevFallback = detail ? parseFallbackChain(detail.fallback) : [];
      if (isNew ? draft.fallback.length > 0 : !fallbackStepsEqual(draft.fallback, prevFallback)) {
        body.fallback = draft.fallback.map(formatFallbackStep);
      }
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/agents/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setRefused(d.error || `save failed (${r.status})`);
        return;
      }
      setDetail(d);
      setDraft(draftOf(d));
      setModels(d.models || models);
      setSaved(true);
      if (isNew) {
        setIsNew(false);
        router.replace(`/agents/${name}`);
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const r = await fetch(`/api/agents/${name}`, { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setRefused(d.error || `delete failed (${r.status})`);
      setArmed(false);
      return;
    }
    router.push('/agents');
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <button onClick={() => router.back()} className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </button>
        <span className="truncate text-[13px]">{name}</span>
        {isNew && <span className="text-[11px] text-[var(--oz-dim)]">new</span>}
      </header>

      {!draft ? (
        <p className="pt-6 text-center text-xs text-[var(--oz-dim)]">{err || 'loading…'}</p>
      ) : (
        <>
          <section className="oz-blk">
            <h2>runs on by default</h2>
            <div className="oz-chips">
              {HARNESSES.map((x) => (
                <button
                  key={x}
                  aria-pressed={h === x}
                  disabled={locked.includes('harness')}
                  onClick={() =>
                    set({
                      harness: x,
                      model: (byHarness[x] || (x === 'root' ? models : []))[0] || null,
                    })
                  }
                  className="disabled:opacity-60"
                >
                  {harnessLabel(x)}
                </button>
              ))}
            </div>
            {locked.includes('harness') && lockNote('harness')}
            <p className="note">a session can still take another engine in its own settings</p>
          </section>

          <section className="oz-blk" id="fallback" data-testid="fallback-block">
            <h2>fallback when it runs out</h2>
            {fallbackLocked ? (
              <p className="note pt-3!" data-testid="fallback-locked">
                locked · never falls back
              </p>
            ) : (
              <>
                {draft.fallback.length > 0 ? (
                  <ul className="oz-fb-ed" data-testid="fallback-list">
                    {draft.fallback.map((step, i) => {
                      const prov =
                        step.engine === 'root' ? providerForModel(step.model, providers) : null;
                      const engUsage = usage?.byEngine[step.engine];
                      return (
                        <li
                          key={`${step.engine}/${step.model || 'default'}-${i}`}
                          data-testid="fallback-row"
                          data-step={formatFallbackStep(step)}
                        >
                          <span className="h" aria-hidden="true">
                            ⠿
                          </span>
                          <b className="oz-badge">{i + 1}</b>
                          <span className="tx">
                            <span>
                              {harnessLabel(step.engine)}
                              {prov && prov.name !== 'yggdrasil' ? ` · ${prov.name}` : ''}
                            </span>
                            <small>
                              {step.model || 'default'}
                              {prov?.noQuota
                                ? ' · no quota'
                                : engUsage?.pct != null
                                  ? ` · ${engUsage.pct}%`
                                  : ''}
                            </small>
                          </span>
                          <button
                            type="button"
                            className="oz-k sm"
                            disabled={i === 0}
                            aria-label={`move fallback ${i + 1} up`}
                            data-testid={`fallback-up-${i}`}
                            onClick={() => moveFallback(i, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="oz-k sm"
                            disabled={i === draft.fallback.length - 1}
                            aria-label={`move fallback ${i + 1} down`}
                            data-testid={`fallback-down-${i}`}
                            onClick={() => moveFallback(i, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="oz-k sm red"
                            aria-label={`remove fallback ${i + 1}`}
                            data-testid={`fallback-rm-${i}`}
                            onClick={() => removeFallback(i)}
                          >
                            ×
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="note pt-3!" data-testid="fallback-empty">
                    none set — automatic fallback
                  </p>
                )}

                {draft.fallback.length < MAX_FALLBACK_CHAIN ? (
                  <div className={draft.fallback.length > 0 ? 'pt-0' : 'pt-0'}>
                    <button
                      type="button"
                      aria-expanded={addFallbackOpen}
                      data-testid="fallback-add-btn"
                      onClick={() => setAddFallbackOpen((o) => !o)}
                      className="oz-k ok h-9 w-full justify-start px-3 text-[12px]"
                    >
                      <LineIcon name="plus" size={13} /> add fallback · {draft.fallback.length} of{' '}
                      {MAX_FALLBACK_CHAIN}
                    </button>

                    {addFallbackOpen && (
                      <div className="mt-2.5 flex flex-col gap-2" data-testid="fallback-picker">
                        {/* Root providers grouped by provider (GET /provider, or root models fallback on 404) */}
                        {providers.length > 0 ? (
                          providers.map((p) => {
                            const isDefaultEnv = p.id === 'yggdrasil' || p.id === 'zai';
                            const list = p.models.length ? p.models : isDefaultEnv ? models : [];
                            if (!list.length) return null;
                            const zaiPct = isDefaultEnv ? usage?.byEngine.root?.pct : null;
                            return (
                              <div
                                key={p.id}
                                className="oz-pgrp"
                                data-testid={`fallback-group-${p.id}`}
                              >
                                <div className="oz-pl">
                                  <span>root · {p.name}</span>
                                  {p.lan && <span className="oz-ptag">LAN</span>}
                                  {p.noQuota && <span className="oz-ptag">no quota</span>}
                                  {p.reachable === true && (
                                    <span className="oz-ptag ok">reachable</span>
                                  )}
                                  {p.reachable === false && (
                                    <span className="oz-ptag bad">unreachable</span>
                                  )}
                                  {zaiPct != null && (
                                    <span className={`oz-ptag ${usageTone(zaiPct)}`}>{zaiPct}%</span>
                                  )}
                                </div>
                                <div className="oz-chips">
                                  {list.map((m) => {
                                    const stepModel = isDefaultEnv ? m : `${p.id}/${m}`;
                                    const already = draft.fallback.some(
                                      (s) => s.engine === 'root' && s.model === stepModel
                                    );
                                    return (
                                      <button
                                        key={`${p.id}/${m}`}
                                        type="button"
                                        disabled={already || p.reachable === false}
                                        onClick={() =>
                                          addFallbackStep({ engine: 'root', model: stepModel })
                                        }
                                      >
                                        {m}
                                        {p.lan && <small>LAN</small>}
                                        {p.reachable === false && <small>unreachable</small>}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })
                        ) : models.length > 0 ? (
                          <div className="oz-pgrp" data-testid="fallback-group-root">
                            <div className="oz-pl">
                              <span>root</span>
                              {usage?.byEngine.root?.pct != null && (
                                <span className={`oz-ptag ${usageTone(usage.byEngine.root.pct)}`}>
                                  {usage.byEngine.root.pct}%
                                </span>
                              )}
                            </div>
                            <div className="oz-chips">
                              {models.map((m) => {
                                const already = draft.fallback.some(
                                  (s) => s.engine === 'root' && s.model === m
                                );
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    disabled={already}
                                    onClick={() => addFallbackStep({ engine: 'root', model: m })}
                                  >
                                    root <em>{m}</em>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}

                        {/* Harness groups (Antigravity, Claude Code, opencode, Codex) */}
                        {(['antigravity', 'claude', 'opencode', 'codex'] as const).map((eng) => {
                          const list = (byHarness[eng] || []).filter((m) => m !== 'default');
                          const choices = list.length > 0 ? list : ['default'];
                          const engPct = usage?.byEngine[eng]?.pct;
                          return (
                            <div
                              key={eng}
                              className="oz-pgrp"
                              data-testid={`fallback-group-${eng}`}
                            >
                              <div className="oz-pl">
                                <span>{harnessLabel(eng)}</span>
                                {engPct != null && (
                                  <span className={`oz-ptag ${usageTone(engPct)}`}>{engPct}%</span>
                                )}
                              </div>
                              <div className="oz-chips">
                                {choices.map((m) => {
                                  const modelVal = m === 'default' ? null : m;
                                  const already = draft.fallback.some(
                                    (s) => s.engine === eng && (s.model || null) === modelVal
                                  );
                                  return (
                                    <button
                                      key={`${eng}/${m}`}
                                      type="button"
                                      disabled={already}
                                      onClick={() =>
                                        addFallbackStep({ engine: eng, model: modelVal })
                                      }
                                    >
                                      {harnessLabel(eng)} <em>{m}</em>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="note" data-testid="fallback-cap">
                    {MAX_FALLBACK_CHAIN} of {MAX_FALLBACK_CHAIN} — max reached
                  </p>
                )}
              </>
            )}
          </section>

          {shows('description') && (
            <section className="oz-blk">
              <h2>description</h2>
              <div>
                <input
                  value={draft.description}
                  disabled={!can('description')}
                  onChange={(e) => set({ description: e.target.value })}
                  aria-label="description"
                  placeholder="what this role is for"
                  className="oz-field"
                />
              </div>
            </section>
          )}

          {shows('model') && (
            <section className="oz-blk">
              <h2>model</h2>
              {(() => {
                // a picker, never free text: the models this harness actually offers
                const list = byHarness[h] || models;
                const cur = draft.model || 'default';
                return list.length <= 8 ? (
                  <div className="oz-chips">
                    {list.map((m) => (
                      <button
                        key={m}
                        aria-pressed={cur === m}
                        disabled={!can('model')}
                        onClick={() => set({ model: m === 'default' ? null : m })}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div>
                    <select
                      value={list.includes(cur) ? cur : ''}
                      disabled={!can('model')}
                      onChange={(e) =>
                        set({ model: e.target.value === 'default' ? null : e.target.value || null })
                      }
                      aria-label="model"
                      className="oz-field"
                    >
                      {!list.includes(cur) && <option value="">{cur}</option>}
                      {/* opencode ids are provider/model: grouped by provider */}
                      {Object.entries(
                        list.reduce<Record<string, string[]>>((g, m) => {
                          const k = m.includes('/') ? m.split('/')[0] : '';
                          (g[k] ||= []).push(m);
                          return g;
                        }, {})
                      ).map(([g, ms]) => {
                        const opts = ms.map((m) => (
                          <option key={m} value={m}>
                            {g ? m.slice(g.length + 1) : m}
                            {labels[h]?.[m] ? ` — ${labels[h][m]}` : ''}
                          </option>
                        ));
                        return g ? (
                          <optgroup key={g} label={g}>
                            {opts}
                          </optgroup>
                        ) : (
                          opts
                        );
                      })}
                    </select>
                  </div>
                );
              })()}
              {shows('variant') && (
                <>
                  <div className="oz-chips pt-0">
                    {['high', 'low', 'off'].map((v) => (
                      <button
                        key={v}
                        aria-pressed={draft.variant === v}
                        disabled={!can('variant')}
                        onClick={() => set({ variant: draft.variant === v ? null : v })}
                      >
                        think {v}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {h !== 'root' && labels[h]?.[draft.model || ''] && (
                <p className="note">{labels[h]?.[draft.model || '']}</p>
              )}
            </section>
          )}

          {shows('prompt') && (
            <section className="oz-blk">
              <h2>{h === 'claude' ? 'extra instructions' : 'system prompt'}</h2>
              <div>
                <textarea
                  value={draft.prompt || ''}
                  disabled={!can('prompt')}
                  onChange={(e) => set({ prompt: e.target.value })}
                  aria-label={h === 'claude' ? 'extra instructions' : 'system prompt'}
                  rows={6}
                  className="oz-field h-auto py-2 text-[12px] leading-relaxed"
                />
              </div>
              {(() => {
                // everything the model reads, as saved: the entry for this role's own model
                const sys = detail?.system || [];
                const reads = sys.find((t) => t.models.includes(draft.model || '')) || sys[0];
                return (
                  reads && (
                    <details className="px-3 pb-2">
                      <summary className="cursor-pointer text-[11px] text-[var(--oz-dim)]">
                        everything the model reads — as saved
                      </summary>
                      <pre
                        data-testid="system-full"
                        className="mt-2 max-h-[60vh] overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap"
                      >
                        {reads.text}
                      </pre>
                    </details>
                  )
                );
              })()}
            </section>
          )}

          {shows('tools') && (
            <section className="oz-blk">
              <h2>tools</h2>
              <div className="oz-chips">
                {TOOLS.map((t) => (
                  <button
                    key={t}
                    aria-pressed={!!draft.tools[t]}
                    disabled={!can('tools')}
                    onClick={() => set({ tools: { ...draft.tools, [t]: !draft.tools[t] } })}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {locked.includes('tools') && lockNote('tools')}
              {detail?.rules && (
                <details className="note">
                  <summary>
                    custom rules ({detail.rules.length}) — toggling a tool replaces them
                  </summary>
                  <ul className="mt-1">
                    {detail.rules.map((r, i) => (
                      <li key={i}>
                        {r.action} {r.permission} {r.pattern}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {shows('sessions') && (
                <div className="oz-chips pt-0">
                  <button
                    aria-pressed={draft.sessions}
                    disabled={!can('sessions')}
                    onClick={() => set({ sessions: !draft.sessions })}
                  >
                    manages sessions
                  </button>
                </div>
              )}
              {locked.includes('sessions') && lockNote('sessions')}
              {shows('steps') && (
                <div className="flex items-center gap-2 pt-0">
                  <input
                    type="number"
                    min={1}
                    value={draft.steps ?? ''}
                    disabled={!can('steps')}
                    onChange={(e) => set({ steps: e.target.value ? Number(e.target.value) : null })}
                    aria-label="steps"
                    placeholder="default"
                    className="oz-field w-28"
                  />
                  <span className="text-[11px] text-[var(--oz-dim)]">steps per turn</span>
                </div>
              )}
            </section>
          )}

          <div className="mb-2.5 flex flex-col gap-1.5">
            <button onClick={() => void save()} disabled={saving} className="oz-k ok h-10 w-full">
              {saving ? 'saving…' : isNew ? 'create role' : 'save'}
            </button>
            {refused && (
              <p role="alert" className="text-[11px] text-[var(--oz-danger)]">
                {refused}
              </p>
            )}
            {saved && <p className="text-[11px] text-[var(--oz-success)]">saved</p>}
          </div>

          {detail && !detail.builtin && !isNew && (
            <section className="oz-blk danger">
              <h2>role</h2>
              <div>
                <button
                  onClick={() => (armed ? void remove() : setArmed(true))}
                  className={`oz-del ${armed ? 'armed' : ''}`}
                >
                  {armed ? 'tap again to delete' : 'delete role'}
                </button>
              </div>
              <p className="note">
                {armed ? 'this cannot be undone' : 'removes this role from the root'}
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}
