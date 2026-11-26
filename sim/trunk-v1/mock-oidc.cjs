// mock-oidc.cjs — a local OpenID Connect provider (and a GitHub-shaped OAuth app) for the G3.7
// rig (sim/trunk-v1-auth.py). Test rigs only: keys are made at start and never leave this process.
//
//   node sim/trunk-v1/mock-oidc.cjs <port> <config.json>
//
// config.json: {"clients": {"<client_id>": {"secret": "…", "redirect_uris": ["…"]}}}
// (the secrets are read from the file, never from the command line). Prints one JSON line
// {"ready": true, "issuer": …} when it listens on 127.0.0.1:<port>.
//
// OIDC:   GET /.well-known/openid-configuration · GET /jwks · GET /authorize · POST /token
// GitHub: GET /gh/login/oauth/authorize · POST /gh/login/oauth/access_token · GET /gh/api/user · GET /gh/api/user/emails
// Control (the rig): POST /_mock/next {profile} — who the next sign-in is and how its token is
//   spoiled (tamper: sig | nonce | iss | aud | exp | alg | kid | rotate | es256 | azp, deny: true);
//   POST /_mock/rotate — publish a second RSA key; GET /_mock/stats.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const port = Number(process.argv[2]);
const cfg = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const issuer = 'http://127.0.0.1:' + port;

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rsa1 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsa2 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec1 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (kp, kid, alg) => Object.assign(kp.publicKey.export({ format: 'jwk' }), { kid, alg, use: 'sig' });
let rotated = false;

const stats = { jwks_fetches: 0, token_calls: 0, last_token_auth: null, last_authorize: null, last_verifier_ok: null, gh_api_calls: 0 };
let next = null; // the next sign-in's profile (one use)
const codes = new Map(); // code → {client_id, redirect_uri, challenge, nonce, profile, gh}
const tokens = new Map(); // github access token → profile

const DEFAULT = { sub: 'owner-sub-1', email: 'owner@example.org', email_verified: true, gh_id: 4242, gh_emails: [{ email: 'owner@example.org', primary: true, verified: true }] };

function sign(header, claims, key, dsa) {
  const h = b64u(JSON.stringify(header));
  const c = b64u(JSON.stringify(claims));
  const msg = h + '.' + c;
  if (header.alg === 'none') return msg + '.';
  const sig = crypto.sign('sha256', Buffer.from(msg), dsa ? { key, dsaEncoding: 'ieee-p1363' } : key);
  return msg + '.' + b64u(sig);
}

function idToken(clientId, nonce, p) {
  const now = Math.floor(Date.now() / 1000);
  const t = p.tamper || '';
  const claims = { iss: t === 'iss' ? 'http://127.0.0.1:1' : issuer, aud: t === 'aud' ? 'someone-else' : clientId, sub: p.sub,
    iat: now, exp: t === 'exp' ? now - 600 : now + 300, nonce: t === 'nonce' ? 'not-the-nonce' : nonce };
  if (t === 'azp') { claims.aud = [clientId, 'other-client']; claims.azp = 'other-client'; }
  if (p.email !== undefined) claims.email = p.email;
  if (p.email_verified !== undefined && p.email_verified !== '__drop__') claims.email_verified = p.email_verified;
  if (t === 'alg') return sign({ alg: 'none', typ: 'JWT' }, claims);
  if (t === 'es256') return sign({ alg: 'ES256', kid: 'ec1', typ: 'JWT' }, claims, ec1.privateKey, true);
  if (t === 'sig') return sign({ alg: 'RS256', kid: 'rsa1', typ: 'JWT' }, claims, evil.privateKey);
  if (t === 'kid') return sign({ alg: 'RS256', kid: 'nobody-has-this', typ: 'JWT' }, claims, evil.privateKey);
  if (t === 'rotate') return sign({ alg: 'RS256', kid: 'rsa2', typ: 'JWT' }, claims, rsa2.privateKey);
  return sign({ alg: 'RS256', kid: 'rsa1', typ: 'JWT' }, claims, rsa1.privateKey);
}

function send(res, status, body, headers) {
  const b = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', 'content-length': Buffer.byteLength(b), connection: 'close' }, headers || {}));
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts).toString()));
  });
}

function clientAuth(req, form) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(h.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
    return { id, secret, how: 'basic' };
  }
  return { id: form.get('client_id'), secret: form.get('client_secret'), how: 'post' };
}

function authorize(url, res, gh) {
  const q = url.searchParams;
  stats.last_authorize = Object.fromEntries(q.entries());
  const client = cfg.clients[q.get('client_id')];
  const redirect = q.get('redirect_uri');
  if (!client || !client.redirect_uris.includes(redirect)) return send(res, 400, { error: 'invalid_client or redirect_uri' });
  if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !(q.get('code_challenge') || '').match(/^[A-Za-z0-9_-]{43}$/)) {
    return send(res, 400, { error: 'invalid_request (code flow + PKCE S256 only)' });
  }
  const p = Object.assign({}, DEFAULT, next || {});
  next = null;
  const back = new URL(redirect);
  back.searchParams.set('state', q.get('state') || '');
  if (p.deny) {
    back.searchParams.set('error', 'access_denied');
  } else {
    const code = b64u(crypto.randomBytes(24));
    codes.set(code, { client_id: q.get('client_id'), redirect_uri: redirect, challenge: q.get('code_challenge'), nonce: q.get('nonce') || '', profile: p, gh });
    back.searchParams.set('code', code);
  }
  res.writeHead(302, { location: back.toString(), connection: 'close', 'content-length': 0 });
  res.end();
}

async function token(req, res, gh) {
  stats.token_calls += 1;
  const form = new URLSearchParams(await readBody(req));
  const a = clientAuth(req, form);
  stats.last_token_auth = a.how;
  const client = cfg.clients[a.id];
  if (!client || client.secret !== a.secret) return send(res, 401, { error: 'invalid_client' });
  const c = codes.get(form.get('code') || '');
  codes.delete(form.get('code') || '');
  if (!c || c.client_id !== a.id || c.redirect_uri !== form.get('redirect_uri') || c.gh !== gh) return send(res, 400, { error: 'invalid_grant' });
  const verifier = form.get('code_verifier') || '';
  const ok = b64u(crypto.createHash('sha256').update(verifier).digest()) === c.challenge;
  stats.last_verifier_ok = ok;
  if (!ok) return send(res, 400, { error: 'invalid_grant' });
  if (gh) {
    const at = 'gho_' + b64u(crypto.randomBytes(18));
    tokens.set(at, c.profile);
    return send(res, 200, { access_token: at, token_type: 'bearer', scope: 'read:user,user:email' });
  }
  return send(res, 200, { access_token: b64u(crypto.randomBytes(18)), token_type: 'Bearer', expires_in: 3600, id_token: idToken(a.id, c.nonce, c.profile) });
}

function ghApi(req, res, what) {
  stats.gh_api_calls += 1;
  const p = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!p) return send(res, 401, { message: 'Bad credentials' });
  if (what === 'user') return send(res, 200, { id: p.gh_id, login: 'owner' });
  return send(res, 200, p.gh_emails);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/.well-known/openid-configuration') {
      return send(res, 200, { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256', 'ES256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256'] });
    }
    if (req.method === 'GET' && p === '/jwks') {
      stats.jwks_fetches += 1;
      const keys = [jwk(rsa1, 'rsa1', 'RS256'), jwk(ec1, 'ec1', 'ES256')];
      if (rotated) keys.push(jwk(rsa2, 'rsa2', 'RS256'));
      return send(res, 200, { keys });
    }
    if (req.method === 'GET' && p === '/authorize') return authorize(url, res, false);
    if (req.method === 'POST' && p === '/token') return token(req, res, false);
    if (req.method === 'GET' && p === '/gh/login/oauth/authorize') return authorize(url, res, true);
    if (req.method === 'POST' && p === '/gh/login/oauth/access_token') return token(req, res, true);
    if (req.method === 'GET' && p === '/gh/api/user') return ghApi(req, res, 'user');
    if (req.method === 'GET' && p === '/gh/api/user/emails') return ghApi(req, res, 'emails');
    if (req.method === 'POST' && p === '/_mock/next') { next = JSON.parse((await readBody(req)) || '{}'); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/_mock/rotate') { rotated = true; return send(res, 200, { ok: true }); }
    if (req.method === 'GET' && p === '/_mock/stats') return send(res, 200, stats);
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e) });
  }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, issuer })));
