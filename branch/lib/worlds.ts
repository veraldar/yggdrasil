/** The eight visual worlds (tokens.css) and the phone's paint cache (per-root world).
 *  Each computer owns its world (`data/root.json`); the phone caches it only so the first
 *  frame paints the right colour before the server answers — server always wins. */
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

/** Deterministic fallback world matching root/src/roots.rs `default_theme_for`. */
export function defaultWorldFor(name: string, isHome = false): WorldId {
  if (isHome || !name) return 'aether';
  const MUL = BigInt(33);
  const MASK = BigInt('0xffffffffffffffff');
  let h = BigInt(5381);
  for (let i = 0; i < name.length; i++) {
    h = (h * MUL + BigInt(name.charCodeAt(i))) & MASK;
  }
  const rest = WORLD_IDS.slice(1);
  return rest[Number(h % BigInt(rest.length))] || 'terminus';
}

const CACHE_KEY = 'oz-root-themes';

function readCache(): Record<string, WorldId> {
  try {
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

export function cachedRootTheme(root: string): WorldId | null {
  if (!root) return null;
  return readCache()[root] ?? null;
}

export function cacheRootTheme(root: string, theme: string) {
  if (!root || !isWorld(theme)) return;
  try {
    const m = readCache();
    if (m[root] === theme) return;
    m[root] = theme;
    localStorage.setItem(CACHE_KEY, JSON.stringify(m));
  } catch {
    /* private mode / quota */
  }
}

export function cacheTreeThemes(tree: {
  home?: { name?: string | null; theme?: string | null } | null;
  roots?: Array<{ id?: string; name?: string; theme?: string | null }>;
}) {
  try {
    const m = readCache();
    let changed = false;
    if (tree.home?.name && isWorld(tree.home.theme) && m[tree.home.name] !== tree.home.theme) {
      m[tree.home.name] = tree.home.theme;
      changed = true;
    }
    for (const r of tree.roots ?? []) {
      const id = r.id || r.name;
      if (id && isWorld(r.theme) && m[id] !== r.theme) {
        m[id] = r.theme;
        changed = true;
      }
    }
    if (changed) localStorage.setItem(CACHE_KEY, JSON.stringify(m));
  } catch {
    /* private mode / quota */
  }
}

/** Temporarily paints `<html data-theme>` and `<meta name="theme-color">` with `theme` while
 *  viewing a computer's page or a session that lives on another computer, restoring the home
 *  world on unmount without touching next-themes' stored home preference. */
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
