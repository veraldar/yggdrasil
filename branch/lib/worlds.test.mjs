// FIX-ROOT-DETAIL-THEME — unit tests for the per-computer world rule (lib/worlds.ts).
// Run: node --test lib/worlds.test.mjs   (node ≥ 23.6 strips the .ts types itself)
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// a phone's localStorage
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { cacheRootTheme, cacheTreeThemes, cachedRootTheme, chosenWorld } = await import('./worlds.ts');

// GET /api/roots on the live home root, 11-23 22:20 (release 20261123-2204-491aa2e7): the owner
// had re-picked utopia for home at 22:18 (rev 1); debian-box and omarchy-lab never had a world
// picked — the brain reports its name-hashed default with theme_rev 0
const LIVE_TREE = {
  home: { name: 'omarchy', theme: 'utopia', theme_rev: 1 },
  roots: [
    { id: 'mac-studio', theme: null, theme_rev: 0 },
    { id: 'omarchy-lab', theme: 'terminus', theme_rev: 0 },
    { id: 'debian-box', theme: 'stagnation', theme_rev: 0 },
  ],
};

beforeEach(() => store.clear());

test('a world counts only once picked: the brain default (theme_rev 0 / absent) is nobody’s choice', () => {
  assert.equal(chosenWorld('stagnation', 0), null); // debian-box on 11-23: painted the page dark
  assert.equal(chosenWorld('aether', 0), null); // an unpicked home: flipped the light app dark
  assert.equal(chosenWorld('terminus', undefined), null); // an older brain without theme_rev
  assert.equal(chosenWorld('terminus', 2), 'terminus');
  assert.equal(chosenWorld('nope', 3), null);
  assert.equal(chosenWorld(null, 1), null);
});

test('the live 11-23 tree caches no world: home follows the app, unpicked computers too', () => {
  cacheTreeThemes(LIVE_TREE);
  assert.equal(cachedRootTheme('debian-box'), null);
  assert.equal(cachedRootTheme('omarchy-lab'), null);
  assert.equal(cachedRootTheme('mac-studio'), null);
  assert.equal(cachedRootTheme('omarchy'), null); // home's world is next-themes', never cached
});

test('the old paint cache (it held the unpicked defaults) is dropped, never read', () => {
  store.set('oz-root-themes', JSON.stringify({ 'debian-box': 'stagnation', 'omarchy-lab': 'terminus' }));
  assert.equal(cachedRootTheme('debian-box'), null);
  assert.equal(store.has('oz-root-themes'), false);
});

test('a picked world is cached, and forgotten when the computer comes back unpicked', () => {
  cacheTreeThemes({ roots: [{ id: 'lab', theme: 'terminus', theme_rev: 1 }] });
  assert.equal(cachedRootTheme('lab'), 'terminus');
  cacheTreeThemes({ roots: [{ id: 'lab', theme: 'drift', theme_rev: 0 }] }); // removed + re-joined
  assert.equal(cachedRootTheme('lab'), null);
  cacheRootTheme('lab', 'control'); // picked on its settings tab
  assert.equal(cachedRootTheme('lab'), 'control');
  cacheRootTheme('lab', null); // the pick failed → back to none
  assert.equal(cachedRootTheme('lab'), null);
});

// ROOT-PAGE-HOME-LAYOUT (11-24) — a world is saved for one computer, on that computer
test('a pick for one computer is that computer’s only', () => {
  cacheRootTheme('lab', 'terminus');
  assert.equal(cachedRootTheme('lab'), 'terminus');
  assert.equal(cachedRootTheme('debian-box'), null);
  assert.equal(cachedRootTheme('omarchy'), null);
});

test('a pick a computer could not take (an older brain) leaves nothing behind', () => {
  cacheRootTheme('debian-box', 'drift'); // painted while the save was on its way
  cacheRootTheme('debian-box', null); // "debian-box needs an update for this": undone
  assert.equal(cachedRootTheme('debian-box'), null);
  // and had it stayed, the tree's word (no pick there: theme_rev 0) clears it
  cacheRootTheme('debian-box', 'drift');
  cacheTreeThemes(LIVE_TREE);
  assert.equal(cachedRootTheme('debian-box'), null);
});
