// The artifacts key's unseen count, per computer: a file on another computer is its own file.
// Run: node --test lib/artifact-read.test.mjs
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};
const { countUnseen, forRoot, lastSeen, markSeen, seenInit } = await import('./artifact-read.ts');

beforeEach(() => store.clear());

test('the home root keeps its files as they are', () => {
  const files = [{ name: 'plan.html', mtime: 10, size: 1, source: 'local' }];
  assert.deepEqual(forRoot(null, files), files);
});

test("another computer's file of the same name is not the home file", () => {
  const home = [{ name: 'plan.html', mtime: 10, size: 1, source: 'local' }];
  const lab = [{ name: 'plan.html', mtime: 20, size: 1 }];
  seenInit(home); // the home files that are there count as seen
  assert.equal(countUnseen(home), 0);
  assert.deepEqual(forRoot('lab', lab), [{ name: 'lab/plan.html', mtime: 20, size: 1, source: 'root:lab' }]);
  // first meeting with lab: what is already there is seen, and home's watermark is untouched
  seenInit(forRoot('lab', lab));
  assert.equal(countUnseen(forRoot('lab', lab)), 0);
  assert.equal(lastSeen('plan.html'), 10);
  assert.equal(lastSeen('lab/plan.html'), 20);
});

test('what lands on that computer afterwards rings, until it is opened', () => {
  seenInit(forRoot('lab', [{ name: 'a.md', mtime: 5, size: 1 }]));
  const later = [
    { name: 'a.md', mtime: 5, size: 1 },
    { name: 'b.md', mtime: 9, size: 1 },
  ];
  seenInit(forRoot('lab', later)); // not the first meeting any more
  assert.equal(countUnseen(forRoot('lab', later)), 1);
  markSeen('lab/b.md', 9);
  assert.equal(countUnseen(forRoot('lab', later)), 0);
  // a third computer starts from its own first meeting
  assert.equal(countUnseen(forRoot('old', later)), 2);
});
