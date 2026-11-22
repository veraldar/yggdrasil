/** Shared JSON-body reader for the API proxy — the 11-11 send-corruption fix
 *  generalized. The degraded phone↔tailscale-serve h2 hop keeps dropping the
 *  FRONT bytes of request bodies (thor 11-09 'Unexpected token M', ve 11-11
 *  'after JSON at position 1' ×3, thor 11-22 'Unexpected token R' on
 *  "fR7vF1N7llv…"): the server receives a SUFFIX of the payload. A bare
 *  req.json() turns that into a raw V8 SyntaxError 500 with no evidence;
 *  reading the text once and parsing explicitly gives a forensic console
 *  line (content-length vs received + first 24 chars pinpoint the cut
 *  offset) and an honest, actionable 400. Every /api route that reads JSON
 *  goes through here — no route may 500 with V8 internals on this again. */
import { NextResponse } from 'next/server';

const CORRUPT_BODY_ERROR =
  'the upload was cut up by the connection — parts of it never arrived. Send again; if it keeps failing, toggle airplane mode once (it forces a fresh connection) and retry';

export type ReadBody<T> =
  | { ok: true; body: T }
  | { ok: false; response: NextResponse };

export async function readJsonBody<T = Record<string, any>>(
  req: Request,
  route: string,
  ctx?: string
): Promise<ReadBody<T>> {
  const raw = await req.text();
  try {
    return { ok: true, body: JSON.parse(raw) as T };
  } catch (e) {
    // content-length vs received bytes + first chars pinpoint the cut
    // offset for the infra report (serve/radio dropping body prefixes)
    console.error(
      `[${route}] body corrupted in transit${ctx ? ` ${ctx}` : ''}: content-length=${req.headers.get('content-length') || '?'} received=${raw.length} head=${JSON.stringify(raw.slice(0, 24))} · ${e}`
    );
    return {
      ok: false,
      response: NextResponse.json({ error: CORRUPT_BODY_ERROR }, { status: 400 }),
    };
  }
}
