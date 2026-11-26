'use client';
/**
 * The owner's answer cards: one per open question a session asked (`card.ask`, from the tree rows), the
 * question in full — Yes · No · Reply. Two or more: Yes to all (N), one call per ask with its own id.
 * Shown in MAIN, and the same card on the asking session's own page (`only`).
 *
 * The buttons exist only on a paired device (GET /api/owner/state); anywhere else — the :8447 door, the
 * box console — one line says where to answer, never a button that fails. The brain checks the device and
 * writes the answer itself (root/src/owner.rs); a press names the ask id it saw, so a question that
 * changed under the thumb is refused (409) and re-shown, not answered.
 */
import { useEffect, useRef, useState } from 'react';
import type { Ask, TreeRow } from '@/lib/card';

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export function AskCards({ tree, only }: { tree: TreeRow[]; only?: string }) {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [replying, setReplying] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const seen = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    fetch('/api/owner/state', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setPaired(!!d?.paired))
      .catch(() => live && setPaired(false));
    return () => {
      live = false;
    };
  }, []);

  const rows = tree.filter(
    (r) => r.card?.ask && (only ? r.id === only : true) && (!r.card.ask.answered || done[r.card.ask.id])
  );
  const open = rows.filter((r) => !r.card!.ask!.answered);

  // the question is on screen: tell the brain once per ask (a reply written after counts as written having seen it)
  useEffect(() => {
    if (!paired) return;
    for (const r of open) {
      const a = r.card!.ask as Ask;
      if (seen.current.has(a.id)) continue;
      seen.current.add(a.id);
      void fetch(`/api/session/${r.id}/seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ask: a.id }),
      }).catch(() => {});
    }
  }, [paired, open]);

  async function answer(r: TreeRow, answer: string) {
    const a = r.card!.ask as Ask;
    setErr('');
    const res = await fetch(`/api/session/${r.id}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ask: a.id, answer }),
    }).catch(() => null);
    if (res?.ok) {
      setDone((d) => ({ ...d, [a.id]: `answered: ${answer === 'yes' || answer === 'no' ? answer : 'replied'} · ${hhmm(Date.now())}` }));
      setReplying(null);
      setDraft('');
    } else {
      const d = await res?.json().catch(() => null);
      setErr(
        res?.status === 409
          ? 'the question changed — read it again'
          : String(d?.error || 'the answer did not go through')
      );
    }
  }

  if (!rows.length) return null;
  return (
    <div data-testid="ask-cards" className="mb-2 flex flex-col gap-2">
      {rows.map((r) => {
        const a = r.card!.ask as Ask;
        const closed = done[a.id];
        return (
          <div key={a.id} data-testid="ask-card" className="oz-card" style={{ display: 'block' }}>
            <div>
              <b>{r.title}</b> <i className="oz-asks">asks:</i>
            </div>
            <div data-testid="ask-q" className="mt-1" style={{ whiteSpace: 'pre-wrap' }}>
              {a.q}
            </div>
            {closed ? (
              <div className="mt-1 opacity-70" data-testid="ask-done">
                {closed}
              </div>
            ) : paired === false ? (
              <div className="mt-1 opacity-70" data-testid="ask-unpaired">
                answer from the paired app
              </div>
            ) : paired ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" data-testid="ask-yes" className="oz-k" onClick={() => void answer(r, 'yes')}>
                  Yes
                </button>
                <button type="button" data-testid="ask-no" className="oz-k" onClick={() => void answer(r, 'no')}>
                  No
                </button>
                <button
                  type="button"
                  data-testid="ask-reply"
                  className="oz-k"
                  onClick={() => setReplying(replying === a.id ? null : a.id)}
                >
                  Reply
                </button>
              </div>
            ) : null}
            {!closed && paired && replying === a.id && (
              <div className="mt-2 flex gap-2">
                <input
                  data-testid="ask-reply-text"
                  value={draft}
                  maxLength={2000}
                  onChange={(e) => setDraft(e.target.value)}
                  className="oz-box flex-1 px-2 py-1"
                  aria-label="your reply"
                />
                <button
                  type="button"
                  className="oz-k"
                  disabled={!draft.trim()}
                  onClick={() => void answer(r, draft.trim())}
                >
                  Send
                </button>
              </div>
            )}
          </div>
        );
      })}
      {paired && open.length >= 2 && (
        <button
          type="button"
          data-testid="ask-yes-all"
          className="oz-k"
          onClick={() => void Promise.all(open.map((r) => answer(r, 'yes')))}
        >
          Yes to all ({open.length})
        </button>
      )}
      {err && (
        <div role="alert" className="oz-asks" data-testid="ask-error">
          {err}
        </div>
      )}
    </div>
  );
}
