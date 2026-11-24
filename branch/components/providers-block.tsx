'use client';

/** Providers block — configured root providers (GET /provider + GET /usage) and the
 *  add/edit provider form (PUT /provider). Reused on /agents, /providers, and
 *  /roots/[root]/settings. Degrades gracefully on 404 (shows empty state, form stays usable). */
import { useCallback, useEffect, useState } from 'react';
import { LineIcon } from '@/components/line-icon';
import {
  PROVIDER_TYPES,
  type ProviderInfo,
  type ProviderType,
  type ProvidersState,
  type UsageState,
  isLocalType,
  normalizeProvidersResponse,
  normalizeUsageResponse,
  providerTypeLabel,
  usageTone,
} from '@/lib/providers';

type FormState = {
  name: string;
  type: ProviderType;
  baseURL: string;
  apiKey: string;
  modelsMode: 'auto' | 'manual';
  manualModels: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  type: 'ollama',
  baseURL: 'http://127.0.0.1:11434',
  apiKey: '',
  modelsMode: 'auto',
  manualModels: '',
};

const DEFAULT_URLS = new Set(PROVIDER_TYPES.map((t) => t.defaultUrl));

export function ProvidersBlock({
  rootId,
  isHome = true,
  disabled = false,
  onChanged,
}: {
  /** optional remote root name; omitted or isHome=true uses /api/provider */
  rootId?: string;
  isHome?: boolean;
  disabled?: boolean;
  onChanged?: (state: ProvidersState) => void;
}) {
  const endpoint =
    rootId && !isHome ? `/api/roots/${encodeURIComponent(rootId)}/provider` : '/api/provider';

  const [state, setState] = useState<ProvidersState | null>(null);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [openId, setOpenId] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [savedMsg, setSavedMsg] = useState('');

  const load = useCallback(async () => {
    const [pr, ur] = await Promise.all([
      fetch(endpoint, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      isHome
        ? fetch('/api/usage', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    const norm = normalizeProvidersResponse(pr);
    setState(norm);
    onChanged?.(norm);
    if (ur) setUsage(normalizeUsageResponse(ur));
  }, [endpoint, isHome, onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  const startAdd = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setErr('');
    setSavedMsg('');
    setAdding(true);
  };

  const startEdit = (p: ProviderInfo) => {
    setEditing(p.id);
    setForm({
      name: p.id,
      type: p.type,
      baseURL: p.baseURL,
      apiKey: '',
      modelsMode: p.discovered || p.models.length === 0 ? 'auto' : 'manual',
      manualModels: p.models.join(', '),
    });
    setErr('');
    setSavedMsg('');
    setAdding(true);
  };

  const setType = (next: ProviderType) => {
    const meta = PROVIDER_TYPES.find((t) => t.value === next);
    setForm((f) => ({
      ...f,
      type: next,
      baseURL: !f.baseURL.trim() || DEFAULT_URLS.has(f.baseURL.trim()) ? meta?.defaultUrl || '' : f.baseURL,
    }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled || saving) return;
    setErr('');
    setSavedMsg('');

    const name = form.name.trim();
    const baseURL = form.baseURL.trim();
    if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      setErr('name: letters, digits, . - _ (64 max)');
      return;
    }
    if (!baseURL) {
      setErr('base URL is required');
      return;
    }
    const manualList = form.manualModels
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (form.modelsMode === 'manual' && manualList.length === 0) {
      setErr('enter at least one model id, or pick auto-discover');
      return;
    }

    const payload: Record<string, unknown> = {
      name,
      type: form.type,
      baseURL,
      models: form.modelsMode === 'auto' ? 'auto' : manualList,
    };
    if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();

    setSaving(true);
    try {
      const r = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d?.error || `save failed (${r.status})`);
        return;
      }
      setSavedMsg(`saved ${name}`);
      setAdding(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setSaving(false);
    }
  }

  const providers = state?.providers || [];
  const rootUsage = usage?.byEngine.root || usage?.byEngine.zai || null;
  const typeMeta = PROVIDER_TYPES.find((t) => t.value === form.type);

  return (
    <section
      className={`oz-blk ${disabled ? 'oz-gone' : ''}`}
      data-testid="providers-block"
    >
      <h2>providers</h2>

      {!state ? (
        <p className="note pt-3!">loading providers…</p>
      ) : providers.length > 0 ? (
        <ul className="oz-alist" data-testid="providers-list">
          {providers.map((p) => {
            const isOpen = openId === p.id;
            const showUsage =
              (p.type === 'zai' || p.id === 'zai' || p.id === 'yggdrasil') &&
              rootUsage?.pct != null;
            return (
              <li
                key={p.id}
                className="eng"
                data-testid="provider-row"
                data-provider={p.id}
                data-reachable={
                  p.reachable === true ? 'yes' : p.reachable === false ? 'no' : 'unknown'
                }
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpenId(isOpen ? '' : p.id)}
                >
                  <span className="r1">
                    <span className="truncate">{p.name}</span>
                    {p.lan && <span className="oz-ptag">LAN</span>}
                    {p.noQuota && <span className="oz-ptag">no quota</span>}
                    <span className="m">
                      {p.reachable === true ? (
                        <span className="text-[var(--oz-success)]">reachable ✓</span>
                      ) : p.reachable === false ? (
                        <span className="text-[var(--oz-danger)]">unreachable</span>
                      ) : (
                        providerTypeLabel(p.type)
                      )}{' '}
                      {isOpen ? '▲' : '›'}
                    </span>
                  </span>
                  <span className="r2">
                    {providerTypeLabel(p.type)}
                    {p.models.length > 0
                      ? ` · ${p.models.slice(0, 3).join(', ')}${p.models.length > 3 ? ` +${p.models.length - 3}` : ''}`
                      : ' · auto-discover'}
                    {showUsage && (
                      <span className={`ml-1.5 ${usageTone(rootUsage!.pct)}`}>
                        · {rootUsage!.pct}%
                      </span>
                    )}
                  </span>
                </button>

                {isOpen && (
                  <div className="pb-2.5 pt-1">
                    <ul className="oz-kv oz-prov-kv">
                      <li>
                        <span>type</span>
                        <span>{providerTypeLabel(p.type)}</span>
                        <span />
                      </li>
                      <li>
                        <span>base URL</span>
                        <span className="break-all">{p.baseURL || '—'}</span>
                        <span />
                      </li>
                      <li>
                        <span>API key</span>
                        <span>
                          {p.keySource}
                          {p.keyResolved === false && p.keySource !== 'not needed' && p.keySource !== 'none'
                            ? ' (unset)'
                            : ''}
                        </span>
                        <span />
                      </li>
                      <li>
                        <span>models</span>
                        <span>
                          {p.discovered ? 'discovered · ' : ''}
                          {p.models.length ? p.models.join(', ') : 'none yet'}
                        </span>
                        <span />
                      </li>
                      <li>
                        <span>reachability</span>
                        <span
                          className={
                            p.reachable === true
                              ? 'text-[var(--oz-success)]'
                              : p.reachable === false
                                ? 'text-[var(--oz-danger)]'
                                : 'text-[var(--oz-dim)]'
                          }
                        >
                          {p.reachable === true
                            ? `reachable ✓${p.latencyMs != null ? ` (${p.latencyMs}ms)` : ''}`
                            : p.reachable === false
                              ? 'unreachable'
                              : 'not checked'}
                        </span>
                        <span />
                      </li>
                      {p.healthHeadline && (
                        <li>
                          <span>health</span>
                          <span className="text-[var(--oz-active)]">{p.healthHeadline}</span>
                          <span />
                        </li>
                      )}
                      {showUsage && (
                        <li>
                          <span>usage</span>
                          <span className={usageTone(rootUsage!.pct)}>
                            5-hour {rootUsage!.pct}%
                          </span>
                          <span />
                        </li>
                      )}
                    </ul>
                    {!disabled && (
                      <div className="mt-2 flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => startEdit(p)}
                          className="oz-k sm"
                          data-testid={`provider-edit-${p.id}`}
                        >
                          edit
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="note pt-3!" data-testid="providers-empty">
          {state.available
            ? 'no providers configured yet — root uses its default upstream'
            : 'no providers configured on this brain yet'}
        </p>
      )}

      {savedMsg && (
        <p className="note text-[var(--oz-success)]!" data-testid="provider-saved">
          {savedMsg}
        </p>
      )}

      {adding ? (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5 pt-0" data-testid="provider-form">
          <div className="text-[11px] text-[var(--oz-dim)]">
            {editing ? `edit ${editing}` : 'add provider'}
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-[var(--oz-dim)]">name</span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="mac-studio"
              aria-label="provider name"
              className="oz-field"
              disabled={disabled || !!editing}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-[var(--oz-dim)]">type</span>
            <select
              value={form.type}
              onChange={(e) => setType(e.target.value as ProviderType)}
              aria-label="provider type"
              className="oz-field"
              disabled={disabled}
            >
              {PROVIDER_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-[var(--oz-dim)]">base URL</span>
            <input
              value={form.baseURL}
              onChange={(e) => setForm((f) => ({ ...f, baseURL: e.target.value }))}
              placeholder={typeMeta?.defaultUrl || 'http://mac-studio:11434'}
              aria-label="provider base URL"
              className="oz-field"
              disabled={disabled}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-[var(--oz-dim)]">API key</span>
            <input
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder={
                isLocalType(form.type)
                  ? 'not needed'
                  : editing
                    ? 'leave blank to keep current · {env:KEY} · {file:/path}'
                    : '{env:API_KEY} · {file:/path} · or literal'
              }
              aria-label="provider API key"
              autoComplete="off"
              spellCheck={false}
              className="oz-field"
              disabled={disabled}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10.5px] text-[var(--oz-dim)]">models</span>
            <div className="oz-chips">
              <button
                type="button"
                aria-pressed={form.modelsMode === 'auto'}
                disabled={disabled}
                onClick={() => setForm((f) => ({ ...f, modelsMode: 'auto' }))}
              >
                auto-discover
              </button>
              <button
                type="button"
                aria-pressed={form.modelsMode === 'manual'}
                disabled={disabled}
                onClick={() => setForm((f) => ({ ...f, modelsMode: 'manual' }))}
              >
                manual
              </button>
            </div>
            {form.modelsMode === 'manual' ? (
              <input
                value={form.manualModels}
                onChange={(e) => setForm((f) => ({ ...f, manualModels: e.target.value }))}
                placeholder="qwen3.8-27b, glm-5.3"
                aria-label="manual model list"
                className="oz-field"
                disabled={disabled}
              />
            ) : (
              <p className="text-[10.5px] text-[var(--oz-dim)]">
                saving enables discovery ({form.type === 'ollama' ? '/api/tags' : '/v1/models'}) and
                reachability checks
              </p>
            )}
          </div>
          {err && (
            <p role="alert" className="text-[11px] text-[var(--oz-danger)]" data-testid="provider-error">
              {err}
            </p>
          )}
          <div className="flex gap-1.5">
            <button
              type="submit"
              disabled={disabled || saving}
              className="oz-k ok flex-1"
              data-testid="provider-save"
            >
              {saving ? 'saving…' : 'save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setEditing(null);
                setErr('');
              }}
              className="oz-k px-4"
            >
              cancel
            </button>
          </div>
        </form>
      ) : (
        <div className={providers.length > 0 ? '' : 'pt-0'}>
          <button
            type="button"
            disabled={disabled}
            onClick={startAdd}
            className="oz-k ok h-9 w-full justify-start px-3 text-[12px]"
            data-testid="add-provider-btn"
          >
            <LineIcon name="plus" size={13} /> add provider
          </button>
        </div>
      )}
    </section>
  );
}
