'use client';

/** /agents — the ROLES page (roles rework 11-22; the URL stays): each role with its badge, the
 *  engine it runs on by default (the root, or Claude Code / Antigravity / opencode / Codex), its
 *  model, what it is for. A row opens its editor (/agents/[name]); '+ new role' names one and
 *  opens it empty. Engines live in /settings. Reached from MAIN's settings ('roles ›') and the
 *  app settings. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import { ProvidersBlock } from '@/components/providers-block';
import {
  type AgentRow,
  ENGINE_NOTE,
  type EngineRow,
  MAX_FALLBACK_CHAIN,
  MORE_ENGINES,
  byRole,
  engineModel,
  engineLabel,
  parseFallbackChain,
  roleTag,
} from '@/lib/agents';
import {
  type ProvidersState,
  type UsageState,
  normalizeProvidersResponse,
  normalizeUsageResponse,
  providerForModel,
  usageTone,
} from '@/lib/providers';

export default function RolesPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [err, setErr] = useState('');
  const [engines, setEngines] = useState<EngineRow[] | null>(null);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [provState, setProvState] = useState<ProvidersState | null>(null);
  const providers = provState?.providers || [];
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  // retry until the list lands — a flaky fetch must not read as "no roles"
  useEffect(() => {
    if (agents) return;
    let stop = false;
    const load = () =>
      fetch('/api/agents', { cache: 'no-store' })
        .then(async (r) => {
          const d = await r.json().catch(() => null);
          if (stop) return;
          if (r.ok && Array.isArray(d)) setAgents(d);
          else setErr(d?.error || `HTTP ${r.status}`);
        })
        .catch((e) => !stop && setErr(String(e)));
      fetch('/api/usage', { cache: 'no-store' })
        .then((x) => (x.ok ? x.json() : null))
        .then((d) => !stop && d && setUsage(normalizeUsageResponse(d)))
        .catch(() => null);
      fetch('/api/provider', { cache: 'no-store' })
        .then((x) => (x.ok ? x.json() : null))
        .then((d) => !stop && d && setProvState(normalizeProvidersResponse(d)))
        .catch(() => null);
    void load();
    const t = setInterval(() => !document.hidden && void load(), 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [agents]);

  // the engines' default models (a role on its default engine without a model of its own runs on it)
  useEffect(() => {
    fetch('/api/engines', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => Array.isArray(d) && setEngines(d))
      .catch(() => {});
  }, []);
  const engineModel = (e: string) => engines?.find((x) => x.name === e)?.model || null;

  const ok = /^[A-Za-z0-9_-]+$/.test(name.trim());
  const create = () => {
    const n = name.trim();
    if (!ok) return;
    if (agents?.some((a) => a.name === n)) router.push(`/agents/${n}`);
    else router.push(`/agents/${n}?new=1`);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <button onClick={() => router.back()} className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </button>
        <span className="text-[13px]">roles</span>
      </header>

      <section className="oz-blk">
        <h2>roles</h2>
        <ul className="oz-alist">
          {[...(agents || [])].sort(byRole).map((a) => {
            const e = a.harness || 'root';
            const model = a.model || engineModel(e) || 'default';
            // the coordinator is MAIN's: always on the root (its model can still change)
            const door = a.name === 'coordinator' || a.pinned === true;
            const chain = door ? [] : parseFallbackChain(a.fallback);
            return (
              <li key={a.name}>
                <Link href={`/agents/${a.name}`} data-testid="agent-row" data-role={a.name}>
                  <span className="r1">
                    <span className="truncate">
                      <span className="mr-1 opacity-60" aria-hidden="true">
                        [{roleTag(a.name)}]
                      </span>
                      {a.name}
                    </span>
                    <span className="tag">{engineLabel(e)}</span>
                    <span className="m">
                      {model} {door ? <span className="text-[10px]">locked</span> : '›'}
                    </span>
                  </span>
                  {door ? (
                    <span className="oz-fb">locked · never falls back</span>
                  ) : chain.length > 0 ? (
                    <span className="oz-fb">
                      fallback
                      {chain.map((step, idx) => {
                        const prov =
                          step.engine === 'root' ? providerForModel(step.model, providers) : null;
                        return (
                          <span key={`${step.engine}/${step.model || ''}`} className="oz-fc">
                            <b className="oz-badge">{idx + 1}</b>
                            {engineLabel(step.engine)}
                            {step.model && <em>{step.model}</em>}
                            {prov?.noQuota && <span>· no quota</span>}
                          </span>
                        );
                      })}
                      {chain.length < MAX_FALLBACK_CHAIN && (
                        <span className="oz-fc plus" aria-hidden="true">
                          +
                        </span>
                      )}
                    </span>
                  ) : (
                    a.description && <span className="r2">{a.description}</span>
                  )}
                </Link>
              </li>
            );
          })}
          {!agents && (
            <li className="py-2 text-[11px] text-[var(--oz-dim)]">
              {err ? `couldn't load roles — ${err} · retrying` : 'loading roles…'}
            </li>
          )}
        </ul>
        {naming ? (
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder="name — letters, digits, - _"
              aria-label="new role name"
              className="oz-field"
            />
            <button onClick={create} disabled={!ok} className="oz-k ok px-3 disabled:opacity-40">
              create
            </button>
          </div>
        ) : (
          <div>
            <button
              onClick={() => setNaming(true)}
              className="oz-k ok h-9 w-full justify-start px-3 text-[12px]"
            >
              <LineIcon name="plus" size={13} /> new role
            </button>
          </div>
        )}
      </section>
      <ProvidersBlock onChanged={setProvState} />
      <SharedPrompt />
    </main>
  );
}

/** The system prompt every role reads first — stored once in the brain, edited here once. */
function SharedPrompt() {
  const [got, setGot] = useState<{ prompt: string; default: string; custom: boolean } | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    fetch('/api/shared-prompt', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setGot(d);
        setText(d.prompt);
      })
      .catch(() => {});
  }, []);
  const save = async (prompt: string) => {
    const r = await fetch('/api/shared-prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setNote(d.error || `save failed (${r.status})`);
    setGot(d);
    setText(d.prompt);
    setNote(
      prompt.trim() ? 'saved — every role reads it from its next turn' : 'back to the default'
    );
  };
  if (!got) return null;
  return (
    <section className="oz-blk">
      <h2>shared by all roles</h2>
      <div>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setNote('');
          }}
          aria-label="shared prompt"
          rows={8}
          className="oz-field h-auto py-2 text-[12px] leading-relaxed"
        />
      </div>
      <div className="oz-chips pt-0">
        <button disabled={text === got.prompt} onClick={() => void save(text)}>
          save
        </button>
        {got.custom && <button onClick={() => void save('')}>reset to default</button>}
      </div>
      {note && <p className="note">{note}</p>}
    </section>
  );
}
