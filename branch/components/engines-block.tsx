'use client';

/** The engines block (moved from /agents to /settings): what can run a session, each with its
 *  default model — a tap opens its choices in place and a pick saves at once
 *  (PUT /api/engines/:name). opencode and Codex sit in a "more engines" fold. */
import { useState } from 'react';
import {
  ENGINE_NOTE,
  type EngineRow,
  applyEngineSave,
  engineControlKind,
  engineLabel,
  splitEngines,
} from '@/lib/agents';

export function EnginesBlock({
  engines,
  onSaved,
}: {
  engines: EngineRow[];
  onSaved: (e: EngineRow[]) => void;
}) {
  const [open, setOpen] = useState('');
  const [refused, setRefused] = useState<{ name: string; msg: string } | null>(null);
  const [text, setText] = useState('');

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
    onSaved(applyEngineSave(engines, name, d, model));
    setOpen('');
  }

  const rowOf = (e: EngineRow) => {
    const label = e.label || engineLabel(e.name);
    const isOpen = open === e.name;
    const cur = e.model || 'default';
    const kind = engineControlKind(e);
    return (
      <li key={e.name} className="eng" data-testid="engine-row" data-engine={e.name}>
        <button
          type="button"
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
          (kind === 'free' ? (
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
                type="button"
                onClick={() => void save(e.name, text.trim() || null)}
                className="oz-k ok px-3"
              >
                save
              </button>
            </div>
          ) : kind === 'chips' ? (
            <div className="oz-chips pb-2">
              {e.models.map((m) => (
                <button
                  type="button"
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

  const { main, more } = splitEngines(engines);
  return (
    <section className="oz-blk" data-testid="engines-block">
      <h2>engines</h2>
      <ul className="oz-alist">{main.map(rowOf)}</ul>
      {more.length > 0 && (
        <details className="pt-0" data-testid="more-engines">
          <summary className="cursor-pointer text-[11px] text-[var(--oz-dim)]">
            more engines (installed, unused)
          </summary>
          <ul className="oz-alist mt-1">{more.map(rowOf)}</ul>
        </details>
      )}
      <p className="note">
        a role runs on its default engine; a session can still take another in its own settings
      </p>
    </section>
  );
}
