#!/usr/bin/env node
// trunk-seed.mjs — a stand-in v1 trunk for rigs and the twin (TWIN_AUTH=trunk), until the WIRE stream's
// bridge writes a real trunk-state.json and the IDP stream's trunk signs real tokens. Loopback only.
//
//   trunk-seed.mjs init  <dir> [--root-name N] [--trunk-url U]
//       a test Ed25519 keypair (<dir>/trunk-key.seed, 0600) and <dir>/trunk-state.json in the C5 shape
//       (docs/trunk-v1/CONTRACTS.md), written the bridge's way: atomic rename, 0600. Keeps an existing key.
//   trunk-seed.mjs mint  <dir> [--did dev_…] [--ip A | --rgn R] [--life-s S] [--role admin|member] [--kep N]
//       one C3 access token on stdout (never put it on a command line yourself: pipe it to a file)
//   trunk-seed.mjs state <dir> [--deny dev_…] [--undeny dev_…] [--kill] [--rotate] [--retire-old]
//       edit trunk-state.json as the bridge would after a trunk push (revoke, kill, key rotation)
//   trunk-seed.mjs front <dir> --port P --app http://127.0.0.1:8250 [--client-ip 203.0.113.7] [--sign-in auto|cookie]
//       the browser's origin, as the trunk is in production: /t/* and /login answered here, everything
//       else relayed to the root's app with X-Forwarded-For = the (fake, public) client address — the
//       app runs `node server.mjs` with BIFROST_TRUST_PROXY=1, as behind its bridge.
//         --sign-in auto   (default) a request with no bifrost_device cookie is signed in as the twin's
//                          device on the way through (unless it sends `x-trunk-seed-anon: 1`): every
//                          browser context, every Playwright `request`, is a signed-in phone, so the
//                          §3 specs run unchanged. The token is real (C3, this dir's key, 15 min).
//         --sign-in cookie only what the browser holds counts: /login → /t/test/sign-in sets the cookies
//                          as the trunk does after a sign-in (?did= ?life_s= ?next=); /t/auth/refresh
//                          rotates them (a revoked device's refresh is refused: 401 login).
//       Per-request knobs (tests): `x-trunk-seed-ip: <addr>` = the client address this request comes
//       from (a roam); POST /t/test/revoke {did} · /t/test/kill · /t/test/unrevoke {did} edit the state.
//       Stubs: GET /t/state, /t/me, /t/me/roots (<dir>/me-roots.json), /t/roots/pending
//       (<dir>/roots-pending.json), DELETE /t/roots/:id and POST /t/roots/enroll/:id/refuse (admin; logged
//       to <dir>/roots-removed.jsonl).
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ta = await import(path.join(HERE, '../../branch/lib/trunk-auth.ts'));
const { regionOf } = await import(path.join(HERE, '../../branch/lib/region.ts'));

const [cmd, dir, ...rest] = process.argv.slice(2);
const opt = (name, d) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : d;
};
const flag = (name) => rest.includes(`--${name}`);
if (!cmd || !dir) {
  console.error('usage: trunk-seed.mjs init|mint|state|front <dir> [options] (see the head of this file)');
  process.exit(2);
}

const F = {
  seed: path.join(dir, 'trunk-key.seed'),
  old: path.join(dir, 'trunk-key.old.seed'),
  state: path.join(dir, 'trunk-state.json'),
  meRoots: path.join(dir, 'me-roots.json'),
  pending: path.join(dir, 'roots-pending.json'),
  removed: path.join(dir, 'roots-removed.jsonl'),
};

const atomic = (file, text) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
};
const readJson = (file, d) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return d;
  }
};
const keyOf = (file) => ta.secretKeyFromSeed(Buffer.from(readFileSync(file, 'utf8').trim(), 'hex'));
const keyEntry = (key, retired = null) => {
  const pub = ta.rawPublic(key);
  return { kid: ta.kidOf(pub), alg: 'ed25519', public: pub.toString('base64url'), retired_at: retired };
};

function writeState(s) {
  s.link = { ...(s.link || {}), state: 'up', written: Date.now() };
  atomic(F.state, `${JSON.stringify(s, null, 2)}\n`);
}

function init() {
  if (!existsSync(F.seed)) atomic(F.seed, `${randomBytes(32).toString('hex')}\n`);
  const key = keyOf(F.seed);
  const now = Date.now();
  const prev = readJson(F.state, null);
  const s = {
    version: 1,
    trunk: {
      url: opt('trunk-url', 'http://127.0.0.1'),
      trunk_id: `trk_${createHash('sha256').update(ta.rawPublic(key)).digest('base64url').slice(0, 12)}`,
      trunk_key: ta.rawPublic(key).toString('base64url'),
    },
    root: { id: 'rt_twin', name: opt('root-name', 'twin') },
    link: { state: 'up', since: now, written: now },
    keys: [keyEntry(key)],
    kill_epoch: prev?.kill_epoch ?? 0,
    lockdown: false,
    deny: [],
    directory: { seq: 1, issued_at: now, sig: '', roots: [] },
    vapid_public: null,
  };
  writeState(s);
  console.log(`trunk-seed: ${F.state} (kid ${s.keys[0].kid}, kill_epoch ${s.kill_epoch})`);
}

const state = () => {
  const s = readJson(F.state, null);
  if (!s) throw new Error(`no ${F.state}: run init first`);
  return s;
};

function mint({ did = 'dev_twin', ip, rgn, lifeS = 900, role = 'admin', kep } = {}) {
  const s = state();
  return ta.mintToken(
    keyOf(F.seed),
    { did, rgn: rgn ?? regionOf(ip ?? '203.0.113.7'), role, kep: kep ?? s.kill_epoch, iss: s.trunk.url, sub: 'acc_twin' },
    { lifeMs: lifeS * 1000 }
  );
}

function edit(fn) {
  const s = state();
  fn(s);
  writeState(s);
  return s;
}
const deny = (did) => edit((s) => s.deny.push({ did, until: Date.now() + 30 * 60_000 }));
const undeny = (did) => edit((s) => (s.deny = s.deny.filter((d) => d.did !== did)));
const kill = () => edit((s) => (s.kill_epoch += 1));

if (cmd === 'init') init();
else if (cmd === 'mint') {
  process.stdout.write(
    `${mint({
      did: opt('did'),
      ip: opt('ip'),
      rgn: opt('rgn'),
      lifeS: Number(opt('life-s', 900)),
      role: opt('role', 'admin'),
      kep: opt('kep') === undefined ? undefined : Number(opt('kep')),
    })}\n`
  );
} else if (cmd === 'state') {
  if (opt('deny')) deny(opt('deny'));
  if (opt('undeny')) undeny(opt('undeny'));
  if (flag('kill')) kill();
  if (flag('rotate')) {
    // a new signing key; the old one stays valid until --retire-old (tokens it signed keep working)
    atomic(F.old, readFileSync(F.seed, 'utf8'));
    atomic(F.seed, `${randomBytes(32).toString('hex')}\n`);
    edit((s) => s.keys.unshift(keyEntry(keyOf(F.seed))));
  }
  if (flag('retire-old')) edit((s) => s.keys.forEach((k, i) => i > 0 && (k.retired_at ??= Date.now())));
  const s = state();
  console.log(`trunk-seed: kill_epoch ${s.kill_epoch}, deny [${s.deny.map((d) => d.did).join(' ')}], keys ${s.keys.length}`);
} else if (cmd === 'front') front();
else {
  console.error(`trunk-seed: unknown command ${cmd}`);
  process.exit(2);
}

// ─── the stand-in trunk front ────────────────────────────────────────────────────────────────────
function front() {
  const port = Number(opt('port'));
  const app = new URL(opt('app', 'http://127.0.0.1:8250'));
  const clientIp = opt('client-ip', '203.0.113.7');
  const auto = opt('sign-in', 'auto') === 'auto';
  if (!port) throw new Error('--port');
  // refresh credentials this front issued: sha256 → {did, ip}; rotated on every use (C3 shape, no grace)
  const refresh = new Map();

  const cookies = (req) =>
    Object.fromEntries(
      String(req.headers.cookie || '')
        .split(/;\s*/)
        .filter(Boolean)
        .map((c) => [c.slice(0, c.indexOf('=')), decodeURIComponent(c.slice(c.indexOf('=') + 1))])
    );
  const ipOf = (req) => String(req.headers['x-trunk-seed-ip'] || clientIp);
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const body = (req) =>
    new Promise((ok) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => ok(b));
    });
  // the cookies the trunk sets after a sign-in or a refresh (C3). No Secure here: the twin is plain
  // http on loopback (Chromium would keep a Secure cookie on 127.0.0.1 too; curl would not).
  const signIn = (did, ip, lifeS = 900) => {
    const r = `bfnr-${randomBytes(32).toString('base64url')}`;
    const accessToken = mint({ did, ip, lifeS });
    refresh.set(createHash('sha256').update(r).digest('hex'), { did, ip });
    return {
      accessToken,
      cookies: [
        `bifrost_device=${accessToken}; HttpOnly; SameSite=Strict; Path=/`,
        `bifrost_refresh=${r}; HttpOnly; SameSite=Strict; Path=/t/auth`,
      ],
    };
  };
  // the device a /t/* call speaks for: its cookie — or, under --sign-in auto, the twin's device (the
  // same rule as the relay: a cookie-less request is signed in on the way through)
  const deviceToken = (req) =>
    cookies(req).bifrost_device ||
    (auto && req.headers['x-trunk-seed-anon'] !== '1' ? autoToken(ipOf(req)) : '');
  const tokenOk = (req) =>
    ta.checkToken(
      deviceToken(req),
      ta.parseState(readFileSync(F.state, 'utf8')) ?? { keys: [], kill_epoch: 0, deny: [] },
      regionOf(ipOf(req))
    );

  async function trunkRoute(req, res, u) {
    const p = u.pathname;
    if (p === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(
        `<!doctype html><meta name="viewport" content="width=device-width"><title>sign in · twin trunk</title>` +
          `<h1 data-trunk-login>sign in</h1><p>stand-in trunk (sim/acceptance/trunk-seed.mjs)</p>` +
          `<form method="post" action="/t/test/sign-in"><button>sign in as the twin's device</button></form>`
      );
    }
    if (p === '/t/test/sign-in') {
      // ?did=dev_… (default dev_twin) · ?life_s=N (the access token's life: a test of the refresh path)
      const did = /^dev_[A-Za-z0-9_-]{1,64}$/.test(u.searchParams.get('did') || '') ? u.searchParams.get('did') : 'dev_twin';
      const life = Math.max(1, Math.min(900, Number(u.searchParams.get('life_s')) || 900));
      const next = (u.searchParams.get('next') || '/').startsWith('/') ? u.searchParams.get('next') || '/' : '/';
      return res.writeHead(302, { location: next, 'set-cookie': signIn(did, ipOf(req), life).cookies, 'cache-control': 'no-store' }).end();
    }
    if (p === '/t/auth/refresh' && req.method === 'POST') {
      const r = cookies(req).bifrost_refresh || '';
      const h = createHash('sha256').update(r).digest('hex');
      const rec = refresh.get(h);
      const s = state();
      if (!rec || s.deny.some((d) => d.did === rec.did)) return json(res, 401, { why: 'invalid', reauth: 'login' });
      refresh.delete(h);
      const issued = signIn(rec.did, ipOf(req));
      return json(res, 200, { ok: true, access_token: issued.accessToken }, { 'set-cookie': issued.cookies }); // a full 15 min again
    }
    if (p === '/t/auth/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true }, { 'set-cookie': ['bifrost_device=; Path=/; Max-Age=0', 'bifrost_refresh=; Path=/t/auth; Max-Age=0'] });
    }
    if (p === '/t/state') return json(res, 200, { claimed: true, has_roots: true, lockdown: !!state().lockdown, providers: [] });
    if (p.startsWith('/t/test/') && req.method === 'POST') {
      const b = await body(req);
      const did = (() => {
        try {
          return JSON.parse(b || '{}').did;
        } catch {
          return undefined;
        }
      })();
      if (p === '/t/test/revoke' && did) return json(res, 200, deny(did));
      if (p === '/t/test/unrevoke' && did) return json(res, 200, undeny(did));
      if (p === '/t/test/kill') return json(res, 200, kill());
      return json(res, 400, { error: 'revoke|unrevoke {did} or kill' });
    }
    // the device API: a token from the cookie, as the real trunk
    const v = tokenOk(req);
    if (!v.ok) return json(res, 401, { why: v.why, reauth: ta.REAUTH[v.why] });
    if (p === '/t/me') return json(res, 200, { account: v.claims.sub, device: v.claims.did, role: v.claims.role });
    if (p === '/t/me/roots') return json(res, 200, readJson(F.meRoots, []));
    if (p === '/t/roots/pending') return json(res, 200, readJson(F.pending, []));
    const refuse = /^\/t\/roots\/enroll\/([A-Za-z0-9_-]{1,64})\/refuse$/.exec(p);
    if (refuse && req.method === 'POST') {
      if (v.claims.role !== 'admin') return json(res, 403, { error: 'admin only' });
      appendFileSync(F.removed, `${JSON.stringify({ enroll: refuse[1], refused: true, at: Date.now(), by: v.claims.did })}\n`);
      return json(res, 200, { ok: true, id: refuse[1] });
    }
    const del = /^\/t\/roots\/([A-Za-z0-9_-]{1,64})$/.exec(p);
    if (del && req.method === 'DELETE') {
      if (v.claims.role !== 'admin') return json(res, 403, { error: 'admin only' });
      appendFileSync(F.removed, `${JSON.stringify({ id: del[1], at: Date.now(), by: v.claims.did })}\n`);
      return json(res, 200, { ok: true, id: del[1] });
    }
    return json(res, 404, { error: 'not in the stand-in trunk' });
  }

  // the relay: P12-style header hygiene, the client address in X-Forwarded-For, the auto sign-in
  const STRIP = /^(x-forwarded-.*|forwarded|x-bifrost-.*|x-real-ip|x-trunk-seed-.*)$/i;
  function relayHeaders(req) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!STRIP.test(k)) h[k] = v;
    h['x-forwarded-for'] = ipOf(req);
    if (auto && !cookies(req).bifrost_device && req.headers['x-trunk-seed-anon'] !== '1') {
      const add = `bifrost_device=${autoToken(ipOf(req))}`;
      h.cookie = h.cookie ? `${h.cookie}; ${add}` : add;
    }
    return h;
  }
  const minted = new Map(); // ip → {tok, at}: one fresh token a minute per client address
  function autoToken(ip) {
    const s = state();
    const m = minted.get(ip);
    if (m && Date.now() - m.at < 60_000 && m.kep === s.kill_epoch) return m.tok;
    const tok = mint({ did: 'dev_twin', ip });
    minted.set(ip, { tok, at: Date.now(), kep: s.kill_epoch });
    return tok;
  }

  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://front');
    if (u.pathname === '/login' || u.pathname.startsWith('/t/')) {
      trunkRoute(req, res, u).catch((e) => json(res, 500, { error: String(e?.message || e) }));
      return;
    }
    const up = http.request(
      { host: app.hostname, port: app.port, method: req.method, path: req.url, headers: relayHeaders(req), agent },
      (r) => {
        const h = { ...r.headers };
        delete h.connection;
        delete h['keep-alive'];
        // every refusal the app gives, in trunk.log (path without its query: no ids beyond the path)
        if ((r.statusCode || 0) >= 400)
          console.log(`${new Date().toISOString()} ${req.method} ${req.url.split('?')[0]} → ${r.statusCode}`);
        res.writeHead(r.statusCode || 502, h);
        r.pipe(res);
      }
    );
    up.on('error', (e) => {
      if (!res.headersSent) json(res, 502, { error: `app: ${e.code || e.message}` });
      else res.destroy();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  // websockets (none of today's routes, but the relay must not break one): a raw pipe after the head
  server.on('upgrade', (req, socket, head) => {
    const s = net.connect(Number(app.port), app.hostname, () => {
      const h = relayHeaders(req);
      s.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head?.length) s.write(head);
      socket.pipe(s).pipe(socket);
    });
    s.on('error', () => socket.destroy());
    socket.on('error', () => s.destroy());
  });
  server.keepAliveTimeout = 5000;
  server.listen(port, '127.0.0.1', () =>
    console.log(`trunk-seed front on http://127.0.0.1:${port} → ${app.origin} (client ${clientIp} = ${regionOf(clientIp)}, sign-in ${auto ? 'auto' : 'cookie'})`)
  );
}
