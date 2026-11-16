'use client';

/** The terminal's sessions, both ways (11-15): every Claude Code, Antigravity (agy) and opencode
 *  conversation on this box — the box's live helper lists them (open ones first). One tap opens
 *  the live page (/cc/<id>?k=<kind>): everything the session does, as it happens, and the same
 *  conversation continues from either side, one writer at a time —
 *    open in a terminal  watch here, type there
 *    background (Claude Code)  type here too (the helper's PTY)
 *    not open anywhere  continue here: the brain runs the turn on THAT conversation (no fork),
 *                       the terminal sees it on its next resume
 *
 *  TerminalStrip: the ones open right now, on the session list. ContinueTerminal: the sheet with
 *  the newest of every harness. */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export type HarnessKind = 'claude' | 'antigravity' | 'opencode';
export type TermSession = {
  kind: HarnessKind;
  id: string;
  cwd: string;
  title: string;
  modified: number;
  live: 'bg' | 'tmux' | 'cmd' | 'here' | null;
  canType: boolean;
};

export const HARNESS_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  antigravity: 'Antigravity',
  opencode: 'opencode',
};

export const liveHref = (s: { kind: string; id: string }) =>
  s.kind === 'claude' ? `/cc/${s.id}` : `/cc/${s.id}?k=${s.kind}`;

const liveWord = (s: TermSession) =>
  s.live === 'tmux'
    ? 'in tmux · you can type'
    : s.live === 'bg'
    ? 'background · you can type'
    : s.live === 'cmd'
      ? 'open in a terminal'
      : s.live === 'here'
        ? 'working here'
        : '';

const when = (t: number) => {
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
};

const home = (p: string) => p.replace(/^\/home\/[^/]+/, '~');

async function fetchSessions(): Promise<TermSession[]> {
  const r = await fetch('/api/cc-live/harness', { cache: 'no-store' });
  const d = await r.json();
  if (!r.ok || !Array.isArray(d.sessions)) throw new Error(d.error || `HTTP ${r.status}`);
  return d.sessions;
}

function Row({ s }: { s: TermSession }) {
  const router = useRouter();
  const word = liveWord(s);
  return (
    <li>
      <button
        onClick={() => router.push(liveHref(s))}
        data-term={s.id}
        data-kind={s.kind}
        data-live={s.live || ''}
        className="oz-row"
      >
        <div className="oz-r1">
          <span className="t">{s.title || HARNESS_LABEL[s.kind]}</span>
          {word ? (
            <span
              className="oz-st"
              style={{ color: s.live === 'cmd' ? 'var(--oz-dim)' : 'var(--oz-success)' }}
            >
              ● {word}
            </span>
          ) : (
            <time>{when(s.modified)}</time>
          )}
        </div>
        <div className="oz-r2">
          {HARNESS_LABEL[s.kind] || s.kind} · {home(s.cwd)}
        </div>
      </button>
    </li>
  );
}

/** On the session list: the terminal's sessions open right now (polled), nothing when none. */
export function TerminalStrip({ onMore }: { onMore: () => void }) {
  const [open, setOpen] = useState<TermSession[]>([]);
  useEffect(() => {
    let stop = false;
    const tick = () =>
      fetchSessions()
        .then((ss) => !stop && setOpen(ss.filter((s) => s.live)))
        .catch(() => !stop && setOpen([]));
    void tick();
    const iv = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, []);
  if (!open.length) return null;
  return (
    <div className="mb-2" data-testid="terminal-strip">
      <div className="flex items-center justify-between px-1 pb-1 text-[10px] text-[var(--oz-dim)]">
        <span>in the terminal</span>
        <button onClick={onMore} className="underline-offset-2 hover:underline">
          all…
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {open.map((s) => (
          <Row key={`${s.kind}:${s.id}`} s={s} />
        ))}
      </ul>
    </div>
  );
}

/** The sheet: the newest conversations of every harness on this box, open ones first. */
export function ContinueTerminal({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<TermSession[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetchSessions()
      .then(setList)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <div className="oz-box mb-2 p-2" data-testid="continue-terminal">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[12px]">terminal sessions</span>
        <button onClick={onClose} className="oz-k sm">
          close
        </button>
      </div>
      <p className="px-1 pb-1.5 text-[10px] text-[var(--oz-dim)]">
        Claude Code, Antigravity and opencode on this box. Open one to watch it live; continue it
        here when it isn’t open in a terminal — the same conversation, both ways.
      </p>
      {err && (
        <p role="alert" className="px-1 pb-1.5 text-[11px] text-[var(--oz-danger)]">
          {err}
        </p>
      )}
      {!list && !err && <p className="px-1 py-2 text-[11px] text-[var(--oz-dim)]">loading…</p>}
      {list && list.length === 0 && (
        <p className="px-1 py-2 text-[11px] text-[var(--oz-dim)]">no terminal sessions on this box</p>
      )}
      <ul className="flex max-h-[55dvh] flex-col gap-1 overflow-y-auto">
        {(list || []).map((s) => (
          <Row key={`${s.kind}:${s.id}`} s={s} />
        ))}
      </ul>
    </div>
  );
}
