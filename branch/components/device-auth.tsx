'use client';

/**
 * S1 client half: a same-origin /api call answering 401 with a `reauth` hint
 * gets ONE single-flight refresh (/api/pair/refresh, the path-scoped refresh
 * cookie rides it) and a retry — whichever hint the 401 carries. A refused refresh
 * means this device is no longer paired → /pair. Mounted once in the layout; inert in tailnet mode,
 * where the middleware never answers 401.
 *
 * v1 (BIFROST_AUTH=trunk, contract C3): a 401 from any v1 verifier (the trunk, this root's app or its
 * bridge) is exactly `{why, reauth: "refresh"|"login"}` — every v0.9 one carries an `error` field too,
 * which is how the two are told apart (the same build serves both modes). `refresh` → one single-flight
 * POST /t/auth/refresh (the trunk, same origin; its refresh cookie is scoped to /t/auth) and a retry;
 * `login`, or a refused refresh → /login (the trunk's sign-in page).
 */
import { useEffect } from 'react';

const inflight = new Map<string, Promise<boolean>>();

function refreshOnce(orig: typeof fetch, url: string): Promise<boolean> {
  let p = inflight.get(url);
  if (!p) {
    p = orig(url, { method: 'POST' })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => setTimeout(() => inflight.delete(url), 0));
    inflight.set(url, p);
  }
  return p;
}

/** A v1 (C3) 401 body: {why, reauth} and nothing else. */
const isV1 = (hint: unknown): hint is { why: string; reauth: 'refresh' | 'login' } =>
  !!hint &&
  typeof hint === 'object' &&
  !('error' in hint) &&
  typeof (hint as { why?: unknown }).why === 'string' &&
  ((hint as { reauth?: unknown }).reauth === 'refresh' || (hint as { reauth?: unknown }).reauth === 'login');

export function DeviceAuth() {
  useEffect(() => {
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await orig(input, init);
      if (res.status !== 401) return res;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(url, location.href);
      if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return res;
      // /pair is mid-handshake: its own claim decides, a refresh here can only race it. The same
      // when the /pair page is shown in place of another page (the page gate, lib/gate.ts): the
      // address is not /pair then, the page says so itself (app/pair/page.tsx).
      if (u.pathname.startsWith('/api/pair') || location.pathname.startsWith('/pair')) return res;
      if (document.documentElement.dataset.pairPage) return res;
      const hint = await res
        .clone()
        .json()
        .catch(() => null);
      if (isV1(hint)) {
        if (hint.reauth === 'refresh' && (await refreshOnce(orig, '/t/auth/refresh'))) return orig(input, init);
        location.assign('/login');
        return res;
      }
      // one refresh for ANY hint, "pair" included: an access token that ran out and was then cleaned out
      // of the registry (lib/devices.ts prune) is answered "pair", not "refresh", though the device is
      // paired and its refresh credential is good. Only a refused refresh means it is not paired.
      if (hint?.reauth && (await refreshOnce(orig, '/api/pair/refresh'))) return orig(input, init);
      if (hint?.reauth) location.assign('/pair?unpaired=1');
      return res;
    };
    return () => {
      window.fetch = orig;
    };
  }, []);
  return null;
}
