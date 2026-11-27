'use client';

/** Where the tree's pages live (owner 11-26): the roots list is `/roots/`, the home root's own
 *  screen is `/<its name>` (omarchy → `/omarchy`), another computer's is `/roots/<name>`.
 *  The bare `/` is the door's address (first contact — S8) and, once the door was walked,
 *  forwards to the roots list. */
import { useEffect, useState } from 'react';
import { ROOTS_PATH, homePathOf } from './home-path-of';

// the pure half (no React, no browser) lives in home-path-of.ts so e2e specs import the same function
export { ROOTS_PATH, homePathOf };

/** localStorage: the home root's name (the list's computer tag leaves it out) */
export const HOME_ROOT_KEY = 'oz-home-root';

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
