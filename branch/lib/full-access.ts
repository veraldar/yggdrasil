/** Full access (owner 11-17): a conversation continued from the terminal may run its turns
 *  outside the sandbox for a while. Only the owner grants that — from the phone, with a key:
 *  the enrollment code typed here ONCE (session settings › full access), kept in this phone's
 *  localStorage, signing every grant as an HMAC. The code itself never travels; the box holds
 *  only the matching owner.key (full-access-enroll.sh, at the computer — full_access.py on the
 *  helper verifies and would refuse anything unsigned, replayed or expired).
 *
 *  Client-side only (WebCrypto + localStorage). The seam is /api/cc-live/* — lib/cc-live.ts. */

const STORE = 'oz-full-access-key';

/** the code as it is signed: its letters and digits, upper case (spaces and dashes in it are
 *  for reading only) — the same normalization the helper applies to owner.key (code_bytes) */
export const keyChars = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/g, '');

async function mac(code: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyChars(code)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type AccessStatus = {
  enabled: boolean;
  enrolled: boolean;
  grants: Record<string, number>;
  max_s?: number;
};

/** the box's full-access state (null: the helper is down or the route is off) */
export const getStatus = (): Promise<AccessStatus | null> =>
  fetch('/api/cc-live/access', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

export const loadKey = (): string => {
  try {
    return localStorage.getItem(STORE) || '';
  } catch {
    return '';
  }
};

export const saveKey = (code: string): void => {
  try {
    localStorage.setItem(STORE, code.trim());
  } catch {
    /* private mode: the code just won't survive a reload */
  }
};

/** is this code the box's enrollment code? (the helper answers from owner.key alone) */
export const checkKey = async (code: string): Promise<boolean> => {
  const ts = Date.now();
  const r = await fetch('/api/cc-live/access/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ts, mac: await mac(code, `check|${ts}`) }),
  }).catch(() => null);
  return !!r?.ok;
};

/** grant one conversation (`kind:id`) for forS seconds — or switch it off (off signs nothing) */
export const setGrant = async (
  key: string,
  on: boolean,
  forS = 0,
  code = loadKey()
): Promise<{ ok: boolean; error?: string; until?: number }> => {
  const ts = Date.now();
  const body = on
    ? { key, on: true, for_s: forS, ts, mac: await mac(code, `grant|${key}|on|${forS}|${ts}`) }
    : { key, on: false, for_s: 0, ts: 0, mac: '' };
  const r = await fetch('/api/cc-live/access/grant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  const d = (await r?.json().catch(() => ({}))) as { error?: string; until?: number };
  return r?.ok ? { ok: true, until: d.until } : { ok: false, error: d.error || `HTTP ${r?.status ?? '?'}` };
};
