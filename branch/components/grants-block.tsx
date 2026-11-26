'use client';
/**
 * Standing permissions — "don't ask me" the owner switches on themselves, one switch per kind. The text of
 * each kind is fixed in the brain (root/src/owner.rs): what the switch covers is shown here as written and
 * cannot be widened by a request. Off by default; a paired device only (the brain checks its credential).
 */
import { useEffect, useState } from 'react';

type Grant = { kind: string; text: string; on: boolean };

export function GrantsBlock() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [paired, setPaired] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    fetch('/api/owner/grants', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && Array.isArray(d?.grants) && setGrants(d.grants))
      .catch(() => {});
    fetch('/api/owner/state', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setPaired(!!d?.paired))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function flip(g: Grant) {
    setErr('');
    const r = await fetch(`/api/owner/grants/${g.kind}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: !g.on }),
    }).catch(() => null);
    const d = await r?.json().catch(() => null);
    if (r?.ok && Array.isArray(d?.grants)) setGrants(d.grants);
    else setErr(String(d?.error || 'the switch did not move'));
  }

  if (!grants.length) return null;
  return (
    <section className="oz-blk" data-testid="grants-block">
      <ul className="oz-kv">
        {grants.map((g) => (
          <li key={g.kind}>
            <span>{g.kind}</span>
            <span />
            <button
              type="button"
              role="switch"
              aria-checked={g.on}
              aria-label={`standing permission ${g.kind}`}
              data-testid={`grant-${g.kind}`}
              disabled={!paired}
              onClick={() => void flip(g)}
              className={`oz-k sm ${g.on ? 'on' : ''}`}
            >
              {g.on ? 'on' : 'off'}
            </button>
          </li>
        ))}
      </ul>
      {grants.map((g) => (
        <p key={g.kind} className="note">
          <b>{g.kind}:</b> {g.text}
        </p>
      ))}
      {!paired && <p className="note">switch from the paired app</p>}
      {err && <p className="note text-[var(--oz-danger)]">{err}</p>}
    </section>
  );
}
