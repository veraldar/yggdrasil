/**
 * Join a new machine to this hub's tree (contract v1 — docs/spec-join.md).
 *
 * The joining machine (root/install/join.sh) POSTs a join request and shows
 * the approve URL as a QR plus a human code; the owner scans it with an
 * already-paired phone and approves. Approval:
 *   - assigns a root id (a unique slug of the name — never `local`/`join`,
 *     never an id any device allowlist already names),
 *   - mints link tokens with the trunk's own CLI (`bifrost-net rootlink
 *     mint`, so the capsule format can never drift from the bridge's opener):
 *     dev claim = the approving device, roots claim = [root id],
 *   - creates the root's long-lived credential (only its sha256 is stored, in
 *     the roots registry next to devices.json, mode 600),
 *   - adds the root to the APPROVING device's allowlist in devices.json,
 *   - holds the raw result in this process's memory until the joiner collects
 *     it ONCE with its join secret. The result names the hub brain (`hub`: its
 *     root name, asked of the brain), so the joined root's reports find home.
 *   - PINS the machine's WireGuard public key (`wg_pub`, sent with the join;
 *     the approve page shows its fingerprint next to the code, so approving the
 *     code pins the key): roots.json gets `wg_pub` + a tunnel address `wg_ip`
 *     from this tree's own small range (`wg.net`, a random 10.x.y.0/24 chosen at
 *     the first such approval), and the result hands back the hub's public key
 *     (BIFROST_WG_PUB_FILE) and the addresses. The hub's WireGuard node
 *     (bifrost-net wg, trunk/src/wg.rs) reads roots.json: brain calls between
 *     roots ride that tunnel; the bridge and the access point see ciphertext.
 *
 * At rest: hashes only (join secret, root secret). Raw link tokens and the
 * raw root secret exist only in memory between approval and the one
 * collection, then are dropped. Pending joins are also written to
 * joins-pending.json beside roots.json (mode 600, atomic, without the raw
 * result): an app restart keeps a pending join approvable for 10 minutes; an
 * approval made before the restart and not yet collected is over (its raw
 * result never touched the disk) and the machine runs join again.
 *
 * Removing a root (the roots sheet's hold): roots.json marks it `revoked`
 * (the trunk's WireGuard node drops it, refill refuses it, its id is never
 * handed out again) and the hub brain forgets it (DELETE /root/peers/<id>).
 *
 * Env: BIFROST_ROOTS_FILE (default: roots.json beside BIFROST_DEVICES_FILE),
 * BIFROST_NET_BIN (default `bifrost-net` on PATH), BIFROST_ROOTLINK_SECRET_FILE
 * or BIFROST_BRIDGE_CONFIG (its `root_link_secret`), BIFROST_ROOTLINK_URL,
 * YGG_PEER_TOKEN, BIFROST_PUBLIC_URL, OPENCODE_URL (the hub brain: its GET /root
 * names it) or YGG_ROOT_NAME, BIFROST_WG_PUB_FILE (the hub node's public key); tuning BIFROST_JOIN_TTL_S (600),
 * BIFROST_JOIN_LIMIT / BIFROST_JOIN_WINDOW_S (5 per 600 s per client address),
 * BIFROST_ROOT_REFILL_LIMIT / BIFROST_ROOT_REFILL_WINDOW_S (6 per 3600 s per root).
 */
import { execFile } from 'child_process';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { chmod, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fetch as undiciFetch } from 'undici';
import { promisify } from 'util';
import { addDeviceRoot, allowlistedRoots, listDevices } from '@/lib/devices';
import { OC } from '@/lib/oc';
import { clientKey } from '@/lib/region';

const run = promisify(execFile);

const DEVICES_FILE = process.env.BIFROST_DEVICES_FILE || '.devices.json';
export const ROOTS_FILE =
  process.env.BIFROST_ROOTS_FILE || join(dirname(DEVICES_FILE), 'roots.json');
const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
export const JOIN_TTL_S = num(process.env.BIFROST_JOIN_TTL_S, 600);
export const LINK_TOKENS_PER_BATCH = 20;
const JOIN_LIMIT = num(process.env.BIFROST_JOIN_LIMIT, 5);
/** pending joins held at once, all clients together (memory stays bounded) */
const JOIN_MAX_PENDING = num(process.env.BIFROST_JOIN_MAX_PENDING, 32);
const JOIN_WINDOW_MS = num(process.env.BIFROST_JOIN_WINDOW_S, 600) * 1000;
const REFILL_LIMIT = num(process.env.BIFROST_ROOT_REFILL_LIMIT, 6);
const REFILL_WINDOW_MS = num(process.env.BIFROST_ROOT_REFILL_WINDOW_S, 3600) * 1000;
/** ids a joined root can never take: the hub itself, and the route segment */
const RESERVED = new Set(['local', 'join']);

export const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && x.length === y.length && timingSafeEqual(x, y);
}

/* ---------------- memory: pending joins, rate windows, write chain ---------------- */

export type JoinStatus = 'pending' | 'approved' | 'refused' | 'expired' | 'delivered';

/** what a joined root needs for its WireGuard node (absent: the hub runs none) */
export type WgGrant = {
  /** the hub node's public key — the joined root's one static peer, `local` */
  public_key: string;
  hub_ip: string;
  /** this root's tunnel address and the tree's range */
  ip: string;
  net: string;
};

export type Approved = {
  root_id: string;
  root_secret: string;
  link_tokens: string[];
  rootlink_url: string;
  peer_token: string;
  /** the hub brain's root name: the joined root's peer for it (YGG_PEERS <hub>=…/local) */
  hub: string;
  wg?: WgGrant;
  /** 'home': the home brain will hand this root its model settings (GET /_wg/local/root/model) */
  model?: 'home';
};

type JoinReq = {
  req: string;
  secretHash: string;
  code: string;
  name: string;
  os: string;
  host: string;
  peer: string;
  /** the machine's WireGuard public key (base64), pinned by the approval */
  wgPub?: string;
  /** "Same as the home root": the machine asks for the home root's model settings (L15) */
  model?: 'home';
  /** public approve link (no secrets) so a second origin (e.g. :8447 tailnet) can hand off to the paired door */
  approveUrl?: string;
  created: number;
  exp: number;
  status: 'pending' | 'approved' | 'refused' | 'delivered';
  by?: string;
  root_id?: string;
  /** the raw result — memory only, dropped on collection or at holdUntil */
  result?: Approved;
  holdUntil?: number;
  why?: string;
};

type State = {
  joins: Map<string, JoinReq>;
  windows: Map<string, number[]>;
  chain: Promise<unknown>;
  /** joins-pending.json was read (and its last seen mtime, so a sibling process sees writes) */
  loaded?: boolean;
  loadedMtime?: number;
};

// globalThis: every route bundle in this one server process sees ONE store
const g = globalThis as { __bifrostJoin?: State };
const S: State = (g.__bifrostJoin ??= {
  joins: new Map(),
  windows: new Map(),
  chain: Promise.resolve(),
});

/** Sliding-window limit: at most `limit` hits per `windowMs` for `key`. */
export function windowTake(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const hits = (S.windows.get(key) ?? []).filter((t) => t > now - windowMs);
  if (S.windows.size > 10_000 && !S.windows.has(key)) S.windows.clear();
  if (hits.length >= limit) {
    S.windows.set(key, hits);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)) };
  }
  hits.push(now);
  S.windows.set(key, hits);
  return { ok: true, retryAfter: 0 };
}

export const joinLimit = (peer: string) =>
  windowTake(`join:${clientKey(peer) || 'unknown'}`, JOIN_LIMIT, JOIN_WINDOW_MS);
export const refillLimit = (root: string) =>
  windowTake(`refill:${root}`, REFILL_LIMIT, REFILL_WINDOW_MS);

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const out = S.chain.then(fn);
  S.chain = out.catch(() => {});
  return out;
}

/* ---------------- pending joins on disk (joins-pending.json, mode 600) ---------------- */

export const JOINS_FILE = join(dirname(ROOTS_FILE), 'joins-pending.json');
/** how long a join lingers after exp/holdUntil (for honest 410s and in-place renewal across restarts) */
const JOIN_LINGER_MS = 3600_000;
const JOIN_STATES = new Set(['pending', 'approved', 'refused', 'delivered']);

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const httpUrl = (v: unknown) => {
  const s = str(v);
  return /^https?:\/\/\S+$/.test(s) ? s : '';
};
const joinLiveOnDisk = (j: JoinReq, now: number) =>
  Math.max(j.exp, j.holdUntil ?? 0) >= now - JOIN_LINGER_MS;

/** one record off the disk, or null when it is not one this module wrote */
function joinOf(v: unknown): JoinReq | null {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const req = str(o.req);
  const secretHash = str(o.secretHash);
  const created = Number(o.created);
  const exp = Number(o.exp);
  if (
    !/^[A-Za-z0-9_-]{16,64}$/.test(req) ||
    !/^[0-9a-f]{64}$/.test(secretHash) ||
    !JOIN_STATES.has(str(o.status)) ||
    !(created > 0) ||
    !(exp > 0)
  ) {
    return null;
  }
  const holdUntil = Number(o.holdUntil);
  const approveUrl = httpUrl(o.approveUrl);
  return {
    req,
    secretHash,
    code: str(o.code),
    name: str(o.name),
    os: str(o.os),
    host: str(o.host),
    peer: str(o.peer),
    ...(wgKey(o.wgPub) ? { wgPub: wgKey(o.wgPub) } : {}),
    ...(o.model === 'home' ? { model: 'home' as const } : {}),
    ...(approveUrl ? { approveUrl } : {}),
    created,
    exp,
    status: o.status as JoinReq['status'],
    ...(str(o.by) ? { by: str(o.by) } : {}),
    ...(str(o.root_id) ? { root_id: str(o.root_id) } : {}),
    ...(holdUntil > 0 ? { holdUntil } : {}),
    ...(str(o.why) ? { why: str(o.why) } : {}),
  };
}

/** Sync from joins-pending.json at startup and whenever another process updates it (e.g. hub-app
 *  writing joins that hub-app-tailnet lists). Never clobbers live in-memory approval secrets. */
function loadJoins() {
  let mtime = 0;
  try {
    mtime = statSync(JOINS_FILE).mtimeMs;
  } catch {
    S.loaded = true;
    return; // none yet, or unreadable
  }
  if (S.loaded && S.loadedMtime === mtime) return;
  const firstLoad = !S.loaded;
  let list: unknown;
  try {
    list = (JSON.parse(readFileSync(JOINS_FILE, 'utf8')) as { joins?: unknown })?.joins;
  } catch {
    return;
  }
  S.loaded = true;
  S.loadedMtime = mtime;
  if (!Array.isArray(list)) return;
  const now = Date.now();
  const seen = new Set<string>();
  for (const v of list) {
    const j = joinOf(v);
    if (!j || !joinLiveOnDisk(j, now)) continue;
    seen.add(j.req);
    const cur = S.joins.get(j.req);
    if (!cur) {
      // approved before a restart, not collected: the raw result was memory only
      if (firstLoad && j.status === 'approved') j.why = 'undelivered';
      S.joins.set(j.req, j);
    } else if (
      !cur.result &&
      (j.created > cur.created ||
        j.exp > cur.exp ||
        j.status !== cur.status ||
        j.secretHash !== cur.secretHash)
    ) {
      S.joins.set(j.req, j);
    }
  }
  if (!firstLoad) {
    for (const [k, cur] of S.joins) {
      if (!seen.has(k) && !cur.result && cur.created < mtime - 2000) S.joins.delete(k);
    }
  }
}

/** Write the joins (never `result`) — atomic, mode 600. Call directly inside `serialize(...)`
 *  so mutations hit disk before HTTP 200 returns; outside `serialize`, use `saveJoins()`. */
async function writeJoins() {
  try {
    const now = Date.now();
    const joins = [...S.joins.values()]
      .filter((j) => joinLiveOnDisk(j, now))
      .map((j) => ({ ...j, result: undefined })); // the raw secrets: memory only
    const tmp = `${JOINS_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, joins }, null, 2) + '\n', { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, JOINS_FILE);
    try {
      S.loadedMtime = statSync(JOINS_FILE).mtimeMs;
    } catch {
      /* ignore */
    }
  } catch (e) {
    console.warn(`join: ${JOINS_FILE} not written: ${(e as Error).message}`);
  }
}

function saveJoins() {
  void serialize(writeJoins);
}

function prune() {
  loadJoins();
  const now = Date.now();
  for (const [k, j] of S.joins) {
    // an undelivered approval is dropped after its hold window (raw secrets
    // never outlive it); every record lingers an hour so a late poll gets an
    // honest 410 instead of a 404 (and a renewing rig keeps the same req id)
    if (j.result && j.holdUntil && j.holdUntil < now) {
      j.result = undefined;
      j.why = 'undelivered';
    }
    if (Math.max(j.exp, j.holdUntil ?? 0) < now - JOIN_LINGER_MS) S.joins.delete(k);
  }
}

/* ---------------- the roots registry (hashes only, mode 600) ---------------- */

export type RootRecord = {
  id: string;
  name: string;
  os: string;
  host: string;
  joined_at: string;
  /** the device that approved it — the dev claim of every link token */
  dev: string;
  secretHash: string;
  /** when the machine collected its credentials (null: never collected) */
  delivered_at: string | null;
  /** its pinned WireGuard public key and tunnel address (roots that joined with one) */
  wg_pub?: string;
  wg_ip?: string;
  /** approved with "Same as the home root": the home brain hands it its model settings, inside
   *  the tunnel only (the brain's GET /root/model) */
  share_model?: boolean;
  /** removed from the tree (the roots sheet): the trunk drops it, refill refuses it, its id stays taken */
  revoked?: boolean;
  revoked_at?: string;
};

/** `wg.net`: this tree's tunnel range, chosen once (the hub's node takes .1) */
type RootsFile = { version: 1; wg?: { net: string }; roots: RootRecord[] };

async function readRoots(): Promise<RootsFile> {
  try {
    const parsed = JSON.parse(await readFile(ROOTS_FILE, 'utf8'));
    const net = typeof parsed?.wg?.net === 'string' ? parsed.wg.net : '';
    return {
      version: 1,
      ...(net ? { wg: { net } } : {}),
      roots: Array.isArray(parsed.roots) ? parsed.roots : [],
    };
  } catch {
    return { version: 1, roots: [] };
  }
}

/* ---------------- WireGuard: the joiner's key, pinned on approval ---------------- */

/** a canonical base64 WireGuard public key (32 bytes), or '' */
export function wgKey(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(v.trim())) return '';
  const b = Buffer.from(v.trim(), 'base64');
  return b.length === 32 && b.toString('base64') === v.trim() ? v.trim() : '';
}

/** The short fingerprint both screens show: sha256(raw key)[0..6], hex, `xxxx-xxxx-xxxx`
 *  (the same as `bifrost-net wg-key` and the joiner print). */
export function wgFingerprint(key: string): string {
  const h = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 12);
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

/** the hub node's public key (BIFROST_WG_PUB_FILE, written by `bifrost-net wg-key`), or '' */
async function hubWgKey(): Promise<string> {
  const file = process.env.BIFROST_WG_PUB_FILE;
  if (!file) return '';
  try {
    return wgKey((await readFile(file, 'utf8')).trim());
  } catch (e) {
    console.warn(`join: BIFROST_WG_PUB_FILE unreadable: ${(e as Error).message}`);
    return '';
  }
}

/** The tree's range (made once: a random 10.x.y.0/24) and the next free address in it. */
function wgAddress(f: RootsFile): { net: string; base: string; ip: string } | null {
  if (!f.wg?.net) {
    f.wg = { net: `10.${randomInt(16, 250)}.${randomInt(1, 255)}.0/24` };
  }
  const base = f.wg.net.split('/')[0].split('.').slice(0, 3).join('.');
  const used = new Set(f.roots.map((r) => r.wg_ip).filter(Boolean));
  for (let h = 2; h < 255; h++) {
    const ip = `${base}.${h}`;
    if (!used.has(ip)) return { net: f.wg.net, base, ip };
  }
  return null;
}

async function writeRoots(f: RootsFile): Promise<void> {
  const tmp = `${ROOTS_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, ROOTS_FILE);
}

/** The joined roots, removed ones left out. */
export async function listRoots() {
  const f = await readRoots();
  return f.roots
    .filter((r) => !r.revoked)
    .map(({ id, name, os, host, joined_at, delivered_at, wg_pub }) => ({
      id,
      name,
      os,
      host,
      joined_at,
      delivered_at: delivered_at ?? null,
      wg_fp: wg_pub ? wgFingerprint(wg_pub) : null,
    }));
}

export function rootIdFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'root';
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!RESERVED.has(id) && !taken.has(id)) return id;
  }
}

/** a root name a joined root can put in its YGG_PEERS (the joiner checks the same shape) */
export const ROOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The hub brain's root NAME, handed to the joiner as `hub`. The joined root
 * peers with the hub brain under this name, and the hub brain's sessions there
 * report home to it (`report_to.root` = the brain's YGG_ROOT_NAME), so it must
 * be the brain's own: asked of the brain (GET <OPENCODE_URL>/root → name), else
 * this app's YGG_ROOT_NAME, else "hub".
 */
/** Tells the home brain the owner approved `root` with "Same as the home root" (its
 *  POST /root/peers/<id>/model, this computer only). false: the brain did not take it. */
async function brainShareModel(root: string): Promise<boolean> {
  try {
    const r = await undiciFetch(`${OC}/root/peers/${encodeURIComponent(root)}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ share: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) return true;
    console.warn(`join: the brain did not take the model sharing for ${root}: ${r.status}`);
  } catch (e) {
    console.warn(
      `join: the brain did not take the model sharing for ${root}: ${(e as Error).message}`
    );
  }
  return false;
}

export async function hubBrainName(): Promise<string> {
  try {
    const r = await undiciFetch(`${OC}/root`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const name = ((await r.json()) as { name?: unknown } | null)?.name;
      if (typeof name === 'string' && ROOT_NAME.test(name)) return name;
      console.warn(`join: the hub brain's name ${JSON.stringify(name)} is not a plain root name`);
    }
  } catch {
    /* the brain is not answering: the env, then the default */
  }
  const env = (process.env.YGG_ROOT_NAME || '').trim();
  return ROOT_NAME.test(env) ? env : 'hub';
}

/* ---------------- minting: the trunk's own CLI ---------------- */

async function rootLinkSecret(): Promise<string> {
  const file = process.env.BIFROST_ROOTLINK_SECRET_FILE;
  if (file) return (await readFile(file, 'utf8')).trim();
  const cfg = process.env.BIFROST_BRIDGE_CONFIG;
  if (cfg) {
    const toml = await readFile(cfg, 'utf8');
    const m = toml.match(/^\s*root_link_secret\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/m);
    return (m?.[1] ?? m?.[2] ?? '').trim();
  }
  return '';
}

export class MintError extends Error {}

/** `n` single-use link tokens for `root`, dev claim `dev`, roots claim [root]. */
export async function mintLinkTokens(root: string, dev: string, n: number): Promise<string[]> {
  const bin = process.env.BIFROST_NET_BIN || 'bifrost-net';
  let secret = '';
  try {
    secret = await rootLinkSecret();
  } catch (e) {
    throw new MintError(`root-link secret unreadable: ${(e as Error).message}`);
  }
  if (!secret) {
    throw new MintError(
      'root-link minting is not configured: set BIFROST_ROOTLINK_SECRET_FILE or BIFROST_BRIDGE_CONFIG (root_link_secret)'
    );
  }
  const one = async () => {
    // execFile, no shell: no argument is ever interpreted
    const { stdout } = await run(
      bin,
      ['rootlink', 'mint', '--root', root, '--dev', dev, '--roots', root, '--secret', secret],
      // the child needs nothing from this process's env (no secret rides it)
      {
        timeout: 10_000,
        encoding: 'utf8',
        env: { PATH: process.env.PATH || '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv,
      }
    );
    const t = stdout.trim();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) throw new Error('unexpected mint output');
    return t;
  };
  const out: string[] = [];
  try {
    for (let i = 0; i < n; i += 5) {
      out.push(...(await Promise.all(Array.from({ length: Math.min(5, n - i) }, one))));
    }
  } catch (e) {
    throw new MintError(`${bin} rootlink mint failed: ${(e as Error).message.split('\n')[0]}`);
  }
  if (new Set(out).size !== out.length) throw new MintError('mint returned a duplicate token');
  return out;
}

/* ---------------- the join flow ---------------- */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
function humanCode(): string {
  const c = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${c.slice(0, 4).join('')}-${c.slice(4).join('')}`;
}

/** printable, single-line, bounded — these strings are shown to the owner */
const invisible = (c: number) =>
  c < 0x20 ||
  (c >= 0x7f && c <= 0x9f) ||
  (c >= 0x200b && c <= 0x200f) || // zero-width
  (c >= 0x202a && c <= 0x202e) || // bidi overrides
  (c >= 0x2066 && c <= 0x2069);
export function clean(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : '';
  return Array.from(s.replace(/\s+/g, ' '))
    .filter((ch) => !invisible(ch.codePointAt(0) ?? 0))
    .join('')
    .trim()
    .slice(0, max);
}

export function createJoin(
  input: {
    name: string;
    os: string;
    host: string;
    wgPub?: string;
    model?: 'home';
    approveBase?: string;
  },
  peer: string
) {
  prune();
  const now0 = Date.now();
  // In-place renewal: when the same rig re-asks (same WireGuard public key, or an expired
  // request from the same peer/name/host/os), refresh the existing pending record in place so
  // its req id, /join?r=<id> link, and comparison code stay stable across renewal cycles.
  let existing: JoinReq | undefined;
  for (const j of S.joins.values()) {
    if (j.status !== 'pending') continue;
    const sameRig = input.wgPub
      ? j.wgPub === input.wgPub
      : !j.wgPub &&
        j.peer === peer &&
        j.name === input.name &&
        j.host === input.host &&
        j.os === input.os &&
        j.exp <= now0;
    if (sameRig && (!existing || j.created > existing.created)) existing = j;
  }

  let pending = 0;
  for (const j of S.joins.values()) {
    if (j !== existing && j.status === 'pending' && j.exp > now0) pending += 1;
  }
  if (pending >= JOIN_MAX_PENDING) return null;

  const secret = randomBytes(16).toString('hex');
  const now = Date.now();
  if (existing) {
    existing.secretHash = sha256(secret);
    existing.name = input.name;
    existing.os = input.os;
    existing.host = input.host;
    existing.peer = peer;
    if (input.model === 'home') existing.model = 'home';
    else delete existing.model;
    if (input.approveBase) existing.approveUrl = `${input.approveBase}/join?r=${existing.req}`;
    existing.created = now;
    existing.exp = now + JOIN_TTL_S * 1000;
    saveJoins();
    return { req: existing.req, secret, code: existing.code, expires_in: JOIN_TTL_S };
  }

  const req = randomBytes(18).toString('base64url');
  const j: JoinReq = {
    req,
    secretHash: sha256(secret),
    code: humanCode(),
    name: input.name,
    os: input.os,
    host: input.host,
    peer,
    ...(input.wgPub ? { wgPub: input.wgPub } : {}),
    ...(input.model === 'home' ? { model: 'home' as const } : {}),
    ...(input.approveBase ? { approveUrl: `${input.approveBase}/join?r=${req}` } : {}),
    created: now,
    exp: now + JOIN_TTL_S * 1000,
    status: 'pending',
  };
  S.joins.set(req, j);
  saveJoins();
  return { req, secret, code: j.code, expires_in: JOIN_TTL_S };
}

function statusOf(j: JoinReq): JoinStatus {
  if (j.status === 'pending' && j.exp < Date.now()) return 'expired';
  if (j.status === 'approved' && !j.result) return 'expired';
  return j.status;
}

/** What the approving phone sees (no secrets). */
export function viewJoin(req: string) {
  prune();
  const j = S.joins.get(req);
  if (!j) return null;
  return {
    req: j.req,
    name: j.name,
    os: j.os,
    host: j.host,
    code: j.code,
    /** the fingerprint of the WireGuard key this approval pins (null: an older joiner) */
    wg_fp: j.wgPub ? wgFingerprint(j.wgPub) : null,
    /** 'home': approving it shares the home root's model, key included, with this machine */
    model: j.model ?? null,
    status: statusOf(j),
    expires_at: new Date(j.exp).toISOString(),
    root_id: j.root_id ?? null,
    ...(j.approveUrl ? { approve_url: j.approveUrl } : {}),
  };
}

/** The newest still-pending join per machine (by WireGuard key when present, else name) — what
 *  the roots sheet lists on both origins. No secrets. */
export function listPendingJoins(): NonNullable<ReturnType<typeof viewJoin>>[] {
  prune();
  const newest = new Map<string, JoinReq>();
  const now = Date.now();
  for (const j of S.joins.values()) {
    if (j.status !== 'pending' || j.exp < now) continue;
    const key = j.wgPub ? `wg:${j.wgPub}` : `name:${j.name}`;
    const old = newest.get(key);
    if (!old || j.created > old.created) newest.set(key, j);
  }
  return [...newest.values()]
    .sort((a, b) => b.created - a.created)
    .map((j) => viewJoin(j.req))
    .filter((v): v is NonNullable<ReturnType<typeof viewJoin>> => !!v);
}

export type PollOut =
  | { http: 404 | 401; body: { error: string } }
  | { http: 202; body: { status: 'pending' } }
  | { http: 410; body: { status: 'refused' | 'expired'; why?: string } }
  | { http: 200; body: { status: 'approved' } & Approved };

/** The joiner's poll: its join secret, the result ONCE, then 410. */
export function pollJoin(req: string, secret: string): Promise<PollOut> {
  return serialize(async () => {
    prune();
    const j = S.joins.get(req);
    if (!j) return { http: 404, body: { error: 'unknown join request' } };
    if (!/^[0-9a-f]{32}$/.test(secret) || !sameHash(sha256(secret), j.secretHash)) {
      return { http: 401, body: { error: 'bad join secret' } };
    }
    const st = statusOf(j);
    if (st === 'pending') return { http: 202, body: { status: 'pending' } };
    if (st === 'refused') return { http: 410, body: { status: 'refused' } };
    if (st === 'delivered') return { http: 410, body: { status: 'expired', why: 'delivered' } };
    if (st === 'expired' || !j.result) {
      return { http: 410, body: { status: 'expired', ...(j.why ? { why: j.why } : {}) } };
    }
    const result = j.result;
    j.result = undefined; // ONCE: the raw secrets leave memory with this response
    j.status = 'delivered';
    await writeJoins();
    const f = await readRoots();
    const rec = f.roots.find((r) => r.id === result.root_id);
    if (rec) {
      rec.delivered_at = new Date().toISOString();
      await writeRoots(f);
    }
    return { http: 200, body: { status: 'approved', ...result } };
  });
}

export type Decision =
  | { http: 200; body: Record<string, unknown> }
  | { http: 404 | 409 | 410 | 502 | 503; body: { error: string; status?: JoinStatus } };

export function refuseJoin(req: string, device: string): Promise<Decision> {
  return serialize(async () => {
    prune();
    const j = S.joins.get(req);
    if (!j) return { http: 404, body: { error: 'unknown join request' } };
    const st = statusOf(j);
    if (st === 'expired') return { http: 410, body: { error: 'join request expired', status: st } };
    if (st !== 'pending') return { http: 409, body: { error: `already ${st}`, status: st } };
    j.status = 'refused';
    j.by = device;
    await writeJoins();
    return { http: 200, body: { status: 'refused' } };
  });
}

export async function approveJoin(req: string, device: string): Promise<Decision> {
  // asked before the serialized section: a slow brain never holds up registry writes
  const hub = await hubBrainName();
  const hubKey = await hubWgKey();
  return serialize(async () => {
    prune();
    const j = S.joins.get(req);
    if (!j) return { http: 404, body: { error: 'unknown join request' } };
    const st = statusOf(j);
    if (st === 'expired') return { http: 410, body: { error: 'join request expired', status: st } };
    if (st !== 'pending') return { http: 409, body: { error: `already ${st}`, status: st } };

    const f = await readRoots();
    // the hub brain's own name is never a joined root's id (it would be its own peer)
    const taken = new Set([
      ...f.roots.map((r) => r.id),
      ...(await allowlistedRoots()),
      hub,
      hub.toLowerCase(),
    ]);
    const root_id = rootIdFor(j.name || j.host, taken);
    // a key pins ONE root: the hub's node could not tell two roots with it apart
    const twin = j.wgPub ? f.roots.find((r) => r.wg_pub === j.wgPub) : undefined;
    if (twin) {
      return {
        http: 409,
        body: { error: `this machine's WireGuard key is already pinned to root ${twin.id}` },
      };
    }
    const addr = j.wgPub ? wgAddress(f) : null;
    // the settings travel inside WireGuard only: a machine with no tunnel key cannot be handed them
    const shareModel = j.model === 'home' && !!j.wgPub && !!addr;
    if (j.wgPub && !addr) {
      return { http: 503, body: { error: "the tree's tunnel range is full" } };
    }

    // mint first: it has no side effects, so a misconfigured hub leaves the
    // request pending and the owner can approve again once it is fixed
    let link_tokens: string[];
    try {
      link_tokens = await mintLinkTokens(root_id, device, LINK_TOKENS_PER_BATCH);
    } catch (e) {
      const msg = e instanceof MintError ? e.message : 'link-token mint failed';
      console.error(`join ${req}: ${msg}`);
      return { http: 503, body: { error: msg } };
    }

    const root_secret = randomBytes(16).toString('hex');
    const now = new Date();
    f.roots.push({
      id: root_id,
      name: j.name,
      os: j.os,
      host: j.host,
      joined_at: now.toISOString(),
      dev: device,
      secretHash: sha256(root_secret),
      delivered_at: null,
      ...(j.wgPub && addr ? { wg_pub: j.wgPub, wg_ip: addr.ip } : {}),
      ...(shareModel ? { share_model: true } : {}),
    });
    await writeRoots(f);
    if (!(await addDeviceRoot(device, root_id))) {
      // the approving device went away between the gate and here: undo
      f.roots = f.roots.filter((r) => r.id !== root_id);
      await writeRoots(f);
      return { http: 409, body: { error: 'approving device is no longer live' } };
    }

    // "Same as the home root": the owner approved it, so the home brain may hand this root its
    // model settings when it asks inside its tunnel. A brain that cannot be told shares nothing.
    const shared = shareModel && (await brainShareModel(root_id));

    j.status = 'approved';
    j.by = device;
    j.root_id = root_id;
    j.holdUntil = Date.now() + JOIN_TTL_S * 1000;
    j.result = {
      root_id,
      root_secret,
      link_tokens,
      rootlink_url: process.env.BIFROST_ROOTLINK_URL || '',
      peer_token: process.env.YGG_PEER_TOKEN || '',
      hub,
      ...(addr && hubKey
        ? { wg: { public_key: hubKey, hub_ip: `${addr.base}.1`, ip: addr.ip, net: addr.net } }
        : {}),
      ...(shared ? { model: 'home' as const } : {}),
    };
    await writeJoins();
    return {
      http: 200,
      body: { status: 'approved', root_id, name: j.name, os: j.os, host: j.host },
    };
  });
}

/** POST /api/roots/<id>/tokens — the root's own credential buys 20 more. */
export async function refillTokens(
  root: string,
  secret: string
): Promise<
  | { http: 200; body: { link_tokens: string[] } }
  | { http: 401 | 409 | 429 | 503; body: { error: string; why?: string }; retryAfter?: number }
> {
  const f = await readRoots();
  const rec = f.roots.find((r) => r.id === root);
  if (!rec || !/^[0-9a-f]{32}$/.test(secret) || !sameHash(sha256(secret), rec.secretHash)) {
    return { http: 401, body: { error: 'unknown root or bad root secret' } };
  }
  if (rec.revoked) {
    return { http: 401, body: { error: 'this root was removed from the tree', why: 'revoked' } };
  }
  // the bridge refuses a link token whose dev claim is revoked: say so here
  // instead of handing out 20 tokens that can never open
  const approver = (await listDevices()).devices.find((d) => d.id === rec.dev);
  if (!approver || approver.revoked) {
    return {
      http: 409,
      body: {
        error: 'the device that approved this root was revoked — join again',
        why: 'device-revoked',
      },
    };
  }
  // counted only once authenticated: a stranger who knows the id cannot
  // drain the root's own refill budget
  const rl = refillLimit(root);
  if (!rl.ok) return { http: 429, body: { error: 'rate limited' }, retryAfter: rl.retryAfter };
  try {
    return {
      http: 200,
      body: { link_tokens: await mintLinkTokens(root, rec.dev, LINK_TOKENS_PER_BATCH) },
    };
  } catch (e) {
    const msg = e instanceof MintError ? e.message : 'link-token mint failed';
    console.error(`refill ${root}: ${msg}`);
    return { http: 503, body: { error: msg } };
  }
}

/* ---------------- the whole tree: what the hub brain knows of every root ---------------- */

/** this root (the hub brain itself), as GET <brain>/root describes it */
export type HomeRoot = {
  name: string;
  os: string | null;
  arch?: string | null;
  cpus: number | null;
  mem_gb: number | null;
  running: number;
  models?: string[];
  theme?: string | null;
  theme_rev?: number;
  /** its own [MAIN] id (null: none yet) */
  main: string | null;
};

/** the brain's word on one other root (GET /root → roots[]) */
export type RootLive = {
  reachable: boolean;
  /** when it last answered (ms since epoch; null: never) */
  seen: number | null;
  running: number;
  models: string[];
  theme?: string | null;
  theme_rev?: number;
  /** its MAIN's id there, and the local proxy of it */
  main: string | null;
  main_proxy: string | null;
  arch?: string | null;
  cpus?: number | null;
  mem_gb?: number | null;
};

type BrainRoot = RootLive & { name: string; os: string | null };

const num0 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strN = (v: unknown) => (typeof v === 'string' && v ? v : null);
/** seconds or milliseconds → milliseconds */
const ms = (v: unknown) => {
  const n = num0(v);
  return n && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
};

function brainRoot(v: unknown): BrainRoot | null {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const name = str(o.name);
  if (!ROOT_NAME.test(name)) return null;
  return {
    name,
    os: strN(o.os),
    arch: strN(o.arch),
    cpus: num0(o.cpus),
    mem_gb: num0(o.mem_gb),
    reachable: o.reachable === true,
    seen: ms(o.seen),
    running: num0(o.running) ?? 0,
    models: (Array.isArray(o.models) ? o.models : [])
      .map((m) => (typeof m === 'string' ? m : str((m as { id?: unknown } | null)?.id)))
      .filter(Boolean),
    theme: strN(o.theme),
    theme_rev: num0(o.theme_rev) ?? 0,
    main: strN(o.main),
    main_proxy: strN(o.main_proxy),
  };
}

/** GET <brain>/root: this root and the brain's word on the others (empty when it does not answer) */
export async function brainTree(): Promise<{ home: HomeRoot | null; roots: BrainRoot[] }> {
  try {
    const r = await undiciFetch(`${OC}/root`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { home: null, roots: [] };
    const d = ((await r.json()) ?? {}) as Record<string, unknown>;
    const hw = (d.hardware ?? {}) as Record<string, unknown>;
    const load = (d.load ?? {}) as Record<string, unknown>;
    return {
      home: {
        name: str(d.name),
        os: strN(hw.os),
        arch: strN(hw.arch),
        cpus: num0(hw.cpus),
        mem_gb: num0(hw.mem_gb),
        running: num0(load.running) ?? 0,
        models: (Array.isArray(d.models) ? d.models : [])
          .map((m) => (typeof m === 'string' ? m : str((m as { id?: unknown } | null)?.id)))
          .filter(Boolean),
        theme: strN(d.theme),
        theme_rev: num0(d.theme_rev) ?? 0,
        main: strN(d.main),
      },
      roots: (Array.isArray(d.roots) ? d.roots : [])
        .map(brainRoot)
        .filter((x): x is BrainRoot => !!x),
    };
  } catch {
    return { home: null, roots: [] };
  }
}

const OFF_LINE: RootLive = {
  reachable: false,
  seen: null,
  running: 0,
  models: [],
  theme: null,
  theme_rev: 0,
  main: null,
  main_proxy: null,
};

/** Registry metadata for one joined root (`joined_at`, `host`, etc.), or null. */
export async function rootRecord(id: string) {
  const f = await readRoots();
  return f.roots.find((r) => !r.revoked && r.id === id) ?? null;
}

/**
 * GET /api/roots: every root of this tree. The joined ones (roots.json, removed ones left out)
 * with the brain's word on each merged in by id (= the root's name on the brain), then the roots
 * the brain knows that roots.json does not (static peers), as the brain describes them.
 */
export async function rootsOverview() {
  const [f, tree] = await Promise.all([readRoots(), brainTree()]);
  const gone = new Set(f.roots.filter((r) => r.revoked).map((r) => r.id));
  const byName = new Map(tree.roots.map((b) => [b.name, b]));
  const used = new Set<string>();
  const live = (b: BrainRoot): RootLive => ({
    reachable: b.reachable,
    seen: b.seen,
    running: b.running,
    models: b.models,
    theme: b.theme,
    theme_rev: b.theme_rev,
    main: b.main,
    main_proxy: b.main_proxy,
    arch: b.arch,
    cpus: b.cpus,
    mem_gb: b.mem_gb,
  });
  const roots: Array<Record<string, unknown> & { id: string; name: string }> = (
    await listRoots()
  ).map((r) => {
    const b = byName.get(r.id) ?? byName.get(r.name);
    if (b) used.add(b.name);
    return { ...r, ...(b ? live(b) : OFF_LINE), os: b?.os || r.os };
  });
  for (const b of tree.roots) {
    if (used.has(b.name) || gone.has(b.name) || b.name === tree.home?.name) continue;
    roots.push({
      id: b.name,
      name: b.name,
      os: b.os || '',
      host: '',
      joined_at: null,
      delivered_at: null,
      wg_fp: null,
      ...live(b),
    });
  }
  return { home: tree.home, roots };
}

/**
 * Remove a root from the tree (the roots sheet's hold → Remove): roots.json marks it `revoked`
 * (the existing atomic write, on the registry chain), then the hub brain forgets it
 * (DELETE /root/peers/<id>: loopback, its proxies say "root removed"). A static peer (not in
 * roots.json) is only forgotten by the brain.
 */
export async function removeRoot(
  id: string
): Promise<{ http: 200 | 404 | 502; body: Record<string, unknown> }> {
  const known = await serialize(async () => {
    const f = await readRoots();
    const rec = f.roots.find((r) => r.id === id);
    if (!rec) return false;
    if (!rec.revoked) {
      rec.revoked = true;
      rec.revoked_at = new Date().toISOString();
      await writeRoots(f);
    }
    return true;
  });
  let brain = 0;
  try {
    const r = await undiciFetch(`${OC}/root/peers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(8000),
    });
    brain = r.status;
  } catch (e) {
    console.warn(`roots: the brain did not forget ${id}: ${(e as Error).message}`);
  }
  if (known || (brain >= 200 && brain < 300)) return { http: 200, body: { ok: true } };
  if (brain === 404) return { http: 404, body: { error: `no root ${id}` } };
  return { http: 502, body: { error: 'the brain did not answer' } };
}
