import { expect, test } from '@playwright/test';
import type { Msg } from '../components/session-message';
import { heldReply } from '../lib/held-reply';

/** L16: a turn you speak is answered aloud, a turn you type in writing — which reply the
 *  session page says for a HELD turn (text mode). */
const m = (o: Partial<Msg> & { role: string; time: number }): Msg => ({
  text: 'x',
  images: [],
  ...o,
});
const user = (id: string, time: number, o: Partial<Msg> = {}) =>
  m({ role: 'user', id, time, ...o });
const reply = (id: string, time: number, parent: string | undefined, o: Partial<Msg> = {}) =>
  m({ role: 'assistant', id, time, parent, done: true, text: 'the answer', ...o });

test('a held turn: its completed reply is the one to say', () => {
  const msgs = [
    user('u0', 100),
    reply('a0', 110, 'u0'),
    user('u1', 200, { modality: 'voice' }),
    reply('a1', 210, 'u1'),
  ];
  const r = heldReply(msgs, { before: 100 });
  expect(r.user).toBe('u1');
  expect(r.reply?.id).toBe('a1');
});

test('a reply still being written is never said (no fragment)', () => {
  const msgs = [user('u1', 200, { modality: 'voice' }), reply('a1', 210, 'u1', { done: false })];
  expect(heldReply(msgs, { before: 100 })).toEqual({ user: 'u1' });
  // …and once it is complete, it is — the turn is remembered by its id
  msgs[1] = reply('a1', 210, 'u1');
  expect(heldReply(msgs, { before: 100, user: 'u1' }).reply?.id).toBe('a1');
});

test('a typed turn is answered in writing: a hold that caught nothing never speaks it', () => {
  const msgs = [user('u0', 100), reply('a0', 110, 'u0'), user('u1', 200), reply('a1', 210, 'u1')];
  expect(heldReply(msgs, { before: 100 })).toEqual({});
});

test('a turn typed after the held one: only the held turn is said', () => {
  const msgs = [
    user('u1', 200, { modality: 'voice' }),
    user('u2', 205), // typed while the first still ran (queued behind it on the brain)
    reply('a1', 210, 'u1', { text: 'spoken answer' }),
    reply('a2', 220, 'u2', { text: 'written answer' }),
  ];
  expect(heldReply(msgs, { before: 100 }).reply?.text).toBe('spoken answer');
});

test("another session's message, the brain's own, a queued one: not the held turn", () => {
  const from = { session: 's', title: 'lead' };
  const msgs = [
    user('x1', 200, { modality: 'voice', from }),
    user('x2', 201, { modality: 'voice', auto: true }),
    user('x3', 202, { modality: 'voice', queued: true }),
    reply('ax', 210, 'x1'),
  ];
  expect(heldReply(msgs, { before: 100 })).toEqual({});
});

test('an older spoken turn (before the press) is not this hold', () => {
  const msgs = [user('u0', 90, { modality: 'voice' }), reply('a0', 95, 'u0')];
  expect(heldReply(msgs, { before: 90 })).toEqual({});
});

test('a brain that does not name the message a reply answers: the next reply, not a later turn’s', () => {
  const msgs = [user('u1', 200, { modality: 'voice' }), reply('a1', 210, undefined)];
  expect(heldReply(msgs, { before: 100 }).reply?.id).toBe('a1');
  const later = [
    user('u1', 200, { modality: 'voice' }),
    user('u2', 205),
    reply('a2', 220, undefined),
  ];
  expect(heldReply(later, { before: 100 }).reply).toBeUndefined();
});

test('a session on another root reads the same (its transcript, its ids)', () => {
  const msgs = [
    user('msg_lab_1', 200, { modality: 'voice' }),
    reply('msg_lab_2', 260, 'msg_lab_1', { text: 'from lab' }),
  ];
  expect(heldReply(msgs, { before: 0 }).reply?.text).toBe('from lab');
});
