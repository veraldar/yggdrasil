import { expect, test } from '@playwright/test';
import type { Msg } from '../components/session-message';
import { answersTyped, heldReply } from '../lib/held-reply';

/** L16: a turn you speak is answered aloud, a turn you type in writing — which reply the
 *  session page says for a HELD turn (text mode). Times are server times; `at` is the press. */
const T = 1_795_000_000_000;
const m = (o: Partial<Msg> & { role: string; time: number }): Msg => ({
  text: 'x',
  images: [],
  ...o,
});
const user = (id: string, time: number, o: Partial<Msg> = {}) =>
  m({ role: 'user', id, time: T + time, ...o });
const reply = (id: string, time: number, parent: string | undefined, o: Partial<Msg> = {}) =>
  m({ role: 'assistant', id, time: T + time, parent, done: true, text: 'the answer', ...o });
const held = (before: number, o: { user?: string } = {}) => ({
  before: before ? T + before : 0,
  at: T + 150,
  ...o,
});
const voice = { modality: 'voice' as const };

test('a held turn: its completed reply is the one to say', () => {
  const msgs = [
    user('u0', 100),
    reply('a0', 110, 'u0'),
    user('u1', 200, voice),
    reply('a1', 210, 'u1'),
  ];
  const r = heldReply(msgs, held(100));
  expect(r.user).toBe('u1');
  expect(r.reply?.id).toBe('a1');
});

test('a reply still being written is never said (no fragment)', () => {
  const msgs = [user('u1', 200, voice), reply('a1', 210, 'u1', { done: false })];
  expect(heldReply(msgs, held(100))).toEqual({ user: 'u1' });
  // …and once it is complete, it is — the turn is remembered by its id
  msgs[1] = reply('a1', 210, 'u1');
  expect(heldReply(msgs, held(100, { user: 'u1' })).reply?.id).toBe('a1');
});

test('a run that was stopped or failed: what is left of it is not said, and the wait ends', () => {
  const msgs = [user('u1', 200, voice), reply('a1', 210, 'u1', { stopped: true, text: 'half a' })];
  expect(heldReply(msgs, held(100))).toEqual({ user: 'u1', over: true });
});

test('a typed turn is answered in writing: a hold that caught nothing never speaks it', () => {
  const msgs = [user('u0', 100), reply('a0', 110, 'u0'), user('u1', 200), reply('a1', 210, 'u1')];
  expect(heldReply(msgs, held(100))).toEqual({});
});

test('a turn typed after the held one: only the held turn is said', () => {
  const msgs = [
    user('u1', 200, voice),
    user('u2', 205), // typed while the first still ran (queued behind it on the brain)
    reply('a1', 210, 'u1', { text: 'spoken answer' }),
    reply('a2', 220, 'u2', { text: 'written answer' }),
  ];
  expect(heldReply(msgs, held(100)).reply?.text).toBe('spoken answer');
});

test('two holds in a row: each gets its own answer', () => {
  const msgs = [
    user('u1', 200, voice),
    user('u2', 205, voice),
    reply('a1', 210, 'u1', { text: 'first' }),
    reply('a2', 220, 'u2', { text: 'second' }),
  ];
  // both were pressed before either landed (the same "before")
  const first = heldReply(msgs, held(100));
  expect(first.reply?.text).toBe('first');
  expect(heldReply(msgs, held(100), [first.user as string]).reply?.text).toBe('second');
});

test("another session's message, the brain's own, a queued one: not the held turn", () => {
  const from = { session: 's', title: 'lead' };
  const msgs = [
    user('x1', 200, { ...voice, from }),
    user('x2', 201, { ...voice, auto: true }),
    user('x3', 202, { ...voice, queued: true }),
    reply('ax', 210, 'x1'),
  ];
  expect(heldReply(msgs, held(100))).toEqual({});
});

test('an older spoken turn is not this hold: before the press, or from long ago', () => {
  const msgs = [user('u0', 90, voice), reply('a0', 95, 'u0')];
  expect(heldReply(msgs, held(90))).toEqual({});
  // pressed before the page had loaded its list (before = 0): a turn of an hour ago is not it…
  const old = [user('u0', -3_600_000, voice), reply('a0', -3_599_000, 'u0')];
  expect(heldReply(old, held(0))).toEqual({});
  // …the one that lands now is
  const now = [...old, user('u1', 200, voice), reply('a1', 260, 'u1', { text: 'now' })];
  expect(heldReply(now, held(0)).reply?.text).toBe('now');
});

test('a brain that does not name the message a reply answers: the next reply, not a later turn’s', () => {
  const msgs = [user('u1', 200, voice), reply('a1', 210, undefined)];
  expect(heldReply(msgs, held(100)).reply?.id).toBe('a1');
  const later = [user('u1', 200, voice), user('u2', 205), reply('a2', 220, undefined)];
  expect(heldReply(later, held(100)).reply).toBeUndefined();
});

test('a session on another root reads the same (its transcript, its ids)', () => {
  const msgs = [
    user('msg_lab_1', 200, voice),
    reply('msg_lab_2', 260, 'msg_lab_1', { text: 'from lab' }),
  ];
  expect(heldReply(msgs, held(0)).reply?.text).toBe('from lab');
});

test('strict L16, hands-free too: the answer to a typed turn is written, to a spoken turn it is said', () => {
  const msgs = [
    user('u1', 100),
    reply('a1', 110, 'u1'),
    user('u2', 200, voice),
    reply('a2', 210, 'u2'),
  ];
  expect(answersTyped(msgs, msgs[1])).toBe(true);
  expect(answersTyped(msgs, msgs[3])).toBe(false);
});

test('strict L16: MAIN coming back by itself, or another session’s message, is not a typed turn', () => {
  const own = reply('a9', 300, 'w-hidden', { autoReply: true }); // its question is not on screen
  const other = [user('u3', 100, { from: { session: 's', title: 'MAIN' } } as Partial<Msg>), reply('a3', 110, 'u3')];
  expect(answersTyped([user('u1', 100), own], own)).toBe(false);
  expect(answersTyped(other, other[1])).toBe(false);
  expect(answersTyped([user('u1', 100)], reply('a4', 120, undefined))).toBe(false);
});
