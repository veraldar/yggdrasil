import { type ChildProcess, execFileSync, spawn } from 'child_process';
import {
  appendFileSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { RoomServiceClient } from 'livekit-server-sdk';
import http from 'node:http';
import { join, resolve } from 'path';
import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
  devices,
  expect,
  test,
} from '@playwright/test';

/**
 * THE END DESIGN IN ONE WORLD — run by sim/trunk-e2e.sh: five machines in private network
 * namespaces — the phone, the VPS (sni-443.py on :443, the access point, the VPS's own eyes with
 * the ap's TLS key, a tap on the media path), the box at home (the bridge dialing OUT, the app in
 * devices mode, LiveKit, the real voice agent with real speech engines, the hub brain on the mock
 * model, the hub's WireGuard node) and two machines that join the tree (mac, lab: each its brain
 * on its own mock, its WireGuard node from the ROOT build, root-dial.py). Every machine but the
 * VPS reaches only tcp 443 on the VPS.
 *
 * The harness runs AT HOME (the box console's browser is the `browser` fixture, on loopback); the
 * phone is its own Chromium in the phone's namespace, its microphone a WAV ("Start a session on
 * mac and have it start a session on lab to say lab done."). The joining machines run
 * sim/trunk-full-joiner.py (join.sh's steps) inside their namespaces.
 *
 *  W1  the box console's QR → the phone pairs through vps:443 (the ap) → home: the list
 *  W2  the pinned channel is up: a data channel to the bridge over ICE-TCP <vps>:443, its DTLS key
 *      the one the QR pinned; /api answers over it
 *  W3  mac joins: POST /api/roots/join through the ap (its WireGuard key), the phone opens the
 *      approve link and sees the same code and tunnel-key fingerprint, approves → mac links
 *      through wss://ap/rootlink; the hub's node pinned that key and reaches mac's brain inside it
 *  W4  lab joins the same way
 *  W5  mac and lab learn each other from the hub's directory (inside their tunnels), their brains too
 *  W6  MAIN delegates by VOICE: hold the roots, the WAV's words → LiveKit over ICE-TCP → the agent's
 *      STT → MAIN → session_start on mac (agent lead), over WireGuard
 *  W7  MAIN's reply is spoken back over the voice room (DTLS, phone ↔ box); its STT matches it
 *  W8  mac does it: its session starts one on lab (joined → joined, through the hub's relay), lab
 *      reports to mac's session, mac reports home — the hub's tree shows it done, lab's words inside
 *  W9  what the VPS read (vps-eye): after pairing no app data from the phone — no API call, no
 *      transcript, no reply; on the root links only WireGuard (mac ↔ lab and root ↔ hub), no
 *      plaintext op; on the media path STUN/DTLS/SRTP only; no key of the call on the VPS
 *  W10 revoke the phone on the box console → its pinned channel severed, out of the room, no
 *      token; the roots it approved lose their tunnels: hub ↔ mac, hub ↔ lab, then mac ↔ lab
 * Every step lands in $PW_STATE/steps.tsv (the table the script prints, with its timings).
 */

const AP = process.env.PW_AP_URL || '';
const AP_IP = process.env.PW_AP_IP || '';
const BASE = process.env.PW_BASE_URL || '';
const STATE = process.env.PW_STATE || '';
const HOME = process.env.PW_HOME || '';
const VOICE = process.env.PW_VOICE || '';
const PHONE_CHROME = process.env.PW_PHONE_CHROME || '';
const PHONE_IP = process.env.PW_PHONE_IP || '';
const TAP = process.env.PW_TAP || '';
const VPS_DIR = process.env.PW_VPS_DIR || '';
const EYE = process.env.PW_EYE || '';
const BRIDGE = process.env.PW_BRIDGE || '';
const HUBWG = process.env.PW_HUBWG || '';
const CAFILE = process.env.PW_CAFILE || '';
const YGG_BIN = process.env.PW_YGG_BIN || '';
const ROOT_NET_BIN = process.env.PW_ROOT_NET_BIN || '';
const ROOT_MOCK = process.env.PW_ROOT_MOCK || '';
const IPS: Record<string, string> = {
  mac: process.env.PW_MAC_IP || '',
  lab: process.env.PW_LAB_IP || '',
};
const [RBRAIN, RPEER, RWG, RWGUDP, RPIPE] = (process.env.PW_ROOT_PORTS || '').split(',');
const LK = {
  url: process.env.PW_LK_API || '',
  key: process.env.PW_LK_KEY || '',
  secret: process.env.PW_LK_SECRET || '',
};
const JOINER = resolve(__dirname, '..', '..', 'sim', 'trunk-full-joiner.py');
const EYE_ROOTS = resolve(__dirname, '..', '..', 'sim', 'trunk-e2e', 'eye-roots.py');
const WAV = join(__dirname, 'fixtures/delegate-en.wav');
const ROOM = 'main';
const HUMAN = `user_${ROOM}`;

test.skip(
  !AP || !STATE || !BASE || !PHONE_CHROME || !HUBWG,
  'run by sim/trunk-e2e.sh (the namespaced world)'
);

type J = Record<string, unknown>;
type Msg = {
  info: { role: string; time?: { created?: number }; meta?: J };
  parts: { type: string; text?: string }[];
};
const screens: Array<[string, Page]> = [];

function record(n: string, ok: boolean, what: string, detail = '') {
  const clean = (s: string) =>
    s
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  appendFileSync(
    join(STATE, 'steps.tsv'),
    `${n}\t${ok ? 'PASS' : 'FAIL'}\t${what}\t${clean(detail).slice(0, 600)}\n`
  );
}

/** one row of the table; a passing step may return its measurements */
async function step(n: string, what: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await test.step(`${n} ${what}`, fn);
    record(n, true, what, detail || '');
    return true;
  } catch (e) {
    record(n, false, what, String(e instanceof Error ? e.message : e));
    for (const [name, p] of screens) {
      await p.screenshot({ path: join(STATE, `fail-${n}-${name}.png`) }).catch(() => {});
    }
    return false;
  }
}

/** a GET on this box's own loopback (plain node:http: the node's door refuses browser shapes) */
function get(
  base: string,
  path: string,
  timeout = 30_000
): Promise<{ status: number; body: J & J[] }> {
  return new Promise((done) => {
    const req = http.request(`${base}${path}`, { method: 'GET', timeout }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* text */
        }
        done({ status: res.statusCode || 0, body: body as J & J[] });
      });
    });
    req.on('error', () => done({ status: 0, body: {} as J & J[] }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const netns = (m: string) => readFileSync(join(STATE, `${m}.netns`), 'utf8').trim();
const nsExec = (m: string, cmd: string[]) =>
  execFileSync('nsenter', [`--net=${netns(m)}`, '--', ...cmd]).toString();
/** a GET on a joined machine's own loopback (its brain, its WireGuard node's door) */
function at(m: string, url: string, timeoutS = 20): { status: number; body: J & J[] } {
  let out = '';
  try {
    out = nsExec(m, ['curl', '-s', '-m', String(timeoutS), '-w', '\n%{http_code}', url]);
  } catch (e) {
    out = String((e as { stdout?: Buffer }).stdout || '') || '\n0';
  }
  const i = out.lastIndexOf('\n');
  const text = out.slice(0, i);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: Number(out.slice(i + 1)) || 0, body: body as J & J[] };
}
const rootBrain = `http://127.0.0.1:${RBRAIN}`;
const rootWg = `http://127.0.0.1:${RWG}`;

type Card = {
  status?: string;
  root?: string;
  headline?: string;
  summary?: string;
  created?: number;
  updated?: number;
};
type Row = J & { id: string; title: string; card?: Card | null; agent?: string };
const treeRows = (rows: unknown): Record<string, Row> =>
  Object.fromEntries(((Array.isArray(rows) ? rows : []) as Row[]).map((x) => [x.title, x]));
const homeTree = async () => treeRows((await get(HOME, '/tree')).body);
const rootTree = (m: string) => treeRows(at(m, `${rootBrain}/tree`).body);

const textOf = (m: Msg) => m.parts.map((p) => p.text || '').join(' ');
async function messages(id: string): Promise<Msg[]> {
  const r = await get(HOME, `/session/${id}/message`);
  return Array.isArray(r.body) ? (r.body as unknown as Msg[]) : [];
}

/** the phone's own fetch, from its page (its cookie; the service worker picks the road) */
const phoneFetch = (page: Page, path: string, init: { method?: string; body?: J } = {}) =>
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
      return { status: r.status, via: r.headers.get('x-bifrost-via'), body: body as J };
    },
    { path, init }
  );

/** a finger on an element, held until `release()` (real touch events — the phone's gesture) */
async function touchDown(page: Page, testId: string) {
  const b = (await page.getByTestId(testId).boundingBox())!;
  const pt = { x: b.x + b.width * 0.4, y: b.y + b.height * 0.55 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
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

/** what every peer connection on the phone's page selected */
type PcView = {
  conn: string;
  dc: boolean;
  fp: string;
  sent: number;
  remote: { ip: string; port: number; protocol: string } | null;
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
      for (const s of all.values()) {
        if (s.type === 'transport' && s.selectedCandidatePairId)
          sel = all.get(String(s.selectedCandidatePairId));
        if (s.type === 'outbound-rtp') sent += Number(s.bytesSent || 0);
      }
      const r = sel && all.get(String(sel.remoteCandidateId));
      const sdp = pc.remoteDescription?.sdp || '';
      out.push({
        conn: pc.connectionState,
        dc: sdp.includes('webrtc-datachannel') && !sdp.includes('m=audio'),
        fp: /a=fingerprint:sha-256 (\S+)/.exec(sdp)?.[1] || '',
        sent,
        remote: r
          ? { ip: String(r.address), port: Number(r.port), protocol: String(r.protocol) }
          : null,
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
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/** the VPS's decrypted view (vps-eye.py) */
type Eye = {
  t: number;
  conn: number;
  who: 'phone' | 'bridge' | 'root';
  src: string;
  dir: 'c2s' | 's2c';
  b64: string;
};
function eyeAll(): Eye[] {
  if (!existsSync(EYE)) return [];
  return readFileSync(EYE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Eye);
}
/** the request lines one machine sent the VPS in those records */
function eyeRequests(recs: Eye[], src: string): string[] {
  const conns = [...new Set(recs.filter((r) => r.src === src).map((r) => r.conn))];
  return conns.flatMap((c) =>
    Buffer.concat(
      recs.filter((r) => r.conn === c && r.dir === 'c2s').map((r) => Buffer.from(r.b64, 'base64'))
    )
      .toString('latin1')
      .split('\r\n')
      .filter((l) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//.test(l))
  );
}
const appCall = (line: string) => /^[A-Z]+ \/(api\/(?!pair)|rtc)/.test(line);
const norm = (x: string) =>
  x
    .toLowerCase()
    .replace(/^sha-256\s*/, '')
    .replace(/[^0-9a-f]/g, '');

test('trunk e2e: phone ⇄ vps:443 ⇄ hub ⇄ joined roots — pinned app data, voice delegation over WireGuard, revoke', async ({
  browser,
}) => {
  test.setTimeout(15 * 60_000);
  writeFileSync(join(STATE, 'steps.tsv'), '');
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const box = await desk.newPage();
  screens.push(['box', box]);

  const phoneBrowser: Browser = await chromium.launch({
    executablePath: PHONE_CHROME,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
      `--host-resolver-rules=MAP ${new URL(AP).hostname} ${AP_IP}`,
      '--ignore-certificate-errors',
    ],
  });
  const phoneCtx: BrowserContext = await phoneBrowser.newContext({
    ...devices['Pixel 7'],
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
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
  await phoneCtx.addInitScript(() => {
    const Orig = window.RTCPeerConnection;
    const all: RTCPeerConnection[] = [];
    (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = all;
    const Wrapped = function (
      this: unknown,
      ...a: ConstructorParameters<typeof RTCPeerConnection>
    ) {
      const pc = new Orig(...a);
      all.push(pc);
      return pc;
    } as unknown as typeof RTCPeerConnection;
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
  });
  // the reply's sound as it arrived over the room (lib/voice-tts.ts' test hook)
  const roomTts = { chunks: [] as Buffer[], rate: 0, first: 0 };
  await phoneCtx.exposeBinding('__ttsTapB64', (_src, b64: string, rate: number) => {
    roomTts.chunks.push(Buffer.from(b64, 'base64'));
    roomTts.rate = rate;
    roomTts.first ||= Date.now();
  });
  await phoneCtx.addInitScript(() => {
    (
      globalThis as unknown as { __bifrostTtsTap: (c: Uint8Array, r: number) => void }
    ).__bifrostTtsTap = (c, r) => {
      let bin = '';
      for (let i = 0; i < c.length; i++) bin += String.fromCharCode(c[i]);
      (window as unknown as { __ttsTapB64: (b: string, r: number) => void }).__ttsTapB64(
        btoa(bin),
        r
      );
    };
  });
  const reached = new Set<string>();
  const offAp: string[] = [];
  const see = (u: string) => {
    if (!/^(https?|wss?):/.test(u)) return;
    reached.add(new URL(u).origin);
    if (!(u.startsWith(`${AP}/`) || u.startsWith(`${AP.replace(/^https/, 'wss')}/`))) offAp.push(u);
  };
  phoneCtx.on('request', (r) => see(r.url()));
  phoneCtx.on('page', (p) => p.on('websocket', (ws) => see(ws.url())));
  const tokens: Array<{ status: number; body: string }> = [];
  const tts: number[] = [];
  phoneCtx.on('response', (r) => {
    const u = r.url();
    if (u.endsWith('/api/token') && r.request().method() === 'POST') {
      const i = tokens.push({ status: r.status(), body: '' }) - 1;
      void r
        .text()
        .then((t) => (tokens[i].body = t))
        .catch(() => {});
    }
    if (u.includes('/api/tts/stream')) tts.push(r.status());
  });
  const pageLog: string[] = [];
  phoneCtx.on('page', (p) => p.on('console', (m) => pageLog.push(`${m.type()} ${m.text()}`)));
  const phone = await phoneCtx.newPage();
  screens.push(['phone', phone]);
  const lk = new RoomServiceClient(LK.url, LK.key, LK.secret);
  const joiners: ChildProcess[] = [];

  let mainId = '';
  let deviceId = '';
  let pin = '';
  let pairedAt = 0;
  let released = 0;
  let voiceTurn: Msg | null = null;
  let macProxy = '';
  const fps: Record<string, string> = {};

  /** the pinned channel is up on the phone's current page (after any navigation) */
  const pinned = async () => {
    await expect(phone.getByTestId('pin-state')).toHaveAttribute('data-state', 'pinned', {
      timeout: 30_000,
    });
  };

  /** a machine joins: its joiner (join.sh's steps) in its own namespace; the phone approves */
  const joinRoot = async (name: string) => {
    const st = join(STATE, name, 'join');
    const out = openSync(join(STATE, `joiner-${name}.log`), 'a');
    joiners.push(
      spawn(
        'nsenter',
        [
          `--net=${netns(name)}`,
          '--',
          'python3',
          JOINER,
          '--state',
          st,
          '--hub',
          AP,
          '--cafile',
          CAFILE,
          '--from',
          IPS[name],
          '--name',
          name,
          '--os',
          'linux',
          '--host',
          `${name}.local`,
          '--brain-bin',
          YGG_BIN,
          '--mock-url',
          ROOT_MOCK,
          '--brain-port',
          RBRAIN,
          '--peer-port',
          RPEER,
          '--net-bin',
          ROOT_NET_BIN,
          '--wg-port',
          RWG,
          '--wg-udp',
          RWGUDP,
          '--wg-pipe',
          RPIPE,
        ],
        { stdio: ['ignore', out, out] }
      )
    );
    const err = () =>
      existsSync(join(st, 'error')) ? readFileSync(join(st, 'error'), 'utf8') : '';
    await expect
      .poll(() => existsSync(join(st, 'join.json')) || !!err(), { timeout: 30_000 })
      .toBe(true);
    expect(err()).toBe('');
    const J1 = JSON.parse(readFileSync(join(st, 'join.json'), 'utf8')) as J;
    // the machine's screen shows the approve QR (qrencode); the phone's camera reads it
    const qrUrl = execFileSync('zbarimg', ['--raw', '-q', join(st, 'approve-qr.png')])
      .toString()
      .trim();
    expect(qrUrl).toBe(String(J1.approve_url));
    expect(qrUrl.startsWith(`${AP}/`), qrUrl).toBe(true);
    const t0 = Date.now();
    await phone.goto(qrUrl);
    await expect(phone.getByTestId('join-code')).toHaveText(String(J1.code), { timeout: 30_000 });
    expect(String(J1.wg_fp)).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    await expect(phone.getByTestId('join-wg-fp')).toHaveText(String(J1.wg_fp));
    await expect(phone.getByTestId('join-name')).toHaveText(name);
    await phone.getByTestId('join-approve').tap();
    await expect(phone.getByTestId('join-status')).toContainText(name, { timeout: 20_000 });
    const approvedMs = Date.now() - t0;
    await expect
      .poll(() => existsSync(join(st, 'linked')) || !!err(), { timeout: 40_000 })
      .toBe(true);
    expect(err()).toBe('');
    const linkedMs = Date.now() - t0;
    fps[name] = String(J1.wg_fp);
    // the hub pinned exactly the key the phone saw, and reaches the root's brain inside it
    const reg = JSON.parse(readFileSync(join(STATE, 'roots.json'), 'utf8'));
    expect(reg.roots.find((r: J) => r.id === name)?.wg_pub).toBe(J1.wg_pub);
    await expect
      .poll(async () =>
        ((await get(HUBWG, '/_wg')).body as unknown as J[]).map((p) => p.fingerprint)
      )
      .toContain(J1.wg_fp);
    let there = await get(HUBWG, `/_wg/${name}/root`);
    for (let i = 0; i < 20 && there.status !== 200; i++) {
      await phone.waitForTimeout(500);
      there = await get(HUBWG, `/_wg/${name}/root`);
    }
    expect(there.status).toBe(200);
    expect(there.body.name).toBe(name);
    // …and the root reaches the hub brain the same way (its one peer, `local`)
    const back = at(name, `${rootWg}/_wg/local/root`);
    expect(back.status).toBe(200);
    expect(back.body.name).toBe('home');
    // the old plaintext switchboard is refused at the bridge
    expect((await get(BRIDGE, `/_root/${name}/root`)).status).toBe(403);
    const t = Date.now();
    await get(HUBWG, `/_wg/${name}/root`);
    return `code ${J1.code}, tunnel key ${J1.wg_fp} (phone = machine = hub's pin) · QR→approved ${approvedMs} ms · →linked through the ap ${linkedMs} ms · hub → ${name} brain inside WireGuard ${Date.now() - t} ms`;
  };

  try {
    // ---------------------------------------------------------------- W1 pair
    await step(
      'W1',
      'box console QR → the phone pairs through vps:443 (the ap) → home',
      async () => {
        await box.goto(`${BASE}/pair`);
        const qr = box.getByTestId('pair-qr');
        await expect(qr.locator('svg')).toBeVisible();
        const png = join(STATE, 'pair-qr.png');
        writeFileSync(png, await qr.screenshot());
        const qrUrl = execFileSync('zbarimg', ['--raw', '-q', png]).toString().trim();
        expect(qrUrl.startsWith(`${AP}/pair#`), qrUrl).toBe(true);
        const claimed = phone.waitForResponse((r) => r.url().endsWith('/api/pair/claim'));
        const t0 = Date.now();
        await phone.goto(qrUrl);
        await claimed;
        pairedAt = Date.now();
        await phone.waitForURL(`${AP}/`, { timeout: 30_000 });
        await expect(phone.getByTestId('roots')).toBeVisible({ timeout: 30_000 });
        const p = await phone.evaluate(() =>
          JSON.parse(localStorage.getItem('bifrost.pin') || 'null')
        );
        deviceId = String(p?.deviceId || '');
        pin = String(p?.fp || '');
        expect(deviceId).toMatch(/^dev_/);
        return `device ${deviceId}, QR→claimed ${pairedAt - t0} ms, box key ${pin.slice(0, 17)}…`;
      }
    );

    // ---------------------------------------------------------------- W2 pinned
    await step(
      'W2',
      `the app rides the pinned channel: ICE-TCP ${AP_IP}:443, the QR's box key`,
      async () => {
        await pinned();
        const pinnedMs = Date.now() - pairedAt;
        const v = (await pcs(phone)).find((x) => x.dc);
        expect(v, 'the bridge peer connection').toBeTruthy();
        expect(norm(v!.fp), 'the answer carried the QR-pinned key').toBe(norm(pin));
        expect(v!.conn).toBe('connected');
        expect(v!.remote).toMatchObject({ ip: AP_IP, port: 443, protocol: 'tcp' });
        const m = await phoneFetch(phone, '/api/session/main');
        expect(m.status).toBe(200);
        expect(m.via).toBe('pinned');
        mainId = String(m.body.id || '');
        expect(mainId).toMatch(/^ses_/);
        const probe = await phoneFetch(phone, '/api/token');
        expect(probe.status, JSON.stringify(probe.body)).toBe(200);
        expect(probe.via).toBe('pinned');
        const rtts = await phone.evaluate(async () => {
          const out: number[] = [];
          for (let i = 0; i < 7; i++) {
            const t = performance.now();
            await (await fetch('/api/session/main', { cache: 'no-store' })).text();
            out.push(performance.now() - t);
          }
          return out.sort((a, b) => a - b);
        });
        return `pinned ${pinnedMs} ms after the claim (tcp ${AP_IP}:443) · MAIN ${mainId} · /api via pinned: median ${Math.round(rtts[3])} ms per call · voice probe 200 over it`;
      }
    );

    // ---------------------------------------------------------------- W3/W4 the roots join
    await step(
      'W3',
      'mac joins: its tunnel key shown on the phone, approved (pinned), linked via wss://ap/rootlink',
      () => joinRoot('mac')
    );
    await step('W4', 'lab joins the same way', () => joinRoot('lab'));

    // ---------------------------------------------------------------- W5 the directory
    await step(
      'W5',
      'mac and lab learn each other from the hub directory (inside their tunnels), and their brains',
      async () => {
        const t0 = Date.now();
        const ids = (m: string) =>
          ((at(m, `${rootWg}/_wg/_roots`).body as unknown as J[]) || []).map?.((p) => p.id) || [];
        await expect.poll(() => ids('mac'), { timeout: 30_000 }).toEqual(['lab']);
        await expect.poll(() => ids('lab'), { timeout: 30_000 }).toEqual(['mac']);
        await expect
          .poll(() => (at('mac', `${rootBrain}/root`).body.peers as string[]) || [], {
            timeout: 30_000,
          })
          .toContain('lab');
        await expect
          .poll(() => (at('lab', `${rootBrain}/root`).body.peers as string[]) || [], {
            timeout: 30_000,
          })
          .toContain('mac');
        await expect
          .poll(async () => ((await get(HOME, '/root')).body.peers as string[]) || [], {
            timeout: 20_000,
          })
          .toEqual(['mac', 'lab']);
        const learned = Date.now() - t0;
        const t = Date.now();
        const r = at('mac', `${rootWg}/_wg/lab/root`);
        expect(r.status).toBe(200);
        expect(r.body.name).toBe('lab');
        return `learned in ${learned} ms · mac → lab brain through the hub's relay ${Date.now() - t} ms (incl. nsenter + curl)`;
      }
    );

    // ---------------------------------------------------------------- W6 delegate by voice
    await step(
      'W6',
      'MAIN delegates by VOICE: the WAV → LiveKit (ICE-TCP) → the agent STT → MAIN → session_start on mac',
      async () => {
        expect(mainId, 'needs W2').toMatch(/^ses_/);
        await phone.goto(`${AP}/`);
        await pinned();
        await hydrated(phone, 'roots-hit');
        const roots = phone.getByTestId('roots');
        const before = (await messages(mainId)).filter((m) => m.info.role === 'user').length;
        const t0 = Date.now();
        const release = await touchDown(phone, 'roots-hit');
        await expect(roots).toHaveAttribute('data-phase', 'talk', { timeout: 40_000 });
        const talkMs = Date.now() - t0;
        await phone.waitForTimeout(6_400); // the utterance: 1.5–5.5 s into the WAV, and a tail
        await release();
        released = Date.now();
        await expect
          .poll(async () => (await messages(mainId)).filter((m) => m.info.role === 'user').length, {
            timeout: 60_000,
          })
          .toBeGreaterThan(before);
        const heardMs = Date.now() - released;
        voiceTurn = (await messages(mainId)).filter((m) => m.info.role === 'user').pop()!;
        const said = textOf(voiceTurn);
        expect(said, said).toMatch(/start a session on (the )?mac\b/i);
        expect(said, said).toMatch(/session on (the )?lab\b/i);
        // MAIN ran session_start with root = mac: the proxy on the hub's tree, the session on mac
        await expect
          .poll(async () => (await homeTree())['on mac']?.card?.root, { timeout: 60_000 })
          .toBe('mac');
        const startedMs = Date.now() - released;
        macProxy = (await homeTree())['on mac'].id;
        await expect
          .poll(() => Object.keys(rootTree('mac')), { timeout: 30_000 })
          .toContain('on mac');
        const tok = tokens.find((t) => t.status === 200);
        expect(tok, JSON.stringify(tokens)).toBeTruthy();
        const body = JSON.parse(tok!.body);
        expect(body.serverUrl).toBe(AP.replace(/^https/, 'wss'));
        expect(body.iceTcp).toEqual([{ ip: AP_IP, port: 443 }]);
        return `hold→talk ${talkMs} ms · release→transcript in MAIN ${heardMs} ms · release→session on mac ${startedMs} ms · heard "${said
          .split('\n')
          .find((l) => /session/i.test(l))
          ?.slice(0, 90)}"`;
      }
    );

    // ---------------------------------------------------------------- W7 the reply, spoken
    let replyBytes = 0;
    await step(
      'W7',
      "MAIN's reply is spoken back over the voice room (not https via the VPS); its STT matches it",
      async () => {
        expect(released, 'needs W6').toBeGreaterThan(0);
        const roots = phone.getByTestId('roots');
        await expect(roots).toHaveAttribute('data-phase', 'speaking', { timeout: 120_000 });
        const speakMs = Date.now() - released;
        await expect(roots).not.toHaveAttribute('data-phase', 'speaking', { timeout: 120_000 });
        const pcm = Buffer.concat(roomTts.chunks);
        replyBytes = pcm.length;
        expect(pcm.length, 'reply audio arrived over the room').toBeGreaterThan(16_000);
        expect(tts, 'no /api/tts/stream (https through the VPS) for the reply').toEqual([]);
        const ms = await messages(mainId);
        const i = ms.findIndex((m) => voiceTurn && textOf(m) === textOf(voiceTurn));
        const reply = ms.slice(i + 1).find((m) => m.info.role === 'assistant' && textOf(m).trim());
        expect(reply, 'MAIN answered the voice turn').toBeTruthy();
        expect(textOf(reply!)).toMatch(/session on mac/);
        const win = Math.round(roomTts.rate * 2.5) * 2;
        const parts: string[] = [];
        for (let o = 0; o < pcm.length; o += win) {
          const f = new FormData();
          f.append(
            'file',
            new Blob([new Uint8Array(wav(pcm.subarray(o, o + win), roomTts.rate))], {
              type: 'audio/wav',
            }),
            'reply.wav'
          );
          const r = await fetch(`${VOICE}/audio/transcriptions`, { method: 'POST', body: f });
          parts.push(((await r.json()) as { text: string }).text);
        }
        const stt = parts.join(' ');
        writeFileSync(join(STATE, 'reply-received.wav'), wav(pcm, roomTts.rate));
        // byte for byte what the box synthesized: the app's TTS route logs each stream's size
        const diag = join(
          __dirname,
          '..',
          '.diag',
          `tts-${new Date().toISOString().slice(0, 10)}.log`
        );
        const made = (existsSync(diag) ? readFileSync(diag, 'utf8').split('\n') : [])
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { ts: string; bytes: number; lang?: string })
          .filter((x) => Date.parse(x.ts) >= released);
        expect(
          made.map((x) => x.bytes),
          'the box synthesized exactly the bytes that arrived'
        ).toContain(pcm.length);
        const want = new Set(words(textOf(reply!)));
        const got = words(stt);
        const hit = got.filter((w) => want.has(w)).length / Math.max(1, got.length);
        expect(hit, `STT "${stt}" vs MAIN's reply "${textOf(reply!)}"`).toBeGreaterThan(0.4);
        expect(got, 'the root it went to, spoken').toContain('mac');
        const sec = pcm.length / 2 / roomTts.rate;
        return `release→speaking ${speakMs} ms · MAIN: "${textOf(reply!).trim()}" · ${pcm.length} bytes over the room (${sec.toFixed(1)} s), 0 via https · STT of the received audio: "${stt.trim().slice(0, 60)}" (${Math.round(hit * 100)}% of its words in the reply)`;
      }
    );

    // ---------------------------------------------------------------- W8 the roots do it
    await step(
      'W8',
      "mac's session starts one on lab; lab reports to mac's session (joined → joined); mac reports home",
      async () => {
        expect(macProxy, 'needs W6').toBeTruthy();
        // on mac: the delegated session (a lead) started its own on root lab
        await expect
          .poll(() => rootTree('mac')['on lab']?.card?.root, { timeout: 60_000 })
          .toBe('lab');
        const labStarted = Date.now() - released;
        // on lab: the session ran and is done
        await expect
          .poll(() => rootTree('lab')['on lab']?.card?.status, { timeout: 60_000 })
          .toBe('done');
        // lab's report reached mac's session (not the hub): its proxy on mac done, lab's words in it
        await expect
          .poll(() => rootTree('mac')['on lab']?.card?.status, { timeout: 60_000 })
          .toBe('done');
        const atMac = Date.now() - released;
        const macTree = rootTree('mac');
        const macSes = macTree['on mac'];
        const macMsgs = at('mac', `${rootBrain}/session/${macSes.id}/message`)
          .body as unknown as Msg[];
        const inbox = macMsgs.map(textOf).find((t) => /"on lab"/.test(t) && /lab done/i.test(t));
        expect(inbox, macMsgs.map(textOf).join(' | ').slice(0, 600)).toBeTruthy();
        // mac's report came home: the hub's tree shows it done, MAIN's inbox has it, lab's words inside
        const inboxOf = async () =>
          (await get(HOME, `/session/${mainId}/inbox`)).body as unknown as J[];
        await expect
          .poll(
            async () => {
              const c = (await homeTree())['on mac']?.card;
              const ib = await inboxOf();
              return (
                c?.status === 'done' &&
                Array.isArray(ib) &&
                ib.some((e) => e.from === macProxy) &&
                /lab done/i.test(JSON.stringify(c) + JSON.stringify(ib))
              );
            },
            { timeout: 90_000 }
          )
          .toBe(true);
        const home = Date.now() - released;
        const t = await homeTree();
        // the hub never ran lab's part: lab reported to mac, not home
        expect(Object.keys(t)).not.toContain('on lab');
        expect(
          Object.keys(t).filter((k) => k.startsWith('on mac')),
          'one delegation'
        ).toEqual(['on mac']);
        // the latencies, from the brains' own card clocks (one machine, one clock), not the polls
        const c = (rows: Record<string, Row>, k: string) => rows[k]?.card || ({} as Card);
        const mt = rootTree('mac');
        const lt = rootTree('lab');
        const ms = (x?: number) => (x ? `${x - released} ms` : '?');
        return `release→lab done ${ms(c(lt, 'on lab').updated)} · →lab's report in mac's session ${ms(c(mt, 'on lab').updated)} · →mac's report home ${ms(c(t, 'on mac').updated)} (polls saw: ${labStarted}/${atMac}/${home} ms) · the hub ran none of lab's part`;
      }
    );

    // ---------------------------------------------------------------- W9 what the VPS read
    await step(
      'W9',
      'the VPS read no app data after pairing, only WireGuard between roots, only STUN/DTLS/SRTP for media',
      async () => {
        expect(pairedAt, 'needs W1').toBeGreaterThan(0);
        const all = eyeAll();
        const after = all.filter((r) => r.t > pairedAt);
        expect(after.length, 'the eye is on the path').toBeGreaterThan(0);
        // the phone: no API call, no LiveKit signaling through the VPS's TLS after pairing
        const lines = eyeRequests(after, PHONE_IP);
        expect(lines.filter(appCall), 'API calls through the VPS after pairing').toEqual([]);
        expect(
          lines.some((l) => l.startsWith('POST /offer ')),
          'the pinned signaling'
        ).toBe(true);
        // nothing of the voice turn, the reply, the briefs or the reports in ANY decrypted byte
        // (phone, the bridge's channel, the root links) after pairing
        const plain = Buffer.concat(after.map((r) => Buffer.from(r.b64, 'base64')))
          .toString('latin1')
          .toLowerCase();
        const turn = voiceTurn ? textOf(voiceTurn) : '';
        const needles = [
          'say lab done',
          'have it start a session',
          'i started a session on mac',
          'mock-reply',
          'started, not done yet',
          '"role":"assistant"',
          mainId,
          macProxy,
          turn
            .split('\n')
            .find((l) => /session/i.test(l))
            ?.slice(0, 30) || '',
        ]
          .filter(Boolean)
          .map((n) => n.toLowerCase());
        expect(
          needles.filter((n) => plain.includes(n)),
          'app plaintext the VPS could read'
        ).toEqual([]);
        // the root links, frame by frame (the VPS's decrypted view of each GET /rootlink)
        const v = JSON.parse(
          execFileSync('python3', [EYE_ROOTS, EYE], { maxBuffer: 512 * 1024 * 1024 }).toString()
        ) as {
          conns: Array<{ conn: number; src: string; root: string | null }>;
          frames: Array<{
            conn: number;
            root: string | null;
            dir: string;
            op: number;
            addr: string | null;
            kind: string | null;
            text_op: string | null;
          }>;
          payload_b64: string;
        };
        const roots = ['mac', 'lab'];
        expect(
          v.conns
            .filter((c) => c.root)
            .map((c) => `${c.root}@${c.src}`)
            .sort(),
          JSON.stringify(v.conns)
        ).toEqual(expect.arrayContaining([`lab@${IPS.lab}`, `mac@${IPS.mac}`]));
        const bin = v.frames.filter((f) => f.op === 2);
        expect(
          bin.filter((f) => f.kind === null),
          'binary frames that are not WireGuard'
        ).toEqual([]);
        const pair = bin.filter(
          (f) => roots.includes(String(f.root)) && roots.includes(String(f.addr))
        );
        expect(pair.length, 'mac ↔ lab frames on their links').toBeGreaterThan(20);
        expect(pair.filter((f) => f.kind === 'data').length).toBeGreaterThan(10);
        const hub = bin.filter((f) => f.addr === 'local');
        expect(hub.length, 'root ↔ hub frames').toBeGreaterThan(20);
        const ops = v.frames.filter((f) => f.op === 1);
        expect(
          ops.filter((f) => f.text_op === 'http' || f.text_op === 'http.reply'),
          'plaintext brain calls on the root links'
        ).toEqual([]);
        const opKinds = [...new Set(ops.map((f) => String(f.text_op)))].sort();
        const payload = Buffer.from(v.payload_b64, 'base64').toString('latin1').toLowerCase();
        for (const n of ['lab done', 'on lab', 'on mac', 'mock-reply', 'started, not done'])
          expect(payload.includes(n), `"${n}" readable on a root link`).toBe(false);
        // the media path: opaque, and nothing on the VPS can decrypt the call
        const media = readFileSync(TAP, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { cls: string; dir?: string })
          .filter((f) => !['open', 'closed'].includes(f.cls));
        expect(media.filter((f) => f.cls === 'other')).toEqual([]);
        expect(
          media.filter((f) => f.cls === 'srtp' && f.dir === 'up').length,
          'mic SRTP'
        ).toBeGreaterThan(50);
        const files: string[] = [];
        const walk = (d: string) => {
          for (const n of readdirSync(d)) {
            const p = join(d, n);
            if (statSync(p).isDirectory()) walk(p);
            else files.push(p);
          }
        };
        walk(VPS_DIR);
        for (const f of files) {
          const t = readFileSync(f, 'utf8');
          expect(t.includes(LK.secret), `${f} holds the LiveKit secret`).toBe(false);
          expect(/"devices"\s*:|"roots"\s*:/.test(t), `${f} is a registry`).toBe(false);
          expect(/private_key|wg\.key/.test(t), `${f} holds a key of the tree`).toBe(false);
        }
        const kinds = lines.reduce<Record<string, number>>((a, l) => {
          const k = l.startsWith('GET /_next/')
            ? 'GET /_next/*'
            : l
                .split(' ')
                .slice(0, 2)
                .join(' ')
                .replace(/\?.*/, '')
                .replace(/\/join\/.*/, '/join/…');
          a[k] = (a[k] || 0) + 1;
          return a;
        }, {});
        const byKind = (k: string) => pair.filter((f) => f.kind === k).length;
        return `phone after pairing: ${lines.length} requests via the VPS (${Object.entries(kinds)
          .map(([k, n]) => `${k}×${n}`)
          .join(
            ', '
          )}), 0 API calls · 0 of ${needles.length} app strings in ${plain.length} decrypted bytes · root links: ${bin.length} binary frames all WireGuard (mac↔lab ${pair.length}: ${byKind('init')} init, ${byKind('response')} resp, ${byKind('data')} data; root↔hub ${hub.length}), text ops only [${opKinds.join(', ')}], 0 plaintext calls · media ${media.length} frames, 0 other · ${replyBytes}-byte reply inside DTLS`;
      }
    );

    // ---------------------------------------------------------------- W10 revoke cuts everything
    await step(
      'W10',
      'revoke the phone on the box console → channel severed, out of the room, no token; both roots lose their tunnels',
      async () => {
        expect(deviceId, 'needs W1').toBeTruthy();
        expect(at('mac', `${rootWg}/_wg/lab/root`).status, 'mac → lab before').toBe(200);
        expect(
          (await lk.listParticipants(ROOM)).some((p) => p.identity === HUMAN),
          'the phone is in the voice room before'
        ).toBe(true);
        await box.goto(`${BASE}/devices`);
        const t0 = Date.now();
        await box.getByTestId(`revoke-${deviceId}`).click();
        await expect(box.getByTestId(`revoked-${deviceId}`)).toBeVisible();
        const cut: Record<string, number> = {};
        const until = async (
          name: string,
          fn: () => Promise<boolean> | boolean,
          timeout: number
        ) => {
          await expect.poll(fn, { timeout, intervals: [100, 200, 250] }).toBe(true);
          cut[name] = Date.now() - t0;
        };
        await until(
          'room',
          async () => !(await lk.listParticipants(ROOM)).some((p) => p.identity === HUMAN),
          15_000
        );
        await until(
          'channel',
          () =>
            /severed peer \d+ \(.*\) — revoked/.test(
              readFileSync(join(STATE, 'bridge.log'), 'utf8')
            ),
          15_000
        );
        await until(
          'hub→mac',
          async () => (await get(HUBWG, '/_wg/mac/root', 3_000)).status !== 200,
          15_000
        );
        await until(
          'hub→lab',
          async () => (await get(HUBWG, '/_wg/lab/root', 3_000)).status !== 200,
          15_000
        );
        await until(
          'mac→hub',
          () => at('mac', `${rootWg}/_wg/local/root`, 3).status !== 200,
          15_000
        );
        // the hub's directory stops vouching for both; a joined node drops a copy older than 20 s
        await until('mac→lab', () => at('mac', `${rootWg}/_wg/lab/root`, 3).status !== 200, 40_000);
        await until('lab→mac', () => at('lab', `${rootWg}/_wg/mac/root`, 3).status !== 200, 40_000);
        let t = { status: 0, via: null as string | null, body: {} as J };
        for (let i = 0; i < 20 && !t.status; i++) {
          t = await phoneFetch(phone, '/api/token', { method: 'POST', body: { room: ROOM } }).catch(
            async () => (await phone.waitForTimeout(250), { status: 0, via: null, body: {} })
          );
        }
        expect(t.status).toBe(401);
        expect(t.body.why).toBe('revoked');
        const peers = (await get(HUBWG, '/_wg')).body as unknown as J[];
        expect(
          Array.isArray(peers) ? peers.filter((p) => p.up) : [],
          'live peers on the hub'
        ).toEqual([]);
        return `revoke → out of the room ${cut.room} ms · pinned channel severed ${cut.channel} ms · hub↛mac ${cut['hub→mac']} ms · hub↛lab ${cut['hub→lab']} ms · mac↛hub ${cut['mac→hub']} ms (3 s probe timeout) · mac↛lab ${cut['mac→lab']} ms · lab↛mac ${cut['lab→mac']} ms · /api/token 401 revoked`;
      }
    );
  } finally {
    await step('∀', `the phone only ever reached ${AP} (and ICE-TCP ${AP_IP}:443)`, async () => {
      expect(reached.size).toBeGreaterThan(0);
      expect(offAp, [...reached].join(' ')).toEqual([]);
      const fw = nsExec('phone', ['nft', 'list', 'ruleset']);
      const n = [...fw.matchAll(/counter packets (\d+)/g)].map((m) => m[1]);
      const rfw = ['mac', 'lab'].map((m) => {
        const c = [...nsExec(m, ['nft', 'list', 'ruleset']).matchAll(/counter packets (\d+)/g)].map(
          (x) => x[1]
        );
        return `${m} ${c[0]} to vps:443, ${c[1]} UDP dropped, ${c[2]} other dropped`;
      });
      return `phone firewall: ${n[0]} packets to vps:443 accepted, ${n[1]} UDP dropped, ${n[2]} other dropped · ${rfw.join(' · ')}`;
    });
    writeFileSync(join(STATE, 'phone-console.log'), pageLog.join('\n'));
    for (const j of joiners) j.kill('SIGTERM');
    await Promise.all([desk.close(), phoneCtx.close()]);
    await phoneBrowser.close();
  }
});
