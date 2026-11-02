/** Profiles — the root's agent profiles (config/yggdrasil-profiles.json),
 *  read-only. One loader for the visible pages (the phone shows who can do
 *  what); the brain keeps them AI-owned — the PWA renders, never edits.
 *  Schema is yggdrasil's own registry: agent.<id>.permission[] lines of
 *  {permission, pattern, action}; allow-lines name the tools, a leading
 *  `*`/allow is "every tool" (the build profile). */

import { readFile } from 'fs/promises';
import path from 'path';

export type Profile = {
  id: string;
  description: string;
  /** tools the profile may use, in registry order (the deny-all line first,
   *  then the allowances) */
  tools: string[];
  /** the profile the registry names as default_agent */
  isDefault: boolean;
};

type ProfilesFile = {
  default_agent?: string;
  agent?: Record<
    string,
    {
      description?: string;
      permission?: { permission: string; action: string; pattern?: string }[];
    }
  >;
};

export class ProfilesError extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

/**
 * Where the registry lives: `pwa/../config` when served from the tree's pwa/,
 * a worktree's own config/ when served from a scratch build (same walk-up as
 * lib/artifacts' worktree rule). First file that parses wins — the served
 * tree is the truth for the served app.
 */
function registryPaths(): string[] {
  const paths: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    paths.push(path.join(dir, 'config', 'yggdrasil-profiles.json'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return paths;
}

async function loadRegistry(): Promise<{ file: ProfilesFile; source: string }> {
  for (const p of registryPaths()) {
    try {
      const raw = await readFile(p, 'utf8');
      return { file: JSON.parse(raw) as ProfilesFile, source: p };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new ProfilesError(`registry unreadable (${path.basename(p)}): ${String(e)}`, 500);
    }
  }
  throw new ProfilesError(
    'profile registry not found (config/yggdrasil-profiles.json)',
    404
  );
}

/** The registry's allow-lines, verbatim and in order: a single `*` allow =
 *  every tool (the build profile — shown as a `*` chip, the registry's own
 *  mark). The deny-all opener is not a tool; narrow deny lines are the
 *  registry's carve-outs, not grants. Each permission appears once. */
function toolsOf(entry: NonNullable<ProfilesFile['agent']>[string]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of entry.permission || []) {
    if (line.action === 'deny' && line.permission === '*') continue;
    if (line.action !== 'allow') continue;
    if (seen.has(line.permission)) continue;
    seen.add(line.permission);
    out.push(line.permission);
  }
  return out;
}

/** All profiles, registry order. */
export async function listProfiles(): Promise<Profile[]> {
  const { file } = await loadRegistry();
  const agents = file.agent || {};
  return Object.entries(agents).map(([id, entry]) => ({
    id,
    description: entry.description || '',
    tools: toolsOf(entry),
    isDefault: file.default_agent === id,
  }));
}

/** One profile by id, or null (route answers 404 with the name). */
export async function getProfile(id: string): Promise<Profile | null> {
  const all = await listProfiles();
  return all.find((p) => p.id === id) || null;
}
