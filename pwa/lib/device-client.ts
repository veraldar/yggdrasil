/**
 * S1 seam client helper (go-chain Lane B fix, S-size): the browser side of
 * device auth. The token lives in localStorage (shown once at pairing) —
 * this mirrors it into a session cookie so EVERY /api/* call from the app
 * carries the device credential without touching each fetch site.
 *
 * Exposure note (secrets-discipline row for the go-chain sim): the raw token
 * is already client-held by design (localStorage, shown once at mint). The
 * cookie adds no new exposure class — same origin, SameSite=Lax, Secure on
 * https origins. The server keeps ONLY sha256 hashes (devices.ts, 0600).
 */
export const DEVICE_COOKIE = 'bifrost_device';

export function deviceToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('bifrost_device') || '';
}

/** Mirror the stored token into the cookie (idempotent, safe to call on load). */
export function syncDeviceCookie(): void {
  const t = deviceToken();
  if (!t) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${DEVICE_COOKIE}=${encodeURIComponent(t)}; path=/; SameSite=Lax${secure}; max-age=31536000`;
}

/** One-time pairing-URL admin credential: https://host/pair#admin=<token>.
 *  Read → consumed → scrubbed from the address bar immediately (receipt law:
 *  the bootstrap admin token is shown once, never persisted). */
export function consumeAdminFragment(): string | null {
  if (typeof window === 'undefined') return null;
  const m = /(?:^|&)admin=([^&]+)/.exec(window.location.hash.slice(1));
  if (!m) return null;
  const admin = decodeURIComponent(m[1]);
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return admin;
}
