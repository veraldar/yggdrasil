/** Files the brain keeps (package 2, contract B/C): a REF names one stored file by its
 *  content hash. Shared by the composer (upload, echo), the messages route (stored part,
 *  transcript urls) and the /api/file routes — no node imports, it runs on the phone too. */

/** REF as the brain answers it: `root` is a root that has the bytes. */
export type FileRef = { hash: string; name: string; mime: string; size: number; root?: string };

/** A non-image file in a message, as the transcript gives it to the page. */
export type FileChip = { name: string; mime: string; size: number; url: string };

/** The largest piece the app passes on (the brain answers its own `piece`, 1 MiB). */
export const PIECE_MAX = 1 << 20;
export const FILES_PER_MESSAGE = 8;
export const HASH_RE = /^[a-f0-9]{64}$/;
/** a root's id/name (matches lib/roots.ts ROOT_NAME and root/src/peers.rs valid_id, incl. v1 rt_… ids) */
export const ROOT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const isImageMime = (mime: string | undefined) => /^image\//i.test(String(mime || ''));

/** The app url of a stored file: `/api/file/<hash>?root=<root>&mime=<mime>` (+ `&name=` for
 *  the files a message lists, so the opened file keeps its name). */
export function fileUrl(
  r: { hash: string; root?: string; mime?: string; name?: string },
  withName = false
): string {
  const q = new URLSearchParams();
  if (r.root) q.set('root', r.root);
  if (r.mime) q.set('mime', r.mime);
  if (withName && r.name) q.set('name', r.name);
  const s = q.toString();
  return `/api/file/${r.hash}${s ? `?${s}` : ''}`;
}

/** The hash a url of ours points at (`/api/file/<hash>?…`, `/file/<hash>`), else ''. */
export function urlHash(url: string): string {
  return /\/file\/([a-f0-9]{64})(?:[?#]|$)/.exec(url)?.[1] || '';
}

/** `refs` of a send body, checked: null when anything in it is not a REF. */
export function cleanRefs(raw: unknown): FileRef[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > FILES_PER_MESSAGE) return null;
  const out: FileRef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null;
    const { hash, name, mime, size, root } = r as Record<string, unknown>;
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return null;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
    if (root !== undefined && root !== null && (typeof root !== 'string' || !ROOT_RE.test(root)))
      return null;
    out.push({
      hash,
      name: String(name || 'file').slice(0, 200),
      mime: String(mime || '') || 'application/octet-stream',
      size,
      ...(typeof root === 'string' && { root }),
    });
  }
  return out;
}

/** The stored message part for a REF (contract B). */
export function refPart(r: FileRef) {
  return {
    type: 'file',
    mime: r.mime,
    filename: r.name,
    url: `/file/${r.hash}`,
    hash: r.hash,
    size: r.size,
    ...(r.root && { root: r.root }),
  };
}

/** What a transcript shows for a REF: images as urls, other files as chips. */
export function refViews(refs: FileRef[]): { images: string[]; files: FileChip[] } {
  return {
    images: refs.filter((r) => isImageMime(r.mime)).map((r) => fileUrl(r)),
    files: refs
      .filter((r) => !isImageMime(r.mime))
      .map((r) => ({ name: r.name, mime: r.mime, size: r.size, url: fileUrl(r, true) })),
  };
}

/** "820 KB", "6.1 MB" */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
