/* Service worker: notification clicks focus/open the session — and, once the phone is paired
 * through a trunk, the PINNED channel's door (lib/pinned.ts): every request for the box's data
 * (/api/* except /api/pair/*, and /rtc/*) — fetch, EventSource, <img>, <audio>, <iframe> — is
 * handed to a page that holds the pinned data channel, which carries it end to end. Nothing else
 * changes: the app shell and first contact (pairing) still come from the network. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      self.clients.claim();
      // this SW never caches the app shell — so any cache left by an older
      // SW (a precache era) is stale weight: purge everything that isn't ours
      try {
        const keep = 'bifrost-pin';
        await Promise.all(
          (await caches.keys()).filter((k) => k !== keep).map((k) => caches.delete(k))
        );
      } catch {}
    })()
  )
);

/* page id → its pinned-channel state: off | connecting | pinned | fallback | reconnecting | refused */
const pinStates = new Map();
const pinWaiters = new Map();
/* any page ever announced a pin: an unannounced page's requests wait for it (no leak at boot) */
let pinMode = null;
const MODE_KEY = '/__bifrost/pin-mode';

async function loadMode() {
  if (pinMode !== null) return pinMode;
  try {
    const r = await (await caches.open('bifrost-pin')).match(MODE_KEY);
    pinMode = r ? (await r.text()) === '1' : false;
  } catch {
    pinMode = false;
  }
  return pinMode;
}

function saveMode(on) {
  if (pinMode === on) return;
  pinMode = on;
  caches
    .open('bifrost-pin')
    .then((c) => c.put(MODE_KEY, new Response(on ? '1' : '0')))
    .catch(() => {});
}

self.addEventListener('message', (e) => {
  const s = e.data && e.data.bifrostPin;
  if (!s || !e.source) return;
  pinStates.set(e.source.id, s);
  saveMode(s !== 'off');
  for (const w of pinWaiters.get(e.source.id) || []) w();
  pinWaiters.delete(e.source.id);
  if (s === 'pinned') for (const w of pinWaiters.get('*') || []) w();
  if (s === 'pinned') pinWaiters.delete('*');
});

const tunnelled = (p) =>
  (p.startsWith('/api/') && !p.startsWith('/api/pair')) || p === '/rtc' || p.startsWith('/rtc/');

function waitState(id, ms) {
  return new Promise((done) => {
    const list = pinWaiters.get(id) || [];
    list.push(done);
    pinWaiters.set(id, list);
    setTimeout(done, ms);
  });
}

async function pinnedClient(id) {
  if (pinStates.get(id) === 'pinned') {
    const c = await self.clients.get(id);
    if (c) return c;
  }
  for (const c of await self.clients.matchAll({ type: 'window' })) {
    if (pinStates.get(c.id) === 'pinned') return c;
  }
  return null;
}

const refused = (why) =>
  new Response(JSON.stringify({ error: 'pin-refused', why }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'x-bifrost-via': 'refused' },
  });
/* the page had the channel and lost it (the box restarting): the request is not sent at all —
 * never to the trunk's TLS; the page opens the channel again and the app retries */
const reconnecting = () =>
  new Response(
    JSON.stringify({ error: 'pin-reconnecting', why: 'the pinned channel is coming back' }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'x-bifrost-via': 'reconnecting',
        'retry-after': '1',
      },
    }
  );

/** a load whose client cannot own a pin channel — waiting for its state is a 10 s burn
 *  for an announcement that will never come:
 *   · a frame (destination 'iframe'; sandboxed artifact frames run no scripts), or a
 *     sub-resource of one (the frame's own clientId, frameType 'nested');
 *   · a top-level page under /api/* — an opened artifact (new tab, address bar, the
 *     preview's corner button): its document is the artifact's, the app never loads
 *     there, so its client (the navigation's resultingClientId) never posts bifrostPin —
 *     and the media inside it (its clientId, frameType 'top-level', url under /api/*).
 *  These ride any pinned window's channel at once; with none (fallback, unpaired, a
 *  first load before any announcement) the network, as ever. */
async function isChannelless(e) {
  const d = e.request.destination;
  if (d === 'iframe') return true;
  if (d === 'document') {
    try {
      return new URL(e.request.url).pathname.startsWith('/api/');
    } catch {
      return false;
    }
  }
  if (!e.clientId) return false;
  try {
    const c = await self.clients.get(e.clientId);
    if (!c) return false;
    if (c.frameType === 'nested') return true;
    if (c.frameType === 'top-level') {
      try {
        return new URL(c.url).pathname.startsWith('/api/');
      } catch {
        return false;
      }
    }
  } catch {
    /* fall through */
  }
  return false;
}

async function viaPinned(e) {
  const id = e.clientId || e.resultingClientId || '';
  if (!(await loadMode())) return fetch(e.request);
  // a frame inside a pinned page: no wait for its own state (it posts none) — the parent
  // page's channel carries it at once. No pinned window anywhere (a page in fallback, an
  // unpaired browser, the first load before any announcement): the network, as ever.
  const channelless = await isChannelless(e);
  if (channelless) {
    if (!(await pinnedClient(id))) return fetch(e.request);
  } else
    // a page still opening its channel: its requests wait (bounded) — never the network first
    for (let i = 0; i < 2; i++) {
      const s = pinStates.get(id);
      if (s === 'connecting' || s === 'reconnecting' || (s === undefined && id && i === 0))
        await waitState(id, 10000);
      else break;
    }
  const own = pinStates.get(id);
  if (own === 'refused') return refused('the box key did not match the pairing QR');
  if (!channelless && own === 'reconnecting' && !(await pinnedClient(id))) return reconnecting();
  const c = await pinnedClient(id);
  if (!c) {
    if ([...pinStates.values()].includes('refused'))
      return refused('the box key did not match the pairing QR');
    return fetch(e.request);
  }
  const u = new URL(e.request.url);
  const headers = [];
  e.request.headers.forEach((v, k) => headers.push([k, v]));
  const body = ['GET', 'HEAD'].includes(e.request.method) ? null : await e.request.arrayBuffer();
  const ch = new MessageChannel();
  const answer = new Promise((done) => {
    ch.port1.onmessage = (m) => done(m.data);
  });
  c.postMessage(
    { bifrostTunnel: { method: e.request.method, url: u.pathname + u.search, headers, body } },
    [ch.port2]
  );
  const a = await answer;
  if (a && typeof a.status === 'number') {
    return new Response(a.body || null, {
      status: a.status,
      statusText: a.statusText || '',
      headers: a.headers,
    });
  }
  if (a && a.state === 'refused') return refused('the box key did not match the pairing QR');
  if (a && a.state === 'reconnecting') return reconnecting();
  // the channel could not carry it: the trunk's TLS, as before. One line in
  // the app's diag (kind "pin") so a slow open decomposes from data: which
  // requests fell through, and why (11-24 fix-3 diagnosis — this was the one
  // inferred leg; now it is measured).
  const why =
    own === 'fallback'
      ? 'fallback'
      : a && a.error
        ? `carry:${String(a.error).slice(0, 120)}`
        : a
          ? 'carry:no-answer'
          : 'no-page';
  console.info('[sw] pin fall-through', e.request.method, u.pathname, why);
  return fetch(e.request);
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin || !tunnelled(u.pathname)) return;
  e.respondWith(viaPinned(e));
});

/* Web Push: the proxy fires this the moment a run finishes — works even
 * when Chrome froze the page (in-page Notification() can't). */
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    /* plain-text or empty payload */
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'bifrost', {
      body: data.body || 'replied',
      tag: data.tag || 'oz-reply',
      icon: '/favicon.ico',
      data: { slug: data.slug },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const slug = (e.notification.data || {}).slug;
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (slug && c.url.includes(`/session/${slug}`)) return c.focus();
      }
      for (const c of all) {
        if ('focus' in c) {
          if (slug) c.navigate(`/session/${slug}`).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(slug ? `/session/${slug}` : '/');
    })()
  );
});
