// v1 access tokens (lib/trunk-auth.ts): PASETO v4.public on the official vectors, C3's checks in C3's
// order with C3's `why`s, the trunk-state.json loader (C5), and — once the IDP stream writes it — the
// shared vectors docs/trunk-v1/vectors/paseto.json that the Rust verifier runs too.
// Run: node --test lib/trunk-auth.test.mjs   (node ≥ 23.6 strips the .ts types itself)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const t = await import('./trunk-auth.ts');

// ── the official PASETO v4 vectors (github.com/paseto-standard/test-vectors, v4.json) ──────────────
const PK = '1eb9dbbbbc047c03fd70604e0071f0987e16b28b757225c11f00415d0e20b1a2';
const SEED = 'b4cbfb43df4ce210727d953e4a713307fa19bb7d9f85041438d9e11b942a3774';
const PAYLOAD = '{"data":"this is a signed message","exp":"2022-01-01T00:00:00+00:00"}';
const FOOTER = '{"kid":"zVhMiPBP9fRf2snEcT7gFTioeA9COcNy9DfgL1W60haN"}';
const OFFICIAL = [
  {
    name: '4-S-1',
    token:
      'v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9bg_XBBzds8lTZShVlwwKSgeKpLT3yukTw6JUz3W4h_ExsQV-P0V54zemZDcAxFaSeef1QlXEFtkqxT1ciiQEDA',
    footer: '',
    implicit: '',
  },
  {
    name: '4-S-2',
    token:
      'v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9v3Jt8mx_TdM2ceTGoqwrh4yDFn0XsHvvV_D0DtwQxVrJEBMl0F2caAdgnpKlt4p7xBnx1HcO-SPo8FPp214HDw.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9',
    footer: FOOTER,
    implicit: '',
  },
  {
    name: '4-S-3',
    token:
      'v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9NPWciuD3d0o5eXJXG5pJy-DiVEoyPYWs1YSTwWHNJq6DZD3je5gf-0M4JR9ipdUSJbIovzmBECeaWmaqcaP0DQ.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9',
    footer: FOOTER,
    implicit: '{"test-vector":"4-S-3"}',
  },
];
// expect-fail vectors that a v4.public verifier must refuse
const OFFICIAL_FAIL = [
  // 4-F-1: a v4.local token handed to the public verifier
  'v4.local.vngXfCISbnKgiP6VWGuOSlYrFYU300fy9ijW33rznDYgxHNPwWluAY2Bgb0z54CUs6aYYkIJ-bOOOmJHPuX_34Agt_IPlNdGDpRdGNnBz2MpWJvB3cttheEc1uyCEYltj7wBQQYX.YXJiaXRyYXJ5LXN0cmluZy10aGF0LWlzbid0LWpzb24',
  // 4-F-2: a v4.public token whose signature is not this key's ("should never decode")
  'v4.public.eyJpbnZhbGlkIjoidGhpcyBzaG91bGQgbmV2ZXIgZGVjb2RlIn22Sp4gjCaUw0c7EH84ZSm_jN_Qr41MrgLNu5LIBCzUr1pn3Z-Wukg9h3ceplWigpoHaTLcwxj0NsI1vjTh67YB.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9',
  // 4-F-3: another version altogether
  'v3.local.23e_2PiqpQBPvRFKzB0zHhjmxK3sKo2grFZRRLM-U7L0a8uHxuF9RlVz3Ic6WmdUUWTxCaYycwWV1yM8gKbZB2JhygDMKvHQ7eBf8GtF0r3K0Q_gF1PXOxcOgztak1eD1dPe9rLVMSgR0nHJXeIGYVuVrVoLWQ.YXJiaXRyYXJ5LXN0cmluZy10aGF0LWlzbid0LWpzb24',
];

const pub = t.publicKeyFromRaw(Buffer.from(PK, 'hex'));
const sec = t.secretKeyFromSeed(Buffer.from(SEED, 'hex'));

test('official 4-S-1..3 verify, and signing with the seed gives the very same tokens', () => {
  for (const v of OFFICIAL) {
    const out = t.v4PublicVerify(v.token, pub, v.implicit);
    assert.ok(out, v.name);
    assert.equal(out.message.toString(), PAYLOAD, v.name);
    assert.equal(out.footer.toString(), v.footer, v.name);
    assert.equal(t.v4PublicSign(PAYLOAD, sec, v.footer, v.implicit), v.token, `${v.name} (Ed25519 is deterministic)`);
  }
  assert.equal(t.rawPublic(sec).toString('hex'), PK);
});

test('official expect-fail vectors and tampering are refused', () => {
  for (const tok of OFFICIAL_FAIL) assert.equal(t.v4PublicVerify(tok, pub), null, tok.slice(0, 12));
  const [s1, s2, s3] = OFFICIAL;
  // the implicit assertion is signed: 4-S-3 without it, 4-S-2 with one, both fail
  assert.equal(t.v4PublicVerify(s3.token, pub, ''), null);
  assert.equal(t.v4PublicVerify(s2.token, pub, '{"test-vector":"4-S-3"}'), null);
  // the footer is signed: swap 4-S-2's footer onto 4-S-1's body, drop 4-S-2's footer
  assert.equal(t.v4PublicVerify(`${s1.token}.${s2.token.split('.')[3]}`, pub), null);
  assert.equal(t.v4PublicVerify(s2.token.split('.').slice(0, 3).join('.'), pub), null);
  // one flipped bit in the message or the signature
  const body = Buffer.from(s1.token.split('.')[2], 'base64url');
  for (const i of [0, body.length - 1]) {
    const b = Buffer.from(body);
    b[i] ^= 1;
    assert.equal(t.v4PublicVerify(`v4.public.${b.toString('base64url')}`, pub), null, `bit at ${i}`);
  }
  // not base64url, padded, a trailing empty footer, another key
  assert.equal(t.v4PublicVerify(`${s1.token}=`, pub), null);
  assert.equal(t.v4PublicVerify(`${s1.token}.`, pub), null);
  assert.equal(t.v4PublicVerify(s1.token.replace('v4.public.', 'v4.public.+'), pub), null);
  const other = t.secretKeyFromSeed(Buffer.alloc(32, 7));
  assert.equal(t.v4PublicVerify(s1.token, t.publicKeyFromRaw(t.rawPublic(other))), null);
});

test('PAE matches the spec examples', () => {
  assert.equal(t.pae([]).toString('hex'), '0000000000000000');
  assert.equal(t.pae([Buffer.alloc(0)]).toString('hex'), '01000000000000000000000000000000');
  assert.equal(
    t.pae([Buffer.from('test')]).toString('hex'),
    '0100000000000000040000000000000074657374'
  );
});

// ── C3 ──────────────────────────────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-11-25T12:00:00Z');
const RGN = 'net:203.0.0.0/16';
const key = t.secretKeyFromSeed(Buffer.alloc(32, 1));
const raw = t.rawPublic(key);
const KID = t.kidOf(raw);
const auth = (over = {}) => ({
  keys: [{ kid: KID, alg: 'ed25519', public: raw.toString('base64url'), retired_at: null }],
  kill_epoch: 3,
  deny: [],
  ...over,
});
const mint = (claims = {}, opts = {}) =>
  t.mintToken(key, { did: 'dev_phone1', sub: 'acc_owner', rgn: RGN, kep: 3, ...claims }, { now: NOW, ...opts });
const check = (tok, a = auth(), region = RGN, now = NOW + 1000) => t.checkToken(tok, a, region, now);

test('kid = k_ + 16 b64url chars of sha256(public)', () => {
  assert.match(KID, /^k_[A-Za-z0-9_-]{16}$/);
  const tok = mint();
  assert.deepEqual(JSON.parse(Buffer.from(tok.split('.')[3], 'base64url')), { kid: KID });
});

test('a good token passes and yields exactly C3 claims', () => {
  const v = check(mint({ role: 'member' }));
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.claims).sort(), ['did', 'exp', 'iat', 'iss', 'jti', 'kep', 'rgn', 'role', 'sub']);
  assert.equal(v.claims.role, 'member');
  assert.equal(v.claims.exp, '2026-11-25T12:15:00Z');
});

test('missing: no token at all', () => {
  assert.deepEqual(check(''), { ok: false, why: 'missing' });
  assert.deepEqual(check('   '), { ok: false, why: 'missing' });
});

test('invalid: signature, kid, retired key, shape', () => {
  const inv = { ok: false, why: 'invalid' };
  assert.deepEqual(check('bfnd-0123456789abcdef0123'), inv, 'a v0.9 device token');
  assert.deepEqual(check(OFFICIAL[1].token), inv, 'a good PASETO from someone else');
  // a key the state does not hold, or one whose kid does not match
  const stranger = t.secretKeyFromSeed(Buffer.alloc(32, 2));
  assert.deepEqual(check(t.mintToken(stranger, { did: 'dev_x', rgn: RGN, kep: 3 }, { now: NOW })), inv);
  assert.deepEqual(check(t.mintToken(stranger, { did: 'dev_x', rgn: RGN, kep: 3 }, { now: NOW, kid: KID })), inv);
  // retired: from its retirement on (not before)
  assert.deepEqual(check(mint(), auth({ keys: [{ ...auth().keys[0], retired_at: NOW }] })), inv);
  assert.equal(check(mint(), auth({ keys: [{ ...auth().keys[0], retired_at: NOW + 5000 }] })).ok, true);
  // no footer, a footer without a kid
  const msg = Buffer.from(mint().split('.')[2], 'base64url').subarray(0, -64).toString();
  assert.deepEqual(check(t.v4PublicSign(msg, key)), inv, 'no footer');
  assert.deepEqual(check(t.v4PublicSign(msg, key, '{"key":"k"}')), inv, 'no kid in the footer');
  assert.deepEqual(check(t.v4PublicSign(msg, key, JSON.stringify({ kid: KID }), 'implicit')), inv, 'an implicit assertion');
  // claims: an extra key, a missing key, wrong types, a non-Z time, a short jti
  const body = JSON.parse(Buffer.from(mint().split('.')[2], 'base64url').subarray(0, -64).toString());
  const signed = (c) => t.v4PublicSign(JSON.stringify(c), key, JSON.stringify({ kid: KID }));
  assert.equal(check(signed(body)).ok, true, 'the control');
  for (const [what, c] of [
    ['extra key', { ...body, admin: true }],
    ['missing jti', { ...body, jti: undefined }],
    ['role', { ...body, role: 'owner' }],
    ['kep string', { ...body, kep: '3' }],
    ['kep negative', { ...body, kep: -1 }],
    ['did prefix', { ...body, did: 'acc_owner' }],
    ['sub prefix', { ...body, sub: 'dev_phone1' }],
    ['exp offset', { ...body, exp: '2026-11-25T12:15:00+00:00' }],
    ['exp millis', { ...body, exp: '2026-11-25T12:15:00.000Z' }],
    ['exp not a day', { ...body, exp: '2026-02-30T12:15:00Z' }],
    ['jti length', { ...body, jti: 'AAAA' }],
    ['not an object', [body]],
  ])
    assert.deepEqual(check(signed(c)), inv, what);
  assert.deepEqual(check(t.v4PublicSign('not json', key, JSON.stringify({ kid: KID }))), inv);
});

test('expired, region, revoked — and C3 order between them', () => {
  const exp = { ok: false, why: 'expired', did: 'dev_phone1' };
  const tok = mint();
  assert.deepEqual(check(tok, auth(), RGN, NOW + 15 * 60_000), exp, 'at exp');
  assert.equal(check(tok, auth(), RGN, NOW + 15 * 60_000 - 1).ok, true, 'a millisecond before');
  assert.deepEqual(check(tok, auth(), 'net:198.51.0.0/16'), { ok: false, why: 'region', did: 'dev_phone1' });
  assert.deepEqual(check(tok, auth(), 'unknown'), { ok: false, why: 'region', did: 'dev_phone1' }, 'plain next start fails closed');
  assert.deepEqual(check(tok, auth({ kill_epoch: 4 })), { ok: false, why: 'revoked', did: 'dev_phone1' });
  assert.equal(check(mint({ kep: 5 }), auth({ kill_epoch: 4 })).ok, true, 'a newer epoch is fine');
  const denied = auth({ deny: [{ did: 'dev_phone1', until: NOW + 60_000 }] });
  assert.deepEqual(check(tok, denied), { ok: false, why: 'revoked', did: 'dev_phone1' });
  assert.equal(check(mint({ did: 'dev_other' }), denied).ok, true, 'someone else is not');
  assert.deepEqual(check(tok, auth({ deny: [{ did: 'dev_phone1', until: null }] })).why, 'revoked');
  assert.equal(check(tok, auth({ deny: [{ did: 'dev_phone1', until: NOW }] })).ok, true, 'an entry past its until');
  // order: invalid before expired; expired before region; region before revoked; kep before deny
  const late = NOW + 16 * 60_000;
  assert.equal(check(tok, auth({ keys: [] }), 'elsewhere', late).why, 'invalid');
  assert.equal(check(tok, auth({ kill_epoch: 9 }), 'elsewhere', late).why, 'expired');
  assert.equal(check(tok, auth({ kill_epoch: 9 }), 'elsewhere').why, 'region');
  assert.equal(check(tok, { ...denied, kill_epoch: 9 }).why, 'revoked');
});

test('REAUTH: expired/region → refresh, the rest → login', () => {
  assert.deepEqual(t.REAUTH, { expired: 'refresh', region: 'refresh', missing: 'login', invalid: 'login', revoked: 'login' });
});

test('deviceStanding: the voice sweep’s question', () => {
  assert.equal(t.deviceStanding('dev_a', 3, auth()), true);
  assert.equal(t.deviceStanding('dev_a', 2, auth()), false);
  assert.equal(t.deviceStanding('dev_a', 3, auth({ deny: [{ did: 'dev_a', until: null }] })), false);
});

// ── trunk-state.json (C5) ─────────────────────────────────────────────────────────────────────────
const C5 = (over = {}) => ({
  version: 1,
  trunk: { url: 'https://ljoolq.veraldar.org', trunk_id: 'trk_1', trunk_key: 'x' },
  root: { id: 'rt_1', name: 'omarchy' },
  link: { state: 'up', since: 1764100000000, written: 1764100005000 },
  keys: [{ kid: KID, alg: 'ed25519', public: raw.toString('base64url'), retired_at: null }],
  kill_epoch: 3,
  lockdown: false,
  deny: [{ did: 'dev_gone', until: 1764100900000 }],
  directory: { seq: 7, issued_at: 1764100000000, sig: 's', roots: [] },
  vapid_public: null,
  ...over,
});

test('parseState: C5 as written by the bridge; foreign or broken files are not a state', () => {
  const s = t.parseState(JSON.stringify(C5()));
  assert.equal(s.keys.length, 1);
  assert.equal(s.kill_epoch, 3);
  assert.deepEqual(s.deny, [{ did: 'dev_gone', until: 1764100900000 }]);
  assert.equal(s.root.name, 'omarchy', 'other readers’ fields ride along');
  assert.equal(t.parseState(JSON.stringify(C5({ version: 2 }))), null);
  assert.equal(t.parseState(JSON.stringify(C5({ kill_epoch: -1 }))), null);
  assert.equal(t.parseState(JSON.stringify(C5({ keys: 'k' }))), null);
  assert.equal(t.parseState(JSON.stringify(C5({ deny: [{ until: 1 }] }))), null, 'an unreadable deny entry');
  assert.equal(t.parseState('{"version":1'), null);
  // a key whose kid is not its own is dropped (the footer could not name it honestly)
  const bad = t.parseState(JSON.stringify(C5({ keys: [{ kid: 'k_AAAAAAAAAAAAAAAA', alg: 'ed25519', public: raw.toString('base64url'), retired_at: null }] })));
  assert.equal(bad.keys.length, 0);
});

test('trunkState: re-read on a new stamp only; missing → fail closed; a torn file keeps the last good', () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'trunk-state-'));
  const file = path.join(dir, 'trunk-state.json');
  const write = (obj) => {
    writeFileSync(`${file}.tmp`, typeof obj === 'string' ? obj : JSON.stringify(obj));
    renameSync(`${file}.tmp`, file); // the bridge's atomic rename
  };
  let now = 1_000_000;
  const at = (dt) => t.trunkState(file, (now += dt));
  try {
    assert.equal(at(1000), null, 'no file yet');
    write(C5());
    assert.equal(at(1000).kill_epoch, 3);
    write(C5({ kill_epoch: 4 }));
    assert.equal(at(t.STATE_CHECK_MS - 1)?.kill_epoch, 3, 'not looked at again within the check interval');
    assert.equal(at(1).kill_epoch, 4, 'the new file, once the interval passed');
    write('{"version":1,"keys":[');
    assert.equal(at(1000).kill_epoch, 4, 'a torn write keeps the last good state');
    write(C5({ kill_epoch: 6 }));
    assert.equal(at(1000).kill_epoch, 6);
    rmSync(file);
    assert.equal(at(1000), null, 'the file gone: no keys, nothing verifies');
    // checkTrunkAccess reads BIFROST_TRUNK_STATE
    write(C5());
    process.env.BIFROST_TRUNK_STATE = file;
    assert.equal(t.checkTrunkAccess(mint(), RGN, NOW + 1000).ok, true);
    assert.equal(t.checkTrunkAccess(mint(), RGN, NOW + 1000).ok, true);
  } finally {
    delete process.env.BIFROST_TRUNK_STATE;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the shared vectors (IDP stream writes them; the Rust verifier runs the same file) ────────────────
const SHARED = new URL('../../docs/trunk-v1/vectors/paseto.json', import.meta.url);
test('shared vectors docs/trunk-v1/vectors/paseto.json', { skip: !existsSync(SHARED) && 'not written yet (IDP stream)' }, () => {
  const v = JSON.parse(readFileSync(SHARED, 'utf8'));
  const pubRaw = Buffer.from(v.keypair?.public ?? v.public_key ?? v.public, 'base64url');
  const kid = t.kidOf(pubRaw);
  if (v.footer) assert.deepEqual(typeof v.footer === 'string' ? JSON.parse(v.footer) : v.footer, { kid });
  const a = {
    keys: [{ kid, alg: 'ed25519', public: pubRaw.toString('base64url'), retired_at: null }],
    kill_epoch: 0,
    deny: [],
    ...(v.state || {}),
  };
  const ok = t.v4PublicVerify(v.token, t.publicKeyFromRaw(pubRaw));
  assert.ok(ok, 'the vector token verifies');
  if (v.claims) assert.deepEqual(JSON.parse(ok.message), v.claims);
  for (const c of v.cases || []) {
    const st = { ...a, ...(c.state || {}) };
    const now = c.now !== undefined ? (typeof c.now === 'number' ? c.now : Date.parse(c.now)) : Date.parse(v.claims?.iat ?? '') + 1000;
    const got = t.checkToken(c.token ?? v.token, st, c.region ?? v.claims?.rgn, now);
    assert.equal(got.ok ? 'ok' : got.why, c.why ?? 'ok', c.name);
    if (!got.ok && c.reauth) assert.equal(t.REAUTH[got.why], c.reauth, c.name);
  }
});
