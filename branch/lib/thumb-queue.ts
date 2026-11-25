/** Bounded concurrency gate for gallery thumbnail iframes.
 *  Without a gate, 45+ html cards all fire at once on /artifacts (6.7 MB
 *  uncompressed), jamming the single ordered SCTP pinned DataChannel for
 *  10+ s and causing head-of-line stalls on the top visible cards.
 *  With viewport intersection + MAX_INFLIGHT = 4, visible top rows get full
 *  bandwidth first and cards scrolled past before starting are skipped. */

export type ThumbTicket = {
  /** Mark the iframe load complete (or failed) and free its slot for the next card. */
  done: () => void;
  /** Cancel a queued (not yet started) card, or release an active slot on unmount. */
  cancel: () => void;
};

export function createThumbQueue(maxInflight = 4, safetyReleaseMs = 4_000) {
  let inflight = 0;
  const waiting: Array<{
    start: () => void;
    cancelled: boolean;
  }> = [];

  const pump = () => {
    while (inflight < maxInflight && waiting.length > 0) {
      const next = waiting.shift()!;
      if (next.cancelled) continue;
      inflight++;
      next.start();
    }
  };

  function request(onGrant: () => void): ThumbTicket {
    let granted = false;
    let released = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const release = () => {
      if (released) return;
      released = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (granted) {
        inflight = Math.max(0, inflight - 1);
        pump();
      }
    };

    const entry = {
      cancelled: false,
      start: () => {
        if (entry.cancelled || released) {
          inflight = Math.max(0, inflight - 1);
          pump();
          return;
        }
        granted = true;
        if (safetyReleaseMs > 0) {
          timer = setTimeout(release, safetyReleaseMs);
        }
        onGrant();
      },
    };

    if (inflight < maxInflight) {
      inflight++;
      entry.start();
    } else {
      waiting.push(entry);
    }

    return {
      done: release,
      cancel: () => {
        entry.cancelled = true;
        if (granted) {
          release();
        } else {
          const i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
        }
      },
    };
  }

  return {
    request,
    stats: () => ({ inflight, waiting: waiting.length }),
  };
}

export const thumbQueue = createThumbQueue(4, 4_000);
