// ENGINES-INTO-SETTINGS — unit tests for the engines block helpers (lib/agents.ts).
// Run: node --test lib/engines-ui.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { applyEngineSave, engineControlKind, splitEngines } = await import('./agents.ts');

const SAMPLE = [
  { name: 'root', label: 'root', model: 'glm-5.3-flash', models: ['glm-5.3-flash', 'glm-5.3'] },
  {
    name: 'claude',
    label: 'Claude Code',
    model: 'opus',
    models: ['fable', 'opus', 'sonnet', 'haiku'],
  },
  {
    name: 'antigravity',
    label: 'Antigravity',
    model: 'gemini-4-neon-high',
    models: ['gemini-4-neon-high', 'default'],
  },
  { name: 'opencode', label: 'opencode', model: null, models: ['default'], more: true },
  { name: 'codex', label: 'Codex', model: null, models: ['default'] },
];

test('splitEngines puts root / claude / antigravity in main and opencode / codex in more', () => {
  const { main, more } = splitEngines(SAMPLE);
  assert.deepEqual(
    main.map((e) => e.name),
    ['root', 'claude', 'antigravity']
  );
  assert.deepEqual(
    more.map((e) => e.name),
    ['opencode', 'codex']
  );
});

test('splitEngines honours an explicit more flag over the default set', () => {
  const custom = [
    { name: 'opencode', model: null, models: [], more: false },
    { name: 'custom-cli', model: null, models: [], more: true },
  ];
  const { main, more } = splitEngines(custom);
  assert.deepEqual(
    main.map((e) => e.name),
    ['opencode']
  );
  assert.deepEqual(
    more.map((e) => e.name),
    ['custom-cli']
  );
});

test('engineControlKind picks free text, chips (<= 8), or select (> 8)', () => {
  assert.equal(engineControlKind({ models: [] }), 'free');
  assert.equal(engineControlKind({ models: ['default'] }), 'free');
  assert.equal(engineControlKind({ models: ['fable', 'opus', 'sonnet', 'haiku'] }), 'chips');
  assert.equal(
    engineControlKind({ models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'] }),
    'chips'
  );
  assert.equal(
    engineControlKind({ models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'] }),
    'select'
  );
});

test('applyEngineSave merges the returned row or falls back to the chosen model on empty body', () => {
  const withRow = applyEngineSave(
    SAMPLE,
    'claude',
    { name: 'claude', model: 'sonnet', models: ['fable', 'opus', 'sonnet', 'haiku'] },
    'sonnet'
  );
  assert.equal(withRow.find((e) => e.name === 'claude')?.model, 'sonnet');
  assert.equal(withRow.find((e) => e.name === 'root')?.model, 'glm-5.3-flash');

  const withEmpty = applyEngineSave(SAMPLE, 'codex', null, 'o3');
  assert.equal(withEmpty.find((e) => e.name === 'codex')?.model, 'o3');

  const cleared = applyEngineSave(SAMPLE, 'claude', {}, null);
  assert.equal(cleared.find((e) => e.name === 'claude')?.model, null);
});
