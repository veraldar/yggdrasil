/** Pure half of lib/home-path.ts — no React, no browser APIs — so the app and the e2e specs
 *  (e2e/home.ts) import the very same function. */

export const ROOTS_PATH = '/roots';

/** top-level routes of the app (branch/app, branch/public) and every top-level path the v1 trunk
 *  answers itself (trunk/src/v1: shell::PAGES, /t, /install, /auth/root, /add-root, the bridge's
 *  /offer /rtc /branch /identity): a home root named like one keeps `/roots/<name>` as its page.
 *  home-path-of.test.mjs fails when branch/app or branch/public grows an entry missing here. */
export const RESERVED = new Set([
  // the app
  'agents', 'api', 'artifacts', 'bridge', 'cc', 'devices', 'join', 'p2p', 'pair', 'providers',
  'roots', 'session', 'settings', 'onboarding', 'favicon.ico',
  // public/ files
  'commit-mono-400-regular.woff', 'everett-light.woff', 'lk-logo-dark.svg', 'lk-logo.svg',
  'lk-wordmark.svg', 'manifest.json', 'opengraph-image-bg.png', 'sw.js', 'user-agi.wav',
  // the v1 trunk's own
  'login', 'claim', 'account', 'offline', 'audit', 'auth', 'add-root', 't', 'install',
  // the bridge's listener
  'offer', 'rtc', 'branch', 'identity',
]);

/** the home screen's path for a home root called `name` (null name → `/`, which forwards) */
export function homePathOf(name?: string | null): string {
  if (!name) return '/';
  if (RESERVED.has(name.toLowerCase()) || name.startsWith('_') || name.includes('.')) {
    return `/roots/${encodeURIComponent(name)}`;
  }
  return `/${encodeURIComponent(name)}`;
}
