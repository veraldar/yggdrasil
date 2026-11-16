'use client';

/** The raw terminal of a background Claude Code session (11-14): xterm.js over the helper's PTY
 *  (`claude attach <id>`), for everything the chat view doesn't cover — menus, /commands, the
 *  exact screen. Keys go to that one session only; the helper drops the two that would leave it
 *  (Ctrl+Z, and ← on an empty input, which opens the agent view). */
import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';

const KEYS: [string, string][] = [
  ['esc', '\x1b'],
  ['tab', '\t'],
  ['⇧tab', '\x1b[Z'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['⏎', '\r'],
  ['^C', '\x03'],
];

export function CcTerm({ id }: { id: string }) {
  const box = useRef<HTMLDivElement>(null);
  const sendRef = useRef<(d: string) => void>(() => {});
  const [state, setState] = useState('connecting…');

  useEffect(() => {
    let gone = false;
    let es: EventSource | null = null;
    let ro: ResizeObserver | null = null;
    let term: import('@xterm/xterm').Terminal | null = null;
    let buf = '';
    let tm: ReturnType<typeof setTimeout> | undefined;
    const post = (path: string, body: unknown) =>
      fetch(`/api/cc-live/s/${id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    sendRef.current = (d: string) => {
      buf += d;
      clearTimeout(tm);
      tm = setTimeout(() => {
        const data = buf;
        buf = '';
        if (data) void post('term', { data });
      }, 20);
    };
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (gone || !box.current) return;
      term = new Terminal({
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        cursorBlink: true,
        scrollback: 3000,
        theme: { background: '#0a0a0a' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(box.current);
      fit.fit();
      term.onData((d) => sendRef.current(d));
      es = new EventSource(`/api/cc-live/s/${id}/term?cols=${term.cols}&rows=${term.rows}`);
      es.onopen = () => setState('');
      es.onerror = () =>
        setState(es?.readyState === EventSource.CLOSED ? 'not attached' : 'reconnecting…');
      es.addEventListener('data', (e) => {
        const b = atob(JSON.parse((e as MessageEvent).data).b);
        term?.write(Uint8Array.from(b, (c) => c.charCodeAt(0)));
      });
      es.addEventListener('end', () => {
        term?.write('\r\n[the session ended]\r\n');
        setState('ended');
      });
      let last = `${term.cols}x${term.rows}`;
      ro = new ResizeObserver(() => {
        if (!term) return;
        fit.fit();
        const now = `${term.cols}x${term.rows}`;
        if (now !== last) {
          last = now;
          void post('term/size', { cols: term.cols, rows: term.rows });
        }
      });
      ro.observe(box.current);
    })();
    return () => {
      gone = true;
      clearTimeout(tm);
      es?.close();
      ro?.disconnect();
      term?.dispose();
    };
  }, [id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="cc-term">
      {state && <p className="pt-1 text-[10px] text-[var(--oz-dim)]">{state}</p>}
      <div ref={box} className="cc-term" />
      <div className="cc-keys" role="toolbar" aria-label="terminal keys">
        {KEYS.map(([label, seq]) => (
          <button
            key={label}
            className="oz-k sm"
            onClick={() => sendRef.current(seq)}
            aria-label={`key ${label}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
