import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { RoomServiceClient } from 'livekit-server-sdk';
import { join } from 'path';
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
 * VOICE OVER YOUR OWN TRUNK — run by sim/trunk-rtc-e2e.sh, which builds three machines in private
 * network namespaces: the phone, the VPS (sni-443.py on :443 + the access point + a byte tap on the
 * media path) and the box at home (the bridge dialing OUT, the app in devices mode, LiveKit, the
 * real voice agent with real speech engines, the brain on the mock model). The phone and the box
 * reach the VPS on tcp 443 only (UDP dropped); the box accepts no inbound connection.
 *
 * This harness runs AT HOME (the box console's browser is the `browser` fixture, on loopback); the
 * phone is its own Chromium, launched inside the phone's namespace (PW_PHONE_CHROME wraps nsenter),
 * its microphone a WAV ("what is two plus two?").
 *
 *  R1 the box console's QR → the phone pairs through the ap → home: the list
 *  R2 hold the roots and talk: the WAV's words → LiveKit → the agent's STT on the box → MAIN
 *  R3 the reply is spoken back: TTS audio bytes at the phone; STT of those bytes matches the text
 *  R4 the media path: the phone's selected candidate pair is tcp <vps>:443 (ICE-TCP through the
 *     ap), UDP was tried and dropped, LiveKit saw a tcp participant
 *  R5 the VPS held no keys: every frame it forwarded on the media path is STUN, DTLS or SRTP —
 *     opaque — and nothing on the VPS knows a LiveKit, DTLS or device secret
 *  R6 revoke the phone on the box console → voice is cut: out of the room, its peer connection
 *     down, its signaling closed, no new token
 * Every step lands in $PW_STATE/steps.tsv (the table the script prints, with its timings).
 */

const AP = process.env.PW_AP_URL || '';
const AP_IP = process.env.PW_AP_IP || '';
const BASE = process.env.PW_BASE_URL || '';
const STATE = process.env.PW_STATE || '';
const HOME = process.env.PW_HOME || '';
const VOICE = process.env.PW_VOICE || '';
const PHONE_CHROME = process.env.PW_PHONE_CHROME || '';
const TAP = process.env.PW_TAP || '';
const VPS_DIR = process.env.PW_VPS_DIR || '';
const LK = {
  url: process.env.PW_LK_API || '',
  key: process.env.PW_LK_KEY || '',
  secret: process.env.PW_LK_SECRET || '',
};
const WAV = join(__dirname, 'fixtures/first-turn-en.wav');
const ROOM = 'main';
const HUMAN = `user_${ROOM}`;

test.skip(
  !AP || !STATE || !BASE || !PHONE_CHROME,
  'run by sim/trunk-rtc-e2e.sh (the namespaced world)'
);

type J = Record<string, unknown>;
type Msg = {
  info: { role: string; time?: { created?: number } };
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
    `${n}\t${ok ? 'PASS' : 'FAIL'}\t${what}\t${clean(detail).slice(0, 500)}\n`
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

const textOf = (m: Msg) => m.parts.map((p) => p.text || '').join(' ');
async function messages(id: string): Promise<Msg[]> {
  const r = await fetch(`${HOME}/session/${id}/message`);
  return r.ok ? ((await r.json()) as Msg[]) : [];
}

/** the phone's own fetch, from its page (its cookie, its network path: the ap) */
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
      return { status: r.status, body: body as Record<string, unknown> };
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

/** what every peer connection on the phone's page selected, and how much it moved */
type PcView = {
  conn: string;
  sent: number;
  recv: number;
  rtt: number | null;
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
        if (s.type === 'transport' && s.selectedCandidatePairId)
          sel = all.get(String(s.selectedCandidatePairId));
        if (s.type === 'outbound-rtp') sent += Number(s.bytesSent || 0);
        if (s.type === 'inbound-rtp') recv += Number(s.bytesReceived || 0);
      }
      const r = sel && all.get(String(sel.remoteCandidateId));
      const l = sel && all.get(String(sel.localCandidateId));
      out.push({
        conn: pc.connectionState,
        sent,
        recv,
        rtt: sel && typeof sel.currentRoundTripTime === 'number' ? sel.currentRoundTripTime : null,
        remote: r
          ? {
              ip: String(r.address),
              port: Number(r.port),
              protocol: String(r.protocol),
              type: String(r.candidateType),
            }
          : null,
        local: l
          ? {
              protocol: String(l.protocol),
              type: String(l.candidateType),
              tcpType: String(l.tcpType),
            }
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

const nsExec = (netns: string, cmd: string[]) =>
  execFileSync('nsenter', [`--net=${netns}`, '--', ...cmd]).toString();

test('trunk rtc: phone ⇄ vps:443 ⇄ box — pair, talk, hear the reply, media end to end, revoke', async ({
  browser,
}) => {
  test.setTimeout(10 * 60_000);
  writeFileSync(join(STATE, 'steps.tsv'), '');
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const box = await desk.newPage();
  screens.push(['box', box]);

  // the phone: its own browser, inside the phone's namespace; the mic plays the WAV
  const phoneBrowser: Browser = await chromium.launch({
    executablePath: PHONE_CHROME,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
      `--host-resolver-rules=MAP ${new URL(AP).hostname} ${AP_IP}`,
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
  // test instrument: remember every peer connection the page makes (to read its stats)
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
      // polled, not evented: close() changes the state without a connectionstatechange event
      let last = pc.connectionState as string;
      const tick = setInterval(() => {
        if (pc.connectionState === last) return;
        last = pc.connectionState;
        (window as unknown as { __pcEvent?: (s: string, t: number) => void }).__pcEvent?.(
          last,
          Date.now()
        );
        if (last === 'closed') clearInterval(tick);
      }, 25);
      return pc;
    } as unknown as typeof RTCPeerConnection;
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
    addEventListener('pagehide', () =>
      (window as unknown as { __pcEvent?: (s: string, t: number) => void }).__pcEvent?.(
        all.some((pc) => pc.connectionState === 'connected')
          ? 'page-left-while-connected'
          : 'page-left',
        Date.now()
      )
    );
  });
  // every peer connection state change, with its time (a binding survives the page's navigation)
  const pcEvents: Array<{ state: string; t: number }> = [];
  await phoneCtx.exposeBinding('__pcEvent', (_src, state: string, t: number) => {
    pcEvents.push({ state, t });
  });
  const reached = new Set<string>();
  const offAp: string[] = [];
  const see = (u: string) => {
    if (!/^(https?|wss?):/.test(u)) return;
    reached.add(new URL(u).origin);
    if (!(u.startsWith(`${AP}/`) || u.startsWith(`${AP.replace(/^https/, 'wss')}/`))) offAp.push(u);
  };
  phoneCtx.on('request', (r) => see(r.url()));
  const sockets: Array<{ url: string; closedAt: number }> = [];
  phoneCtx.on('page', (p) =>
    p.on('websocket', (ws) => {
      see(ws.url());
      const rec = { url: ws.url(), closedAt: 0 };
      sockets.push(rec);
      ws.on('close', () => (rec.closedAt = Date.now()));
    })
  );
  const tokens: Array<{ status: number; body: string }> = [];
  const tts: Array<{ text: string; status: number; rate: number; pcm: Buffer }> = [];
  phoneCtx.on('response', (r) => {
    const u = r.url();
    if (u.endsWith('/api/token') && r.request().method() === 'POST') {
      const at = tokens.push({ status: r.status(), body: '' }) - 1;
      void r
        .text()
        .then((t) => (tokens[at].body = t))
        .catch(() => {});
    }
    if (u.includes('/api/tts/stream')) {
      let text = '';
      try {
        text = String(r.request().postDataJSON()?.text || '');
      } catch {
        /* not json */
      }
      void r
        .body()
        .then((b) =>
          tts.push({
            text,
            status: r.status(),
            rate: Number(r.headers()['x-sample-rate'] || 0),
            pcm: b,
          })
        )
        .catch(() => {});
    }
  });
  const pageLog: string[] = [];
  phoneCtx.on('page', (p) => p.on('console', (m) => pageLog.push(`${m.type()} ${m.text()}`)));
  const phone = await phoneCtx.newPage();
  screens.push(['phone', phone]);
  const lk = new RoomServiceClient(LK.url, LK.key, LK.secret);

  let mainId = '';
  let deviceId = '';
  let released = 0;
  let voiceTurn: Msg | null = null;

  try {
    // ---------------------------------------------------------------- R1 pair
    await step(
      'R1',
      'box console QR → the phone pairs through vps:443 (the ap) → home: the list',
      async () => {
        await box.goto(`${BASE}/pair`);
        const qr = box.getByTestId('pair-qr');
        await expect(qr.locator('svg')).toBeVisible();
        const png = join(STATE, 'pair-qr.png');
        writeFileSync(png, await qr.screenshot());
        const qrUrl = execFileSync('zbarimg', ['--raw', '-q', png]).toString().trim();
        expect(qrUrl.startsWith(`${AP}/pair#`), qrUrl).toBe(true);
        await phone.goto(qrUrl);
        await phone.waitForURL(`${AP}/`, { timeout: 30_000 });
        await expect(phone.getByTestId('roots')).toBeVisible({ timeout: 30_000 });
        const pin = await phone.evaluate(() =>
          JSON.parse(localStorage.getItem('bifrost.pin') || 'null')
        );
        deviceId = String(pin?.deviceId || '');
        expect(deviceId).toMatch(/^dev_/);
        mainId = String((await phoneFetch(phone, '/api/session/main')).body.id || '');
        expect(mainId).toMatch(/^ses_/);
        // voice is a paired device's: the probe says available, through the ap
        const probe = await phoneFetch(phone, '/api/token');
        expect(probe.status, JSON.stringify(probe.body)).toBe(200);
        return `device ${deviceId}, MAIN ${mainId}`;
      }
    );

    // ---------------------------------------------------------------- R2 talk
    await step(
      'R2',
      'hold the roots and talk: the WAV → LiveKit over ICE-TCP → the agent STT → MAIN',
      async () => {
        expect(mainId, 'needs R1').toMatch(/^ses_/);
        await hydrated(phone, 'roots-hit');
        const roots = phone.getByTestId('roots');
        const before = (await messages(mainId)).filter((m) => m.info.role === 'user').length;
        const t0 = Date.now();
        const release = await touchDown(phone, 'roots-hit');
        await expect(roots).toHaveAttribute('data-phase', 'talk', { timeout: 40_000 });
        const talkMs = Date.now() - t0;
        await phone.waitForTimeout(3_200); // the utterance: 0.4–2 s into the WAV, and a tail
        await release();
        released = Date.now();
        await expect(roots).toHaveAttribute('data-phase', /working|speaking|listening/, {
          timeout: 10_000,
        });
        await expect
          .poll(async () => (await messages(mainId)).filter((m) => m.info.role === 'user').length, {
            timeout: 60_000,
          })
          .toBeGreaterThan(before);
        const heardMs = Date.now() - released;
        const ms = await messages(mainId);
        voiceTurn = ms.filter((m) => m.info.role === 'user').pop()!;
        const said = textOf(voiceTurn);
        expect(said, said).toMatch(/2 ?\+ ?2|two plus two/i);
        const tok = tokens.find((t) => t.status === 200);
        expect(tok, JSON.stringify(tokens)).toBeTruthy();
        const body = JSON.parse(tok!.body);
        expect(body.serverUrl).toBe(AP.replace(/^https/, 'wss'));
        expect(body.iceTcp).toEqual([{ ip: AP_IP, port: 443 }]);
        return `hold→talk ${talkMs} ms (token + signal + ICE-TCP + agent) · release→transcript in MAIN ${heardMs} ms · heard "${said
          .split('\n')
          .find((l) => /2|two/i.test(l))
          ?.slice(0, 60)}"`;
      }
    );

    // ---------------------------------------------------------------- R3 the reply, spoken
    await step(
      'R3',
      'the reply is spoken back: TTS audio at the phone, its STT matches the reply',
      async () => {
        expect(released, 'needs R2').toBeGreaterThan(0);
        const roots = phone.getByTestId('roots');
        await expect(roots).toHaveAttribute('data-phase', 'speaking', { timeout: 120_000 });
        const speakMs = Date.now() - released;
        await expect
          .poll(() => tts.filter((t) => t.status === 200 && t.pcm.length > 0).length, {
            timeout: 60_000,
          })
          .toBeGreaterThan(0);
        const t = tts.find((x) => x.status === 200 && x.pcm.length > 0)!;
        expect(t.rate).toBeGreaterThan(0);
        // the text it spoke is MAIN's reply to that voice turn
        const ms = await messages(mainId);
        const at = ms.findIndex((m) => voiceTurn && textOf(m) === textOf(voiceTurn));
        const reply = ms.slice(at + 1).find((m) => m.info.role === 'assistant');
        expect(reply, 'MAIN answered the voice turn').toBeTruthy();
        const head = words(t.text).slice(0, 3).join(' ');
        expect(words(textOf(reply!)).join(' ')).toContain(head);
        // and what arrived is that speech: the box's own STT on the received bytes
        const f = new FormData();
        f.append(
          'file',
          new Blob([new Uint8Array(wav(t.pcm, t.rate))], { type: 'audio/wav' }),
          'reply.wav'
        );
        const stt = (await (
          await fetch(`${VOICE}/audio/transcriptions`, { method: 'POST', body: f })
        ).json()) as { text: string };
        writeFileSync(join(STATE, 'reply-received.wav'), wav(t.pcm, t.rate));
        const want = new Set(words(t.text));
        const got = words(stt.text);
        const hit = got.filter((w) => want.has(w)).length / Math.max(1, got.length);
        expect(hit, `STT "${stt.text}" vs spoken "${t.text}"`).toBeGreaterThan(0.6);
        expect(words(stt.text).join(' ')).toMatch(/two plus two/);
        const sec = t.pcm.length / 2 / t.rate;
        return `release→speaking ${speakMs} ms · ${t.pcm.length} bytes (${sec.toFixed(1)} s @ ${t.rate} Hz) · STT of the received audio: "${stt.text.slice(0, 80)}" (${Math.round(hit * 100)}% of its words in the reply)`;
      }
    );

    // ---------------------------------------------------------------- R4 the media path
    await step(
      'R4',
      `the media path: selected pair = tcp ${AP_IP}:443 (ICE-TCP via the ap), UDP dropped, LiveKit saw tcp`,
      async () => {
        const views = await pcs(phone);
        const live = views.filter((v) => v.conn === 'connected');
        expect(live.length, JSON.stringify(views)).toBeGreaterThan(0);
        for (const v of live) {
          expect(v.remote, JSON.stringify(v)).toMatchObject({
            ip: AP_IP,
            port: 443,
            protocol: 'tcp',
          });
          expect(v.local?.protocol).toBe('tcp');
        }
        const sent = live.reduce((a, v) => a + v.sent, 0);
        expect(sent, 'mic audio bytes sent over it').toBeGreaterThan(10_000);
        const ps = await lk.listParticipants(ROOM);
        const me = ps.find((p) => p.identity === HUMAN);
        expect(me, ps.map((p) => p.identity).join(',')).toBeTruthy();
        expect(me!.attributes?.device).toBe(deviceId);
        expect(me!.tracks.length, 'the mic track is published').toBeGreaterThan(0);
        const lkLog = readFileSync(join(STATE, 'livekit.log'), 'utf8')
          .split('\n')
          .filter((l) => l.includes('participant active') && l.includes(HUMAN));
        expect(
          lkLog.some((l) => l.includes('"connectionType": "tcp"')),
          lkLog.join('\n').slice(0, 300)
        ).toBe(true);
        // the phone's firewall: UDP was tried (Chrome gathers it) and every packet dropped
        const fw = nsExec(readFileSync(join(STATE, 'phone.netns'), 'utf8').trim(), [
          'nft',
          'list',
          'ruleset',
        ]);
        const udp = Number(/meta l4proto udp counter packets (\d+)/.exec(fw)?.[1] || 0);
        expect(udp, fw).toBeGreaterThan(0);
        const rtt = live.find((v) => v.rtt !== null)?.rtt;
        return `${live.length} pc connected · remote ${live[0].remote?.ip}:${live[0].remote?.port}/${live[0].remote?.protocol} (${live[0].remote?.type}), local ${live[0].local?.type}/${live[0].local?.tcpType} · ${sent} bytes sent · ICE rtt ${rtt != null ? Math.round(rtt * 1000) : '?'} ms · ${udp} UDP packets dropped at the phone`;
      }
    );

    // ---------------------------------------------------------------- R5 the VPS holds no keys
    await step(
      'R5',
      'the VPS forwarded only opaque bytes (STUN/DTLS/SRTP) and holds no key of the call',
      async () => {
        const frames = readFileSync(TAP, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(
            (l) =>
              JSON.parse(l) as {
                conn: number;
                dir?: string;
                cls: string;
                dtls?: number;
                len?: number;
              }
          );
        const data = frames.filter((f) => !['open', 'closed'].includes(f.cls));
        const by = (c: string) => data.filter((f) => f.cls === c);
        expect(data.length, 'frames crossed the VPS').toBeGreaterThan(50);
        expect(by('other'), JSON.stringify(by('other').slice(0, 3))).toEqual([]);
        expect(by('stun').length).toBeGreaterThan(0);
        const hs = by('dtls').filter((f) => f.dtls === 22);
        expect(
          hs.length,
          'the DTLS handshake crossed (as ciphertext-bearing records)'
        ).toBeGreaterThan(0);
        const srtpUp = by('srtp').filter((f) => f.dir === 'up');
        expect(srtpUp.length, 'the mic as SRTP').toBeGreaterThan(50);
        // nothing on the VPS can decrypt it: no LiveKit secret, no device registry, no DTLS key
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
          expect(/"devices"\s*:/.test(t), `${f} is a device registry`).toBe(false);
        }
        expect(
          files.some((f) => /dtls/i.test(f)),
          files.join(' ')
        ).toBe(false);
        const conns = new Set(data.map((f) => f.conn)).size;
        return `${data.length} frames over ${conns} ICE-TCP connection(s): ${by('stun').length} STUN, ${by('dtls').length} DTLS (${hs.length} handshake), ${by('srtp').length} SRTP/SRTCP, 0 other · VPS files: ${files.map((f) => f.slice(VPS_DIR.length + 1)).join(', ')}`;
      }
    );

    // ---------------------------------------------------------------- R6 revoke
    await step(
      'R6',
      'box console revokes the phone → voice cut: out of the room, pc down, /rtc closed, no token',
      async () => {
        expect(deviceId, 'needs R1').toBeTruthy();
        expect(
          (await lk.listParticipants(ROOM)).some((p) => p.identity === HUMAN),
          'in the room before'
        ).toBe(true);
        await box.goto(`${BASE}/devices`);
        const t0 = Date.now();
        await box.getByTestId(`revoke-${deviceId}`).click();
        await expect(box.getByTestId(`revoked-${deviceId}`)).toBeVisible();
        await expect
          .poll(async () => (await lk.listParticipants(ROOM)).some((p) => p.identity === HUMAN), {
            timeout: 15_000,
            intervals: [100],
          })
          .toBe(false);
        const goneMs = Date.now() - t0;
        // the phone's media: its peer connection leaves 'connected' (LiveKit closed it), and the
        // VPS saw the ICE-TCP connection end (the tap's last record of it). The page itself may
        // navigate away meanwhile (its next /api call is refused: back to pairing).
        // (the phone's own view: its first peer-connection event after the revoke — its pc
        // leaving 'connected', or the page leaving for pairing — is reported, not required:
        // the media is cut where it flows, at LiveKit and on the VPS)
        const down = () => pcEvents.find((e) => e.t >= t0 && e.state !== 'connected');
        await expect.poll(() => !!down(), { timeout: 15_000, intervals: [100] }).toBe(true);
        const pcMs = down()!.t - t0;
        const tapClosed = () =>
          readFileSync(TAP, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { cls: string; t?: number })
            .filter((f) => f.cls === 'closed' && (f.t || 0) >= t0);
        await expect.poll(() => tapClosed().length, { timeout: 15_000 }).toBeGreaterThan(0);
        const tapMs = Math.min(...tapClosed().map((f) => f.t || 0)) - t0;
        const rtc = sockets.filter((s) => s.url.includes('/rtc'));
        expect(rtc.length).toBeGreaterThan(0);
        await expect.poll(() => rtc.every((s) => s.closedAt > 0), { timeout: 15_000 }).toBe(true);
        // its page may be navigating back to pairing right now: ask once it has settled
        let t = { status: 0, body: {} as Record<string, unknown> };
        for (let i = 0; i < 20 && !t.status; i++) {
          t = await phoneFetch(phone, '/api/token', { method: 'POST', body: { room: ROOM } }).catch(
            async () => (await phone.waitForTimeout(250), { status: 0, body: {} })
          );
        }
        expect(t.status).toBe(401);
        expect(t.body.why).toBe('revoked');
        return `revoke→out of the room ${goneMs} ms · →ICE-TCP closed at the VPS ${tapMs} ms · →phone pc ${down()!.state} ${pcMs} ms · /rtc closed · /api/token 401 revoked`;
      }
    );
  } finally {
    await step('∀', `the phone only ever reached ${AP} (and ICE-TCP ${AP_IP}:443)`, async () => {
      expect(reached.size).toBeGreaterThan(0);
      expect(offAp, [...reached].join(' ')).toEqual([]);
      // what else the phone's browser tried is the firewall's business (counted, dropped):
      // UDP to every candidate, and TCP to the box's own candidate address — never reached
      const fw = nsExec(readFileSync(join(STATE, 'phone.netns'), 'utf8').trim(), [
        'nft',
        'list',
        'ruleset',
      ]);
      const n = [...fw.matchAll(/counter packets (\d+)/g)].map((m) => m[1]);
      return `phone firewall: ${n[0]} packets to vps:443 accepted, ${n[1]} UDP dropped, ${n[2]} other dropped`;
    });
    writeFileSync(join(STATE, 'phone-console.log'), pageLog.join('\n'));
    if (existsSync(STATE))
      writeFileSync(
        join(STATE, 'phone-pcs.json'),
        JSON.stringify(await pcs(phone).catch(() => []), null, 1)
      );
    await Promise.all([desk.close(), phoneCtx.close()]);
    await phoneBrowser.close();
  }
});
