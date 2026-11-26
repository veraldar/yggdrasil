// The requests board's wording and grouping. Run: node --test lib/asks.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GROUPS, askedAt, groupAsks, landed, parseAsks, sessionLabel, shortSha } from './asks.ts';

const ask = (id, status, extra = {}) => ({
  id,
  text: 'x',
  created: 1,
  home: { id: 'h', title: 'MAIN' },
  session: { id: 's', title: '' },
  status,
  why: '',
  branch: '',
  commit: '',
  note: '',
  updated: 0,
  ...extra,
});

test('groups come in the page order and keep the brain order inside', () => {
  const g = groupAsks([
    ask('1', 'done'),
    ask('2', 'blocked'),
    ask('3', 'done'),
    ask('4', 'running'),
  ]);
  assert.deepEqual(
    g.map((x) => x.status),
    GROUPS.map((x) => x.status)
  );
  assert.deepEqual(
    g.find((x) => x.status === 'done').asks.map((a) => a.id),
    ['1', '3']
  );
  assert.equal(g[0].status, 'blocked');
  assert.equal(g.at(-1).status, 'answered');
});

test('landed needs a branch AND a commit; sha is short', () => {
  assert.equal(landed({ branch: 'b', commit: 'abc' }), true);
  assert.equal(landed({ branch: 'b', commit: '' }), false);
  assert.equal(shortSha('b024e076aaaaaaaa'), 'b024e076');
});

test('a session without a title is named by its id tail', () => {
  assert.equal(sessionLabel({ id: 'ses_abcdef123456', title: ' ' }), 'session 123456');
  assert.equal(sessionLabel({ id: 'x', title: 'Roots page' }), 'Roots page');
});

test('asked-at is a day and a 24 h minute', () => {
  const t = new Date(2026, 10, 26, 21, 36).getTime();
  assert.equal(askedAt(t, 'en-US'), 'Nov 26, 21:36');
});

test('parseAsks drops what is not a card', () => {
  assert.deepEqual(parseAsks({ error: 'x' }), []);
  assert.equal(parseAsks([ask('1', 'done'), null, { id: 2 }]).length, 1);
});
