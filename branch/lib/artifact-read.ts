/** Per-artifact seen watermarks: unseen = file mtime newer than the last
 *  time you opened it. Phone-local, like chat read receipts. A rewrite
 *  moves mtime, so an agent updating a design rings the bell again —
 *  "they updated the mockup" is worth a notification too. */
/** what the watermarks need of a file (an ArtifactEntry, or another computer's row) */
type Seen = { name: string; mtime: number; source?: string };

const KEY = 'oz-artifact-seen';
const INIT = 'oz-artifact-init';

function readAll(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export function lastSeen(name: string): number {
  return readAll()[name] || 0;
}

/** Seen up to `mtime` (the file version you actually opened) — per name,
 *  never goes backwards. */
export function markSeen(name: string, mtime: number): void {
  if (!name || !mtime) return;
  try {
    const all = readAll();
    if ((all[name] || 0) >= mtime) return;
    all[name] = mtime;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}

export function countUnseen(files: Seen[]): number {
  const all = readAll();
  let n = 0;
  for (const f of files) if (f.mtime > (all[f.name] || 0)) n++;
  return n;
}

/** First run after the feature ships: treat everything currently on disk
 *  as seen — a bell opening at "167" helps nobody. Per source: when a phone
 *  first meets a new source (the main tree's dir joined the sandbox gallery
 *  10-26, ~500 files), that source's backlog is seen too; only what lands
 *  after rings. The bare INIT key is the local dir's (pre-sources phones). */
export function seenInit(files: Seen[]): void {
  const key = (src: string) => (src === 'local' ? INIT : `${INIT}:${src}`);
  // local always inits on the first load, even empty — its first file rings
  const srcs = ['local', ...files.map((f) => f.source || 'local')];
  const todo = new Set(srcs.filter((src) => !localStorage.getItem(key(src))));
  if (!todo.size) return;
  for (const f of files) if (todo.has(f.source || 'local')) markSeen(f.name, f.mtime);
  try {
    for (const src of todo) localStorage.setItem(key(src), '1');
  } catch {
    /* private mode */
  }
}

export function markAllSeen(files: Seen[]): void {
  for (const f of files) markSeen(f.name, f.mtime);
}

/** The same watermarks for another computer's files: each is kept under that computer's name
 *  (`<root>/<file>`), so a file there never counts as the home file of the same name — and the
 *  first time this phone meets that computer, what is already there counts as seen (seenInit).
 *  `root` null = the home root's own files, as they are. */
export function forRoot<T extends Seen>(root: string | null, files: T[]): T[] {
  if (!root) return files;
  return files.map((f) => ({ ...f, name: `${root}/${f.name}`, source: `root:${root}` }));
}
