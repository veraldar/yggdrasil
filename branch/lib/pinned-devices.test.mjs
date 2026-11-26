// lib/pinned.ts outside trunk mode: tailnet and devices pages without a pin boot exactly as before v1 —
// state off, no request of pinned.ts's own (no /t/me/roots, no wait for /api/build), the app's calls
// go out untouched. (The trunk boot is lib/pinned.test.mjs; this file runs in its own process.)
// Run: node --test lib/pinned-devices.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

const calls = [];
const store = new Map(); // a tailnet / unpaired devices phone: no pin of any kind
Object.assign(globalThis, {
  window: globalThis,
  document: { cookie: 'theme=x' }, // no bifrost_mode marker: the door is not in trunk mode
  location: { protocol: 'https:', hostname: 'box.example', host: 'box.example', origin: 'https://box.example', href: 'https://box.example/' },
  RTCPeerConnection: function RTCPeerConnection() {},
  fetch: async (input) => {
    calls.push(new URL(typeof input === 'string' ? input : input.url, 'https://box.example/').pathname);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
});

const pinned = await import('./pinned.ts');

test('no marker, no pin: off at once, pinned.ts asks nothing, the app’s calls go straight out', async () => {
  pinned.bootPinned();
  assert.equal(pinned.pinState().state, 'off');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls, [], 'no /t/me/roots, no /api/build of its own');
  const r = await window.fetch('https://box.example/api/build');
  assert.equal(r.status, 200);
  assert.deepEqual(calls, ['/api/build'], 'the app’s own call, untouched and not held');
  assert.equal(pinned.pinState().state, 'off');
});
