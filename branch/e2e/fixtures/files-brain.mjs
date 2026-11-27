#!/usr/bin/env node
/** A small stand-in brain for the files specs (package 2) until the real routes exist: exactly
 *  the contract's file routes (contract §B) and the session routes the session page needs.
 *  It checks what the app sends the way the real brain must take it — a message's file part
 *  has the stored-part shape and names a file it has, or the send is refused.
 *
 *  Env: PORT (4261), FAKE_ROOT_NAME (home), YGG_FILE_MAX_MB (100),
 *       FAKE_LAB_NAME (lab) + FAKE_LAB_ARTIFACTS (dir): the artifacts "on" the other root.
 *  Run: node e2e/fixtures/files-brain.mjs */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.PORT || 4261);
const ME = process.env.FAKE_ROOT_NAME || 'home';
const LAB = process.env.FAKE_LAB_NAME || 'lab';
const LAB_DIR = process.env.FAKE_LAB_ARTIFACTS || '';
const MAX = Number(process.env.YGG_FILE_MAX_MB || 100) * 1024 * 1024;
const PIECE = 1 << 20;

const blobs = new Map(); // hash → Buffer
const uploads = new Map(); // id → {name, mime, size, chunks, have}
const sessions = new Map(); // id → {info, messages}

const MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
};
const id = (p) => `${p}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
const mb = (n) => {
  const m = n / (1024 * 1024);
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} MB`;
};

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
    'content-length': buf.length,
    ...headers,
  });
  res.end(buf);
}

function body(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}
const json = async (req) => {
  try {
    return JSON.parse((await body(req)).toString() || '{}');
  } catch {
    return null;
  }
};

function keep(buf, name, mime) {
  const hash = createHash('sha256').update(buf).digest('hex');
  blobs.set(hash, buf);
  return { hash, name, mime, size: buf.length, root: ME };
}

/** a file part must be the stored shape (contract §B) and name a file this root has */
function badPart(p) {
  if (p.type !== 'file' || !p.hash) return '';
  const ok =
    /^[a-f0-9]{64}$/.test(p.hash) &&
    p.url === `/file/${p.hash}` &&
    typeof p.mime === 'string' &&
    typeof p.filename === 'string' &&
    typeof p.size === 'number' &&
    typeof p.root === 'string';
  if (!ok) return `file part is not the stored shape: ${JSON.stringify(p)}`;
  const b = blobs.get(p.hash);
  if (!b || b.length !== p.size) return `no file ${p.hash} of ${p.size} bytes here`;
  return '';
}

function session(title) {
  const now = Date.now();
  const s = { info: { id: id('ses_'), title, time: { created: now, updated: now } }, messages: [] };
  sessions.set(s.info.id, s);
  return s;
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const m = req.method;
  let r;
  try {
    // --- files (contract §B) ---
    if (m === 'POST' && p === '/file/upload') {
      const b = await json(req);
      if (!b || typeof b.name !== 'string' || typeof b.size !== 'number')
        return send(res, 400, { error: 'name and size' });
      if (b.size > MAX)
        return send(res, 413, {
          error: `${b.name} is ${mb(b.size)}. The limit is ${MAX / (1024 * 1024)} MB per file.`,
          limit: MAX,
        });
      const up = id('up');
      // an empty file is done at the start
      if (b.size === 0)
        return send(res, 200, {
          upload: up,
          piece: PIECE,
          have: 0,
          file: keep(Buffer.alloc(0), b.name, b.mime || 'application/octet-stream'),
        });
      uploads.set(up, {
        name: b.name,
        mime: b.mime || 'application/octet-stream',
        size: b.size,
        chunks: [],
        have: 0,
      });
      return send(res, 200, { upload: up, piece: PIECE });
    }
    if (m === 'PUT' && (r = /^\/file\/upload\/([\w-]+)$/.exec(p))) {
      const up = uploads.get(r[1]);
      if (!up) return send(res, 404, { error: 'no such upload' });
      const off = Number(u.searchParams.get('offset'));
      const buf = await body(req);
      if (off !== up.have) return send(res, 409, { error: 'go on from have', have: up.have });
      if (buf.length > PIECE) return send(res, 413, { error: 'a piece is over 1 MB' });
      if (up.have + buf.length > up.size)
        return send(res, 400, { error: 'more than the size said' });
      up.chunks.push(buf);
      up.have += buf.length;
      console.log(`[fake] PUT ${r[1]} offset=${off} len=${buf.length} have=${up.have}/${up.size}`);
      if (up.have < up.size) return send(res, 200, { have: up.have });
      uploads.delete(r[1]);
      return send(res, 200, {
        have: up.have,
        file: keep(Buffer.concat(up.chunks), up.name, up.mime),
      });
    }
    if (m === 'GET' && (r = /^\/file\/([a-f0-9]{64})\/info$/.exec(p))) {
      const b = blobs.get(r[1]);
      return b ? send(res, 200, { size: b.length }) : send(res, 404, { error: 'not found' });
    }
    if (m === 'GET' && (r = /^\/file\/([a-f0-9]{64})$/.exec(p))) {
      const b = blobs.get(r[1]);
      if (!b) return send(res, 404, { error: 'not found' });
      if (u.searchParams.has('offset')) {
        const off = Number(u.searchParams.get('offset'));
        const len = Math.min(Number(u.searchParams.get('len') || PIECE), PIECE);
        return send(res, 200, b.subarray(off, off + len));
      }
      return send(res, 200, b, {
        'content-type': u.searchParams.get('mime') || 'application/octet-stream',
      });
    }
    if (m === 'POST' && p === '/file/artifact') {
      const b = (await json(req)) || {};
      const name = String(b.name || '');
      const root = b.root || ME;
      if (root === LAB && LAB_DIR && /^[\w][\w.-]*$/.test(name)) {
        try {
          const buf = readFileSync(path.join(LAB_DIR, name));
          const mime = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
          return send(res, 200, keep(buf, name, mime));
        } catch {
          /* not there */
        }
      }
      return send(res, 404, { error: `no artifact ${name} on ${root}` });
    }

    // --- what the session page reads ---
    if (m === 'GET' && p === '/root')
      return send(res, 200, { name: ME, note: '', models: [], profiles: [], peers: [LAB] });
    if (m === 'GET' && p === '/session/status') return send(res, 200, {});
    if (m === 'GET' && p === '/tree') return send(res, 200, []);
    if (m === 'GET' && p === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': hello\n\n');
      const t = setInterval(() => res.write(': ping\n\n'), 10_000);
      req.on('close', () => clearInterval(t));
      return;
    }
    if (m === 'GET' && p === '/session')
      return send(
        res,
        200,
        [...sessions.values()].map((s) => s.info)
      );
    if (m === 'POST' && p === '/session') {
      const b = (await json(req)) || {};
      return send(res, 200, session(String(b.title || 'session')).info);
    }
    if ((r = /^\/session\/(ses_\w+)(\/.*)?$/.exec(p))) {
      const s = sessions.get(r[1]);
      if (!s) return send(res, 404, { error: `no session ${r[1]}` });
      const rest = r[2] || '';
      if (m === 'GET' && !rest) return send(res, 200, s.info);
      if (m === 'DELETE' && !rest) {
        sessions.delete(r[1]);
        return send(res, 200, true);
      }
      if (m === 'POST' && rest === '/abort') return send(res, 200, false);
      if (m === 'GET' && rest === '/message') return send(res, 200, s.messages);
      if (m === 'POST' && rest === '/message') {
        const b = (await json(req)) || {};
        const parts = Array.isArray(b.parts) ? b.parts : [];
        const bad = parts.map(badPart).find(Boolean);
        if (bad) return send(res, 400, { error: bad });
        const now = Date.now();
        const user = { info: { id: id('msg_'), role: 'user', time: { created: now } }, parts };
        const files = parts.filter((x) => x.type === 'file');
        const txt = parts
          .filter((x) => x.type === 'text')
          .map((x) => x.text || '')
          .join('\n');
        const exact = files.length === 0 && /^reply with exactly:\s*([\s\S]+)$/i.exec(txt.trim());
        const reply = {
          info: {
            id: id('msg_'),
            role: 'assistant',
            parentID: user.info.id,
            time: { created: now + 1, completed: now + 2 },
          },
          parts: [
            {
              type: 'text',
              text: exact
                ? exact[1]
                : `got ${files.length} file${files.length === 1 ? '' : 's'}: ${files.map((f) => f.filename || f.mime).join(', ')}`,
            },
          ],
        };
        s.messages.push(user, reply);
        s.info.time.updated = now;
        return send(res, 200, reply);
      }
    }
    return send(res, 404, { error: `no route ${m} ${p}` });
  } catch (e) {
    return send(res, 500, { error: String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`fake files brain "${ME}" on :${PORT} (limit ${MAX / (1024 * 1024)} MB)`)
);
