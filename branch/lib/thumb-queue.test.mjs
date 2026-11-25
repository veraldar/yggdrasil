// Bounded thumbnail concurrency queue: prevents 45+ gallery iframes from
// flooding the pinned DataChannel all at once.
// Run: node --test lib/thumb-queue.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createThumbQueue } = await import('./thumb-queue.ts');

test('caps in-flight thumbnails and drains FIFO as each completes', () => {
  const q = createThumbQueue(2, 0);
  const started = [];
  const t1 = q.request(() => started.push(1));
  const t2 = q.request(() => started.push(2));
  const t3 = q.request(() => started.push(3));
  const t4 = q.request(() => started.push(4));

  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(q.stats(), { inflight: 2, waiting: 2 });

  t1.done();
  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(q.stats(), { inflight: 2, waiting: 1 });

  // Idempotent done() never double-releases a slot
  t1.done();
  assert.deepEqual(q.stats(), { inflight: 2, waiting: 1 });

  t2.done();
  assert.deepEqual(started, [1, 2, 3, 4]);
  t3.done();
  t4.done();
  assert.deepEqual(q.stats(), { inflight: 0, waiting: 0 });
});

test('cancelling a scrolled-past card drops it from the queue without consuming a slot', () => {
  const q = createThumbQueue(2, 0);
  const started = [];
  const t1 = q.request(() => started.push(1));
  const t2 = q.request(() => started.push(2));
  const t3 = q.request(() => started.push(3));
  const t4 = q.request(() => started.push(4));

  // User flicked past card 3 before it started
  t3.cancel();
  assert.deepEqual(q.stats(), { inflight: 2, waiting: 1 });

  t1.done();
  assert.deepEqual(started, [1, 2, 4]);
  t2.done();
  t4.done();
  assert.deepEqual(q.stats(), { inflight: 0, waiting: 0 });
});

test('safety timeout releases a stalled slot so the queue never deadlocks', async () => {
  const q = createThumbQueue(1, 30);
  const started = [];
  q.request(() => started.push(1)); // never calls done()
  const t2 = q.request(() => started.push(2));
  assert.deepEqual(started, [1]);

  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(started, [1, 2]);
  t2.done();
  assert.deepEqual(q.stats(), { inflight: 0, waiting: 0 });
});
