'use client';

/** A terminal's session, live (11-14 Claude Code; 11-15 every harness: `?k=antigravity|opencode`):
 *  as the terminal shows it, as it happens — the owner's messages, the replies, every tool call
 *  and its result, subagents summed up. History first (the last ~200 things, scroll up for more),
 *  then live. The same conversation both ways, one writer at a time:
 *    open in a terminal        watch only (type there)
 *    a Claude Code background session (`claude --bg`, `/bg`)  typed into from here — text +
 *                              Enter, esc, its numbered questions as buttons — through the box's
 *                              helper, which attaches to THIS session only
 *    not open anywhere         continue here: the message goes to THE bifrost session on this
 *                              conversation (made on the first one), whose turn resumes it; the
 *                              reply shows up here as the transcript grows */
import { use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { slugify } from '@/lib/slug';
import { LineIcon } from '@/components/line-icon';
import { HARNESS_LABEL } from '@/components/app/continue-claude';
import { HARNESS_TAG } from '@/lib/agents';
import {
  type CcItem,
  type CcPrompt,
  type CcSub,
  Item,
  PromptCard,
} from '@/components/cc-live/view';

const CcTerm = dynamic(() => import('@/components/cc-live/term').then((m) => m.CcTerm), {
  ssr: false,
});

type Meta = {
  sessionId: string;
  short: string;
  name: string;
  kind: string;
  cwd: string;
  title: string;
  canType: boolean;
  harness?: string;
  live?: Live;
};
type Live = 'bg' | 'tmux' | 'cmd' | 'here' | null;
type Status = {
  live?: Live;
  canType?: boolean;
  gone?: boolean;
  status?: string;
  state?: string;
  kind?: string;
  attached?: boolean;
  prompt?: CcPrompt | null;
  moved?: string;
};
type Res = { text: string; error: boolean; agent?: string };

const key = (it: CcItem) => `${it.k}:${it.id}`;

/** the message the owner sent, as the harness stored it (opencode keeps it in quotes) */
const norm = (t: string) =>
  (t || '')
    .trim()
    .replace(/^["'“]+|["'”]+$/g, '')
    .trim();

/** Fold incoming items into the list: a result joins its call (wherever it is), a re-sent item
 *  (a reconnect re-sends the newest page) replaces its copy, the rest go at the end — or at the
 *  start for an older page. A result whose call isn't loaded waits in `orphans`. */
function fold(
  prev: CcItem[],
  incoming: CcItem[],
  orphans: Map<string, Res>,
  older: boolean
): CcItem[] {
  const next = prev.slice();
  const at = new Map(next.map((it, i) => [key(it), i]));
  const add: CcItem[] = [];
  const addAt = new Map<string, number>();
  for (let it of incoming) {
    if (it.k === 'result') {
      const res = { text: it.text || '', error: !!it.error };
      const i = at.get(`tool:${it.id}`);
      const j = addAt.get(`tool:${it.id}`);
      if (i !== undefined) next[i] = { ...next[i], result: res, agent: it.agent || next[i].agent };
      else if (j !== undefined)
        add[j] = { ...add[j], result: res, agent: it.agent || add[j].agent };
      else orphans.set(it.id, { ...res, agent: it.agent });
      continue;
    }
    if (it.k === 'tool' && !it.result && orphans.has(it.id)) {
      const o = orphans.get(it.id)!;
      orphans.delete(it.id);
      it = { ...it, result: { text: o.text, error: o.error }, agent: o.agent || it.agent };
    }
    const i = at.get(key(it));
    if (i !== undefined) {
      next[i] = it;
      continue;
    }
    addAt.set(key(it), add.length);
    add.push(it);
  }
  return older ? [...add, ...next] : [...next, ...add];
}

function statusWord(s: Status | null, meta: Meta | null): [string, string] {
  if (!s) return ['', ''];
  if (s.live === 'here') return ['working here', 'var(--oz-success)'];
  // Claude Code says what it is doing (its own status), whoever has it open
  if (meta?.harness === 'claude' && !s.gone) {
    if (s.state === 'blocked' || s.status === 'waiting') return ['needs you', 'var(--oz-active)'];
    if (s.status === 'busy' || s.state === 'working') return ['working', 'var(--oz-success)'];
  }
  if (s.live === 'tmux') return ['in tmux · you can type', 'var(--oz-success)'];
  if (s.live === 'cmd') return ['open in a terminal', 'var(--oz-dim)'];
  if (s.live === 'bg') return ['idle', 'var(--oz-dim)'];
  return ['not open', 'var(--oz-dim)'];
}

export default function CcLive({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ k?: string }>;
}) {
  const { id } = use(params);
  const { k } = use(searchParams);
  const router = useRouter();
  const kind = k === 'antigravity' || k === 'opencode' ? k : 'claude';
  const base = `/api/cc-live/h/${kind}/${id}`;
  // "continue here": THE bifrost session on this conversation, and the send it is waiting on
  const [bif, setBif] = useState<{ id: string; title: string } | null>(null);
  const waiting = useRef<{ text: string; at: number } | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [items, setItems] = useState<CcItem[]>([]);
  const [pending, setPending] = useState<CcItem[]>([]);
  const [subs, setSubs] = useState<Record<string, CcSub>>({});
  const [cursor, setCursor] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [conn, setConn] = useState('connecting…');
  const [fatal, setFatal] = useState('');
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'chat' | 'term'>('chat');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const orphans = useRef(new Map<string, Res>());
  const gotHistory = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow the bottom while the reader is there
  const keep = useRef<number | null>(null); // scrollHeight before an older page is prepended

  // the live stream: hello → history → items as the transcript grows, status, subagents
  useEffect(() => {
    const es = new EventSource(`${base}/stream`);
    es.onopen = () => setConn('');
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        // not a stream (the helper said no): ask once, in words
        void fetch(`${base}/history?limit=1`)
          .then((r) => r.json())
          .then((d) => setFatal(d.error || 'this session is not available'))
          .catch(() => setFatal('the Claude Code live helper is not answering'));
      } else setConn('reconnecting…');
    };
    es.addEventListener('hello', (e) => setMeta(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('history', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { items: CcItem[]; cursor: number };
      // the first page sets the cursor; a reconnect's page only adds what is new
      if (!gotHistory.current) {
        gotHistory.current = true;
        setCursor(d.cursor);
      }
      setItems((prev) => fold(prev, d.items, orphans.current, false));
    });
    es.addEventListener('items', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { items: CcItem[] };
      setItems((prev) => fold(prev, d.items, orphans.current, false));
      const typed = d.items.filter((it) => it.k === 'user').map((it) => norm(it.text || ''));
      if (typed.length) {
        setPending((p) => p.filter((x) => !typed.includes(norm(x.text || ''))));
        if (waiting.current && typed.includes(norm(waiting.current.text))) waiting.current = null;
      }
    });
    es.addEventListener('status', (e) => setStatus(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('sub', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { id: string; tools: number; last: string };
      setSubs((s) => ({ ...s, [d.id]: { tools: d.tools, last: d.last } }));
    });
    return () => es.close();
  }, [id, base]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const r = await fetch(`${base}/history?before=${cursor}&limit=200`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      keep.current = scroller.current?.scrollHeight ?? null;
      setItems((prev) => fold(prev, d.items, orphans.current, true));
      setCursor(d.cursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  }, [cursor, base, loadingOlder]);

  // a message continued here: when bifrost's turn ends and the transcript never showed it, the
  // turn did not reach the conversation — say what bifrost said (e.g. "open in a terminal")
  useEffect(() => {
    if (!bif) return;
    const iv = setInterval(async () => {
      const w = waiting.current;
      if (!w) return;
      try {
        const r = await fetch(`/api/session/${slugify(bif.title)}/messages?limit=6&errors=1`, {
          cache: 'no-store',
          headers: { 'X-Session-Pin': bif.id },
        });
        const ms = (await r.json()) as {
          role: string;
          text: string;
          time: number;
          done?: boolean;
          error?: string;
        }[];
        // the reply to THIS message (a queued one waits behind the turn running now: that turn's
        // reply is not it) — the first assistant message after it
        const list = Array.isArray(ms) ? ms : [];
        let mine = -1;
        list.forEach((m, i) => {
          if (m.role === 'user' && norm(m.text || '') === norm(w.text)) mine = i;
        });
        const last = mine >= 0 ? list.slice(mine + 1).find((m) => m.role === 'assistant') : undefined;
        if (last?.done && waiting.current === w) {
          setTimeout(() => {
            if (waiting.current !== w) return; // the transcript caught up meanwhile
            waiting.current = null;
            setPending((p) => p.filter((x) => norm(x.text || '') !== norm(w.text)));
            setErr(last.error || last.text || 'the turn did not reach the conversation');
          }, 4000);
        }
      } catch {
        /* the next tick asks again */
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [bif]);

  // scroll: an older page keeps the reader's place; new items follow the bottom if they were there
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current !== null) {
      el.scrollTop += el.scrollHeight - keep.current;
      keep.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, status?.prompt, tab]);

  const reports = useMemo(() => {
    const m = new Map<string, CcItem>();
    for (const it of items)
      if (it.k === 'note' && it.kind === 'agent' && it.agent) m.set(it.agent, it);
    return m;
  }, [items]);
  // a subagent's report shows on its card; the note stands alone only when the card isn't loaded
  const cardAgents = useMemo(
    () => new Set(items.filter((it) => it.k === 'tool' && it.agent).map((it) => it.agent!)),
    [items]
  );

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };

  // not open anywhere: the brain continues THIS conversation (one bifrost session per conversation)
  async function continueHere(text: string) {
    let b = bif;
    if (!b) {
      const r = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attach: { kind, id, cwd: meta?.cwd || '', title: meta?.title || '' } }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.id) throw new Error(d.error || `HTTP ${r.status}`);
      b = { id: d.id, title: d.title };
      setBif(b);
    }
    waiting.current = { text, at: Date.now() };
    const r = await fetch(`/api/session/${slugify(b.title)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Pin': b.id },
      body: JSON.stringify({ text, async: true }),
    });
    if (!r.ok) {
      waiting.current = null;
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setErr('');
    try {
      if (canType) await post('input', { text });
      else await continueHere(text);
      setPending((p) => [
        ...p,
        {
          k: 'user',
          id: `local-${Date.now()}`,
          t: new Date().toISOString(),
          text,
          pending: true,
          queued: !canType && busyHere,
        },
      ]);
      setInput('');
      stick.current = true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  // open in a plain terminal: a copy goes on here, the terminal's conversation stays untouched
  async function forkHere() {
    setSending(true);
    setErr('');
    try {
      const r = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attach: { kind, id, cwd: meta?.cwd || '', title: meta?.title || '', fork: true },
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.id) throw new Error(d.error || `HTTP ${r.status}`);
      router.push(`/session/${slugify(d.title)}?id=${d.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }

  async function act(path: string, body: unknown) {
    setSending(true);
    setErr('');
    try {
      await post(path, body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  // typed into from here: a Claude Code background session, or any one open in tmux (both ways)
  const canType = status ? !!status.canType : !!meta?.canType;
  const live: Live = status ? (status.live ?? null) : (meta?.live ?? null);
  // nobody has it open: it continues here, through bifrost
  // nobody else has it open — or bifrost itself is working on it: then a message waits its turn
  const canContinue = !!meta && !canType && (!live || live === 'here');
  const busyHere = live === 'here';
  const [word, colour] = statusWord(status, meta);
  const prompt = status?.prompt || null;
  const label = HARNESS_LABEL[kind] || kind;
  const who = kind === 'antigravity' ? 'agy' : kind;
  const title = meta?.title || label;

  return (
    <main
      className="relative mx-auto flex h-dvh max-w-md flex-col overflow-hidden px-3"
      data-testid="cc-live"
    >
      {/* the same header as any session: its tag and title, a breathing dot while it works */}
      <header className="oz-head">
        <div
          className="min-w-0 flex-1 truncate text-[13px]"
          title={meta ? `${label} · ${meta.cwd.replace(/^\/home\/[^/]+/, '~')}` : label}
        >
          <span className="mr-1 opacity-60" aria-hidden="true">
            [{HARNESS_TAG[kind] || 'CLA'}]
          </span>
          {title}
          {word === 'working' && (
            <span className="oz-breathe ml-2 text-[var(--oz-success)]" aria-label="working">
              ●
            </span>
          )}
        </div>
        {word && (
          <span
            data-testid="cc-status"
            data-state={status?.state || status?.status || ''}
            className="flex-none text-[10px]"
            style={{ color: colour }}
          >
            {word}
          </span>
        )}
        {canType && kind === 'claude' && live === 'bg' && (
          <div className="oz-tabs flex-none">
            <button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>
              chat
            </button>
            <button aria-pressed={tab === 'term'} onClick={() => setTab('term')}>
              terminal
            </button>
          </div>
        )}
      </header>

      {fatal ? (
        <p role="alert" className="pt-6 text-[12px] text-[var(--oz-danger)]">
          {fatal}
        </p>
      ) : tab === 'term' && canType ? (
        <CcTerm id={id} />
      ) : (
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (el.scrollTop < 40 && cursor && !loadingOlder) void loadOlder();
          }}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pt-3 pb-2"
          data-testid="cc-scroll"
        >
          {cursor > 0 && (
            <button
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
              className="oz-k sm mb-3 w-full"
            >
              {loadingOlder ? 'loading…' : 'earlier…'}
            </button>
          )}
          {conn && items.length === 0 && <p className="text-[11px] text-[var(--oz-dim)]">{conn}</p>}
          <div className="cc-list">
            {items.map((it) =>
              it.k === 'note' &&
              it.kind === 'agent' &&
              it.agent &&
              cardAgents.has(it.agent) ? null : (
                <Item key={key(it)} it={it} subs={subs} reports={reports} who={who} />
              )
            )}
            {pending.map((it) => (
              <Item key={it.id} it={it} subs={subs} reports={reports} who={who} />
            ))}
          </div>
          {status?.state === 'blocked' && !prompt && canType && (
            <p className="cc-ask text-[12px]">
              the session is asking something — reading its screen…
            </p>
          )}
          {prompt && canType && (
            <PromptCard
              prompt={prompt}
              busy={sending}
              onPick={(n, label) => void act('answer', { n, label })}
              onEsc={() => void act('key', { key: 'esc' })}
            />
          )}
        </div>
      )}

      {err && (
        <p role="alert" className="pb-1 text-[11px] text-[var(--oz-danger)]">
          {err}
        </p>
      )}
      {conn && items.length > 0 && <p className="pb-1 text-[10px] text-[var(--oz-dim)]">{conn}</p>}
      {bif && (
        <p className="pb-1 text-[10px] text-[var(--oz-dim)]" data-testid="cc-bifrost">
          continued through bifrost ·{' '}
          <Link href={`/session/${slugify(bif.title)}?id=${bif.id}`} className="underline">
            open that session
          </Link>
        </p>
      )}

      {!fatal &&
        meta &&
        tab === 'chat' &&
        (canType || canContinue ? (
          <div
            className="oz-dock -mx-3 px-3 pb-[max(8px,env(safe-area-inset-bottom))]"
            data-testid={canType ? 'cc-type' : 'cc-continue'}
          >
            {canType && (
              <button
                onClick={() => void act('key', { key: 'esc' })}
                disabled={sending}
                aria-label="interrupt (esc)"
                className="oz-k"
              >
                esc
              </button>
            )}
            <textarea
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={
                prompt
                  ? 'answer the question above first…'
                  : canType
                    ? `message ${meta.name}…`
                    : busyHere
                      ? 'it is working — your message waits its turn…'
                      : 'continue it here…'
              }
              aria-label="message the session"
              className="oz-ta"
              style={{ maxHeight: 120 }}
            />
            <button
              onClick={() => void send()}
              disabled={sending || !input.trim()}
              aria-label="send"
              className="oz-k ok"
            >
              <LineIcon name="send" size={16} />
            </button>
          </div>
        ) : (
          // the same footer as any session: the composer, here read-only (someone else has it
          // open), and where send sits, the copy to go on in a new session
          <div
            className="oz-dock -mx-3 px-3 pb-[max(8px,env(safe-area-inset-bottom))]"
            data-testid="cc-watch-only"
          >
            <textarea
              disabled
              rows={1}
              placeholder="watch only"
              aria-label="watch only"
              className="oz-ta opacity-60"
            />
            <button
              onClick={() => void forkHere()}
              disabled={sending}
              aria-label="continue in a new session"
              title="continue in a new session"
              className="oz-k ok"
              data-testid="cc-fork"
            >
              <LineIcon name="fork" size={16} />
            </button>
          </div>
        ))}
    </main>
  );
}
