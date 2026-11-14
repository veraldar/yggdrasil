/**
 * The pinned channel — after pairing, the phone's app traffic rides a WebRTC
 * data channel to the box, end to end, keyed by the box identity the pairing
 * QR pinned (docs/own-trunk.md, "What the server can see").
 *
 * Through the trunk the access point terminates the app's TLS: whoever runs
 * the VPS could read every API call. So once a pin exists, this module opens
 * a data channel `tun` to the box's bridge (signaling: POST /offer through the
 * ap — its answer must carry the pinned DTLS fingerprint, or the phone refuses
 * it before a byte flows), media path: ICE over TCP via the trunk's :443 (or
 * the LAN). Over it ride raw HTTP/1.1 streams — the bridge applies the same
 * law as the access point's edge (ap.rs: device gate, one request per stream,
 * websocket upgrades) with the device credential it bound at /offer.
 *
 *   - /api/* (except /api/pair/*: pairing is first contact) and /rtc/* — every
 *     fetch, EventSource, <img>/<audio>/<iframe> — reach it through the
 *     service worker (public/sw.js), which asks this page to carry them;
 *   - WebSockets to /rtc (LiveKit's signaling) through `TunnelWebSocket`: the
 *     LiveKit DTLS fingerprint then arrives over the pinned channel, so the
 *     VPS cannot swap it either.
 *
 * States (the indicator, components/pin-state.tsx): off (no pin) · connecting
 * (requests wait) · pinned · fallback (the channel cannot come up: the trunk's
 * TLS carries the app, as before) · refused (the box key did not match: a man
 * in the middle — nothing is sent, nothing falls back).
 */
import { type Pin, PinMismatch, assertPinned, loadPin } from '@/lib/p2p';

export type PinState = 'off' | 'connecting' | 'pinned' | 'fallback' | 'refused';

const OPEN = 1;
const DATA = 2;
const CLOSE = 3;
const AUTH = 5;
const CHUNK = 16 * 1024;
const CONNECT_MS = 8_000;
const REFRESH_EVERY_MS = 12 * 60_000; // access tokens live 15 min (lib/devices.ts)

const enc = new TextEncoder();
const dec = new TextDecoder();

/** paths that ride the pinned channel (everything else is the app shell or first contact) */
export function tunnelled(path: string): boolean {
  return (
    (path.startsWith('/api/') && !path.startsWith('/api/pair')) ||
    path === '/rtc' ||
    path.startsWith('/rtc/')
  );
}

function frame(kind: number, id: number, payload?: Uint8Array): Uint8Array {
  const f = new Uint8Array(5 + (payload?.length || 0));
  f[0] = kind;
  new DataView(f.buffer).setUint32(1, id);
  if (payload) f.set(payload, 5);
  return f;
}

type Sink = { data: (b: Uint8Array) => void; close: () => void };

class Link {
  private streams = new Map<number, Sink>();
  private next = 1;
  onClose: (why: string) => void = () => {};

  constructor(
    readonly pc: RTCPeerConnection,
    private dc: RTCDataChannel
  ) {
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => {
      const b = new Uint8Array(e.data as ArrayBuffer);
      if (b.length < 5) return;
      const id = new DataView(b.buffer, b.byteOffset).getUint32(1);
      const s = this.streams.get(id);
      if (!s) return;
      if (b[0] === DATA) s.data(b.subarray(5));
      else if (b[0] === CLOSE) {
        this.streams.delete(id);
        s.close();
        this.send(frame(CLOSE, id)); // the box's side of the stream ends too
      }
    };
    dc.onclose = () => this.end('channel closed');
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.end(`peer ${pc.connectionState}`);
    });
  }

  get up() {
    return this.dc.readyState === 'open';
  }

  private ended = false;
  private end(why: string) {
    if (this.ended) return;
    this.ended = true;
    for (const s of this.streams.values()) s.close();
    this.streams.clear();
    this.onClose(why);
  }

  send(b: Uint8Array) {
    if (this.dc.readyState === 'open') this.dc.send(b as Uint8Array<ArrayBuffer>);
  }

  /** a new stream: its head now, then `write` / `abort`; answers to `sink` */
  stream(head: Uint8Array, sink: Sink) {
    const id = this.next++;
    this.streams.set(id, sink);
    this.send(frame(OPEN, id, head));
    return {
      write: (b: Uint8Array) => {
        for (let o = 0; o < b.length; o += CHUNK)
          this.send(frame(DATA, id, b.subarray(o, o + CHUNK)));
      },
      abort: () => {
        if (this.streams.delete(id)) this.send(frame(CLOSE, id));
      },
    };
  }

  auth(token: string) {
    this.send(frame(AUTH, 0, enc.encode(token)));
  }

  close() {
    this.pc.close();
  }
}

// ---- the state machine --------------------------------------------------------------------

let state: PinState = 'off';
let why = '';
let link: Link | null = null;
let opening: Promise<void> | null = null;
const listeners = new Set<(s: PinState, why: string) => void>();
const waiters: Array<() => void> = [];
let origFetch: typeof fetch | null = null;

function setState(s: PinState, w = '') {
  state = s;
  why = w;
  for (const l of listeners) l(s, w);
  if (s !== 'connecting') waiters.splice(0).forEach((f) => f());
  tellWorker();
}

export const pinState = () => ({ state, why });
export function onPinState(f: (s: PinState, why: string) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function tellWorker() {
  try {
    navigator.serviceWorker?.controller?.postMessage({ bifrostPin: state });
  } catch {
    /* no worker: nothing to tell */
  }
}

/** wait until the state is no longer `connecting` (bounded) */
function settled(): Promise<void> {
  if (state !== 'connecting') return Promise.resolve();
  return new Promise((done) => {
    waiters.push(done);
    setTimeout(done, CONNECT_MS + 2_000);
  });
}

function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((done) => {
    if (pc.iceGatheringState === 'complete') return done();
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        done();
      }
    });
  });
}

async function openLink(pin: Pin): Promise<Link> {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel('tun', { ordered: true });
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, 1_500);
    const post = () =>
      origFetch!('/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pc.localDescription),
        credentials: 'same-origin',
      });
    let r = await post();
    if (r.status === 401) {
      // an expired access cookie: one refresh (first contact), then once more
      const hint = await r.json().catch(() => ({}));
      if (hint?.reauth !== 'refresh')
        throw new Error(`the box refused this phone (${hint?.why || 401})`);
      const f = await origFetch!('/api/pair/refresh', { method: 'POST' });
      if (!f.ok) throw new Error('the box refused this phone (refresh)');
      r = await post();
    }
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) {
      throw new Error(`no pinned channel here (${r.status})`);
    }
    const answer = (await r.json()) as RTCSessionDescriptionInit;
    assertPinned(answer.sdp || '', pin); // a swapped key ends it HERE: PinMismatch
    await pc.setRemoteDescription(answer);
    await new Promise<void>((done, fail) => {
      if (dc.readyState === 'open') return done();
      const t = setTimeout(() => fail(new Error('the pinned channel did not open')), CONNECT_MS);
      dc.onopen = () => {
        clearTimeout(t);
        done();
      };
    });
    return new Link(pc, dc);
  } catch (e) {
    pc.close();
    throw e;
  }
}

function connect(pin: Pin): Promise<void> {
  opening ??= (async () => {
    setState('connecting');
    try {
      const l = await openLink(pin);
      link = l;
      l.onClose = (w) => {
        if (link !== l) return;
        link = null;
        // the box hung up (a revoked device, a lapsed token, the network): try once more
        setState('connecting', w);
        setTimeout(() => void connect(pin), 500);
      };
      setState('pinned');
    } catch (e) {
      link = null;
      if (e instanceof PinMismatch) setState('refused', String(e.message));
      else setState('fallback', e instanceof Error ? e.message : String(e));
    } finally {
      opening = null;
    }
  })();
  return opening;
}

// ---- HTTP over a stream ------------------------------------------------------------------

export type TunnelRequest = {
  method: string;
  url: string; // path + query
  headers: Array<[string, string]>;
  body: ArrayBuffer | null;
};

const SKIP = new Set([
  'host',
  'connection',
  'content-length',
  'cookie',
  'transfer-encoding',
  'keep-alive',
]);

function headOf(r: TunnelRequest, extra: Array<[string, string]> = []): Uint8Array {
  let h = `${r.method} ${r.url} HTTP/1.1\r\nHost: ${location.host}\r\n`;
  for (const [k, v] of [...r.headers, ...extra]) {
    if (!SKIP.has(k.toLowerCase()) && !/[\r\n]/.test(k + v)) h += `${k}: ${v}\r\n`;
  }
  if (r.body && r.body.byteLength) h += `Content-Length: ${r.body.byteLength}\r\n`;
  return enc.encode(h + '\r\n');
}

type Head = { status: number; statusText: string; headers: Array<[string, string]> };

function parseHead(b: Uint8Array): Head {
  const lines = dec.decode(b).split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(lines[0] || '');
  const headers: Array<[string, string]> = [];
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) headers.push([l.slice(0, i).trim(), l.slice(i + 1).trim()]);
  }
  return { status: m ? Number(m[1]) : 502, statusText: m?.[2] || '', headers };
}

const find = (b: Uint8Array, seq: number[], from = 0) => {
  outer: for (let i = from; i <= b.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (b[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
};
const CRLF = [13, 10];
const CRLF2 = [13, 10, 13, 10];
const cat = (a: Uint8Array, b: Uint8Array) => {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
};

/** a de-chunker for Transfer-Encoding: chunked (push bytes, get body bytes) */
function dechunker() {
  let buf: Uint8Array = new Uint8Array(0);
  let need = -1; // bytes left of the current chunk (+2 for its CRLF); -1 = reading a size line
  let done = false;
  return {
    push(b: Uint8Array): Uint8Array[] {
      buf = cat(buf, b);
      const out: Uint8Array[] = [];
      while (!done) {
        if (need < 0) {
          const e = find(buf, CRLF);
          if (e < 0) break;
          const size = parseInt(dec.decode(buf.subarray(0, e)).split(';')[0].trim(), 16);
          buf = buf.subarray(e + 2);
          if (!size) {
            done = true;
            break;
          }
          need = size + 2;
        } else {
          if (buf.length < need) {
            if (buf.length > 2 && need - 2 > 0) {
              const take = Math.min(buf.length, need - 2);
              out.push(buf.slice(0, take));
              buf = buf.subarray(take);
              need -= take;
            }
            break;
          }
          if (need > 2) out.push(buf.slice(0, need - 2));
          buf = buf.subarray(need);
          need = -1;
        }
      }
      return out;
    },
    get done() {
      return done;
    },
  };
}

/** one HTTP request over the pinned channel → a streaming Response */
export function tunnelFetch(r: TunnelRequest, signal?: AbortSignal): Promise<Response> {
  const l = link;
  if (!l || !l.up) return Promise.reject(new Error('no pinned channel'));
  return new Promise((resolve, reject) => {
    let head: Uint8Array | null = new Uint8Array(0);
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    let chunked: ReturnType<typeof dechunker> | null = null;
    let left = -1; // content-length still to come (-1 = until close)
    const early: Uint8Array[] = [];
    const deliver = (b: Uint8Array) => {
      if (!b.length) return;
      if (ctl) ctl.enqueue(b);
      else early.push(b);
    };
    const finish = () => {
      try {
        ctl?.close();
      } catch {
        /* already closed */
      }
    };
    const body = (b: Uint8Array) => {
      if (chunked) {
        for (const x of chunked.push(b)) deliver(x);
        if (chunked.done) finish();
      } else if (left >= 0) {
        const take = b.subarray(0, left);
        left -= take.length;
        deliver(take);
        if (left === 0) finish();
      } else deliver(b);
    };
    const onHead = (h: Head, rest: Uint8Array) => {
      const hv = (k: string) => h.headers.find(([n]) => n.toLowerCase() === k)?.[1] || '';
      if (/chunked/i.test(hv('transfer-encoding'))) chunked = dechunker();
      else if (hv('content-length')) left = Number(hv('content-length'));
      const nullBody = [101, 204, 205, 304].includes(h.status) || r.method === 'HEAD';
      const stream = nullBody
        ? null
        : new ReadableStream<Uint8Array>({
            start(c) {
              ctl = c;
              early.splice(0).forEach((x) => c.enqueue(x));
            },
            cancel() {
              s.abort();
            },
          });
      const headers = new Headers();
      for (const [k, v] of h.headers) {
        const lk = k.toLowerCase();
        if (!['transfer-encoding', 'connection', 'content-length', 'set-cookie'].includes(lk))
          headers.append(k, v);
      }
      headers.set('x-bifrost-via', 'pinned');
      resolve(new Response(stream, { status: h.status, statusText: h.statusText, headers }));
      if (rest.length) body(rest);
      if (left === 0 || nullBody) finish();
    };
    const s = l.stream(headOf(r), {
      data: (b) => {
        if (!head) return body(b);
        head = cat(head, b);
        const e = find(head, CRLF2);
        if (e < 0) return;
        const h = parseHead(head.subarray(0, e));
        const rest = head.subarray(e + 4);
        head = null;
        onHead(h, rest);
      },
      close: () => {
        if (head) reject(new Error('the box closed the stream before answering'));
        finish();
      },
    });
    if (r.body && r.body.byteLength) s.write(new Uint8Array(r.body));
    signal?.addEventListener('abort', () => s.abort(), { once: true });
  });
}

// ---- WebSocket over a stream (LiveKit's signaling) -----------------------------------------

const RealWS =
  typeof window !== 'undefined' ? window.WebSocket : (undefined as unknown as typeof WebSocket);

/** A WebSocket whose bytes ride the pinned channel (RFC 6455 framing done here). */
export class TunnelWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = 'blob';
  protocol = '';
  extensions = '';
  bufferedAmount = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private s: { write: (b: Uint8Array) => void; abort: () => void } | null = null;
  private buf: Uint8Array = new Uint8Array(0);
  private head: Uint8Array | null = new Uint8Array(0);
  private frag: Uint8Array[] = [];
  private fragOp = 0;
  private closeSent = false;

  constructor(
    readonly url: string,
    protocols?: string | string[]
  ) {
    super();
    const u = new URL(url);
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const extra: Array<[string, string]> = [
      ['Upgrade', 'websocket'],
      ['Connection', 'Upgrade'],
      ['Sec-WebSocket-Key', key],
      ['Sec-WebSocket-Version', '13'],
    ];
    const ps = typeof protocols === 'string' ? [protocols] : protocols || [];
    if (ps.length) extra.push(['Sec-WebSocket-Protocol', ps.join(', ')]);
    const l = link;
    if (!l || !l.up) {
      setTimeout(() => this.fail(1006, 'no pinned channel'), 0);
      return;
    }
    const req: TunnelRequest = {
      method: 'GET',
      url: u.pathname + u.search,
      headers: [],
      body: null,
    };
    // Connection: Upgrade must survive headOf's filter: written by hand
    let h = dec.decode(headOf(req)).replace(/\r\n$/, '');
    for (const [k, v] of extra) h += `${k}: ${v}\r\n`;
    this.s = l.stream(enc.encode(h + '\r\n'), {
      data: (b) => this.data(b),
      close: () => this.fail(1006, 'stream closed'),
    });
  }

  private emit(type: string, e: Event) {
    const h = (this as unknown as Record<string, ((e: Event) => void) | null>)[`on${type}`];
    h?.call(this, e);
    this.dispatchEvent(e);
  }

  private fail(code: number, reason: string) {
    if (this.readyState === 3) return;
    const wasOpen = this.readyState === 1;
    this.readyState = 3;
    if (!wasOpen || code !== 1000) this.emit('error', new Event('error'));
    this.emit('close', new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
    this.s?.abort();
  }

  private data(b: Uint8Array) {
    if (this.head) {
      this.head = cat(this.head, b);
      const e = find(this.head, CRLF2);
      if (e < 0) return;
      const h = parseHead(this.head.subarray(0, e));
      const rest = this.head.subarray(e + 4);
      this.head = null;
      if (h.status !== 101) return this.fail(1006, `upgrade refused (${h.status})`);
      this.protocol =
        h.headers.find(([k]) => k.toLowerCase() === 'sec-websocket-protocol')?.[1] || '';
      this.readyState = 1;
      this.emit('open', new Event('open'));
      if (rest.length) this.data(rest);
      return;
    }
    this.buf = cat(this.buf, b);
    for (;;) {
      const f = this.buf;
      if (f.length < 2) return;
      let n = f[1] & 0x7f;
      let p = 2;
      if (n === 126) {
        if (f.length < 4) return;
        n = (f[2] << 8) | f[3];
        p = 4;
      } else if (n === 127) {
        if (f.length < 10) return;
        n = Number(new DataView(f.buffer, f.byteOffset + 2, 8).getBigUint64(0));
        p = 10;
      }
      const masked = (f[1] & 0x80) !== 0;
      const mk = masked ? f.subarray(p, p + 4) : null;
      if (masked) p += 4;
      if (f.length < p + n) return;
      let payload = f.slice(p, p + n);
      if (mk) payload = payload.map((x, i) => x ^ mk[i % 4]);
      this.buf = f.subarray(p + n);
      const fin = (f[0] & 0x80) !== 0;
      const op = f[0] & 0x0f;
      if (op === 0x8) {
        const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
        if (!this.closeSent) this.sendFrame(0x8, payload.subarray(0, 2));
        this.readyState = 3;
        this.emit(
          'close',
          new CloseEvent('close', { code, reason: dec.decode(payload.subarray(2)), wasClean: true })
        );
        this.s?.abort();
        return;
      }
      if (op === 0x9) {
        this.sendFrame(0xa, payload);
        continue;
      }
      if (op === 0xa) continue;
      if (op !== 0) {
        this.fragOp = op;
        this.frag = [];
      }
      this.frag.push(payload);
      if (!fin) continue;
      const whole = this.frag.length === 1 ? this.frag[0] : this.frag.reduce(cat);
      this.frag = [];
      const data =
        this.fragOp === 1
          ? dec.decode(whole)
          : this.binaryType === 'arraybuffer'
            ? whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.byteLength)
            : new Blob([whole as Uint8Array<ArrayBuffer>]);
      this.emit('message', new MessageEvent('message', { data }));
    }
  }

  private sendFrame(op: number, payload: Uint8Array) {
    const n = payload.length;
    const hdr = n < 126 ? 2 : n < 65536 ? 4 : 10;
    const f = new Uint8Array(hdr + 4 + n);
    f[0] = 0x80 | op;
    if (n < 126) f[1] = 0x80 | n;
    else if (n < 65536) {
      f[1] = 0x80 | 126;
      f[2] = n >> 8;
      f[3] = n & 0xff;
    } else {
      f[1] = 0x80 | 127;
      new DataView(f.buffer).setBigUint64(2, BigInt(n));
    }
    const mk = crypto.getRandomValues(new Uint8Array(4));
    f.set(mk, hdr);
    for (let i = 0; i < n; i++) f[hdr + 4 + i] = payload[i] ^ mk[i % 4];
    this.s?.write(f);
  }

  send(d: string | ArrayBufferLike | ArrayBufferView | Blob) {
    if (this.readyState !== 1) throw new DOMException('not open', 'InvalidStateError');
    if (typeof d === 'string') return this.sendFrame(0x1, enc.encode(d));
    if (d instanceof Blob) {
      void d.arrayBuffer().then((b) => this.sendFrame(0x2, new Uint8Array(b)));
      return;
    }
    const u = ArrayBuffer.isView(d)
      ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
      : new Uint8Array(d as ArrayBuffer);
    this.sendFrame(0x2, u);
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const p = cat(new Uint8Array([code >> 8, code & 0xff]), enc.encode(reason));
    this.closeSent = true;
    this.sendFrame(0x8, p);
    setTimeout(() => {
      if (this.readyState !== 3) {
        this.readyState = 3;
        this.emit('close', new CloseEvent('close', { code, reason, wasClean: true }));
        this.s?.abort();
      }
    }, 1_000);
  }
}

// ---- boot ------------------------------------------------------------------------------------

/** the page's half of the service worker's tunnel: carry one request, stream the answer back */
async function carry(e: MessageEvent) {
  const req = (e.data as { bifrostTunnel?: TunnelRequest }).bifrostTunnel;
  const port = e.ports[0];
  if (!req || !port) return;
  await settled();
  if (state !== 'pinned' || !link) {
    port.postMessage({ state });
    return;
  }
  try {
    const res = await tunnelFetch(req);
    const headers: Array<[string, string]> = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    const body = res.body;
    port.postMessage(
      { status: res.status, statusText: res.statusText, headers, body },
      body ? [body as unknown as Transferable] : []
    );
  } catch (err) {
    port.postMessage({ state, error: String(err) });
  }
}

/** a fetch the service worker is not (yet) in charge of: carried here, the same law */
async function inPage(orig: typeof fetch, input: RequestInfo | URL, init?: RequestInit) {
  const req = new Request(input, init);
  await settled();
  if (state === 'refused')
    return new Response(JSON.stringify({ error: 'pin-refused', why }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'x-bifrost-via': 'refused' },
    });
  if (state !== 'pinned' || !link) return orig(req);
  const headers: Array<[string, string]> = [];
  req.headers.forEach((v, k) => headers.push([k, v]));
  const u = new URL(req.url);
  const body = ['GET', 'HEAD'].includes(req.method) ? null : await req.arrayBuffer();
  return tunnelFetch({ method: req.method, url: u.pathname + u.search, headers, body }, req.signal);
}

/** learn every renewed access token (pairing and refresh answer with it) → the box's peer */
function watchTokens(orig: typeof fetch): typeof fetch {
  return async (input, init) => {
    const target = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      location.href
    );
    if (
      state !== 'off' &&
      target.origin === location.origin &&
      tunnelled(target.pathname) &&
      !navigator.serviceWorker?.controller
    ) {
      return inPage(orig, input, init);
    }
    const res = await orig(input, init);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const p = new URL(url, location.href).pathname;
      if (res.ok && (p === '/api/pair/refresh' || p === '/api/pair/claim')) {
        const t = (await res.clone().json())?.accessToken;
        if (typeof t === 'string' && link) link.auth(t);
      }
    } catch {
      /* not ours to read */
    }
    return res;
  };
}

/** beacons (lib/diag.ts flushes with one) do not pass a service worker: carried here too */
function patchBeacon() {
  const beacon = navigator.sendBeacon?.bind(navigator);
  if (beacon) {
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      const u = new URL(String(url), location.href);
      if (u.origin !== location.origin || !tunnelled(u.pathname) || state === 'off')
        return beacon(url, data);
      if (state === 'refused') return true; // dropped: nothing to an attacked trunk
      if (state !== 'pinned') return state === 'fallback' ? beacon(url, data) : true;
      void new Response(data ?? null)
        .arrayBuffer()
        .then((body) =>
          tunnelFetch({
            method: 'POST',
            url: u.pathname + u.search,
            headers: [['content-type', 'application/json']],
            body,
          })
        )
        .catch(() => {});
      return true;
    };
  }
}

/** pairing just saved a pin (app/pair): from now on this page sends the box's data nowhere but
 *  the pinned channel — what it still has to say on the way out waits, and the service worker
 *  holds the next page's requests until that page's channel is up */
export function pinSaved(): void {
  if (state === 'off') setState('connecting', 'paired — opening the pinned channel');
}

let booted = false;

/** start the pinned channel for this page (idempotent): called by the root layout */
export function bootPinned(): void {
  if (booted || typeof window === 'undefined') return;
  booted = true;
  origFetch = window.fetch.bind(window);
  window.fetch = watchTokens(origFetch);
  patchBeacon();
  const pin = loadPin();
  if (!pin?.fp || location.protocol !== 'https:' || !('RTCPeerConnection' in window)) {
    setState('off');
    return;
  }
  // LiveKit's signaling (and any websocket to the box) rides the channel when it is up
  const Real = RealWS;
  const Patched = function (url: string | URL, protocols?: string | string[]) {
    const u = new URL(String(url), location.href);
    if (u.host === location.host && tunnelled(u.pathname) && state === 'pinned') {
      return new TunnelWebSocket(u.href, protocols);
    }
    return new Real(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  Patched.prototype = Real.prototype;
  window.WebSocket = Patched;
  navigator.serviceWorker?.addEventListener('message', (e) => void carry(e));
  navigator.serviceWorker?.addEventListener('controllerchange', tellWorker);
  void connect(pin);
  // keep the box's peer credential fresh (the bridge severs a lapsed one)
  setInterval(() => {
    if (state === 'pinned')
      void origFetch!('/api/pair/refresh', { method: 'POST' }).then(async (r) => {
        const t = r.ok ? (await r.json().catch(() => null))?.accessToken : null;
        if (typeof t === 'string' && link) link.auth(t);
      });
  }, REFRESH_EVERY_MS);
}

/** what the pinned peer connection selected (the indicator's detail; tests) */
export async function pinnedPath(): Promise<string> {
  if (!link) return '';
  const st = await link.pc.getStats();
  let out = '';
  st.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) {
      const pair = st.get(s.selectedCandidatePairId);
      const r = pair && st.get(pair.remoteCandidateId);
      if (r) out = `${r.protocol} ${r.address}:${r.port}`;
    }
  });
  return out;
}
