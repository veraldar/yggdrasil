'use client';

/** The context sheet (phase 1, plan G1): what this session's model was actually sent.
 *  A full-screen overlay (the .oz-film pattern) with four tabs —
 *    Sent        the captured request, block by block (origin chip + size; tap = full text;
 *                the red dropped line at the end)
 *    MAIN's view what the coordinator sees of this session: tree line, card, reports, briefs,
 *                the session_read text
 *    Memory      the librarian's view of this session: index mark, facts from/about it (✕
 *                forgets one), the top hits for its title
 *    Harness     what the harness (claude/agy/opencode) holds — only when the session runs one
 *  Two actions: "tell this session…" pre-fills its composer with "[missing context] ";
 *  "ask MAIN about this" opens MAIN with a pre-filled note naming the gap. Read-only
 *  end to end — the sheet never writes to the session. */

import { useCallback, useEffect, useState } from 'react';
import { LineIcon } from '@/components/line-icon';

type Block = {
  i: number;
  kind: string;
  origin: string;
  role?: string;
  msg?: number;
  label: string;
  bytes: number;
  tok?: number;
  head: string;
};

type Summary = {
  captured_at?: number;
  model?: string;
  dialect?: string;
  totals: { bytes: number; tok: number };
  blocks: Block[];
  tools: string[];
  dropped: { fold_lines: number; rollup_msgs: number; from: number; to: number };
  preview?: boolean;
  harness?: { prompt?: string; system?: string; argv?: string[] } | null;
};

const ORIGIN_COLOUR: Record<string, string> = {
  shared: 'var(--oz-active)',
  agents_md: 'var(--oz-info)',
  role: 'var(--oz-success)',
  tools: 'var(--oz-dim)',
  verbatim: 'var(--oz-text)',
  one_liner: 'var(--oz-warn, #b58900)',
  station_one_liner: 'var(--oz-warn, #b58900)',
  summary: 'var(--oz-info)',
  pruned: 'var(--oz-dim)',
  tree: 'var(--oz-success)',
  clock: 'var(--oz-dim)',
  inbox: 'var(--oz-danger)',
  voice: 'var(--oz-info)',
};

const kb = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : `${n}`);

export function ContextSheet({
  slug,
  onClose,
  onTellSession,
  onAskMain,
}: {
  slug: string;
  onClose: () => void;
  /** pre-fills this session's composer with "[missing context] " */
  onTellSession: () => void;
  /** opens MAIN with a pre-filled note naming the gap; the owner sends it */
  onAskMain: () => void;
}) {
  const [tab, setTab] = useState<'sent' | 'main' | 'memory' | 'harness'>('sent');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [blockText, setBlockText] = useState<string>('');
  const [mainView, setMainView] = useState<Record<string, unknown> | null>(null);
  const [memory, setMemory] = useState<Record<string, unknown> | null>(null);
  const [harness, setHarness] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(
    async (part: string) => {
      try {
        const r = await fetch(`/api/session/${encodeURIComponent(slug)}/context?part=${part}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`brain ${r.status}`);
        return await r.json();
      } catch (e) {
        setErr(String(e));
        return null;
      }
    },
    [slug]
  );

  useEffect(() => {
    void load('summary').then((d) => d && setSummary(d));
  }, [load]);

  // the tab's part loads on first visit
  useEffect(() => {
    if (tab === 'main' && !mainView) void load('main_view').then(setMainView);
    if (tab === 'memory' && !memory) void load('memory').then(setMemory);
    if (tab === 'harness' && !harness) void load('harness').then(setHarness);
  }, [tab, mainView, memory, harness, load]);

  const openBlock = async (i: number) => {
    if (open === i) {
      setOpen(null);
      setBlockText('');
      return;
    }
    setOpen(i);
    setBlockText('');
    try {
      const r = await fetch(`/api/session/${encodeURIComponent(slug)}/context?part=block&i=${i}`, { cache: 'no-store' });
      const d = await r.json();
      setBlockText(d.text || '');
    } catch {
      setBlockText('(could not load)');
    }
  };

  const isHarness = !!summary?.harness || ((harness as { captured?: unknown } | null)?.captured != null);

  // the ✕ on a fact row: DELETE /api/memory/fact/[id] → brain → librarian forget; the row
  // disappears (the list reloads on next open — the tab keeps its data while open)
  const forgetFact = async (fid: string) => {
    try {
      const r = await fetch(`/api/memory/fact/${fid}`, { method: 'DELETE', cache: 'no-store' });
      if (!r.ok) throw new Error(`brain ${r.status}`);
      setMemory((m) => {
        if (!m) return m;
        const facts = String(m.facts || '')
          .split('\n')
          .filter((l) => !l.includes(`(id=${fid}`))
          .join('\n');
        return { ...m, facts };
      });
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="oz-film ctx-sheet" role="dialog" aria-label="what this session knows" data-testid="ctx-sheet">
      <header className="flex items-center gap-2 px-3 pt-[calc(10px+env(safe-area-inset-top))]">
        <button type="button" className="oz-k sm" aria-label="close the context sheet" data-testid="ctx-close" onClick={onClose}>
          <LineIcon name="close" size={14} />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">what this session knows</h2>
        <span className="text-[10px] text-[var(--oz-dim)] tabular-nums" data-testid="ctx-totals">
          {summary ? `${kb(summary.totals.bytes)}B · ${kb(summary.totals.tok)}t` : '…'}
        </span>
      </header>

      <div className="oz-tabs mx-3 mt-2" role="tablist">
        <button aria-pressed={tab === 'sent'} onClick={() => setTab('sent')} data-testid="ctx-tab-sent">
          Sent
        </button>
        <button aria-pressed={tab === 'main'} onClick={() => setTab('main')} data-testid="ctx-tab-main">
          MAIN&apos;s view
        </button>
        <button aria-pressed={tab === 'memory'} onClick={() => setTab('memory')} data-testid="ctx-tab-memory">
          Memory
        </button>
        {isHarness && (
          <button aria-pressed={tab === 'harness'} onClick={() => setTab('harness')} data-testid="ctx-tab-harness">
            Harness
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12.5px] leading-relaxed">
        {err && (
          <p role="alert" className="text-[var(--oz-danger)]">
            {err}
          </p>
        )}

        {tab === 'sent' && summary && (
          <>
            <p className="pb-2 text-[11px] text-[var(--oz-dim)]">
              {summary.preview ? 'assembled preview of the next turn' : `captured this turn · ${summary.model} · ${summary.dialect}`}
              {summary.tools.length > 0 && ` · ${summary.tools.length} tools`}
            </p>
            <ol className="grid gap-1" data-testid="ctx-blocks">
              {summary.blocks.map((b) => (
                <li key={b.i}>
                  <button
                    type="button"
                    onClick={() => void openBlock(b.i)}
                    aria-expanded={open === b.i}
                    className="w-full border border-[var(--oz-border)] bg-[var(--oz-surface)] px-2 py-1.5 text-left"
                  >
                    <span className="inline-block h-2 w-2 flex-none rounded-full" style={{ background: ORIGIN_COLOUR[b.origin] || 'var(--oz-dim)' }} aria-hidden />
                    <span className="pl-2 text-[11px] font-medium">{b.label}</span>
                    <span className="float-right text-[10px] text-[var(--oz-dim)] tabular-nums">{kb(b.bytes)}B</span>
                    {open === b.i && (
                      <pre className="ctx-block mt-1 max-h-72 overflow-auto whitespace-pre-wrap border-t border-[var(--oz-border)] pt-1 text-[10.5px] text-[var(--oz-dim)]" data-testid={`ctx-block-${b.i}`}>
                        {blockText || '…'}
                      </pre>
                    )}
                  </button>
                </li>
              ))}
            </ol>
            <p className="pt-2 text-[11px] text-[var(--oz-danger)]" data-testid="ctx-dropped">
              {summary.dropped.fold_lines + summary.dropped.rollup_msgs > 0
                ? `${summary.dropped.fold_lines + summary.dropped.rollup_msgs} messages from ${summary.dropped.from} to ${summary.dropped.to}, by fold/roll-up`
                : 'nothing dropped this turn'}
            </p>
          </>
        )}
        {tab === 'sent' && !summary && !err && <p className="text-[var(--oz-dim)]">…</p>}

        {tab === 'main' && mainView && (
          <div className="grid gap-2" data-testid="ctx-main-view">
            <pre className="ctx-pre whitespace-pre-wrap border border-[var(--oz-border)] bg-[var(--oz-surface)] p-2 text-[11px]">{String(mainView.tree_line || '')}</pre>
            <pre className="ctx-pre whitespace-pre-wrap border border-[var(--oz-border)] bg-[var(--oz-surface)] p-2 text-[11px]">{JSON.stringify(mainView.card, null, 1)}</pre>
            {(mainView.reports as unknown[] | undefined)?.length ? (
              <section>
                <h3 className="pb-1 text-[11px] text-[var(--oz-dim)]">reports MAIN got from this session</h3>
                {(mainView.reports as { headline?: string; status?: string }[]).map((r, i) => (
                  <p key={i} className="border-b border-[var(--oz-border)] py-1 text-[11px]">
                    ({r.status}) {r.headline}
                  </p>
                ))}
              </section>
            ) : null}
            <pre className="ctx-pre whitespace-pre-wrap text-[11px] text-[var(--oz-dim)]">{String(mainView.session_read || '')}</pre>
          </div>
        )}

        {tab === 'memory' && memory && (
          <div className="grid gap-2 text-[11px]" data-testid="ctx-memory">
            <pre className="ctx-pre whitespace-pre-wrap">{String(memory.status || 'the librarian has nothing on this yet')}</pre>
            <pre className="ctx-pre whitespace-pre-wrap text-[var(--oz-dim)]">{String(memory.stale || '')}</pre>
            {String(memory.facts || '').trim() && (
              <section>
                <h3 className="pb-1 text-[var(--oz-dim)]">facts from or about this session</h3>
                {(memory.facts as string).split('\n').map((line, i) => {
                  const m = line.match(/\(id=(\d+)/); // "- [topic] fact (3h ago) (id=12)"
                  return (
                    <p key={i} className="flex items-start gap-1 border-b border-[var(--oz-border)] py-1">
                      <span className="min-w-0 flex-1 whitespace-pre-wrap">{line}</span>
                      {m && (
                        <button
                          type="button"
                          className="oz-del flex-none px-1 text-[var(--oz-dim)]"
                          aria-label={`forget fact ${m[1]}`}
                          data-testid={`ctx-fact-del-${m[1]}`}
                          onClick={() => void forgetFact(m[1])}
                        >
                          ✕
                        </button>
                      )}
                    </p>
                  );
                })}
              </section>
            )}
            <pre className="ctx-pre whitespace-pre-wrap text-[var(--oz-dim)]">{String(memory.search || '')}</pre>
          </div>
        )}

        {tab === 'harness' && harness && (
          <div className="grid gap-2 text-[11px]" data-testid="ctx-harness">
            {harness.transcript != null && <pre className="ctx-pre whitespace-pre-wrap">{typeof harness.transcript === 'string' ? harness.transcript : JSON.stringify(harness.transcript, null, 1)}</pre>}
            {(() => {
              const c = harness.captured as { prompt?: string; system?: string } | null | undefined;
              return c ? (
                <>
                  <pre className="ctx-pre whitespace-pre-wrap border border-[var(--oz-border)] bg-[var(--oz-surface)] p-2">{String(c.system || '(no system text)')}</pre>
                  <pre className="ctx-pre max-h-72 overflow-auto whitespace-pre-wrap text-[var(--oz-dim)]">{String(c.prompt || '')}</pre>
                </>
              ) : null;
            })()}
          </div>
        )}
      </div>

      <footer className="flex gap-2 px-3 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2">
        <button type="button" className="oz-del flex-1" data-testid="ctx-tell" onClick={onTellSession}>
          tell this session…
        </button>
        <button type="button" className="oz-del flex-1" data-testid="ctx-ask-main" onClick={onAskMain}>
          ask MAIN about this
        </button>
      </footer>
    </div>
  );
}
