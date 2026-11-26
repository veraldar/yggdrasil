// lib/pinned.ts behind a v1 trunk, at the module level: the boot hold (P11: a trunk page's /api waits
// until the directory pin is known), the pin-change alarm (D3), `refused` as the page's last word, and
// the store contract React reads it through (usePinState = useSyncExternalStore: one snapshot object
// per change — G3.6 S13 lost the alarm when a component subscribed after the change had landed).
// Run: node --test lib/pinned.test.mjs   (node ≥ 23.6 strips the .ts types itself)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// lib/p2p.ts and lib/pinned.ts use constructor parameter properties, which node's type stripping
// refuses: the app's own TypeScript compiles them (transpile only, no type check)
const ts = createRequire(import.meta.url)('typescript');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/lib/')) return next(new URL(`./${spec.slice(6)}.ts`, import.meta.url).href, ctx);
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts') || url.includes('/node_modules/')) return next(url, ctx);
    const out = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: fileURLToPath(url),
    });
    return { format: 'module', source: out.outputText, shortCircuit: true };
  },
});

const FP_A = 'sha-256 ' + 'AA:'.repeat(31) + 'AA';
const FP_C = 'sha-256 ' + 'CC:'.repeat(31) + 'CC';

// a phone's page behind a trunk-mode door: what bootPinned reads before its first request
const store = new Map([
  ['bifrost.trunk.pins', JSON.stringify({ rt_home: { fp: FP_A, rootId: 'rt_home', rootName: 'home', savedAt: 'x', door: true } })],
]);
const calls = [];
let rootsAnswer = null; // resolved by the test: the directory's answer arrives when it says so
const realFetch = globalThis.fetch;
Object.assign(globalThis, {
  window: globalThis,
  document: { cookie: 'theme=x; bifrost_mode=trunk' },
  location: { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:19050', origin: 'http://127.0.0.1:19050', href: 'http://127.0.0.1:19050/' },
  RTCPeerConnection: function RTCPeerConnection() {},
  fetch: async (input) => {
    const u = new URL(typeof input === 'string' ? input : input.url, 'http://127.0.0.1:19050/');
    calls.push(u.pathname);
    if (u.pathname === '/t/me/roots')
      return new Promise((done) => {
        rootsAnswer = () =>
          done(Response.json([{ id: 'rt_home', name: 'home', online: true, has_app: true, has_voice: true, dtls_fp: FP_C, door: true }]));
      });
    return new Response('sent to the network', { status: 200 });
  },
});
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
});

const pinned = await import('./pinned.ts');

test('the store: one snapshot object per state (useSyncExternalStore reads it), off before boot', () => {
  const a = pinned.pinState();
  assert.equal(a.state, 'off');
  assert.equal(pinned.pinState(), a, 'unchanged state → the same object');
});

test('trunk page: /api waits at boot; the changed directory pin → refused + alarm; the waiting call never reaches the network', async () => {
  const seen = [];
  const off = pinned.onPinState((s, why) => seen.push([s, why]));
  pinned.bootPinned();
  const held = pinned.pinState();
  assert.equal(held.state, 'connecting', 'held at boot: nothing leaves before the pin is known (P11)');
  const early = window.fetch('http://127.0.0.1:19050/api/session'); // the app's first call, issued while held
  assert.ok(rootsAnswer, 'the directory was asked at boot');
  assert.deepEqual(calls, ['/t/me/roots']);
  rootsAnswer();
  const r = await early;
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('x-bifrost-via'), 'refused');
  const now = pinned.pinState();
  assert.equal(now.state, 'refused');
  assert.equal(now.why, pinned.PIN_CHANGED_ALARM);
  assert.notEqual(now, held, 'a change is a new snapshot');
  assert.deepEqual(seen.at(-1), ['refused', pinned.PIN_CHANGED_ALARM]);
  assert.deepEqual(calls, ['/t/me/roots'], 'no /api, no /offer ever reached the network');
  assert.equal(JSON.parse(store.get('bifrost.trunk.pins')).rt_home.fp, FP_A, 'the remembered pin is kept');
  off();
});

test('a reader that subscribes AFTER the alarm landed reads it from the store (what usePinState does on mount; S13)', () => {
  // useSyncExternalStore subscribes, then reads the snapshot again — no notification is needed
  let notified = 0;
  const off = pinned.onPinState(() => notified++);
  assert.equal(pinned.pinState().state, 'refused');
  assert.equal(pinned.pinState().why, pinned.PIN_CHANGED_ALARM);
  assert.equal(notified, 0);
  off();
});

test('after the alarm the page stays refused: pairing hooks do not reopen it, later calls never reach the network', async () => {
  const before = pinned.pinState();
  pinned.pinSaved();
  assert.equal(pinned.pinState(), before);
  const r = await window.fetch('http://127.0.0.1:19050/api/roots');
  assert.equal(r.status, 503);
  assert.deepEqual(calls, ['/t/me/roots']);
});

test.after(() => {
  globalThis.fetch = realFetch;
});
