'use client';

/** Claude Code live (11-14): the pieces of a running Claude Code session's page — what the
 *  owner typed and the assistant's replies like chat, each tool call a compact card (name, what
 *  it does; tap for the input and the output; errors show without a tap), subagents summed up
 *  on their card, the session's numbered questions (permission prompts) as buttons. */
import { useState } from 'react';
import { Streamdown } from 'streamdown';

export type CcItem = {
  k: 'user' | 'assistant' | 'tool' | 'result' | 'note' | 'turn';
  id: string;
  t: string;
  text?: string;
  queued?: boolean;
  error?: boolean;
  name?: string;
  title?: string;
  detail?: string;
  agent?: string;
  result?: { text: string; error: boolean };
  kind?: string;
  more?: string;
  ms?: number;
  /** local: typed on this page, not in the transcript yet */
  pending?: boolean;
};
export type CcSub = { tools: number; last: string };
export type CcPrompt = {
  question: string;
  context: string[];
  options: { n: number; label: string; selected: boolean }[];
  footer: string;
};

/** the date and the time a thing was said: "Nov 15, 10:12 PM" */
const clock = (t: string) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime())
    ? ''
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};
const secs = (ms: number) =>
  ms >= 60_000
    ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
    : `${Math.max(1, Math.round(ms / 1000))}s`;

export function ToolCard({ it, sub, report }: { it: CcItem; sub?: CcSub; report?: CcItem }) {
  const [open, setOpen] = useState(false);
  const running = !it.result;
  const err = !!it.result?.error;
  const agentCard = it.name === 'Agent' || it.name === 'Task';
  const firstLines = (s: string) => s.split('\n').slice(0, 4).join('\n');
  return (
    <div
      className={`cc-tool ${err ? 'err' : ''}`}
      data-tool={it.name}
      data-id={it.id}
      data-open={open}
      data-state={running ? 'running' : err ? 'error' : 'done'}
    >
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${it.name}: ${it.title || ''}`}
      >
        <span className={`g ${running ? 'oz-breathe' : ''}`}>
          {running ? '●' : err ? '✗' : '✓'}
        </span>
        <span className="n">{agentCard ? 'subagent' : it.name}</span>
        <span className="t">{it.title}</span>
      </button>
      {agentCard && (sub || report) && (
        <div className="cc-sub" data-testid="cc-sub">
          {report
            ? `reported: ${report.text}`
            : `${sub!.tools} tool call${sub!.tools === 1 ? '' : 's'}${sub!.last ? ` · ${sub!.last}` : ''}`}
        </div>
      )}
      {err && !open && <pre className="cc-pre err">{firstLines(it.result!.text)}</pre>}
      {open && (
        <>
          {it.detail ? (
            <pre className="cc-pre" data-testid="cc-input">
              {it.detail}
            </pre>
          ) : null}
          {it.result ? (
            <pre className={`cc-pre ${err ? 'err' : ''}`} data-testid="cc-output">
              {it.result.text || '(no output)'}
            </pre>
          ) : (
            <p className="cc-sub">running…</p>
          )}
          {report?.more ? <pre className="cc-pre">{report.more}</pre> : null}
        </>
      )}
    </div>
  );
}

function Note({ it }: { it: CcItem }) {
  const glyph: Record<string, string> = {
    task: '◇',
    agent: '◆',
    compact: '⋯',
    command: '/',
    shell: '!',
    interrupted: '■',
    recap: '※',
    error: '✗',
  };
  const line = (
    <>
      <span className="mr-1.5">{glyph[it.kind || ''] || '·'}</span>
      {it.text}
    </>
  );
  return it.more ? (
    <details className={`cc-note ${it.kind}`} data-note={it.kind}>
      <summary>{line}</summary>
      <pre className="cc-pre mt-1">{it.more}</pre>
    </details>
  ) : (
    <div className={`cc-note ${it.kind}`} data-note={it.kind}>
      {line}
    </div>
  );
}

export function Item({
  it,
  subs,
  reports,
  who = 'claude',
}: {
  it: CcItem;
  subs: Record<string, CcSub>;
  reports: Map<string, CcItem>;
  /** who answers: claude · agy · opencode */
  who?: string;
}) {
  if (it.k === 'user') {
    // a message another session sent: the brain put its sender on the first line
    const raw = it.text || '';
    const sent = /^\[from session “([^”]+)”(?: on root ([^\]]+))?\]\n/.exec(raw);
    const text = sent ? raw.slice(sent[0].length) : raw;
    return (
      <div
        className={`text-[13.5px] leading-relaxed break-words ${sent ? 'oz-from' : ''}`}
        data-k="user"
        data-from={sent ? sent[1] : 'you'}
        data-pending={it.pending ? (it.queued ? 'queued' : '') : undefined}
      >
        <div className="oz-who">
          {sent ? (
            <span data-testid="msg-from" className="text-[var(--oz-info)]">
              (← {sent[2] ? `${sent[1]} · ${sent[2]}` : sent[1]})
            </span>
          ) : (
            <span className="text-[var(--oz-success)]">(you)</span>
          )}
          {/* sent while it worked: it waits its turn, then shows up in the conversation */}
          <time>{it.pending ? (it.queued ? 'queued' : 'sending…') : clock(it.t)}</time>
          {it.queued && !it.pending && (
            <span className="text-[10px] text-[var(--oz-dim)]">· while it worked</span>
          )}
        </div>
        <span className="whitespace-pre-wrap">{text}</span>
      </div>
    );
  }
  if (it.k === 'assistant') {
    return (
      <div
        className={`text-[13.5px] leading-relaxed break-words ${it.error ? 'text-[var(--oz-danger)]' : ''}`}
        data-k="assistant"
      >
        <div className="oz-who">
          <span className="text-[var(--oz-dim)]">({who})</span>
          <time>{clock(it.t)}</time>
        </div>
        <Streamdown>{it.text || ''}</Streamdown>
      </div>
    );
  }
  if (it.k === 'tool')
    return (
      <ToolCard it={it} sub={subs[it.id]} report={it.agent ? reports.get(it.agent) : undefined} />
    );
  if (it.k === 'turn') return <div className="cc-turn">— done in {secs(it.ms || 0)} —</div>;
  if (it.k === 'result') {
    // a result whose call is further back (scroll up for it)
    return (
      <ToolCard
        it={{
          ...it,
          k: 'tool',
          name: 'result',
          title: 'of an earlier call',
          result: { text: it.text || '', error: !!it.error },
        }}
      />
    );
  }
  return <Note it={it} />;
}

export function PromptCard({
  prompt,
  busy,
  onPick,
  onEsc,
}: {
  prompt: CcPrompt;
  busy: boolean;
  onPick: (n: number, label: string) => void;
  onEsc: () => void;
}) {
  return (
    <div className="cc-ask" data-testid="cc-prompt" role="group" aria-label={prompt.question}>
      {prompt.context.length > 0 && <pre className="cc-pre mx-0">{prompt.context.join('\n')}</pre>}
      <div className="q">{prompt.question}</div>
      <div className="opts">
        {prompt.options.map((o) => (
          <button
            key={o.n}
            disabled={busy}
            onClick={() => onPick(o.n, o.label)}
            className={`oz-k ${o.n === 1 ? 'ok' : ''}`}
            data-opt={o.n}
          >
            {o.n}. {o.label}
          </button>
        ))}
        <button disabled={busy} onClick={onEsc} className="oz-k sm self-start">
          esc · cancel
        </button>
      </div>
    </div>
  );
}
