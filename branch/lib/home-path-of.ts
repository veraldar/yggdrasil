/** Pure half of lib/home-path.ts — no React, no browser APIs — so the app and the e2e specs
 *  (e2e/home.ts) import the very same function. */

export const ROOTS_PATH = '/roots/';

/** top-level routes of the app: a home root named like one keeps `/roots/<name>` as its page */
const RESERVED = new Set([
  'agents', 'api', 'artifacts', 'bridge', 'cc', 'devices', 'join', 'p2p', 'pair', 'providers',
  'roots', 'session', 'settings', 'onboarding', 'favicon.ico',
]);

/** the home screen's path for a home root called `name` (null name → `/`, which forwards) */
export function homePathOf(name?: string | null): string {
  if (!name) return '/';
  if (RESERVED.has(name.toLowerCase()) || name.startsWith('_') || name.includes('.')) {
    return `/roots/${encodeURIComponent(name)}`;
  }
  return `/${encodeURIComponent(name)}`;
}
