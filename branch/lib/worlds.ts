/** The eight visual worlds (tokens.css) and the per-computer world.
 *
 *  The app has ONE look: the world the owner picked in settings (next-themes, `data-theme` on
 *  <html>). A computer's page, and a session living on another computer, wear a world of their
 *  own only once someone picked one FOR that computer (root settings tab, or MAIN on request):
 *  the brain counts those picks in `theme_rev`. Until then the brain still reports a world —
 *  root/src/roots.rs `default_theme_for` hashes the name into one — but nobody chose it, so it
 *  is ignored here and the page follows the app (owner 11-23 22:19: "keep the same design, the
 *  ux should be the same between root as is our current root").
 *
 *  The phone caches chosen worlds only, so the first frame paints right before the server
 *  answers — server always wins. */
'use client';

import { useEffect } from 'react';

export const WORLDS = [
  { id: 'aether', desc: 'deep-space terminal · plain hairlines' },
  { id: 'terminus', desc: 'ash & ember · corner ticks' },
  { id: 'drift', desc: 'moonlit light · dotted rules' },
  { id: 'divergence', desc: 'the fork · dashed rules' },
  { id: 'transcendence', desc: 'the dissolve · double rules' },
  { id: 'control', desc: 'the notary · corner ticks' },
  { id: 'utopia', desc: 'the orchard · daylight paper' },
  { id: 'stagnation', desc: 'the winter · bare grey' },
] as const;

export type WorldId = (typeof WORLDS)[number]['id'];
export const WORLD_IDS: readonly WorldId[] = WORLDS.map((w) => w.id);
export const SWATCHES = ['bg', 'text', 'success', 'active', 'danger', 'info'] as const;

export function isWorld(v: unknown): v is WorldId {
  return typeof v === 'string' && (WORLD_IDS as readonly string[]).includes(v);
}

/** The world someone picked for a computer, or null when its world is only the brain's
 *  name-hashed default (`theme_rev` 0 or absent: an older brain, a never-touched computer). */
export function chosenWorld(theme: unknown, rev: unknown): WorldId | null {
  return isWorld(theme) && typeof rev === 'number' && rev > 0 ? theme : null;
}

// 'oz-root-themes' (release 20261123-2204) also cached the brain's unchosen defaults, which is
// what painted debian-box dark: it is dropped, never read
const CACHE_KEY = 'oz-root-worlds';
const OLD_CACHE_KEY = 'oz-root-themes';

function readCache(): Record<string, WorldId> {
  try {
    localStorage.removeItem(OLD_CACHE_KEY);
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, WorldId> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isWorld(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeCache(m: Record<string, WorldId>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(m));
  } catch {
    /* private mode / quota */
  }
}

/** the world picked for `root`, as this phone last heard it (null: none picked) */
export function cachedRootTheme(root: string): WorldId | null {
  if (!root) return null;
  return readCache()[root] ?? null;
}

/** remember `root`'s picked world (null: it has none — forget any old one) */
export function cacheRootTheme(root: string, theme: WorldId | null) {
  if (!root) return;
  const m = readCache();
  if (theme ? m[root] === theme : !(root in m)) return;
  if (theme) m[root] = theme;
  else delete m[root];
  writeCache(m);
}

/** one GET /api/roots answer → the cache holds exactly the computers that have a picked world
 *  (never home: its world is the app's own, next-themes keeps that one) */
export function cacheTreeThemes(tree: {
  home?: { name?: string | null; theme?: string | null; theme_rev?: number } | null;
  roots?: Array<{ id?: string; name?: string; theme?: string | null; theme_rev?: number }>;
}) {
  const m = readCache();
  let changed = false;
  const put = (id: string | null | undefined, w: WorldId | null) => {
    if (!id) return;
    if (w && m[id] !== w) {
      m[id] = w;
      changed = true;
    } else if (!w && id in m) {
      delete m[id];
      changed = true;
    }
  };
  put(tree.home?.name, null);
  for (const r of tree.roots ?? []) put(r.id || r.name, chosenWorld(r.theme, r.theme_rev));
  if (changed) writeCache(m);
}

/** Temporarily paints `<html data-theme>` and `<meta name="theme-color">` with `theme` while
 *  viewing a computer's page or a session that lives on another computer, restoring the home
 *  world on unmount without touching next-themes' stored home preference. null = nothing to
 *  paint: the page keeps the app's own world. */
export function useScopedTheme(theme: WorldId | null | undefined) {
  useEffect(() => {
    if (!theme) return;
    const html = document.documentElement;
    const prev = html.getAttribute('data-theme');
    html.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    const prevMeta = meta?.getAttribute('content') ?? null;
    const bg = getComputedStyle(html).getPropertyValue('--oz-bg').trim();
    if (bg && meta) meta.setAttribute('content', bg);
    return () => {
      if (prev) html.setAttribute('data-theme', prev);
      else html.removeAttribute('data-theme');
      const restored = getComputedStyle(html).getPropertyValue('--oz-bg').trim();
      if (meta && (restored || prevMeta)) meta.setAttribute('content', restored || prevMeta || '');
    };
  }, [theme]);
}
