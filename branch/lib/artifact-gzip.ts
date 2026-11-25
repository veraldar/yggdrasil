/** Async gzip helper for artifact responses (/api/artifact and /api/artifact/[name]).
 *  Fixes the live regex bug `/(^|; )gzip(;|$)/` that rejected every real browser's
 *  comma-separated `Accept-Encoding: gzip, deflate, br, zstd`, and uses async zlib
 *  so large text/HTML responses never block Node's event loop. */
import { promisify } from 'util';
import { gzip } from 'zlib';

const gzipAsync = promisify(gzip);

/** Minimum payload where gzip beats framing overhead. */
export const GZIP_MIN = 1024;
/** Upper bound on cached gzip payloads (2 MB covers normal HTML/MD/JSON deliverables
 *  without unbounded RAM growth). */
export const GZIP_MAX = 2 * 1024 * 1024;
const CACHE_MAX = 64;

const gzCache = new Map<string, Uint8Array>();

/** True if an HTTP Accept-Encoding header permits gzip (RFC 9110 comma-separated list). */
export function acceptsGzip(header: string | null | undefined): boolean {
  if (!header) return false;
  for (const part of header.split(',')) {
    const [rawEnc, ...params] = part.trim().toLowerCase().split(';');
    if (rawEnc.trim() !== 'gzip') continue;
    const q = params.find((p) => p.trim().startsWith('q='));
    if (q) {
      const val = Number(q.trim().slice(2));
      if (!Number.isNaN(val) && val <= 0) return false;
    }
    return true;
  }
  return false;
}

export function isCompressibleType(type: string): boolean {
  const base = type.split(';')[0].trim().toLowerCase();
  return (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base === 'application/xml' ||
    base === 'image/svg+xml' ||
    base === 'application/javascript'
  );
}

/** Async gzip with a bounded in-memory cache keyed by `cacheKey` (e.g. name+mtime+size).
 *  Returns null if the client doesn't accept gzip, type/size is ineligible, or gzip
 *  doesn't shrink the payload. */
export async function maybeGzip(
  acceptEncoding: string | null | undefined,
  type: string,
  raw: Uint8Array,
  cacheKey?: string
): Promise<Uint8Array | null> {
  if (!acceptsGzip(acceptEncoding)) return null;
  if (!isCompressibleType(type)) return null;
  if (raw.length < GZIP_MIN || raw.length > GZIP_MAX) return null;
  if (cacheKey) {
    const hit = gzCache.get(cacheKey);
    if (hit) return hit;
  }
  const gz = new Uint8Array(await gzipAsync(raw, { level: 6 }));
  if (gz.length >= raw.length) return null;
  if (cacheKey) {
    if (gzCache.size >= CACHE_MAX) gzCache.clear();
    gzCache.set(cacheKey, gz);
  }
  return gz;
}

/** Clear the in-memory gzip cache (tests only). */
export function clearGzipCache(): void {
  gzCache.clear();
}
