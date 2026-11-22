'use client';

/** /agents — the ROLES page (roles rework 11-22; the URL stays): each role with its badge, the
 *  engine it runs on by default (the root, or Claude Code / Antigravity / opencode / Codex), its
 *  model, what it is for. A row opens its editor (/agents/[name]); '+ new role' names one and
 *  opens it empty. Below: the ENGINES — one row each with its default model, a tap opens its
 *  model choices and saves (opencode and Codex behind "more engines"). Reached from MAIN's
 *  settings ('roles ›') and the app settings. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import {
  type AgentRow,
  ENGINE_NOTE,
  type EngineRow,
  MORE_ENGINES,
  byRole,
  engineLabel,
  roleTag,
} from '@/lib/agents';

export default function RolesPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [err, setErr] = useState('');
  const [engines, setEngines] = useState<EngineRow[] | null>(null);
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
            const door = a.name === 'coordinator';
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
                  {a.description && <span className="r2">{a.description}</span>}
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
      {engines && <Engines engines={engines} onSaved={setEngines} />}
      <SharedPrompt />
    </main>
  );
}

/** The engines: what can run a session, each with its default model — a tap opens its choices
 *  and a pick saves at once (PUT /api/engines/:name). opencode and Codex sit in a fold. */
function Engines({
  engines,
  onSaved,
}: {
  engines: EngineRow[];
  onSaved: (e: EngineRow[]) => void;
}) {
  const [open, setOpen] = useState('');
  const [refused, setRefused] = useState<{ name: string; msg: string } | null>(null);
  const [text, setText] = useState('');
  const more = (e: EngineRow) => e.more ?? MORE_ENGINES.has(e.name);

  async function save(name: string, model: string | null) {
    setRefused(null);
    const r = await fetch(`/api/engines/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }).catch(() => null);
    const d = await r?.json().catch(() => null);
    if (!r?.ok)
      return setRefused({ name, msg: d?.error || `save failed (${r?.status ?? 'offline'})` });
    // the brain answers the row; an empty answer still means saved — the pick shows
    const row: EngineRow =
      d && typeof d === 'object' && d.name === name
        ? d
        : { ...engines.find((e) => e.name === name)!, model };
    onSaved(engines.map((e) => (e.name === name ? { ...e, ...row } : e)));
    setOpen('');
  }

  const rowOf = (e: EngineRow) => {
    const label = e.label || engineLabel(e.name);
    const isOpen = open === e.name;
    const cur = e.model || 'default';
    const free = !e.models?.length || (e.models.length === 1 && e.models[0] === 'default');
    return (
      <li key={e.name} className="eng" data-testid="engine-row" data-engine={e.name}>
        <button
          aria-expanded={isOpen}
          onClick={() => {
            setOpen(isOpen ? '' : e.name);
            setRefused(null);
            setText(e.model || '');
          }}
        >
          <span className="r1">
            <span className="truncate">{label}</span>
            <span className="m">
              {e.model || 'its default'} {isOpen ? '▲' : '›'}
            </span>
          </span>
          {ENGINE_NOTE[e.name] && <span className="r2">{ENGINE_NOTE[e.name]}</span>}
        </button>
        {isOpen &&
          (free ? (
            // free text: the engine takes any id it knows (empty = its own pick)
            <div className="flex gap-1.5 pb-2">
              <input
                value={text}
                onChange={(x) => setText(x.target.value)}
                onKeyDown={(x) => x.key === 'Enter' && void save(e.name, text.trim() || null)}
                placeholder="empty = its default"
                aria-label={`${label} default model`}
                className="oz-field"
              />
              <button
                onClick={() => void save(e.name, text.trim() || null)}
                className="oz-k ok px-3"
              >
                save
              </button>
            </div>
          ) : e.models.length <= 8 ? (
            <div className="oz-chips pb-2">
              {e.models.map((m) => (
                <button
                  key={m}
                  aria-pressed={cur === m}
                  onClick={() => void save(e.name, m === 'default' ? null : m)}
                >
                  {m}
                </button>
              ))}
            </div>
          ) : (
            <div className="pb-2">
              <select
                value={e.models.includes(cur) ? cur : ''}
                onChange={(x) =>
                  x.target.value &&
                  void save(e.name, x.target.value === 'default' ? null : x.target.value)
                }
                aria-label={`${label} default model`}
                className="oz-field"
              >
                {!e.models.includes(cur) && <option value="">{cur}</option>}
                {e.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {e.labels?.[m] ? ` — ${e.labels[m]}` : ''}
                  </option>
                ))}
              </select>
            </div>
          ))}
        {isOpen && e.labels?.[cur] && (
          <p className="pb-2 text-[10.5px] text-[var(--oz-dim)]">{e.labels[cur]}</p>
        )}
        {refused?.name === e.name && (
          <p role="alert" className="pb-2 text-[11px] text-[var(--oz-danger)]">
            {refused.msg}
          </p>
        )}
      </li>
    );
  };

  const main = engines.filter((e) => !more(e));
  const rest = engines.filter(more);
  return (
    <section className="oz-blk" data-testid="engines-block">
      <h2>engines</h2>
      <ul className="oz-alist">{main.map(rowOf)}</ul>
      {rest.length > 0 && (
        <details className="pt-0" data-testid="more-engines">
          <summary className="cursor-pointer text-[11px] text-[var(--oz-dim)]">
            more engines (installed, unused)
          </summary>
          <ul className="oz-alist mt-1">{rest.map(rowOf)}</ul>
        </details>
      )}
      <p className="note">
        a role runs on its default engine; a session can still take another in its own settings
      </p>
    </section>
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
