/** The composer's upload (contract C): one file to the brain, in pieces of the size it answers
 *  (never more than 1 MiB), through /api/file/upload. Resumes where the brain says it has got
 *  to (409 {have}); a refusal comes back as the brain's own words. */
import { type FileRef, PIECE_MAX } from './file-ref';

export type Uploaded = { ref: FileRef } | { error: string };

async function answer(r: Response): Promise<Record<string, unknown>> {
  return ((await r.json().catch(() => null)) as Record<string, unknown> | null) || {};
}

export async function uploadFile(blob: Blob, name: string, mime: string): Promise<Uploaded> {
  let start: Response;
  try {
    start = await fetch('/api/file/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mime, size: blob.size }),
    });
  } catch {
    return { error: `could not send ${name}` };
  }
  const s = await answer(start);
  if (!start.ok || typeof s.upload !== 'string') {
    return {
      error: typeof s.error === 'string' ? s.error : `could not send ${name} (${start.status})`,
    };
  }
  // an empty file is done at the start (the brain answers its REF there)
  const done = s.file as FileRef | undefined;
  if (done && typeof done.hash === 'string') return { ref: done };
  const piece = Math.max(1, Math.min(Number(s.piece) || PIECE_MAX, PIECE_MAX));
  let have = 0;
  let misses = 0;
  for (;;) {
    let r: Response;
    try {
      r = await fetch(`/api/file/upload/${encodeURIComponent(s.upload)}?offset=${have}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob.slice(have, have + piece),
      });
    } catch {
      // the radio dropped: the same piece again, a few times
      if (++misses > 4) return { error: `could not send ${name}` };
      await new Promise((ok) => setTimeout(ok, 500 * misses));
      continue;
    }
    const d = await answer(r);
    if (r.status === 409 && typeof d.have === 'number') {
      // the brain has a different amount than we thought: go on from there
      if (++misses > 4) return { error: `could not send ${name}` };
      have = d.have;
      continue;
    }
    if (!r.ok) {
      return {
        error: typeof d.error === 'string' ? d.error : `could not send ${name} (${r.status})`,
      };
    }
    const file = d.file as FileRef | undefined;
    if (file && typeof file.hash === 'string') return { ref: file };
    const next = Number(d.have);
    if (!(next > have) || next >= blob.size) return { error: `could not send ${name}` };
    have = next;
    misses = 0;
  }
}
