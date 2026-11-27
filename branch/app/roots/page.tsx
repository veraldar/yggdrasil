'use client';

/** /roots/ — the list of every computer of the tree (owner 11-26). A page of its own, no longer an
 *  overlay on home: plain white (no root's theme; each row wears its own root's palette), a back key
 *  to the home screen, and the browser's back button lands here from a computer's page. */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { DOOR_KEY } from '@/lib/tree-first';
import { HOME_ROOT_KEY, RootsSheet, type Tree } from '@/components/roots-sheet';
import { cachedHomePath } from '@/lib/home-path';
import { cacheTreeThemes } from '@/lib/worlds';

export default function RootsPage() {
  const router = useRouter();
  // the status bar is white here too, the theme's colour again on the way out
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const prev = meta?.getAttribute('content') ?? null;
    meta?.setAttribute('content', '#ffffff');
    return () => {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--oz-bg').trim();
      if (meta && (bg || prev)) meta.setAttribute('content', bg || prev || '');
    };
  }, []);
  // a fresh device gets the door wherever it first lands (`/`, `/<home>`, here): not walked → `/`
  useEffect(() => {
    try {
      if (!localStorage.getItem(DOOR_KEY)) {
        window.location.replace('/' + window.location.search + window.location.hash);
      }
    } catch {
      /* private mode can't keep the flag — never trap it off the list */
    }
  }, []);
  const onTree = useCallback((t: Tree) => {
    cacheTreeThemes(t);
    if (t.home?.name) {
      try {
        localStorage.setItem(HOME_ROOT_KEY, t.home.name);
      } catch {
        /* private mode */
      }
    }
  }, []);
  const home = () => router.push(cachedHomePath());
  return <RootsSheet page onClose={home} onTree={onTree} />;
}
