// HIDE-STATION-USER-R1 — unit tests for the owner-voice machinery strip.
// Run: node --test lib/station-hide.test.mjs   (node ≥ 23.6 strips the .ts types itself)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripStationLine, stripUserMachinery } from './station-hide.ts';

// the shape of the 23 Nov 13:30 leak: a session's final report injected as a plain user turn
const REPORT = [
  '# HIDE-STATION-R2 — verdict DONE (owner transcript clean)',
  '- Leak scope confirmed: hub served release 20261122-2146-111f06ee; strip commits lived on another branch.',
  '- Fix: ported the line-based strip into branch/lib/station-hide.ts, wired into messages GET.',
  '- Proven live: release 20261123-1329-81ebc091 deployed to hub-app + hub-app-tailnet ONLY.',
  '- New standing trap: run builds as systemd-run --user --unit=… bash -c \'build command\'.',
  '',
].join('\n');

test('a pure report turn (the 13:30 HIDE-STATION-R2 shape) renders as nothing', () => {
  assert.equal(stripUserMachinery(REPORT), '');
  // the existing station strip alone kept it: this is the leak
  assert.notEqual(stripStationLine(REPORT), '');
});

test('every report header form seen live is machinery', () => {
  for (const h of [
    '# PHONE-PAIR-R2 — fresh pair links',
    '# PAIR-PAGE-R1 — trunk pair flow diagnosis + proof',
    '# PHONE-PAIR-R3 — clickable, phone-reachable pair link',
    '# PAIR-MINT 2026-11-23T11:00Z',
    '## HIDE-STATION-R2: verdict DONE',
    '# SWAP-FIX-R12',
  ]) {
    assert.equal(stripUserMachinery(`${h}\n- one\n- two\n  continued\n`), '', h);
  }
});

test('pure brain blocks render as nothing', () => {
  const pure = [
    '[station turn] reports: "importer" (done): built, 18 tests pass',
    '[inbox] Reports from your sessions since the user last heard from you:\n- "a" (done, worth_knowing): x (id=ses_a)\n- "b" (failed, needs_you): y',
    '[inbox since your last turn]\n- "a" (done): x',
    '[context ≈ 43k tokens · rolls up at 200k]',
    '[context ≈ 43k tokens',
    '[clock 2026-11-19T10:00:00Z] [gap since last user turn 3m]',
    '[gap since last user turn 26h 4m]',
    [
      '[roots] where sessions can run (session_start root=<name>; default = this one):',
      '- omarchy (this root)',
      '- mac: unreachable right now',
      '[tree] your sessions now:',
      '- "P1 · integrator" [lead, idle, 3h ago] stage B done (id=ses_1)',
      '  - "sub" [build, done, 4h ago] built (id=ses_2)',
      'other sessions active in the last 2 days (the user\'s own):',
      '  - "x" [build, idle, 1d ago] y (id=ses_3)',
      'work other roots asked this machine for (theirs — never reuse it for this user):',
      '  - "z" [build, idle, 1d ago] w (id=ses_4)',
      '(3 closed session(s) hidden; sessions_find with archived=true)',
    ].join('\n'),
    '[tree] your sessions now:\n(none yet)\n',
  ];
  for (const t of pure) assert.equal(stripUserMachinery(t), '', t);
});

test('mixed turn: machinery lines go, the owner\'s words stay', () => {
  // the brain's wire shape: awareness line, clock header, inbox block, then the owner's text
  assert.equal(
    stripUserMachinery(
      '[context ≈ 43k tokens · rolls up at 200k]\n' +
        '[clock 2026-11-19T11:00:00Z] [gap since last user turn 5h 2m] [rules: <1h continuous flow; 1-24h brief re-anchor] [meanwhile]\n' +
        '[clock] lane x landed\n' +
        '[inbox since your last turn]\n- "a" (done): x\n' +
        'next ask'
    ),
    'next ask'
  );
  // the header as a same-line prefix: only its tokens go
  assert.equal(stripUserMachinery('[clock 2026-11-19T10:00:00Z] hello'), 'hello');
  assert.equal(
    stripUserMachinery('[clock 2026-11-19T11:00:00Z] [inbox since your last turn]\n- x\nnext ask'),
    'next ask'
  );
  // owner words before a report, and after it (a blank line or a prose line ends the block)
  assert.equal(stripUserMachinery(`can you check this?\n${REPORT}`), 'can you check this?');
  assert.equal(stripUserMachinery(`${REPORT}\nwhat does this mean?`), 'what does this mean?');
  assert.equal(
    stripUserMachinery('# PAIR-MINT 2026-11-23T11:00Z\n- link\nok worked!\n- my own note'),
    'ok worked!\n- my own note'
  );
  // a station one-liner in front of the owner's question
  assert.equal(
    stripUserMachinery('[station turn] reports: "importer" (done): built\nand the tests?'),
    'and the tests?'
  );
});

test('owner sentences without a marker at a line start are always kept, unchanged', () => {
  for (const t of [
    'was end to end badge puseh on ap.veraldar.org?',
    'was Trunk observability lead improved from review?',
    'ok worked!',
    'yes',
    'go',
    'in our agent tyoe who is reponsable to define goals, plan, specs, dev team?',
    '- buy milk\n- call mom',
    '# notes for later',
    '# Plan-R2 — later',
    '# TODO',
    'HIDE-STATION-R2 — did that land?',
    'the [tree] view is wrong',
    'what does [inbox] mean',
    'clock is off: [clock 2026-11-23T10:00:00Z]',
    '> [inbox] Reports from your sessions: quoted by me',
    '> # HIDE-STATION-R2 — verdict DONE',
    'tree',
    'inbox?',
    'other sessions are slow',
    '"Windows page blocked at W-MODEL, no way to give the PC a model" wha model the text to speach ?',
    '',
  ]) {
    assert.equal(stripUserMachinery(t), t.trim(), t);
  }
});
