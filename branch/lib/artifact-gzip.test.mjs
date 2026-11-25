// Artifact gzip compression helpers: RFC 9110 Accept-Encoding parsing, caching,
// and DecompressionStream round-trip (matching lib/pinned.ts tunnel decompression).
// Run: node --test lib/artifact-gzip.test.mjs
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const { acceptsGzip, clearGzipCache, isCompressibleType, maybeGzip } =
  await import('./artifact-gzip.ts');

beforeEach(() => clearGzipCache());

test('acceptsGzip handles real browser comma-separated headers and q=0 rejection', () => {
  assert.equal(acceptsGzip('gzip, deflate, br, zstd'), true);
  assert.equal(acceptsGzip('br, gzip;q=0.8, deflate'), true);
  assert.equal(acceptsGzip('gzip'), true);
  assert.equal(acceptsGzip('GZIP, br'), true);
  assert.equal(acceptsGzip('deflate, br'), false);
  assert.equal(acceptsGzip('gzip;q=0, br'), false);
  assert.equal(acceptsGzip('gzip;q=0.0'), false);
  assert.equal(acceptsGzip(''), false);
  assert.equal(acceptsGzip(null), false);
});

test('isCompressibleType selects text, json, svg, and rejects binary media', () => {
  assert.equal(isCompressibleType('text/html; charset=utf-8'), true);
  assert.equal(isCompressibleType('text/markdown; charset=utf-8'), true);
  assert.equal(isCompressibleType('application/json'), true);
  assert.equal(isCompressibleType('image/svg+xml'), true);
  assert.equal(isCompressibleType('video/mp4'), false);
  assert.equal(isCompressibleType('image/png'), false);
  assert.equal(isCompressibleType('application/pdf'), false);
});

test('maybeGzip compresses browser-requested HTML, caches by key, and round-trips via DecompressionStream', async () => {
  const html =
    '<!doctype html><body>' + '<p>artifact performance test payload</p>\n'.repeat(120) + '</body>';
  const raw = new TextEncoder().encode(html);

  const gz = await maybeGzip('gzip, deflate, br, zstd', 'text/html; charset=utf-8', raw, 'a:1:raw');
  assert.ok(gz, 'expected gzipped bytes');
  assert.ok(
    gz.length < raw.length * 0.2,
    `expected strong compression, got ${gz.length}/${raw.length}`
  );

  // Cache hit returns the exact same buffer
  const gz2 = await maybeGzip('gzip, deflate, br', 'text/html; charset=utf-8', raw, 'a:1:raw');
  assert.equal(gz2, gz);

  // Round-trip through Web DecompressionStream (the exact primitive lib/pinned.ts uses)
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(gz);
      c.close();
    },
  }).pipeThrough(new DecompressionStream('gzip'));
  const roundTripped = await new Response(stream).text();
  assert.equal(roundTripped, html);

  // Skips tiny payloads (< 1 KB) and non-gzip callers
  const tiny = new TextEncoder().encode('<p>small</p>');
  assert.equal(await maybeGzip('gzip, deflate, br', 'text/html', tiny), null);
  assert.equal(await maybeGzip('br', 'text/html', raw), null);
});
