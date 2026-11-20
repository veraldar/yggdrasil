/**
 * v0.9 no-tailscale serve: `node server.mjs` instead of `next start`.
 *
 * Which entry runs when:
 *   BIFROST_AUTH=devices (pairing) → `node server.mjs` — REQUIRED (below). The
 *     installer's bifrost-app.service runs exactly this.
 *   BIFROST_AUTH=tailnet → `next start` (npm start) as before, behind
 *     `tailscale serve`; server.mjs works there too.
 * Both serve the same `next build` output. Under any entry but this one,
 * lib/region.ts reads NO peer (BIFROST_PEER_STAMP below is unset): a
 * client-sent x-bifrost-peer is never believed, so devices mode misserved by
 * `next start` fails closed (region "unknown", no console) instead of open.
 *
 * The ONE place the peer address is known. Plain `next start` keeps a
 * client-sent X-Forwarded-For (base-server `??=`), so a LAN client could claim
 * to be loopback (= the box console = pairing admin) or fake its network
 * region. Here every request gets `x-bifrost-peer` from the socket, and any
 * client-sent copy is deleted first. Behind a reverse proxy YOU run, set
 * BIFROST_TRUST_PROXY=1 to take the first X-Forwarded-For hop instead.
 *
 * Env: PORT (8095), HOST (0.0.0.0), BIFROST_TRUST_PROXY.
 */
import next from 'next';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

// A release ships Next's standalone output (scripts/release.sh): no next.config.ts and no webpack next to
// this file. The build's resolved config is in .next/required-server-files.json — hand it to Next the way
// its own standalone server.js does, so loading the config needs nothing the release leaves out.
const serverFiles = path.join(process.cwd(), '.next', 'required-server-files.json');
if (!existsSync(path.join(process.cwd(), 'next.config.ts')) && existsSync(serverFiles)) {
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG ??= JSON.stringify(
    JSON.parse(readFileSync(serverFiles, 'utf8')).config
  );
}

const port = Number(process.env.PORT || 8095);
const hostname = process.env.HOST || '0.0.0.0';
const trustProxy = process.env.BIFROST_TRUST_PROXY === '1';

// in-process marker (never from the env file): x-bifrost-peer is ours to read
process.env.BIFROST_PEER_STAMP = 'server.mjs';

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => {
  const forwarded = trustProxy
    ? String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim()
    : '';
  delete req.headers['x-bifrost-peer'];
  if (!trustProxy) delete req.headers['x-forwarded-for'];
  req.headers['x-bifrost-peer'] = forwarded || req.socket.remoteAddress || '';
  handle(req, res);
});
// The trunk's bridge half-closes its side of the connection once a request is sent (one request
// per stream). Node's default then aborts the request still in flight, so a route found its body
// destroyed ("Response body object should not be disturbed or locked") or nothing answered at all —
// one upload piece in a few failed over the pinned channel. Keep a half-closed request alive; the
// connection still ends after the answer.
server.httpAllowHalfOpen = true;
server.listen(port, hostname, () => {
  console.log(`bifrost pwa on http://${hostname}:${port} (peer-stamped, trustProxy=${trustProxy})`);
});
