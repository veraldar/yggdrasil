/** GET /api/artifact/[name] → files the agents dropped (this checkout's
 *  artifacts/, the main tree's when running from a worktree) or the app's
 *  own built-ins (branch/artifacts-builtin — the door's tree film), so the
 *  phone can render them inline in the chat (markdown images / sandboxed
 *  iframes). Name is sanitized; which file a name means is decided by
 *  lib/artifacts' one rule, shared with the /artifacts gallery.
 *  `?root=<r>&session=<s>` with r another root (a session there made it): the brain fetches it
 *  from that root (POST /file/artifact) and its bytes go out with the same headers a local
 *  artifact of that extension gets. No root, or the home root's own name: the local file. */
import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { ARTIFACT_TYPES, resolveArtifact, safeArtifactName } from '@/lib/artifacts';
import { ROOT_RE } from '@/lib/file-ref';
import { ocFetch, ocRaw } from '@/lib/oc';
import { renderMdPage } from '@/lib/render-md';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'not found' }, { status: 404 });

/** the home root's name (the brain's GET /root), a minute at a time; null = it gives none */
let home: { name: string | null; at: number } | null = null;
async function homeRoot(): Promise<string | null> {
  if (home && Date.now() - home.at < 60_000) return home.name;
  const d = (await ocFetch('/root').catch(() => null)) as { name?: unknown } | null;
  const name = typeof d?.name === 'string' && d.name ? d.name : null;
  home = { name, at: Date.now() };
  return name;
}

/** One artifact's answer, wherever its bytes came from (local file or another root). */
async function serve(
  req: Request,
  name: string,
  type: string,
  bytes: () => Promise<Uint8Array>,
  stream: (() => ReadableStream<Uint8Array>) | null,
  source: string
): Promise<Response> {
  // top-level navigation (address bar / new tab / gallery corner button):
  // md renders as a phone-readable page, other text wraps raw in the
  // app's black — browsers paint raw text white, and an opened .log must
  // still read like bifrost. Chat fetches (sec-fetch-dest: empty, accept: */*)
  // get the raw bytes they .text() — the md viewer in the chat renders markdown
  // itself. Note: when the PWA service worker (public/sw.js) intercepts /api/*
  // navigations, Chromium downgrades sec-fetch-dest to "empty" (or drops it on
  // the pinned tunnel), while Accept still carries text/html.
  const dest = req.headers.get('sec-fetch-dest');
  const accept = req.headers.get('accept') || '';
  const doc = dest === 'document' || ((!dest || dest === 'empty') && accept.includes('text/html'));
  const html = type.startsWith('text/html');
  const md = type.startsWith('text/markdown');
  if (md && doc) {
    try {
      return new Response(renderMdPage(name, Buffer.from(await bytes()).toString('utf-8')), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Artifact-Source': source,
          // as sandboxed as the chat's html frames: no scripts, no
          // access to the app's origin
          'Content-Security-Policy': 'sandbox',
        },
      });
    } catch {
      /* the parser refused the file: it still reads, below, as plain text */
    }
  }
  // Html is NOT text to wrap (it is text/html too — opened, it showed
  // its source): it goes out as itself, below. (An .md whose render threw
  // lands here too — the source still reads, wrapped, never white.)
  if (type.startsWith('text/') && !html && doc) {
    const esc = Buffer.from(await bytes())
      .toString('utf-8')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const page =
      `<!doctype html><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${name}</title>` +
      `<style>html{background:#080810}body{margin:0;background:#080810;color:#fff;` +
      `font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:16px;` +
      `white-space:pre-wrap;word-break:break-word}</style>` +
      `<body>${esc}</body>`;
    return new Response(page, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return new Response(stream ? stream() : new Uint8Array(await bytes()), {
    headers: {
      'Content-Type': type,
      // long enough to cache during a chat, short enough to pick up rewrites
      'Cache-Control': 'no-store',
      'X-Artifact-Source': source,
      // an html page opened on its own (gallery tap, new tab) renders
      // as sandboxed as the chat's frame (sandbox=""): no scripts, no
      // access to the app's origin
      ...(html && doc ? { 'Content-Security-Policy': 'sandbox' } : {}),
    },
  });
}

/** an artifact a session on another root made: the brain brings it here, then its bytes */
async function remote(req: Request, name: string, type: string, root: string, session: string) {
  let ref: { hash?: unknown; root?: unknown } | null;
  try {
    ref = await ocFetch('/file/artifact', {
      method: 'POST',
      body: JSON.stringify({ name, root, ...(session && { session }) }),
    });
  } catch {
    return notFound();
  }
  const hash = typeof ref?.hash === 'string' && /^[a-f0-9]{64}$/.test(ref.hash) ? ref.hash : '';
  if (!hash) return notFound();
  const at = typeof ref?.root === 'string' && ROOT_RE.test(ref.root) ? `?root=${ref.root}` : '';
  let r: Awaited<ReturnType<typeof ocRaw>>;
  try {
    r = await ocRaw(`/file/${hash}${at}`);
  } catch {
    return notFound();
  }
  if (!r.ok || !r.body) return notFound();
  const body = r.body as unknown as ReadableStream<Uint8Array>;
  return serve(
    req,
    name,
    type,
    async () => new Uint8Array(await r.arrayBuffer()),
    () => body,
    root
  );
}

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!safeArtifactName(name)) {
    return NextResponse.json({ error: 'bad name' }, { status: 400 });
  }
  const ext = path.extname(name).toLowerCase();
  // the type comes from the extension alone — no extension is no file we
  // could serve, which is a 404 (a 415 read as "wrong format" for a name
  // that never existed, 10-24 /api/artifact/the-tree-film)
  if (!ext) {
    return NextResponse.json(
      {
        error:
          'not found — artifact names carry their extension (the door films: door-tree.html, far-vision.html)',
      },
      { status: 404 }
    );
  }
  const type = ARTIFACT_TYPES[ext];
  if (!type) return NextResponse.json({ error: 'unsupported type' }, { status: 415 });
  const q = new URL(req.url).searchParams;
  const root = q.get('root') || '';
  // a brain that names no root of its own (opencode) reaches no other: the local file
  const here = root ? await homeRoot() : null;
  if (root && ROOT_RE.test(root) && here && root !== here) {
    const session = q.get('session') || '';
    return remote(req, name, type, root, /^[A-Za-z0-9_-]{1,128}$/.test(session) ? session : '');
  }
  const hit = await resolveArtifact(name);
  if (hit) {
    try {
      const data = await readFile(hit.file);
      return await serve(req, name, hit.type, async () => data, null, hit.source);
    } catch {
      /* raced a delete */
    }
  }
  return notFound();
}
