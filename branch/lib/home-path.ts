'use client';

/** Where the tree's pages live (owner 11-26): the roots list is `/roots/`, the home root's own
 *  screen is `/<its name>` (omarchy → `/omarchy`), another computer's is `/roots/<name>`.
 *  The bare `/` is the door's address (first contact — S8) and, once the door was walked,
 *  forwards to the roots list. */
import { useEffect, useState } from 'react';

/** localStorage: the home root's name (the list's computer tag leaves it out) */
export const HOME_ROOT_KEY = 'oz-home-root';

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

/** the home screen's path as this phone last heard the home root's name */
export function cachedHomePath(): string {
  try {
    return homePathOf(localStorage.getItem(HOME_ROOT_KEY));
  } catch {
    return '/';
  }
}

/** the home screen's href for a link (`/` until the home root's name is known on this phone,
 *  and the first server render always says `/`: the roots list or the door take it from there) */
export function useHomeHref(): string {
  const [href, setHref] = useState('/');
  useEffect(() => setHref(cachedHomePath()), []);
  return href;
}
