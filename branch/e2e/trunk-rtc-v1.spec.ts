import { execFileSync } from 'child_process';
import { createHmac } from 'crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { RoomServiceClient } from 'livekit-server-sdk';
import { join } from 'path';
import { type Browser, type BrowserContext, type Page, chromium, devices, expect, test } from '@playwright/test';

/**
 * G3.2 · VOICE OVER THE v1 TRUNK — run by sim/trunk-rtc-v1-e2e.sh (the v1 port of trunk-rtc.spec.ts,
 * which stays the v0.9 baseline). Three machines in private network namespaces: the phone, the VPS
 * (sni-443.py on :443 → the eye → `bifrost-net trunk` with its own TLS; the ICE route → a byte tap →
 * the trunk's ICE-TCP listener, routed by REGISTERED ufrag) and the root at home (the bridge's
 * `[trunk]` link dialing OUT, the app in BIFROST_AUTH=trunk, LiveKit, the real voice agent, real
 * speech engines, the brain on the mock model). The phone and the root reach the VPS on tcp 443 only.
 * The trunk was claimed (F1) and the root enrolled (F4) by the rig before this runs.
 *
 * This harness runs AT HOME. The admin's browser (the owner's laptop, signed in to the trunk) is its
 * own Chromium at home reaching https://ap.tree.test through the VPS; the phone is its own Chromium
 * in the phone's namespace, its microphone a WAV ("what is two plus two?").
 *
 *  R1 the admin's /pair QR (POST /t/pair/qr) → the phone redeems it (POST /t/pair/redeem) → the door
 *  P1 the app rides the PINNED channel: ICE-TCP <vps>:443 to the bridge, its DTLS key = the trunk
 *     directory's pin for this root (/t/me/roots, remembered per root), the str0m ufrag registered
 *  R2 hold the roots and talk: the WAV → LiveKit over ICE-TCP → the agent's STT → MAIN
 *  R3 the reply is spoken back over the voice room; STT of the received bytes matches MAIN's reply
 *  R4 the media path: selected pair tcp <vps>:443, UDP dropped, LiveKit saw a tcp participant
 *  R5 the VPS forwarded only STUN/DTLS/SRTP and holds no key of the call (no LiveKit secret, no
 *     DTLS / root / WireGuard private key of the root)
 *  E1 the VPS's own eyes (it holds the trunk's TLS key): after pairing no app data crossed it — no
 *     API call, no /rtc, no transcript, no reply, no session id, no LiveKit DTLS key
 *  U1 §5.7 on the PINNED path: every ufrag of LiveKit's answers to this phone was registered by
 *     the root over /t/root (acked before the SDP went on) and the trunk routes it (GET
 *     /t/ice/owner → 200; a made-up ufrag → 404)
 *  R6 the admin removes the phone on /devices (DELETE /t/devices/:id): voice cut ≤ 1 s (out of the
 *     room), the pinned channel severed ≤ 1 s, the phone's next call 401 revoked / login
 *  U2 §5.7 on the PLAIN path: phone B (paired by `trunk-ctl pair-qr`; its directory entry carries no
 *     pin — a root enrolled without a DTLS identity) talks with /rtc through the trunk relay: its
 *     LiveKit ufrags registered there, routed, the words reach MAIN
 *  R7 `trunk-ctl devices revoke` on phone B: voice cut ≤ 1 s, its plain /rtc severed, 401 revoked
 *  M1 an ACTIVE man in the middle at the VPS swaps the root's DTLS fingerprint in the /offer answer:
 *     a fresh phone refuses the channel, says so, no fallback, sends the VPS no app data
 *  M2 the VPS also swaps the directory's pin: the phone that remembered the real key raises the
 *     pin-change alarm (D3), refuses, no fallback, no app data
 *  ∀  the phone only ever reached the trunk's origin
 * Every step lands in $PW_STATE/steps.tsv (the table the script prints, with its timings).
 */

const AP = process.env.PW_AP_URL || '';
const AP_IP = process.env.PW_AP_IP || '';
const STATE = process.env.PW_STATE || '';
const HOME = process.env.PW_HOME || '';
const HOME_ID = process.env.PW_HOME_ID || '';
const HOME_DIR = process.env.PW_HOME_DIR || '';
const VOICE = process.env.PW_VOICE || '';
const PHONE_CHROME = process.env.PW_PHONE_CHROME || '';
const TAP = process.env.PW_TAP || '';
const VPS_DIR = process.env.PW_VPS_DIR || '';
const VPS_NETNS = process.env.PW_VPS_NETNS || '';
const TRUNK_HTTP = process.env.PW_TRUNK_HTTP || '';
const ADMIN = process.env.PW_ADMIN || '';
const CTL = (process.env.PW_CTL || '').split(' ').filter(Boolean);
const LK = {
  url: process.env.PW_LK_API || '',
  key: process.env.PW_LK_KEY || '',
  secret: process.env.PW_LK_SECRET || '',
};
const EYE = process.env.PW_EYE || '';
const MITM = process.env.PW_MITM || '';
const WAV = join(__dirname, 'fixtures/first-turn-en.wav');
const ROOM = 'main';
const HUMAN = `user_${ROOM}`;
const HOST = new URL(AP || 'https://x.invalid').hostname;
const PIN_CHANGED = "this computer's key changed";

test.skip(!AP || !STATE || !HOME_ID || !PHONE_CHROME || !ADMIN || !CTL.length, 'run by sim/trunk-rtc-v1-e2e.sh');

type J = Record<string, unknown>;
type Msg = { info: { id?: string; role: string; time?: { created?: number } }; parts: { type: string; text?: string }[] };
const screens: Array<[string, Page]> = [];

function record(n: string, ok: boolean, what: string, detail = '') {
  const clean = (s: string) =>
    s
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  appendFileSync(join(STATE, 'steps.tsv'), `${n}\t${ok ? 'PASS' : 'FAIL'}\t${what}\t${clean(detail).slice(0, 500)}\n`);
}

/** one row of the table; a passing step may return its measurements */
async function step(n: string, what: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await test.step(`${n} ${what}`, fn);
    record(n, true, what, detail || '');
    return true;
  } catch (e) {
    record(n, false, what, String(e instanceof Error ? e.message : e));
    for (const [name, p] of screens) await p.screenshot({ path: join(STATE, `fail-${n}-${name}.png`) }).catch(() => {});
    return false;
  }
}

const textOf = (m: Msg) => m.parts.map((p) => p.text || '').join(' ');
async function messages(id: string): Promise<Msg[]> {
  const r = await fetch(`${HOME}/session/${id}/message`);
  return r.ok ? ((await r.json()) as Msg[]) : [];
}

/** a page's own fetch (its cookies, its network path: the trunk) */
const pageFetch = (page: Page, path: string, init: { method?: string; body?: J } = {}) =>
  page.evaluate(
    async ({ path, init }) => {
      const r = await fetch(path, {
        method: init.method || 'GET',
        headers: init.body ? { 'content-type': 'application/json' } : {},
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      const text = await r.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* text */
      }
      return { status: r.status, via: r.headers.get('x-bifrost-via'), body: body as Record<string, unknown> };
    },
    { path, init }
  );

/** a finger on an element, held until `release()` (real touch events — the phone's gesture) */
async function touchDown(page: Page, testId: string) {
  const b = (await page.getByTestId(testId).boundingBox())!;
  const at = { x: b.x + b.width * 0.4, y: b.y + b.height * 0.55 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  return async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  };
}

const hydrated = (page: Page, testId: string) =>
  page.waitForFunction(
    (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps'));
    },
    testId,
    { timeout: 30_000 }
  );

/** what every peer connection on the page selected, how much it moved, and its remote ufrag */
type PcView = {
  conn: string;
  sent: number;
  recv: number;
  rtt: number | null;
  audio: boolean;
  ufrags: string[];
  fp: string;
  remote: { ip: string; port: number; protocol: string; type: string } | null;
  local: { protocol: string; type: string; tcpType: string } | null;
};
const pcs = (page: Page): Promise<PcView[]> =>
  page.evaluate(async () => {
    const out: PcView[] = [];
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs || []) {
      const st = await pc.getStats();
      const all = new Map<string, Record<string, unknown>>();
      st.forEach((s: Record<string, unknown>) => all.set(String(s.id), s));
      let sel: Record<string, unknown> | undefined;
      let sent = 0;
      let recv = 0;
      for (const s of all.values()) {
        if (s.type === 'transport' && s.selectedCandidatePairId) sel = all.get(String(s.selectedCandidatePairId));
        if (s.type === 'outbound-rtp') sent += Number(s.bytesSent || 0);
        if (s.type === 'inbound-rtp') recv += Number(s.bytesReceived || 0);
      }
      const r = sel && all.get(String(sel.remoteCandidateId));
      const l = sel && all.get(String(sel.localCandidateId));
      const sdp = pc.remoteDescription?.sdp || '';
      out.push({
        conn: pc.connectionState,
        sent,
        recv,
        rtt: sel && typeof sel.currentRoundTripTime === 'number' ? sel.currentRoundTripTime : null,
        audio: sdp.includes('m=audio'),
        ufrags: [...new Set([...sdp.matchAll(/a=ice-ufrag:(\S+)/g)].map((m) => m[1]))],
        fp: /a=fingerprint:sha-256 (\S+)/.exec(sdp)?.[1] || '',
        remote: r ? { ip: String(r.address), port: Number(r.port), protocol: String(r.protocol), type: String(r.candidateType) } : null,
        local: l ? { protocol: String(l.protocol), type: String(l.candidateType), tcpType: String(l.tcpType) } : null,
      });
    }
    return out;
  });

/** raw PCM int16 LE mono → a WAV file's bytes */
function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** words, the way a speech engine and a text compare: digits and "+" as words */
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/\b2\b/g, ' two ')
    .replace(/\b3\b/g, ' three ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/** the VPS's decrypted view (vps-eye.py): records since `from` */
type Eye = { t: number; conn: number; who: 'phone' | 'bridge' | 'root'; dir: 'c2s' | 's2c'; b64: string };
function eyeSince(from: number, to = Infinity): Eye[] {
  if (!existsSync(EYE)) return [];
  return readFileSync(EYE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Eye)
    .filter((r) => r.t >= from && r.t <= to);
}
/** the request lines phones sent the VPS in those records, per connection */
function eyeRequests(recs: Eye[]): string[] {
  const text = (conn: number) =>
    Buffer.concat(recs.filter((r) => r.conn === conn && r.dir === 'c2s').map((r) => Buffer.from(r.b64, 'base64'))).toString('latin1');
  const conns = [...new Set(recs.filter((r) => r.who === 'phone').map((r) => r.conn))];
  return conns.flatMap((c) =>
    text(c)
      .split('\r\n')
      .filter((l) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//.test(l))
  );
}
const appCall = (line: string) => /^[A-Z]+ \/(api\/(?!pair)|rtc)/.test(line);
const norm = (x: string) =>
  String(x || '')
    .toLowerCase()
    .replace(/^sha-256\s*/, '')
    .replace(/[^0-9a-f]/g, '');

const nsExec = (netns: string, cmd: string[]) => execFileSync('nsenter', [`--net=${netns}`, '--', ...cmd]).toString();
const ctl = (...args: string[]) => execFileSync(CTL[0], [...CTL.slice(1), ...args], { encoding: 'utf8' }).trim();
/** the router's question (sni-443 v2): does the trunk route this ufrag? — asked from the VPS */
const iceOwner = (u: string) =>
  nsExec(readFileSync(VPS_NETNS, 'utf8').trim(), ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', `${TRUNK_HTTP}/t/ice/owner?u=${encodeURIComponent(u)}`]).trim();
const log = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

// ---- the admin (claim-admin.py's JSON): cookies + TOTP seed for the step-up ----
type Admin = { cookies: { bifrost_device: string; bifrost_refresh?: string }; totp_secret: string; last_step?: number };
function b32(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/[\s=]/g, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totpAt(secret: string, stepN: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(stepN));
  const mac = createHmac('sha1', b32(secret)).update(msg).digest();
  const off = mac[19] & 0x0f;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
/** a fresh second factor on the admin's device (the trunk refuses a TOTP step used before) */
async function stepUp(page: Page, admin: Admin): Promise<void> {
  const now = Math.floor(Date.now() / 30_000);
  let s = Math.max(now - 1, (admin.last_step ?? 0) + 1);
  if (s > now + 1) {
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 300);
    s = Math.floor(Date.now() / 30_000);
  }
  const r = await pageFetch(page, '/t/auth/step-up', { method: 'POST', body: { totp: totpAt(admin.totp_secret, s) } });
  expect(r.status, `step-up: ${JSON.stringify(r.body)}`).toBe(200);
  admin.last_step = s;
}

test('G3.2 v1 trunk rtc: QR pairing, voice over the trunk, ufrag routing, revoke ≤ 1 s, MITM fails closed', async () => {
  test.setTimeout(12 * 60_000);
  writeFileSync(join(STATE, 'steps.tsv'), '');
  const admin = JSON.parse(readFileSync(ADMIN, 'utf8')) as Admin;
  const resolver = `--host-resolver-rules=MAP ${HOST} ${AP_IP}`;
  // the admin's laptop: at home, through the VPS like any browser; the trunk's self-signed test cert
  const deskBrowser = await chromium.launch({ args: [resolver, '--ignore-certificate-errors'] });
  const desk = await deskBrowser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  await desk.addCookies([
    { name: 'bifrost_device', value: admin.cookies.bifrost_device, domain: HOST, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' },
    ...(admin.cookies.bifrost_refresh
      ? [{ name: 'bifrost_refresh', value: admin.cookies.bifrost_refresh, domain: HOST, path: '/t/auth', secure: true, httpOnly: true, sameSite: 'Strict' as const }]
      : []),
  ]);
  const box = await desk.newPage();
  screens.push(['admin', box]);

  // the phones: their own browser, inside the phone's namespace; the mic plays the WAV
  const phoneBrowser: Browser = await chromium.launch({
    executablePath: PHONE_CHROME,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
      resolver,
      // the test trunk's self-signed cert: a service worker script is refused on a cert error even
      // with ignoreHTTPSErrors (a phone on the real trunk has its Let's Encrypt cert)
      '--ignore-certificate-errors',
    ],
  });
  const reached = new Set<string>();
  const offAp: string[] = [];
  const see = (u: string) => {
    if (!/^(https?|wss?):/.test(u)) return;
    reached.add(new URL(u).origin);
    if (!(u.startsWith(`${AP}/`) || u.startsWith(`${AP.replace(/^https/, 'wss')}/`))) offAp.push(u);
  };
  /** one phone: a fresh context, every peer connection remembered, the room's TTS tapped */
  async function phoneContext(opts: { serviceWorkers?: 'allow' | 'block' } = {}) {
    const ctx: BrowserContext = await phoneBrowser.newContext({
      ...devices['Pixel 7'],
      ignoreHTTPSErrors: true,
      permissions: ['microphone'],
      serviceWorkers: opts.serviceWorkers || 'allow',
      storageState: {
        cookies: [],
        origins: [
          {
            origin: AP,
            localStorage: [
              { name: 'bifrost-door', value: 'v2' },
              { name: 'bifrost-first-turn', value: '1' },
              { name: 'oz-mode', value: 'text' },
            ],
          },
        ],
      },
    });
    await ctx.addInitScript(() => {
      const Orig = window.RTCPeerConnection;
      const all: RTCPeerConnection[] = [];
      (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = all;
      const Wrapped = function (this: unknown, ...a: ConstructorParameters<typeof RTCPeerConnection>) {
        const pc = new Orig(...a);
        all.push(pc);
        // polled, not evented: close() changes the state without a connectionstatechange event
        let last = pc.connectionState as string;
        const tick = setInterval(() => {
          if (pc.connectionState === last) return;
          last = pc.connectionState;
          (window as unknown as { __pcEvent?: (s: string, t: number) => void }).__pcEvent?.(last, Date.now());
          if (last === 'closed') clearInterval(tick);
        }, 25);
        return pc;
      } as unknown as typeof RTCPeerConnection;
      Wrapped.prototype = Orig.prototype;
      Object.setPrototypeOf(Wrapped, Orig);
      window.RTCPeerConnection = Wrapped;
      addEventListener('pagehide', () =>
        (window as unknown as { __pcEvent?: (s: string, t: number) => void }).__pcEvent?.(
          all.some((pc) => pc.connectionState === 'connected') ? 'page-left-while-connected' : 'page-left',
          Date.now()
        )
      );
    });
    const pcEvents: Array<{ state: string; t: number }> = [];
    await ctx.exposeBinding('__pcEvent', (_src, state: string, t: number) => {
      pcEvents.push({ state, t });
    });
    const roomTts = { chunks: [] as Buffer[], rate: 0, first: 0 };
    await ctx.exposeBinding('__ttsTapB64', (_src, b64: string, rate: number) => {
      roomTts.chunks.push(Buffer.from(b64, 'base64'));
      roomTts.rate = rate;
      roomTts.first ||= Date.now();
    });
    await ctx.addInitScript(() => {
      (globalThis as unknown as { __bifrostTtsTap: (c: Uint8Array, r: number) => void }).__bifrostTtsTap = (c, r) => {
        let bin = '';
        for (let i = 0; i < c.length; i++) bin += String.fromCharCode(c[i]);
        (window as unknown as { __ttsTapB64: (b: string, r: number) => void }).__ttsTapB64(btoa(bin), r);
      };
    });
    ctx.on('request', (r) => see(r.url()));
    const sockets: Array<{ url: string; closedAt: number }> = [];
    ctx.on('page', (p) =>
      p.on('websocket', (ws) => {
        see(ws.url());
        const rec = { url: ws.url(), closedAt: 0 };
        sockets.push(rec);
        ws.on('close', () => (rec.closedAt = Date.now()));
      })
    );
    const tokens: Array<{ status: number; body: string }> = [];
    const tts: Array<{ status: number }> = [];
    ctx.on('response', (r) => {
      const u = r.url();
      if (u.endsWith('/api/token') && r.request().method() === 'POST') {
        const at = tokens.push({ status: r.status(), body: '' }) - 1;
        void r
          .text()
          .then((t) => (tokens[at].body = t))
          .catch(() => {});
      }
      if (u.includes('/api/tts/stream')) tts.push({ status: r.status() });
    });
    const pageLog: string[] = [];
    ctx.on('page', (p) => p.on('console', (m) => pageLog.push(`${m.type()} ${m.text()}`)));
    const page = await ctx.newPage();
    return { ctx, page, pcEvents, roomTts, tokens, tts, pageLog, sockets };
  }
  const A = await phoneContext();
  const phone = A.page;
  screens.push(['phone', phone]);
  const lk = new RoomServiceClient(LK.url, LK.key, LK.secret);

  let mainId = '';
  let deviceId = '';
  // E1's two clocks: `loadAt` = the phone starts loading the QR's page (first contact); `pairedAt` =
  // the trunk answered the redeem — the device exists from here on, "after pairing" means after it
  let loadAt = 0;
  let pairedAt = 0;
  let released = 0;
  let voiceTurn: Msg | null = null;
  let dirPin = '';

  /** the phone's own LiveKit peer connections (the ones carrying audio) */
  const lkPcs = async (page: Page) => (await pcs(page)).filter((v) => v.audio);
  /** hold the roots on `page` for the WAV's sentence; the user turn it makes on MAIN */
  async function talk(page: Page, before: number) {
    await hydrated(page, 'roots-hit');
    const roots = page.getByTestId('roots');
    const t0 = Date.now();
    const release = await touchDown(page, 'roots-hit');
    await expect(roots).toHaveAttribute('data-phase', 'talk', { timeout: 40_000 });
    const talkMs = Date.now() - t0;
    await page.waitForTimeout(3_200); // the utterance: 0.4–2 s into the WAV, and a tail
    await release();
    const rel = Date.now();
    await expect(roots).toHaveAttribute('data-phase', /working|speaking|listening/, { timeout: 10_000 });
    await expect
      .poll(async () => (await messages(mainId)).filter((m) => m.info.role === 'user').length, { timeout: 60_000 })
      .toBeGreaterThan(before);
    const ms = await messages(mainId);
    return { talkMs, released: rel, heardMs: Date.now() - rel, turn: ms.filter((m) => m.info.role === 'user').pop()! };
  }
  /** a pairing link straight from the trunk's console (`trunk-ctl pair-qr`) */
  const consoleQr = () => String((JSON.parse(ctl('pair-qr')) as { url: string }).url);
  /** the phone redeems a QR link: the shell's /pair page → POST /t/pair/redeem → "joined" → the door.
   *  (The trunk's page stops at "joined: <name> · member" — spec F5.3 says the phone lands on the
   *  door; the phone's owner taps BIFROST, the shell's link to the door.) */
  async function redeem(page: Page, url: string) {
    const redeemed = page.waitForResponse((r) => r.url().endsWith('/t/pair/redeem'));
    await page.goto(url);
    const r = await redeemed;
    expect(r.status(), await r.text().catch(() => '')).toBe(200);
    const t = Date.now();
    await expect(page.locator('#p-joined')).toBeVisible({ timeout: 10_000 });
    expect(page.url(), 'the token never stays in the address bar (B4)').toBe(`${AP}/pair`);
    if (page.url() !== `${AP}/`) await page.locator('a.oz-brand').click();
    await page.waitForURL(`${AP}/`, { timeout: 30_000 });
    return t;
  }
  const deviceOf = async (page: Page) => String(((await pageFetch(page, '/t/me')).body.device as J | undefined)?.id || '');
  /** time from `t0` until `fn` holds (polled every 50 ms), or -1 */
  async function until(t0: number, fn: () => Promise<boolean> | boolean, ms = 15_000): Promise<number> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return Date.now() - t0;
      await new Promise((r) => setTimeout(r, 50));
    }
    return -1;
  }
  // (an empty room may be gone already: LiveKit answers "not found" — nobody is in it)
  const inRoom = async () => (await lk.listParticipants(ROOM).catch(() => [])).some((p) => p.identity === HUMAN);

  try {
    // ---------------------------------------------------------------- R1 pair by QR
    await step('R1', "the admin's /pair QR → the phone redeems it through vps:443 (the v1 trunk) → the door: the list", async () => {
      await box.goto(`${AP}/devices`);
      await stepUp(box, admin);
      await box.goto(`${AP}/pair`);
      const qr = box.locator('#p-qr-img');
      await expect(qr.locator('svg')).toBeVisible({ timeout: 20_000 });
      const png = join(STATE, 'pair-qr.png');
      writeFileSync(png, await qr.screenshot());
      const qrUrl = execFileSync('zbarimg', ['--raw', '-q', png]).toString().trim();
      expect(qrUrl.startsWith(`${AP}/pair#v=2&t=bfnp-`), qrUrl.replace(/t=.*/, 't=…')).toBe(true);
      // E1's clocks (NOTES-P1.md:153): POST /offer may leave before the door's load event — "it
      // crossed the VPS" counts from loadAt; "no app data after pairing" counts from the redeem's answer
      loadAt = Date.now();
      pairedAt = await redeem(phone, qrUrl);
      await expect(phone.getByTestId('roots')).toBeVisible({ timeout: 30_000 });
      deviceId = await deviceOf(phone);
      expect(deviceId).toMatch(/^dev_/);
      // the admin's dialog says who joined
      await expect(box.locator('#p-joined')).toBeVisible({ timeout: 10_000 });
      const joined = (await box.locator('#p-joined-line').textContent()) || '';
      expect(joined).toMatch(/joined: .* · member/);
      // a second scan of the same QR: 410 used
      const again = await phone.evaluate(async (t) => {
        const r = await fetch('/t/pair/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) });
        return { status: r.status, why: ((await r.json().catch(() => ({}))) as { why?: string }).why };
      }, new URLSearchParams(qrUrl.split('#')[1]).get('t'));
      expect(again).toEqual({ status: 410, why: 'used' });
      mainId = String((await pageFetch(phone, '/api/session/main')).body.id || '');
      expect(mainId).toMatch(/^ses_/);
      const probe = await pageFetch(phone, '/api/token');
      expect(probe.status, JSON.stringify(probe.body)).toBe(200);
      return `device ${deviceId} (${joined.trim()}), MAIN ${mainId}, second scan 410 used`;
    });

    // ---------------------------------------------------------------- P1 the pinned channel
    await step('P1', `the app rides the pinned channel: ICE-TCP ${AP_IP}:443, the key = the trunk directory's pin for this root`, async () => {
      await expect(phone.getByTestId('pin-state')).toHaveAttribute('data-state', 'pinned', { timeout: 20_000 });
      const pinnedMs = Date.now() - loadAt;
      const dir = (await pageFetch(phone, '/t/me/roots')).body as unknown as Array<{ id: string; dtls_fp: string; door: boolean }>;
      const me = dir.find((r) => r.id === HOME_ID);
      expect(me?.door, JSON.stringify(dir)).toBe(true);
      dirPin = String(me?.dtls_fp || '');
      const enrolled = JSON.parse(readFileSync(join(HOME_DIR, 'enroll.json'), 'utf8')).dtls_fp as string;
      expect(norm(dirPin), 'the directory pins the key the root enrolled').toBe(norm(enrolled));
      const remembered = await phone.evaluate((id) => JSON.parse(localStorage.getItem('bifrost.trunk.pins') || '{}')[id]?.fp || '', HOME_ID);
      expect(norm(remembered), 'the phone remembered the pin per root').toBe(norm(dirPin));
      const bridgePc = (await pcs(phone)).find((v) => !v.audio && v.fp);
      expect(bridgePc, 'the bridge peer connection').toBeTruthy();
      expect(norm(bridgePc!.fp), "the answer carried the directory's pinned key").toBe(norm(dirPin));
      expect(bridgePc!.conn).toBe('connected');
      expect(`${bridgePc!.remote?.protocol} ${bridgePc!.remote?.ip}:${bridgePc!.remote?.port}`).toBe(`tcp ${AP_IP}:443`);
      // §5.7: the bridge's own str0m ufrag was registered with the trunk before its answer
      const reg = log(join(HOME_DIR, 'bridge.log')).match(/offer: pinned-channel ufrag (\S+) registered with the trunk — acked in (\d+) ms/g) || [];
      expect(reg.length, 'the pinned channel ufrag was registered and acked').toBeGreaterThan(0);
      const r = await phone.evaluate(async () => {
        const x = await fetch('/api/session/main');
        return { status: x.status, via: x.headers.get('x-bifrost-via') };
      });
      expect(r).toEqual({ status: 200, via: 'pinned' });
      const rtts = await phone.evaluate(async () => {
        const out: number[] = [];
        for (let i = 0; i < 7; i++) {
          const t = performance.now();
          await (await fetch('/api/session/main', { cache: 'no-store' })).text();
          out.push(performance.now() - t);
        }
        return out.sort((a, b) => a - b);
      });
      return `pinned ${pinnedMs} ms after the QR opened (tcp ${AP_IP}:443), root key = directory pin ${dirPin.slice(8, 25)}…, ${reg[reg.length - 1].replace(/.*— /, '')}, /api via ${r.via}: median ${Math.round(rtts[3])} ms per call`;
    });

    // ---------------------------------------------------------------- R2 talk
    await step('R2', 'hold the roots and talk: the WAV → LiveKit over ICE-TCP → the agent STT → MAIN', async () => {
      expect(mainId, 'needs R1').toMatch(/^ses_/);
      const before = (await messages(mainId)).filter((m) => m.info.role === 'user').length;
      const t = await talk(phone, before);
      released = t.released;
      voiceTurn = t.turn;
      const said = textOf(voiceTurn);
      expect(said, said).toMatch(/\b(2|two) ?(\+|plus) ?(2|two)\b/i);
      const tok = A.tokens.find((x) => x.status === 200);
      expect(tok, JSON.stringify(A.tokens)).toBeTruthy();
      const body = JSON.parse(tok!.body);
      expect(body.serverUrl).toBe(AP.replace(/^https/, 'wss'));
      expect(body.iceTcp).toEqual([{ ip: AP_IP, port: 443 }]);
      return `hold→talk ${t.talkMs} ms (token + signal + ufrag registration + ICE-TCP + agent) · release→transcript in MAIN ${t.heardMs} ms · heard "${said
        .split('\n')
        .find((l) => /2|two/i.test(l))
        ?.slice(0, 60)}"`;
    });

    // ---------------------------------------------------------------- R3 the reply, spoken
    let replyBytes = 0;
    await step('R3', 'the reply is spoken back over the voice room (not https via the VPS); its STT matches MAIN', async () => {
      expect(released, 'needs R2').toBeGreaterThan(0);
      const roots = phone.getByTestId('roots');
      await expect(roots).toHaveAttribute('data-phase', 'speaking', { timeout: 120_000 });
      const speakMs = Date.now() - released;
      await expect(roots).not.toHaveAttribute('data-phase', 'speaking', { timeout: 120_000 });
      const pcm = Buffer.concat(A.roomTts.chunks);
      replyBytes = pcm.length;
      expect(pcm.length, 'reply audio arrived over the room').toBeGreaterThan(16_000);
      expect(A.roomTts.rate).toBeGreaterThan(0);
      expect(A.tts.map((t) => t.status), 'no /api/tts/stream (https through the VPS) for the reply').toEqual([]);
      const ms = await messages(mainId);
      const at = ms.findIndex((m) => voiceTurn && textOf(m) === textOf(voiceTurn));
      const reply = ms.slice(at + 1).find((m) => m.info.role === 'assistant');
      expect(reply, 'MAIN answered the voice turn').toBeTruthy();
      const win = Math.round(A.roomTts.rate * 2.5) * 2;
      const parts: string[] = [];
      for (let o = 0; o < pcm.length; o += win) {
        const f = new FormData();
        f.append('file', new Blob([new Uint8Array(wav(pcm.subarray(o, o + win), A.roomTts.rate))], { type: 'audio/wav' }), 'reply.wav');
        const r = await fetch(`${VOICE}/audio/transcriptions`, { method: 'POST', body: f });
        parts.push(((await r.json()) as { text: string }).text);
      }
      const stt = parts.join(' ');
      writeFileSync(join(STATE, 'reply-received.wav'), wav(pcm, A.roomTts.rate));
      const diag = join(__dirname, '..', '.diag', `tts-${new Date().toISOString().slice(0, 10)}.log`);
      const made = (existsSync(diag) ? readFileSync(diag, 'utf8').split('\n') : [])
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { ts: string; bytes: number })
        .filter((x) => Date.parse(x.ts) >= released);
      expect(made.map((x) => x.bytes), 'the root synthesized exactly the bytes that arrived').toContain(pcm.length);
      const want = new Set(words(textOf(reply!)));
      const got = words(stt);
      const hit = got.filter((w) => want.has(w)).length / Math.max(1, got.length);
      expect(hit, `STT "${stt}" vs MAIN's reply "${textOf(reply!)}"`).toBeGreaterThan(0.4);
      expect(got, 'the words of the voice turn, spoken back').toEqual(expect.arrayContaining(['two', 'plus']));
      const sec = pcm.length / 2 / A.roomTts.rate;
      return `release→speaking ${speakMs} ms · ${pcm.length} bytes over the room (${sec.toFixed(1)} s @ ${A.roomTts.rate} Hz), 0 via https, = the root's TTS bytes exactly · STT "${stt.slice(0, 70)}" (${Math.round(hit * 100)}% in MAIN's reply)`;
    });

    // ---------------------------------------------------------------- R4 the media path
    await step('R4', `the media path: selected pair = tcp ${AP_IP}:443 (ICE-TCP via the v1 trunk), UDP dropped, LiveKit saw tcp`, async () => {
      const live = (await pcs(phone)).filter((v) => v.conn === 'connected');
      expect(live.length, JSON.stringify(live)).toBeGreaterThan(0);
      for (const v of live) {
        expect(v.remote, JSON.stringify(v)).toMatchObject({ ip: AP_IP, port: 443, protocol: 'tcp' });
        expect(v.local?.protocol).toBe('tcp');
      }
      const sent = live.reduce((a, v) => a + v.sent, 0);
      expect(sent, 'mic audio bytes sent over it').toBeGreaterThan(10_000);
      const ps = await lk.listParticipants(ROOM);
      const me = ps.find((p) => p.identity === HUMAN);
      expect(me, ps.map((p) => p.identity).join(',')).toBeTruthy();
      expect(me!.attributes?.device).toBe(deviceId);
      expect(me!.tracks.length, 'the mic track is published').toBeGreaterThan(0);
      const lkLog = log(join(HOME_DIR, 'livekit.log'))
        .split('\n')
        .filter((l) => l.includes('participant active') && l.includes(HUMAN));
      expect(lkLog.some((l) => l.includes('"connectionType": "tcp"')), lkLog.join('\n').slice(0, 300)).toBe(true);
      const fw = nsExec(readFileSync(join(STATE, 'phone.netns'), 'utf8').trim(), ['nft', 'list', 'ruleset']);
      const udp = Number(/meta l4proto udp counter packets (\d+)/.exec(fw)?.[1] || 0);
      expect(udp, fw).toBeGreaterThan(0);
      const rtt = live.find((v) => v.rtt !== null)?.rtt;
      return `${live.length} pc connected · remote ${live[0].remote?.ip}:${live[0].remote?.port}/${live[0].remote?.protocol} (${live[0].remote?.type}), local ${live[0].local?.type}/${live[0].local?.tcpType} · ${sent} bytes sent · ICE rtt ${rtt != null ? Math.round(rtt * 1000) : '?'} ms · ${udp} UDP packets dropped at the phone`;
    });

    // ---------------------------------------------------------------- R5 the VPS holds no keys
    await step('R5', 'the VPS forwarded only opaque bytes (STUN/DTLS/SRTP) and holds no key of the call', async () => {
      const frames = readFileSync(TAP, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { conn: number; dir?: string; cls: string; dtls?: number; len?: number });
      const data = frames.filter((f) => !['open', 'closed'].includes(f.cls));
      const by = (c: string) => data.filter((f) => f.cls === c);
      expect(data.length, 'frames crossed the VPS').toBeGreaterThan(50);
      expect(by('other'), JSON.stringify(by('other').slice(0, 3))).toEqual([]);
      expect(by('stun').length).toBeGreaterThan(0);
      const hs = by('dtls').filter((f) => f.dtls === 22);
      expect(hs.length, 'the DTLS handshake crossed').toBeGreaterThan(0);
      const srtpUp = by('srtp').filter((f) => f.dir === 'up');
      expect(srtpUp.length, 'the mic as SRTP').toBeGreaterThan(50);
      const appDown = by('dtls')
        .filter((f) => f.dtls === 23 && f.dir === 'down')
        .reduce((a, f) => a + (f.len || 0), 0);
      expect(appDown, 'the reply audio as DTLS application data').toBeGreaterThan(replyBytes);
      // nothing on the VPS can decrypt the call: no LiveKit secret, and none of the root's private
      // keys (DTLS, root link, WireGuard). v1 keeps accounts and devices on the trunk by design
      // (spec §5.2) — the v0.9 "no device registry" check has no v1 counterpart.
      const secrets: Array<[string, string]> = [['the LiveKit secret', LK.secret]];
      const dtls = JSON.parse(readFileSync(join(HOME_DIR, 'bridge-dtls.json'), 'utf8')) as { private_key: string };
      secrets.push(['the root DTLS private key', dtls.private_key.slice(0, 64)]);
      secrets.push(['the root link key', readFileSync(join(HOME_DIR, 'root.key'), 'utf8').trim()]);
      secrets.push(['the root WireGuard key', readFileSync(join(HOME_DIR, 'wg.key'), 'utf8').trim()]);
      const files: string[] = [];
      const walk = (d: string) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          const st = statSync(p, { throwIfNoEntry: false });
          if (!st) continue;
          if (st.isDirectory()) walk(p);
          else if (st.isFile()) files.push(p);
        }
      };
      walk(VPS_DIR);
      for (const f of files) {
        const t = readFileSync(f);
        for (const [what, s] of secrets) expect(s.length > 16 && t.includes(s), `${f} holds ${what}`).toBe(false);
      }
      expect(files.some((f) => /dtls/i.test(f)), files.join(' ')).toBe(false);
      const conns = new Set(data.map((f) => f.conn)).size;
      return `${data.length} frames over ${conns} ICE-TCP connection(s): ${by('stun').length} STUN, ${by('dtls').length} DTLS (${hs.length} handshake), ${by('srtp').length} SRTP/SRTCP, 0 other; ${appDown} bytes of DTLS application data down · ${files.length} VPS files hold none of ${secrets.length} call/root secrets`;
    });

    // ---------------------------------------------------------------- E1 the VPS's own eyes
    await step('E1', 'the VPS (it holds the trunk TLS key) saw no app data after pairing: no API call, /rtc, transcript, reply', async () => {
      expect(pairedAt, 'needs R1').toBeGreaterThan(0);
      const recs = eyeSince(pairedAt + 1);
      expect(recs.length, 'the eye is on the path').toBeGreaterThan(0);
      const lines = eyeRequests(recs);
      expect(lines.filter(appCall), 'API calls through the VPS after pairing').toEqual([]);
      expect(eyeRequests(eyeSince(loadAt + 1)).some((l) => l.startsWith('POST /offer ')), 'the pinned signaling crossed it').toBe(true);
      // every decrypted byte, the root's own channel included (it carries the relayed streams)
      const plain = Buffer.concat(recs.map((r) => Buffer.from(r.b64, 'base64'))).toString('latin1');
      const turn = voiceTurn ? textOf(voiceTurn) : '';
      const needles = ['MOCK-REPLY', 'What is 2', 'mode=hands-free', '"role":"assistant"', mainId, ...(turn ? [turn.slice(0, 24)] : [])].filter(Boolean);
      const seen = needles.filter((n) => plain.includes(n));
      expect(seen, 'app plaintext the VPS could read').toEqual([]);
      const fps = [...plain.matchAll(/a=fingerprint:sha-256 ((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})/g)].map((m) => m[1]);
      const notBridge = fps.filter((f) => norm(f) !== norm(dirPin));
      const lkFps = (await lkPcs(phone)).map((v) => norm(v.fp)).filter(Boolean);
      expect(notBridge.map(norm).filter((f) => lkFps.includes(f)), "LiveKit's DTLS key crossed the VPS in clear").toEqual([]);
      const kinds = lines.reduce<Record<string, number>>((a, l) => {
        const k = l.startsWith('GET /_next/') ? 'GET /_next/*' : l.split(' ').slice(0, 2).join(' ').replace(/\?.*/, '');
        a[k] = (a[k] || 0) + 1;
        return a;
      }, {});
      return `after pairing the VPS carried ${lines.length} phone requests: ${Object.entries(kinds)
        .map(([k, n]) => `${k}×${n}`)
        .join(', ')} · 0 API calls, 0 /rtc · 0 of ${needles.length} app strings in ${plain.length} decrypted bytes · DTLS keys seen: the root's (pinned) + ${notBridge.length} of the phone's own offers, never LiveKit's`;
    });

    // ---------------------------------------------------------------- U1 §5.7 on the pinned path
    await step('U1', "§5.7 pinned /rtc (tun): LiveKit's ufrags registered by the root, acked before the SDP, routed by the trunk", async () => {
      const lkv = await lkPcs(phone);
      const ufrags = [...new Set(lkv.flatMap((v) => v.ufrags))];
      expect(ufrags.length, JSON.stringify(lkv)).toBeGreaterThan(0);
      const blog = log(join(HOME_DIR, 'bridge.log'));
      const regs = [...blog.matchAll(/rtc: LiveKit ufrag (\S+) registered with the trunk — (acked|NO ack[^(]*\(ice\.reg_timeout\)) in (\d+) ms/g)];
      const reg = new Map<string, { acked: boolean; ms: number }>();
      for (const m of regs) for (const u of m[1].split(',')) reg.set(u, { acked: m[2] === 'acked', ms: Number(m[3]) });
      for (const u of ufrags) {
        expect(reg.get(u)?.acked, `LiveKit ufrag ${u} registered + acked (bridge.log: ${regs.map((m) => m[0]).join(' | ')})`).toBe(true);
        expect(iceOwner(u), `the trunk routes ${u}`).toBe('200');
      }
      expect(iceOwner('zzzzNotRegistered'), 'an unknown ufrag').toBe('404');
      // the /rtc rode the tunnel: E1 found no /rtc through the VPS; the phone's LiveKit pcs are up over it
      expect(lkv.every((v) => v.conn === 'connected' && v.remote?.ip === AP_IP && v.remote?.port === 443), JSON.stringify(lkv)).toBe(true);
      const ack = ufrags.map((u) => reg.get(u)!.ms);
      return `${ufrags.length} LiveKit ufrag(s) [${ufrags.join(', ')}] registered over /t/root (ack ${Math.min(...ack)}–${Math.max(...ack)} ms before the SDP went on) · /t/ice/owner 200 each, unknown → 404 · ${lkv.length} LiveKit pc(s) connected via ${AP_IP}:443`;
    });

    // ---------------------------------------------------------------- R6 revoke from /devices
    await step('R6', 'the admin removes the phone on /devices: voice cut ≤ 1 s, pinned channel severed ≤ 1 s, next call 401 login', async () => {
      expect(deviceId, 'needs R1').toBeTruthy();
      expect(await inRoom(), 'in the room before').toBe(true);
      // a unique name for its row (the shell names a phone by its user agent)
      const mark = `rtc-phone-a-${Date.now() % 100000}`;
      const ren = await pageFetch(box, `/t/devices/${deviceId}`, { method: 'PATCH', body: { name: mark } });
      expect(ren.status, JSON.stringify(ren.body)).toBe(200);
      await box.goto(`${AP}/devices`);
      const row = box.locator('#d-list > *').filter({ has: box.locator(`input[aria-label="rename ${mark}"]`) });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      const severedBefore = (log(join(HOME_DIR, 'bridge.log')).match(/severed peer/g) || []).length;
      await row.getByRole('button', { name: 'Remove' }).click();
      await expect(box.locator('#d-sheet')).toBeVisible();
      const del = box.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/t/devices/${deviceId}`));
      await box.locator('#d-sheet-yes').click();
      const resp = await del;
      const t0 = Date.now();
      expect(resp.status(), await resp.text().catch(() => '')).toBe(200);
      const down = () => A.pcEvents.find((e) => e.t >= t0 && e.state !== 'connected');
      const [goneMs, severMs, pcMs] = await Promise.all([
        until(t0, async () => !(await inRoom())),
        until(t0, () => (log(join(HOME_DIR, 'bridge.log')).match(/severed peer/g) || []).length > severedBefore),
        until(t0, () => !!down()),
      ]);
      expect(goneMs, 'out of the LiveKit room (voice cut)').toBeGreaterThanOrEqual(0);
      expect(severMs, 'the bridge severed the pinned channel').toBeGreaterThanOrEqual(0);
      expect(goneMs, `voice cut in ${goneMs} ms`).toBeLessThanOrEqual(1000);
      expect(severMs, `pinned channel severed in ${severMs} ms`).toBeLessThanOrEqual(1000);
      const tapMs = await until(t0, () =>
        readFileSync(TAP, 'utf8')
          .split('\n')
          .filter(Boolean)
          .some((l) => {
            const f = JSON.parse(l) as { cls: string; t?: number };
            return f.cls === 'closed' && (f.t || 0) >= t0;
          })
      );
      let t = { status: 0, via: null as string | null, body: {} as J };
      const tried: string[] = [];
      const until401 = Date.now() + 20_000;
      while (Date.now() < until401) {
        t = await pageFetch(phone, '/api/token', { method: 'POST', body: { room: ROOM } }).catch(() => ({ status: 0, via: null, body: {} }));
        if (tried[tried.length - 1] !== `${t.status}`) tried.push(`${t.status}`);
        if (t.status === 401) break;
        await phone.waitForTimeout(250).catch(() => {});
      }
      expect(t.status, `the phone's /api/token answers: ${tried.join(' → ')}`).toBe(401);
      expect(t.body.why).toBe('revoked');
      expect(t.body.reauth).toBe('login');
      return `DELETE /t/devices → out of the room ${goneMs} ms · pinned channel severed ${severMs} ms · phone pc ${down()?.state} ${pcMs} ms · ICE-TCP closed at the VPS ${tapMs} ms · /api/token ${tried.join(' → ')} (revoked, login)`;
    });

    // ---------------------------------------------------------------- U2 §5.7 on the plain path
    const B2 = await phoneContext({ serviceWorkers: 'block' });
    screens.push(['phone-b', B2.page]);
    let deviceB = '';
    await step('U2', "§5.7 plain /rtc (through the trunk relay): phone B with no directory pin talks; LiveKit's ufrags registered there", async () => {
      // phone B's directory entry carries no pin (a root enrolled without its DTLS identity): no
      // pinned channel, every call — /rtc included — goes plain through the trunk to the bridge
      await B2.ctx.route('**/t/me/roots', async (route) => {
        const r = await route.fetch();
        const list = (await r.json()) as Array<Record<string, unknown>>;
        await route.fulfill({ response: r, json: list.map((x) => ({ ...x, dtls_fp: '' })) });
      });
      const regBefore = (log(join(HOME_DIR, 'bridge.log')).match(/rtc: LiveKit ufrag/g) || []).length;
      const t1 = await redeem(B2.page, consoleQr());
      await expect(B2.page.getByTestId('roots')).toBeVisible({ timeout: 30_000 });
      deviceB = await deviceOf(B2.page);
      expect(deviceB).toMatch(/^dev_/);
      expect(await B2.page.getByTestId('pin-state').getAttribute('data-state')).toBe('off');
      const r = await pageFetch(B2.page, '/api/session/main');
      expect(r.status).toBe(200);
      expect(r.via, 'not over a pinned channel').toBeNull();
      const before = (await messages(mainId)).filter((m) => m.info.role === 'user').length;
      const t = await talk(B2.page, before);
      expect(textOf(t.turn)).toMatch(/\b(2|two) ?(\+|plus) ?(2|two)\b/i);
      const rtc = eyeRequests(eyeSince(t1)).filter((l) => l.startsWith('GET /rtc'));
      expect(rtc.length, '/rtc went through the trunk relay (the eye saw it)').toBeGreaterThan(0);
      const lkv = await lkPcs(B2.page);
      const ufrags = [...new Set(lkv.flatMap((v) => v.ufrags))];
      expect(ufrags.length).toBeGreaterThan(0);
      const blog = log(join(HOME_DIR, 'bridge.log'));
      const after = [...blog.matchAll(/rtc: LiveKit ufrag (\S+) registered with the trunk — acked in (\d+) ms/g)];
      const acked = new Set(after.flatMap((m) => m[1].split(',')));
      for (const u of ufrags) {
        expect(acked.has(u), `LiveKit ufrag ${u} (plain path) registered + acked`).toBe(true);
        expect(iceOwner(u), `the trunk routes ${u}`).toBe('200');
      }
      expect((blog.match(/rtc: LiveKit ufrag/g) || []).length, 'new registrations on the plain path').toBeGreaterThan(regBefore);
      expect(lkv.some((v) => v.conn === 'connected' && v.remote?.ip === AP_IP && v.remote?.port === 443 && v.remote?.protocol === 'tcp'), JSON.stringify(lkv)).toBe(true);
      return `phone B ${deviceB} (no pin: state off) · ${rtc.length} /rtc upgrade(s) through the trunk · ${ufrags.length} LiveKit ufrag(s) [${ufrags.join(', ')}] registered + acked, /t/ice/owner 200 · hold→talk ${t.talkMs} ms, release→MAIN ${t.heardMs} ms`;
    });

    // ---------------------------------------------------------------- R7 trunk-ctl devices revoke
    await step('R7', '`trunk-ctl devices revoke` on phone B: voice cut ≤ 1 s, its plain /rtc severed, next call 401 login', async () => {
      expect(deviceB, 'needs U2').toMatch(/^dev_/);
      expect(await inRoom(), 'phone B in the room before').toBe(true);
      const rtcOpen = () => B2.sockets.filter((x) => /\/rtc(\/|\?|$)/.test(new URL(x.url).pathname + new URL(x.url).search) && !x.closedAt);
      expect(rtcOpen().length, "phone B's plain /rtc socket is open before").toBeGreaterThan(0);
      const open = rtcOpen();
      const cutBefore = (log(join(HOME_DIR, 'bridge.log')).match(/\/rtc of device \S+ severed/g) || []).length;
      ctl('devices', 'revoke', deviceB, 'rig');
      const t0 = Date.now();
      const [goneMs, cutMs] = await Promise.all([
        until(t0, async () => !(await inRoom())),
        until(t0, () => open.every((x) => x.closedAt > 0)),
      ]);
      expect(goneMs, 'out of the LiveKit room (voice cut)').toBeGreaterThanOrEqual(0);
      expect(goneMs, `voice cut in ${goneMs} ms`).toBeLessThanOrEqual(1000);
      expect(cutMs, 'the plain /rtc severed').toBeGreaterThanOrEqual(0);
      expect(cutMs, `plain /rtc severed in ${cutMs} ms`).toBeLessThanOrEqual(1000);
      const byBridge = (log(join(HOME_DIR, 'bridge.log')).match(/\/rtc of device \S+ severed/g) || []).length > cutBefore;
      const t = await pageFetch(B2.page, '/api/token', { method: 'POST', body: { room: ROOM } });
      expect(t.status).toBe(401);
      expect(t.body.why).toBe('revoked');
      expect(t.body.reauth).toBe('login');
      return `trunk-ctl devices revoke → out of the room ${goneMs} ms · the phone's plain /rtc closed ${cutMs} ms (${byBridge ? 'the bridge cut it' : 'the trunk cut the relayed stream'}) · /api/token 401 (revoked, login)`;
    });
    await B2.ctx.close().catch(() => {});

    // ---------------------------------------------------------------- M1 an active MITM at the VPS
    const C = await phoneContext();
    screens.push(['mitm-phone', C.page]);
    await step('M1', "an active man in the middle at the VPS swaps the root's key in the /offer answer: a fresh phone refuses, sends nothing", async () => {
      await phone.close().catch(() => {});
      writeFileSync(MITM, 'swap the DTLS fingerprints');
      const t1 = await redeem(C.page, consoleQr());
      await expect(C.page.getByTestId('pin-state')).toHaveAttribute('data-state', 'refused', { timeout: 20_000 });
      await expect(C.page.getByTestId('pin-state')).toHaveText(/mismatch/);
      const r = await pageFetch(C.page, '/api/session/main');
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('pin-refused');
      const v = await pageFetch(C.page, '/api/token', { method: 'POST', body: { room: ROOM } });
      expect(v.status, 'no voice token either').toBe(503);
      await C.page.waitForTimeout(1_500);
      expect(await C.page.getByTestId('pin-state').getAttribute('data-state'), 'no fallback').toBe('refused');
      const lines = eyeRequests(eyeSince(t1));
      expect(lines.filter(appCall), 'API calls through the attacking VPS').toEqual([]);
      const swapped = eyeSince(t1 - 10_000).some((x) => x.who === 'phone' && x.dir === 's2c' && Buffer.from(x.b64, 'base64').includes('a=fingerprint'));
      expect(swapped, 'the attack was on the path (the /offer answer crossed it)').toBe(true);
      return `the VPS swapped the root key in the /offer answer → the phone refused ("${await C.page.getByTestId('pin-state').textContent()}"), stays refused, /api 503 pin-refused, no voice token, 0 API calls through the VPS`;
    });

    // ---------------------------------------------------------------- M2 the directory swapped too
    await step('M2', 'the VPS also swaps the directory pin: the phone that remembered the real key raises the pin-change alarm (D3)', async () => {
      const remembered = await C.page.evaluate((id) => JSON.parse(localStorage.getItem('bifrost.trunk.pins') || '{}')[id]?.fp || '', HOME_ID);
      expect(norm(remembered), 'the phone remembered the real key (M1 left it)').toBe(norm(dirPin));
      writeFileSync(MITM, 'swap the DTLS fingerprints + the directory');
      const t2 = Date.now();
      await C.page.goto(`${AP}/`);
      await expect(C.page.getByTestId('pin-state')).toHaveAttribute('data-state', 'refused', { timeout: 20_000 });
      await expect(C.page.getByTestId('pin-state')).toContainText(PIN_CHANGED);
      const r = await pageFetch(C.page, '/api/session/main');
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('pin-refused');
      await C.page.waitForTimeout(1_500);
      expect(await C.page.getByTestId('pin-state').getAttribute('data-state'), 'no fallback').toBe('refused');
      const kept = await C.page.evaluate((id) => JSON.parse(localStorage.getItem('bifrost.trunk.pins') || '{}')[id]?.fp || '', HOME_ID);
      expect(norm(kept), 'the remembered pin is never overwritten by the swapped one').toBe(norm(dirPin));
      const recs = eyeSince(t2);
      expect(eyeRequests(recs).filter(appCall), 'API calls through the attacking VPS').toEqual([]);
      const dirSeen = recs.some((x) => x.who === 'phone' && x.dir === 's2c' && Buffer.from(x.b64, 'base64').includes('"dtls_fp"'));
      expect(dirSeen, 'the swapped directory crossed the eye').toBe(true);
      return `the VPS swapped /t/me/roots' dtls_fp → "${(await C.page.getByTestId('pin-state').textContent())?.trim()}", stays refused, remembered pin kept, /api 503 pin-refused, 0 API calls through the VPS`;
    });
  } finally {
    rmSync(MITM, { force: true });
    await step('∀', `the phones only ever reached ${AP} (and ICE-TCP ${AP_IP}:443)`, async () => {
      expect(reached.size).toBeGreaterThan(0);
      expect(offAp, [...reached].join(' ')).toEqual([]);
      const fw = nsExec(readFileSync(join(STATE, 'phone.netns'), 'utf8').trim(), ['nft', 'list', 'ruleset']);
      const n = [...fw.matchAll(/counter packets (\d+)/g)].map((m) => m[1]);
      return `phone firewall: ${n[0]} packets to vps:443 accepted, ${n[1]} UDP dropped, ${n[2]} other dropped`;
    });
    writeFileSync(join(STATE, 'phone-console.log'), A.pageLog.join('\n'));
    if (existsSync(STATE)) writeFileSync(join(STATE, 'phone-pcs.json'), JSON.stringify(await pcs(phone).catch(() => []), null, 1));
    await desk.close().catch(() => {});
    await deskBrowser.close().catch(() => {});
    await phoneBrowser.close().catch(() => {});
  }
});
