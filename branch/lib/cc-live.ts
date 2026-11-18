/** Claude Code live (11-14): the box's helper for running Claude Code sessions (cc_live.py, unit
 *  rc-<preview>-cclive, loopback only). It runs outside the brain's sandbox because `claude attach`
 *  needs the Claude Code daemon's sockets; the app is the only one holding its token
 *  (CC_LIVE_TOKEN_FILE, 0600, not bound into the brain's sandbox).
 *
 *  Server-side only (route handlers). */
import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';

export const CC_LIVE = process.env.CC_LIVE_URL || '';
const TOKEN_FILE = process.env.CC_LIVE_TOKEN_FILE || '';

/** SSE streams stay open for as long as a page watches: no timeouts. */
const agent = new Agent({ headersTimeout: 30_000, bodyTimeout: 0 });

function token(): string {
  // read on every call: a restarted helper keeps the file, a new install writes a new one
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

/** The only paths the app forwards: the session lists, per session its history and live stream
 *  (any harness), and for a Claude Code session (a uuid) its screen, input, keys, prompt answers
 *  and terminal. Nothing else reaches it. */
const ALLOWED: [string, RegExp][] = [
  ['GET', /^sessions$/],
  ['GET', /^harness$/],
  ['GET', /^h\/(claude|antigravity|opencode)\/[A-Za-z0-9_-]{1,80}\/(history|stream)$/],
  ['POST', /^h\/(claude|antigravity|opencode)\/[A-Za-z0-9_-]{1,80}\/(input|key|answer)$/],
  ['GET', /^s\/[0-9a-f-]{36}\/(history|stream|screen|term)$/],
  ['POST', /^s\/[0-9a-f-]{36}\/(input|key|answer|term|term\/size)$/],
  // full access (11-17): its state, and the owner's signed grant / key check (the signature is
  // made on the phone; the body carries nothing secret — see lib/full-access.ts)
  ['GET', /^access$/],
  ['POST', /^access\/(grant|check)$/],
];

export function allowed(method: string, path: string): boolean {
  return ALLOWED.some(([m, re]) => m === method && re.test(path));
}

/** The existing gate (see /api/token, /api/dispatch): the app serves the tailnet only. */
export function gated(): Response | null {
  if (process.env.NODE_ENV !== 'development' && process.env.BIFROST_AUTH !== 'tailnet') {
    return Response.json(
      { error: 'Claude Code live needs the tailnet gate (BIFROST_AUTH=tailnet)' },
      { status: 403 }
    );
  }
  if (!CC_LIVE || !TOKEN_FILE) {
    return Response.json(
      {
        error: 'Claude Code live is not set up on this box (CC_LIVE_URL, CC_LIVE_TOKEN_FILE)',
        code: 'off',
      },
      { status: 503 }
    );
  }
  return null;
}

export async function ccForward(
  method: string,
  path: string,
  query: string,
  body: string | null,
  signal?: AbortSignal
) {
  return undiciFetch(`${CC_LIVE}/${path}${query}`, {
    method,
    body: method === 'POST' ? body || '{}' : undefined,
    headers: { 'Content-Type': 'application/json', 'x-cc-live-token': token() },
    signal,
    dispatcher: agent,
  } as Parameters<typeof undiciFetch>[1]);
}
