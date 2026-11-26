#!/usr/bin/env node
/* two-voice-v1.mjs — G3.6 step 15 (spec §5.7, §9): two voice roots, each with ITS OWN LiveKit,
 * behind ONE v1 trunk; a spoken turn reaches each — LiveKit's random ufrags routed to the right
 * root through the trunk's single ICE-TCP port by dynamic registration.
 *
 * Run by `sim/trunk-rtc-v1-e2e.sh --scenario two-voice`, AT HOME (the harness reads lab's brain
 * through a loopback hop). The world: the v1 trunk on the VPS (:443, sni-443 → its TLS; ICE-TCP →
 * the tap → its ICE listener), two roots enrolled into it — home (198.51.100.20) and lab
 * (198.51.100.30) — each a door with the app (BIFROST_AUTH=trunk), its own LiveKit, voice agent,
 * speech and brain, each its bridge's [trunk] link dialing out. Two phones in the phone's namespace,
 * the same WAV as their microphone ("what is two plus two?").
 *
 *  V1  phone A pairs by the admin's /pair QR → its door is home; the pinned channel to home's bridge
 *  V2  phone B pairs by `trunk-ctl pair-qr`, picks lab as its door (PUT /t/me/door) → pinned to lab's
 *      bridge (the directory's pin for lab); its /api/session/main is lab's MAIN
 *  V3  both hold the mic AT THE SAME TIME: the words reach home's MAIN (from A) and lab's MAIN (from B)
 *  V4  §5.7: each phone's LiveKit media rides ICE-TCP <vps>:443; A's LiveKit ufrags were registered by
 *      home only, B's by lab only, the trunk routes every one (GET /t/ice/owner 200); each LiveKit
 *      saw its participant over tcp; two different LiveKit DTLS keys
 *  V5  each answer is spoken back over its own root's room
 *  ∀   the phones only ever reached the trunk's origin
 * The table: $PW_STATE/steps.tsv. LADDER: G3.6 step 15 = this scenario's V3 + V4 (+ V5).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE, brain, chromium, devices, env, failed, hydrated, must, poll, screens, sleep, step, textOf, touchDown } from './rig-lib.mjs';
import { adminDesk, consoleQr, pageFetch, pairV1, redeem } from './v1-lib.mjs';

const AP = env('PW_AP_URL');
const AP_IP = env('PW_AP_IP');
const PHONE_CHROME = env('PW_PHONE_CHROME');
const APP = env('APP_DIR');
const CTL = env('PW_CTL');
const VPS_NETNS = env('PW_VPS_NETNS');
const TRUNK_HTTP = env('PW_TRUNK_HTTP');
const ROOTS = {
  home: { id: env('PW_HOME_ID'), brain: env('PW_HOME'), lk: env('PW_HOME_LK'), bridge: env('PW_HOME_BRIDGE') },
  lab: { id: env('PW_LAB_ID'), brain: env('PW_LAB'), lk: env('PW_LAB_LK'), bridge: env('PW_LAB_BRIDGE') },
};
must(AP && STATE && PHONE_CHROME && APP && CTL && env('PW_ADMIN') && ROOTS.home.id && ROOTS.lab.id && ROOTS.lab.brain,
  'run by sim/trunk-rtc-v1-e2e.sh --scenario two-voice');
const WAV = join(APP, 'e2e', 'fixtures', 'first-turn-en.wav');
const t00 = Date.now();

const norm = (x) => String(x || '').toLowerCase().replace(/^sha-256\s*/, '').replace(/[^0-9a-f]/g, '');
const log = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const iceOwner = (u) =>
  execFileSync('nsenter', [`--net=${readFileSync(VPS_NETNS, 'utf8').trim()}`, '--', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
    `${TRUNK_HTTP}/t/ice/owner?u=${encodeURIComponent(u)}`]).toString().trim();
/** the LiveKit ufrags a root's bridge registered with the trunk (and had acked) */
const registered = (r) => new Set([...log(ROOTS[r].bridge).matchAll(/rtc: LiveKit ufrag (\S+) registered with the trunk — acked/g)].flatMap((m) => m[1].split(',')));
const userTurns = async (r, sid) => ((await brain(ROOTS[r].brain, `/session/${sid}/message`)).body || []).filter((m) => m.info.role === 'user');
async function mainOf(r) {
  const list = (await brain(ROOTS[r].brain, '/session')).body || [];
  const m = list.find((s) => s.title === '[MAIN]');
  must(m, `no [MAIN] on ${r}`);
  return m.id;
}

/** every peer connection the page made: state, selected pair, remote SDP ufrags + fingerprint */
const pcs = (page) =>
  page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs || []) {
      const st = await pc.getStats();
      let sel = null;
      st.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) sel = st.get(s.selectedCandidatePairId);
      });
      const r = sel && st.get(sel.remoteCandidateId);
      const sdp = pc.remoteDescription?.sdp || '';
      out.push({
        conn: pc.connectionState,
        audio: sdp.includes('m=audio'),
        ufrags: [...new Set([...sdp.matchAll(/a=ice-ufrag:(\S+)/g)].map((m) => m[1]))],
        fp: /a=fingerprint:sha-256 (\S+)/.exec(sdp)?.[1] || '',
        remote: r ? `${r.protocol} ${r.address}:${r.port}` : '',
      });
    }
    return out;
  });

const desk = await adminDesk({ ap: AP, apIp: AP_IP, adminPath: env('PW_ADMIN') });
const phoneBrowser = await chromium.launch({
  executablePath: PHONE_CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`,
    '--autoplay-policy=no-user-gesture-required', `--host-resolver-rules=MAP ${new URL(AP).hostname} ${AP_IP}`, '--ignore-certificate-errors'],
});
const offAp = [];
async function phone(name) {
  const ctx = await phoneBrowser.newContext({
    ...devices['Pixel 7'],
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
    storageState: { cookies: [], origins: [{ origin: AP, localStorage: [
      { name: 'bifrost-door', value: 'v2' }, { name: 'bifrost-first-turn', value: '1' }, { name: 'oz-mode', value: 'text' },
    ] }] },
  });
  await ctx.addInitScript(() => {
    const Orig = window.RTCPeerConnection;
    const all = [];
    window.__pcs = all;
    const Wrapped = function (...a) {
      const pc = new Orig(...a);
      all.push(pc);
      return pc;
    };
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
  });
  const tts = { chunks: [], rate: 0 };
  await ctx.exposeBinding('__ttsTapB64', (_s, b64, rate) => {
    tts.chunks.push(Buffer.from(b64, 'base64'));
    tts.rate = rate;
  });
  await ctx.addInitScript(() => {
    globalThis.__bifrostTtsTap = (c, r) => {
      let bin = '';
      for (let i = 0; i < c.length; i++) bin += String.fromCharCode(c[i]);
      window.__ttsTapB64(btoa(bin), r);
    };
  });
  ctx.on('request', (r) => {
    const u = r.url();
    if (/^(https?|wss?):/.test(u) && !u.startsWith(`${AP}/`) && !u.startsWith(`${AP.replace(/^https/, 'wss')}/`)) offAp.push(u);
  });
  const page = await ctx.newPage();
  screens.push([name, page]);
  return { ctx, page, tts };
}

/** hold the roots for the WAV's sentence; resolves when the root's MAIN stored the words */
async function talk(P, r, main) {
  const before = (await userTurns(r, main)).length;
  await hydrated(P.page, '[data-testid="roots-hit"]');
  const roots = P.page.getByTestId('roots');
  const t0 = Date.now();
  const release = await touchDown(P.page, P.page.getByTestId('roots-hit'));
  let talkMs = -1;
  try {
    await poll(async () => (await roots.getAttribute('data-phase')) === 'talk', 40_000, `${r}: the mic never went live`, 100);
    talkMs = Date.now() - t0;
    await sleep(3_200);
  } finally {
    await release();
  }
  const released = Date.now();
  const turns = await poll(async () => {
    const u = await userTurns(r, main);
    return u.length > before ? u : null;
  }, 60_000, `${r}'s MAIN got no voice turn`);
  return { talkMs, heardMs: Date.now() - released, said: textOf(turns[turns.length - 1]), released };
}

const A = await phone('phone-a');
const B = await phone('phone-b');
screens.push(['admin', desk.page]);
const M = {};
const T = {};
try {
  await step('V1', "phone A pairs by the admin's /pair QR → door home → pinned to home's bridge", async () => {
    await pairV1(desk, A.page, { ap: AP, png: join(STATE, 'two-voice-qr.png') });
    const dir = (await pageFetch(A.page, '/t/me/roots')).body;
    const home = dir.find((x) => x.id === ROOTS.home.id);
    must(home?.door === true, `A's door is not home: ${JSON.stringify(dir)}`);
    await poll(async () => (await A.page.getByTestId('pin-state').getAttribute('data-state')) === 'pinned', 20_000, 'A never pinned');
    const bp = (await pcs(A.page)).find((v) => !v.audio && v.fp);
    must(bp && norm(bp.fp) === norm(home.dtls_fp), `A's channel key ${bp?.fp} ≠ home's pin ${home.dtls_fp}`);
    M.home = await mainOf('home');
    const s = await pageFetch(A.page, '/api/session/main');
    must(s.status === 200 && s.via === 'pinned' && s.body.id === M.home, `A's MAIN ${JSON.stringify(s)} ≠ home's ${M.home}`);
    return `A pinned to home (${bp.remote}), its MAIN = home's ${M.home}`;
  });

  await step('V2', "phone B pairs by `trunk-ctl pair-qr`, picks lab as its door → pinned to lab's bridge, lab's MAIN", async () => {
    await redeem(B.page, consoleQr(CTL), AP);
    const put = await pageFetch(B.page, '/t/me/door', { method: 'PUT', body: { root_id: ROOTS.lab.id } });
    must(put.status === 200, `PUT /t/me/door: ${put.status} ${JSON.stringify(put.body)}`);
    await B.page.goto(`${AP}/`);
    await B.page.getByTestId('roots').waitFor({ timeout: 30_000 });
    const dir = (await pageFetch(B.page, '/t/me/roots')).body;
    const lab = dir.find((x) => x.id === ROOTS.lab.id);
    must(lab?.door === true, `B's door is not lab: ${JSON.stringify(dir)}`);
    await poll(async () => (await B.page.getByTestId('pin-state').getAttribute('data-state')) === 'pinned', 20_000, 'B never pinned');
    const bp = (await pcs(B.page)).filter((v) => !v.audio && v.fp && v.conn === 'connected').pop();
    must(bp && norm(bp.fp) === norm(lab.dtls_fp), `B's channel key ${bp?.fp} ≠ lab's pin ${lab.dtls_fp}`);
    must(norm(lab.dtls_fp) !== norm(dir.find((x) => x.id === ROOTS.home.id)?.dtls_fp), 'home and lab share a key');
    M.lab = await mainOf('lab');
    const s = await pageFetch(B.page, '/api/session/main');
    must(s.status === 200 && s.via === 'pinned' && s.body.id === M.lab, `B's MAIN ${JSON.stringify(s)} ≠ lab's ${M.lab}`);
    return `B's door = lab, pinned to lab (${bp.remote}), its MAIN = lab's ${M.lab}`;
  });

  await step('V3', "both hold the mic at the same time: A's words reach home's MAIN, B's reach lab's MAIN", async () => {
    must(M.home && M.lab, 'needs V1 + V2');
    const [a, b] = await Promise.all([talk(A, 'home', M.home), talk(B, 'lab', M.lab)]);
    for (const [r, x] of [['home', a], ['lab', b]]) must(/\b(2|two) ?(\+|plus) ?(2|two)\b/i.test(x.said), `${r} heard "${x.said}"`);
    T.home = a;
    T.lab = b;
    return `home: hold→talk ${a.talkMs} ms, release→MAIN ${a.heardMs} ms ("${a.said.slice(0, 40)}") · lab: hold→talk ${b.talkMs} ms, release→MAIN ${b.heardMs} ms ("${b.said.slice(0, 40)}")`;
  });

  await step('V4', "§5.7: ONE ICE-TCP port, two LiveKits — each phone's LiveKit ufrags registered by its own root only, routed, tcp", async () => {
    const regs = { home: registered('home'), lab: registered('lab') };
    const out = [];
    for (const [P, r, o] of [[A, 'home', 'lab'], [B, 'lab', 'home']]) {
      const lk = (await pcs(P.page)).filter((v) => v.audio);
      must(lk.length > 0, `${r}: no LiveKit peer connection`);
      for (const v of lk) must(v.conn === 'connected' && v.remote === `tcp ${AP_IP}:443`, `${r}: LiveKit pc ${JSON.stringify(v)}`);
      const uf = [...new Set(lk.flatMap((v) => v.ufrags))];
      for (const u of uf) {
        must(regs[r].has(u), `${r}'s LiveKit ufrag ${u} not registered by ${r} (${[...regs[r]].join(',')})`);
        must(!regs[o].has(u), `${r}'s LiveKit ufrag ${u} registered by ${o} too`);
        must(iceOwner(u) === '200', `the trunk does not route ${u}`);
      }
      const active = log(ROOTS[r].lk).split('\n').filter((l) => l.includes('participant active') && l.includes('user_main'));
      must(active.some((l) => l.includes('"connectionType": "tcp"')), `${r}'s LiveKit saw no tcp participant: ${active.join(' ').slice(0, 200)}`);
      out.push({ r, uf, fp: lk[0].fp });
    }
    must(norm(out[0].fp) !== norm(out[1].fp), 'one LiveKit answered both phones');
    must(iceOwner('zzzzNotRegistered') === '404', 'an unknown ufrag is routed');
    return out.map((x) => `${x.r}: ${x.uf.length} LiveKit ufrag(s) [${x.uf.join(', ')}] registered by ${x.r} only, /t/ice/owner 200, tcp ${AP_IP}:443`).join(' · ') + ' · two LiveKit DTLS keys';
  });

  await step('V5', 'each answer is spoken back over its own root\'s voice room', async () => {
    must(T.home && T.lab, 'needs V3');
    const out = [];
    for (const [P, r] of [[A, 'home'], [B, 'lab']]) {
      await poll(() => P.tts.chunks.length > 0, 120_000, `${r}: no reply audio over the room`);
      await poll(async () => (await P.page.getByTestId('roots').getAttribute('data-phase')) !== 'speaking', 120_000, `${r}: the reply never ended`, 500);
      const n = P.tts.chunks.reduce((a, c) => a + c.length, 0);
      must(n > 16_000, `${r}: ${n} bytes of reply audio`);
      out.push(`${r}: ${n} bytes (${(n / 2 / P.tts.rate).toFixed(1)} s)`);
    }
    return out.join(' · ');
  });

  await step('∀', `the phones only ever reached ${AP}`, async () => {
    must(offAp.length === 0, offAp.slice(0, 3).join(' '));
  });
} finally {
  process.stderr.write(`two-voice: ${failed.length ? 'RED ' + failed.join(' ') : 'GREEN'} in ${Math.round((Date.now() - t00) / 1000)} s\n`);
  await desk.browser.close().catch(() => {});
  await phoneBrowser.close().catch(() => {});
}
process.exit(failed.length ? 1 : 0);
