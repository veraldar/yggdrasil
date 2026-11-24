// A save an older computer cannot take reads as one plain line, never "404 Not Found".
// Run: node --test lib/root-outdated.test.mjs   (node ≥ 23.6 strips the .ts types itself)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsUpdate, rootLacksRoute } from './root-outdated.ts';

test('the 11-24 phone log: every world picked for debian-box', () => {
  // PUT /api/roots/debian-box/theme → 502 {"error":"root debian-box: 404 Not Found "}
  assert.equal(rootLacksRoute(502, 'root debian-box: 404 Not Found '), true);
  assert.equal(rootLacksRoute(502, 'root debian-box: 404 Not Found'), true);
  assert.equal(needsUpdate('debian-box'), 'debian-box needs an update for this');
});

test('a route that is there under another method only', () => {
  assert.equal(rootLacksRoute(502, 'root lab: 405 Method Not Allowed '), true);
});

test('a root that answers "not found" in its own words has the route', () => {
  assert.equal(rootLacksRoute(502, 'root lab: 404 Not Found {"error":"unknown engine nope"}'), false);
  assert.equal(rootLacksRoute(502, 'root lab: 404 Not Found no agent zzz'), false);
});

test('every other failure stays what it is', () => {
  assert.equal(rootLacksRoute(502, 'root lab unreachable: error sending request'), false);
  assert.equal(rootLacksRoute(502, 'root lab: 500 Internal Server Error '), false);
  assert.equal(rootLacksRoute(502, 'root lab: 403 Forbidden {"error":"only the home root may change this computer\'s settings"}'), false);
  assert.equal(rootLacksRoute(502, 'the brain did not answer: fetch failed'), false);
  assert.equal(rootLacksRoute(502, 'unknown root "lab" (known: )'), false);
  // only the hub brain's 502 carries a root's refusal
  assert.equal(rootLacksRoute(404, 'root lab: 404 Not Found '), false);
  assert.equal(rootLacksRoute(400, 'root lab: 404 Not Found '), false);
  assert.equal(rootLacksRoute(502, undefined), false);
  assert.equal(rootLacksRoute(502, { error: 'x' }), false);
});
