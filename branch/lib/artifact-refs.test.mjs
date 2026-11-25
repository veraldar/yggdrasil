// Artifact reference parsing for inline chat previews and their open-in-new-tab affordance.
// Run: node --test lib/artifact-refs.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { artifactName, artifactRefs, openInNewTabLabel } = await import('./artifact-refs.ts');

test('extracts html, md, text, pdf, and audio refs with clean names', () => {
  const msg = [
    'See /api/artifact/mockup.html and [report](/api/artifact/report.md).',
    'Logs: /api/artifact/build.log, paper: /api/artifact/spec.pdf, clip: /api/artifact/note.mp3!',
  ].join('\n');

  assert.deepEqual(artifactRefs(msg), [
    { src: '/api/artifact/mockup.html', kind: 'html', name: 'mockup.html' },
    { src: '/api/artifact/report.md', kind: 'md', name: 'report.md' },
    { src: '/api/artifact/build.log', kind: 'text', name: 'build.log' },
    { src: '/api/artifact/spec.pdf', kind: 'pdf', name: 'spec.pdf' },
    { src: '/api/artifact/note.mp3', kind: 'audio', name: 'note.mp3' },
  ]);
});

test('preserves query params (remote root) while stripping trailing sentence punctuation', () => {
  const msg = 'From lab: /api/artifact/plan.md?root=lab&session=ses_42.';
  assert.deepEqual(artifactRefs(msg), [
    { src: '/api/artifact/plan.md?root=lab&session=ses_42', kind: 'md', name: 'plan.md' },
  ]);
  assert.equal(artifactName('/api/artifact/plan.md?root=lab&session=ses_42'), 'plan.md');
});

test('deduplicates repeated links and ignores images or unsupported types', () => {
  const msg = [
    '![shot](/api/artifact/shot.png)',
    '/api/artifact/bin.exe',
    '/api/artifact/page.html',
    '[again](/api/artifact/page.html)',
  ].join('\n');

  assert.deepEqual(artifactRefs(msg), [
    { src: '/api/artifact/page.html', kind: 'html', name: 'page.html' },
  ]);
});

test('openInNewTabLabel matches the artifacts gallery corner button naming', () => {
  assert.equal(openInNewTabLabel('report.md'), 'open report.md in new tab');
  assert.equal(openInNewTabLabel('demo-v2.html'), 'open demo-v2.html in new tab');
});
