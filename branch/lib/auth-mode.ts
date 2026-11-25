/**
 * The door's auth mode, as GET /api/build reports it: trunk mode (v1, BIFROST_AUTH=trunk) adds
 * `auth: "trunk"`; tailnet and devices answer exactly as before (no field). The trunk-only pieces of the
 * UI — the settings "account & devices ›" link (→ the trunk's /account), the roots sheet's pending roots
 * (GET /t/roots/pending) and its remove (DELETE /t/roots/:id) — switch on it.
 *
 * No request of its own: FreshReload (mounted once in the layout) already asks /api/build on every
 * page load and publishes the answer here.
 */
import { useEffect, useState } from 'react';

export type BuildInfo = { id?: string; ttsVoice?: string; auth?: string };

let known: BuildInfo | null = null;
let settle: (b: BuildInfo) => void = () => {};
const ready = new Promise<BuildInfo>((r) => (settle = r));

/** FreshReload's /api/build answer (the first one wins the promise; later ones update `known`). */
export function publishBuild(b: BuildInfo): void {
  known = b;
  settle(b);
}

export const isTrunk = (b: BuildInfo | null) => b?.auth === 'trunk';

/** resolves once FreshReload has published /api/build (used by non-React modules such as lib/pinned.ts). */
export const buildReady = (): Promise<BuildInfo> => ready;

/** true once /api/build said trunk mode (false until then, and in tailnet / devices mode). */
export function useTrunkMode(): boolean {
  const [trunk, setTrunk] = useState(() => isTrunk(known));
  useEffect(() => {
    let live = true;
    void ready.then((b) => live && setTrunk(isTrunk(b)));
    return () => {
      live = false;
    };
  }, []);
  return trunk;
}
