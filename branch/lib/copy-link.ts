'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** The absolute URL of an app-relative artifact path (`/api/artifact/<name>[?root=…]`) on the
 *  origin the phone is on right now. */
export function absoluteUrl(path: string): string {
  try {
    return new URL(path, window.location.origin).href;
  } catch {
    return path;
  }
}

/** Put `text` on the clipboard. Must run inside the tap handler (user gesture).
 *  1. the async Clipboard API (https), 2. a hidden textarea + execCommand('copy'),
 *  3. last resort: window.prompt with the text preselected ("press and hold to copy"). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* blocked (permissions, insecure context) — fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) return true;
  } catch {
    /* fall through */
  }
  try {
    window.prompt('press and hold to copy', text);
  } catch {
    /* no prompt either */
  }
  return false;
}

/** copy state for one key: `copied` is true for 2 s after a successful copy */
export function useCopyLink(path: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = useCallback(() => {
    void copyText(absoluteUrl(path)).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [path]);
  return { copied, copy };
}
