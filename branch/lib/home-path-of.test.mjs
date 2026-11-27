// unit tests for the pure home-path rule (lib/home-path-of.ts).
// Run: node --test lib/home-path-of.test.mjs   (node ≥ 23.6 strips the .ts types itself)
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { ROOTS_PATH, homePathOf } = await import('./home-path-of.ts');

test('no name → the bare / (the door, which forwards)', () => {
  assert.equal(homePathOf(), '/');
  assert.equal(homePathOf(null), '/');
  assert.equal(homePathOf(''), '/');
});

test('a normal root name is its own top-level page', () => {
  assert.equal(homePathOf('omarchy'), '/omarchy');
  assert.equal(homePathOf('home'), '/home');
  assert.equal(homePathOf('mac-studio'), '/mac-studio');
});

test('a name like a top-level route keeps /roots/<name> (any case)', () => {
  for (const n of ['roots', 'settings', 'session', 'artifacts', 'api', 'devices', 'join', 'p2p', 'pair',
    'agents', 'bridge', 'cc', 'providers', 'onboarding']) {
    assert.equal(homePathOf(n), `/roots/${n}`, n);
  }
  assert.equal(homePathOf('Settings'), '/roots/Settings');
  assert.equal(homePathOf('ROOTS'), '/roots/ROOTS');
});

test('a name starting with _ or holding a . keeps /roots/<name>', () => {
  assert.equal(homePathOf('_'), '/roots/_');
  assert.equal(homePathOf('_next'), '/roots/_next');
  assert.equal(homePathOf('.'), '/roots/.');
  assert.equal(homePathOf('favicon.ico'), '/roots/favicon.ico');
  assert.equal(homePathOf('my.box'), '/roots/my.box');
});

test('the name is URL-encoded', () => {
  assert.equal(homePathOf('my box'), '/my%20box');
  assert.equal(homePathOf('a/b'), '/a%2Fb');
});

test('ROOTS_PATH', () => assert.equal(ROOTS_PATH, '/roots/'));
