// Chat-style follow (owner 11-24) — unit tests for the pure helpers behind the transcript scroll.
// Run: node --test lib/scroll-follow.test.mjs   (node ≥ 23.6 strips the .ts types itself)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOLLOW_PX, anchorShift, atBottom, lastKey, msgKey, pickAnchor } from './scroll-follow.ts';

test('at the bottom, or within the small threshold: follow; further up: do not', () => {
  assert.equal(atBottom({ scrollHeight: 5000, scrollTop: 4220, clientHeight: 780 }), true); // 0 px
  assert.equal(atBottom({ scrollHeight: 5000, scrollTop: 4180, clientHeight: 780 }), true); // 40 px
  assert.equal(atBottom({ scrollHeight: 5000, scrollTop: 4220 - FOLLOW_PX + 1, clientHeight: 780 }), true);
  assert.equal(atBottom({ scrollHeight: 5000, scrollTop: 4220 - FOLLOW_PX, clientHeight: 780 }), false);
  assert.equal(atBottom({ scrollHeight: 5000, scrollTop: 1200, clientHeight: 780 }), false); // reading
  // a transcript shorter than the screen is always "at the bottom"
  assert.equal(atBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 780 }), true);
});

test('keys are the message id: a sliding window keeps every row on its own message', () => {
  const win = (from) => Array.from({ length: 5 }, (_, k) => ({ id: `msg_${from + k}`, time: from + k }));
  const before = win(0).map(msgKey);
  const after = win(2).map(msgKey); // two arrived, two dropped off the top
  // the rows both windows show keep their keys (an index key gave row 0 to a new message)
  assert.deepEqual(before.slice(2), after.slice(0, 3));
  assert.notEqual(msgKey({ id: 'msg_0', time: 0 }, 0), msgKey({ id: 'msg_2', time: 2 }, 0));
});

test('local rows (an echo, a queued message) get unique keys without an id', () => {
  const a = msgKey({ role: 'user', time: 1000 }, 7);
  const b = msgKey({ role: 'user', time: 1000, queued: true }, 8);
  const c = msgKey({ role: 'user', time: 1000 }, 9);
  assert.equal(new Set([a, b, c]).size, 3);
  assert.ok(!a.startsWith('msg_'));
});

test('lastKey names the newest message; empty list has none', () => {
  assert.equal(lastKey([]), '');
  assert.equal(lastKey([{ id: 'a', time: 1 }, { id: 'b', time: 2 }]), 'b');
  assert.equal(lastKey([{ id: 'a', time: 1 }, { role: 'user', time: 5 }]), 'user-5');
});

test('the anchor is the first message still showing, with its offset under the view top', () => {
  const items = [
    { id: 'a', top: -900, bottom: -500 }, // above, gone
    { id: 'b', top: -500, bottom: 40 }, // its tail still shows: this is where the reader is
    { id: 'c', top: 54, bottom: 300 },
  ];
  assert.deepEqual(pickAnchor(items, 0), { id: 'b', y: -500 });
  assert.deepEqual(pickAnchor(items, 100), { id: 'c', y: -46 });
  assert.equal(pickAnchor([], 0), null);
  // works on any iterable (the page feeds a generator over the DOM rows)
  function* gen() { yield* items; }
  assert.deepEqual(pickAnchor(gen(), 0), { id: 'b', y: -500 });
});

test('the shift puts the anchor back where it sat', () => {
  const a = { id: 'b', y: 86 };
  assert.equal(anchorShift(a, 86), 0); // nothing moved (native anchoring already held it)
  assert.equal(anchorShift(a, -281), -367); // the window slid: the text rose 367 px → scroll up 367
  assert.equal(anchorShift(a, 300), 214); // something grew above: scroll down
  assert.equal(anchorShift(a, null), 0); // the message left the window: leave the view alone
});
