/**
 * v1 access tokens — the root app's verifier for BIFROST_AUTH=trunk (spec §5.4, contract C3).
 *
 * The trunk signs every device's access token as PASETO v4.public (Ed25519); this root never holds a
 * secret of the trunk's, only the public keys its bridge writes to `trunk-state.json` (C5,
 * BIFROST_TRUNK_STATE). Verified here with node:crypto alone (no new dependency).
 *
 *   token   v4.public.<b64url(msg || sig)>.<b64url(footer)>     implicit assertion: empty
 *   payload {iss, sub: acc_…, did: dev_…, role: admin|member, rgn, kep, iat, exp, jti}   (exactly these)
 *   footer  {"kid":"k_<first 16 b64url chars of sha256(public key)>"}
 *
 * Every verifier (trunk, this app, the bridge offline) runs the same checks in the same order and
 * answers the same `why` (C3):
 *   no token                                          → missing
 *   signature with a non-retired kid from keys[]      → invalid   (any malformed token or claim too)
 *   exp passed                                        → expired
 *   rgn ≠ region of the request's real client address → region
 *   kep < kill_epoch                                  → revoked
 *   did in deny[]                                     → revoked
 * 401 body {why, reauth}: expired/region → refresh (POST /t/auth/refresh), everything else → login.
 *
 * Pure: no app alias imports, so the twin's seeder (sim/acceptance/trunk-seed.mjs) and the unit tests
 * load this very file. The request's region is the caller's (lib/region.ts regionOfReq).
 */
import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export type Why = 'missing' | 'invalid' | 'expired' | 'region' | 'revoked';
export type Reauth = 'refresh' | 'login';

export const REAUTH: Record<Why, Reauth> = {
  expired: 'refresh',
  region: 'refresh',
  missing: 'login',
  invalid: 'login',
  revoked: 'login',
};

export type Claims = {
  iss: string;
  sub: string;
  did: string;
  role: 'admin' | 'member';
  rgn: string;
  kep: number;
  iat: string;
  exp: string;
  jti: string;
};

export type TrunkKey = { kid: string; alg: 'ed25519'; public: string; retired_at: number | null };
export type DenyEntry = { did: string; until: number | null };

/** What a verifier needs from trunk-state.json: the keys, the kill epoch, the deny-list, the issuers. */
export type Authority = {
  keys: TrunkKey[];
  kill_epoch: number;
  deny: DenyEntry[];
  /**
   * Every origin a valid token's `iss` may be (the trunk mints with public_url and https://<extra
   * name>, C3). An old state file has none → `origin(trunk.url)` (state.rs backfills the same way);
   * no issuers at all (no state file) → nothing verifies.
   */
  issuers: string[];
};

/** C3: `iat` more than this many seconds in the future → invalid (clock skew allowance). */
export const IAT_SKEW_S = 60;

export type Verdict = { ok: true; claims: Claims } | { ok: false; why: Why; did?: string };

// ─── PASETO v4.public ────────────────────────────────────────────────────────────────────────────

const HEADER = 'v4.public.';
const SIG_LEN = 64;

/** base64url without padding, canonical only (Buffer's own decoder skips junk and odd tails). */
export function b64urlDecode(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const b = Buffer.from(s, 'base64url');
  return b.toString('base64url') === s ? b : null;
}

export const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

/** PASETO pre-authentication encoding: LE64(n) || Σ LE64(len(p)) || p (top bit of each LE64 clear). */
export function pae(pieces: Array<Buffer | Uint8Array>): Buffer {
  const le64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(n >>> 0, 0);
    b.writeUInt32LE(Math.floor(n / 0x100000000) & 0x7fffffff, 4);
    return b;
  };
  const out: Buffer[] = [le64(pieces.length)];
  for (const p of pieces) out.push(le64(p.length), Buffer.from(p));
  return Buffer.concat(out);
}

/** An Ed25519 public key from its raw 32 bytes. */
export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(raw) }, format: 'jwk' });
}

/** An Ed25519 secret key from its 32-byte seed (tests and the twin's seeder only: roots never sign). */
export function secretKeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  // PKCS#8 for Ed25519 = this fixed 16-byte prefix + the seed (RFC 8410)
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** The raw 32 bytes of an Ed25519 public key. */
export function rawPublic(key: KeyObject): Buffer {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return b64urlDecode(pub.export({ format: 'jwk' }).x as string)!;
}

/** C3's key id: `k_` + the first 16 b64url characters of sha256(raw public key). */
export function kidOf(rawPub: Buffer): string {
  return `k_${b64url(createHash('sha256').update(rawPub).digest()).slice(0, 16)}`;
}

type Parts = { body: Buffer; footer: Buffer };

/** The token's pieces, before any trust: null when it is not a well-formed v4.public token. */
export function parseV4Public(token: string): Parts | null {
  if (typeof token !== 'string' || !token.startsWith(HEADER)) return null;
  const rest = token.slice(HEADER.length).split('.');
  if (rest.length < 1 || rest.length > 2) return null;
  const body = b64urlDecode(rest[0]);
  if (!body || body.length < SIG_LEN) return null;
  let footer: Buffer = Buffer.alloc(0);
  if (rest.length === 2) {
    const f = b64urlDecode(rest[1]);
    if (!f || f.length === 0) return null; // an empty footer is written without its dot
    footer = f;
  }
  return { body, footer };
}

/** PASETO v4.public verify: the message, or null. `implicit` is the implicit assertion (C3: empty). */
export function v4PublicVerify(
  token: string,
  key: KeyObject,
  implicit: Buffer | string = ''
): { message: Buffer; footer: Buffer } | null {
  const p = parseV4Public(token);
  if (!p) return null;
  const message = p.body.subarray(0, p.body.length - SIG_LEN);
  const sig = p.body.subarray(p.body.length - SIG_LEN);
  const m2 = pae([Buffer.from(HEADER), message, p.footer, Buffer.from(implicit)]);
  let good = false;
  try {
    good = edVerify(null, m2, key, sig);
  } catch {
    good = false;
  }
  return good ? { message: Buffer.from(message), footer: p.footer } : null;
}

/** PASETO v4.public sign (tests and the twin's seeder: the trunk is the only real signer). */
export function v4PublicSign(
  message: Buffer | string,
  key: KeyObject,
  footer: Buffer | string = '',
  implicit: Buffer | string = ''
): string {
  const m = Buffer.from(message);
  const f = Buffer.from(footer);
  const sig = edSign(null, pae([Buffer.from(HEADER), m, f, Buffer.from(implicit)]), key);
  return `${HEADER}${b64url(Buffer.concat([m, sig]))}${f.length ? `.${b64url(f)}` : ''}`;
}

// ─── C3 claims ───────────────────────────────────────────────────────────────────────────────────

const CLAIM_KEYS = ['iss', 'sub', 'did', 'role', 'rgn', 'kep', 'iat', 'exp', 'jti'];
const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ID = (prefix: string) => new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,64}$`);
const ACC = ID('acc');
const DEV = ID('dev');

/** RFC 3339 `YYYY-MM-DDTHH:MM:SSZ` → unix ms, or NaN (a real calendar instant only). */
export function timeOf(s: string): number {
  if (!RFC3339_Z.test(s)) return Number.NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString().replace('.000Z', 'Z') === s ? t : Number.NaN;
}

/**
 * C3's origin, lowercased, as state.rs `origin_of` writes it: "https://host[:port]" (a scheme-less
 * url is taken as https; http survives, for a loopback twin trunk).
 */
export function originOf(url: string): string {
  const at = url.indexOf('://');
  let scheme = 'https';
  let rest = url;
  if (at > 0) {
    scheme = url.slice(0, at).toLowerCase();
    rest = url.slice(at + 3);
    if (scheme !== 'https' && scheme !== 'http') {
      return `https://${rest}`;
    }
  }
  const host = rest.split(/[/?#]/, 1)[0].toLowerCase();
  return `${scheme}://${host}`;
}

/** The payload as C3 claims, or null: exactly C3's keys, each of its type. */
export function claimsOf(message: Buffer): Claims | null {
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(message.toString('utf8'));
  } catch {
    return null;
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const keys = Object.keys(c);
  if (keys.length !== CLAIM_KEYS.length || !CLAIM_KEYS.every((k) => keys.includes(k))) return null;
  const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : null);
  const jti = b64urlDecode(s('jti') ?? '!');
  if (
    !s('iss') ||
    !ACC.test(s('sub') ?? '') ||
    !DEV.test(s('did') ?? '') ||
    (c.role !== 'admin' && c.role !== 'member') ||
    !s('rgn') ||
    !Number.isSafeInteger(c.kep) ||
    (c.kep as number) < 0 ||
    Number.isNaN(timeOf(s('iat') ?? '')) ||
    Number.isNaN(timeOf(s('exp') ?? '')) ||
    !jti ||
    jti.length !== 16
  )
    return null;
  return c as unknown as Claims;
}

/** The footer's kid (read before trust: it only picks which key to try). */
export function footerKid(footer: Buffer): string | null {
  try {
    const f = JSON.parse(footer.toString('utf8'));
    return f && typeof f === 'object' && typeof f.kid === 'string' ? f.kid : null;
  } catch {
    return null;
  }
}

/** A key is usable while it has no retirement time, or that time has not come yet. */
const live = (k: TrunkKey, now: number) => k.retired_at === null || k.retired_at > now;

/**
 * C3, in C3's order. `region` is the region class of the request's real client address
 * (lib/region.ts regionOfReq — 'unknown' when no stamped peer, which no token carries: fails closed).
 */
export function checkToken(raw: string, auth: Authority, region: string, now = Date.now()): Verdict {
  const token = (raw || '').trim();
  if (!token) return { ok: false, why: 'missing' };
  const parts = parseV4Public(token);
  if (!parts) return { ok: false, why: 'invalid' };
  const kid = footerKid(parts.footer);
  const key = kid ? auth.keys.find((k) => k.kid === kid && live(k, now)) : undefined;
  if (!key) return { ok: false, why: 'invalid' };
  const pub = keyObject(key);
  const v = pub && v4PublicVerify(token, pub);
  if (!v) return { ok: false, why: 'invalid' };
  const claims = claimsOf(v.message);
  if (!claims) return { ok: false, why: 'invalid' };
  const did = claims.did;
  // the trunk's own issuers only, and no token from the future (more than 60 s of clock skew) —
  // both invalid, before any time or region judgment (C3 M3: iss, iat)
  if (!auth.issuers.some((o) => o.toLowerCase() === claims.iss.toLowerCase())) {
    return { ok: false, why: 'invalid' };
  }
  if (timeOf(claims.iat) > now + IAT_SKEW_S * 1000) return { ok: false, why: 'invalid' };
  if (now >= timeOf(claims.exp)) return { ok: false, why: 'expired', did };
  if (claims.rgn !== region) return { ok: false, why: 'region', did };
  if (claims.kep < auth.kill_epoch) return { ok: false, why: 'revoked', did };
  if (auth.deny.some((d) => d.did === did && (d.until === null || d.until > now)))
    return { ok: false, why: 'revoked', did };
  return { ok: true, claims };
}

/** Is a device still in good standing (the voice sweep, lib/voice-revoke.ts)? Its token's kill epoch. */
export function deviceStanding(did: string, kep: number, auth: Authority, now = Date.now()): boolean {
  if (kep < auth.kill_epoch) return false;
  return !auth.deny.some((d) => d.did === did && (d.until === null || d.until > now));
}

const keyCache = new Map<string, KeyObject | null>();
function keyObject(k: TrunkKey): KeyObject | null {
  let o = keyCache.get(k.public);
  if (o === undefined) {
    const raw = b64urlDecode(k.public);
    try {
      o = raw && raw.length === 32 ? publicKeyFromRaw(raw) : null;
    } catch {
      o = null;
    }
    if (keyCache.size > 64) keyCache.clear();
    keyCache.set(k.public, o);
  }
  return o;
}

// ─── trunk-state.json (C5) ───────────────────────────────────────────────────────────────────────

/** The whole C5 file as parsed (other readers' fields kept: directory, link, …). */
export type TrunkState = Authority & {
  version: 1;
  trunk?: { url?: string; trunk_id?: string; trunk_key?: string; issuers?: string[] };
  root?: { id?: string; name?: string };
  link?: { state?: string; since?: number; written?: number };
  lockdown?: boolean;
  directory?: unknown;
  vapid_public?: string | null;
};

const EMPTY: Authority = { keys: [], kill_epoch: 0, deny: [], issuers: [] };

const isMs = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * C5 → the verifier's view, or null when the file is not a C5 state. Keys whose kid does not match
 * their public key are dropped (the footer's kid must name the key it was signed with). Issuers:
 * `trunk.issuers[]` when the file has them, else `origin(trunk.url)` (state.rs backfills the same
 * way for an old file); neither in the file → none (nothing verifies).
 */
export function parseState(text: string): TrunkState | null {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(text);
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object' || s.version !== 1) return null;
  if (!Array.isArray(s.keys) || !Array.isArray(s.deny)) return null;
  if (!Number.isSafeInteger(s.kill_epoch) || (s.kill_epoch as number) < 0) return null;
  const keys: TrunkKey[] = [];
  for (const k of s.keys as Array<Record<string, unknown>>) {
    if (!k || k.alg !== 'ed25519' || typeof k.kid !== 'string' || typeof k.public !== 'string') continue;
    const raw = b64urlDecode(k.public);
    if (!raw || raw.length !== 32 || kidOf(raw) !== k.kid) continue;
    const retired = k.retired_at ?? null;
    if (retired !== null && !isMs(retired)) continue;
    keys.push({ kid: k.kid, alg: 'ed25519', public: k.public, retired_at: retired as number | null });
  }
  const deny: DenyEntry[] = [];
  for (const d of s.deny as Array<Record<string, unknown>>) {
    if (!d || typeof d.did !== 'string') return null; // a deny-list we cannot read is not skipped
    const until = d.until ?? null;
    deny.push({ did: d.did, until: until === null || isMs(until) ? (until as number | null) : null });
  }
  const trunk = (s.trunk ?? {}) as { url?: unknown; issuers?: unknown };
  let issuers: string[] = [];
  if (Array.isArray(trunk.issuers)) {
    issuers = trunk.issuers.filter((o): o is string => typeof o === 'string' && o.length > 0);
  } else if (typeof trunk.url === 'string' && trunk.url) {
    issuers = [originOf(trunk.url)];
  }
  return { ...(s as object), version: 1, keys, kill_epoch: s.kill_epoch as number, deny, issuers } as TrunkState;
}

type Cache = { path: string; checked: number; stamp: string; state: TrunkState | null };
// one cache per process, whichever module instance (middleware bundle, route bundle) asks
const g = globalThis as unknown as { __bifrostTrunkState?: Cache };

/** How often the file's stamp is looked at (a stat, never a read): revocation lands within this. */
export const STATE_CHECK_MS = Number(process.env.BIFROST_TRUNK_STATE_CHECK_MS) || 100;

/**
 * The bridge's trunk-state.json (BIFROST_TRUNK_STATE), re-read only when its stamp (inode, mtime,
 * size) changes — the bridge replaces it by an atomic rename, at least every 10 s. Missing or not a
 * C5 file: no keys (every token `invalid`, fail closed); a file that turns unreadable after a good
 * one keeps the good one (a torn write cannot unlock anything: it never grants more than the last).
 */
export function trunkState(path = process.env.BIFROST_TRUNK_STATE || '', now = Date.now()): TrunkState | null {
  let c = g.__bifrostTrunkState;
  if (!c || c.path !== path) c = g.__bifrostTrunkState = { path, checked: 0, stamp: '', state: null };
  if (now - c.checked < STATE_CHECK_MS && c.checked) return c.state;
  c.checked = now;
  if (!path) return (c.state = null);
  let stamp = '';
  try {
    const st = statSync(path);
    stamp = `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    c.stamp = '';
    return (c.state = null);
  }
  if (stamp === c.stamp) return c.state;
  try {
    const parsed = parseState(readFileSync(path, 'utf8'));
    if (parsed || !c.state) c.state = parsed;
    c.stamp = stamp;
  } catch {
    /* unreadable this instant: keep what we had, look again next time */
  }
  return c.state;
}

/** The authority now in force (empty when there is no state: nothing verifies). */
export const authority = (now = Date.now()): Authority => trunkState(undefined, now) ?? EMPTY;

/** C3 against the live trunk-state.json. */
export const checkTrunkAccess = (raw: string, region: string, now = Date.now()): Verdict =>
  checkToken(raw, authority(now), region, now);

// ─── minting (the twin's seeder and tests only) ─────────────────────────────────────────────────

/** RFC 3339 with second precision and `Z`, as C3 writes times. */
export const rfc3339 = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** A C3 token signed by `key`. Defaults: a 15 min life from `now`. */
export function mintToken(
  key: KeyObject,
  claims: Partial<Claims> & Pick<Claims, 'did' | 'rgn'>,
  opts: { now?: number; lifeMs?: number; kid?: string } = {}
): string {
  const now = opts.now ?? Date.now();
  const full: Claims = {
    iss: claims.iss ?? 'https://trunk.invalid',
    sub: claims.sub ?? 'acc_test',
    did: claims.did,
    role: claims.role ?? 'admin',
    rgn: claims.rgn,
    kep: claims.kep ?? 0,
    iat: claims.iat ?? rfc3339(now),
    exp: claims.exp ?? rfc3339(now + (opts.lifeMs ?? 15 * 60_000)),
    jti: claims.jti ?? b64url(randomBytes(16)),
  };
  const kid = opts.kid ?? kidOf(rawPublic(key));
  return v4PublicSign(JSON.stringify(full), key, JSON.stringify({ kid }));
}

/** Default issuers for a minted test authority: the iss mintToken itself defaults to. */
export const TEST_ISSUERS = ['https://trunk.invalid'];
