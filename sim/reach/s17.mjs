#!/usr/bin/env node
/* s17.mjs — S17: a 6 MB PDF to a Claude Code session on ANOTHER root; a file it makes opens on
 * the phone (lead-review L10).
 *
 * Run by `sim/trunk-full-e2e.sh --scenario s17`. The world is the trunk-full rig's: the ap on the
 * "internet", the hub box (bridge dialing out, app in devices mode, brain "home", the hub's
 * WireGuard node). The phone (Chromium, Pixel 7) only talks to https://ap.tree.test. Root "lab"
 * joins the way trunk-full's step 4e does it (sim/trunk-full-joiner.py: QR, approved on the phone,
 * WireGuard through the hub's relay) — so every byte between home and lab rides the tunnel.
 *
 * Lab's Claude Code is the REAL `claude` binary run by lab's brain harness; the namespace has no
 * model upstream and no login, so its env points it at sim/reach/cc_model.py (a scripted model that
 * only knows what Claude Code sends it — see that file). Lab's work folder gets a CLAUDE.md naming
 * its artifacts folder (as sim/brain-up.sh seeds a twin's AGENTS.md): that is how a model knows
 * where "your artifacts folder" is.
 *
 *  S17.1 the box console's QR → the phone pairs through the ap → its list
 *  S17.2 lab joins: its code + tunnel key on the phone, approved; it links; home learns it
 *  S17.3 setup: home's MAIN starts "pdf reader" (agent claude) on root lab — a Claude Code session
 *  S17.4 Ása opens it, taps the paperclip, picks report.pdf (6.4 MB), asks "what is the marker word
 *        in this pdf", taps send → lab stores ONE user message whose file part is the PDF (same
 *        sha256, same size) and lab holds the bytes (files/blobs/<sha256>)
 *  S17.5 Claude Code was handed it: its prompt names the file and a path on lab with those bytes,
 *        and its Read tool sent the model exactly that PDF
 *  S17.6 the reply holds the marker word — in lab's store and on the phone's screen
 *  S17.7 "now write marker.html into your artifacts folder with the marker word and link it" → the
 *        file is in lab's artifacts folder; the phone shows the link
 *  S17.8 Ása taps the link → the page opens: 200, text/html, the marker word on it
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATE, brain, chromium, devices, env, failed, must, pair, phoneFetch, poll, rowOf, screens, sleep, step,
  textOf, tool,
} from './rig-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AP = env('PW_AP_URL');
const AP_IP = env('PW_AP_IP');
const BASE = env('PW_BASE_URL');
const HOME = env('PW_HOME');
const CCM_LOG = env('PW_CC_LOG');
const LAB = `http://127.0.0.1:${env('PW_LAB_PORT')}`;
const LABST = join(STATE, 'lab');
const LABDATA = join(LABST, 'brain'); // the joiner's brain folder: data/, work/, artifacts/
const ART = join(LABDATA, 'artifacts');
const TITLE = 'pdf reader';
must(AP && STATE && BASE && HOME && CCM_LOG && env('PW_CC_MODEL') && env('PW_LAB_PORT'), 'run by sim/trunk-full-e2e.sh --scenario s17');

const t00 = Date.now();
const pdf = JSON.parse(execFileSync('python3', [join(HERE, 'make_pdf.py'), join(STATE, 'report.pdf'), '--mb', env('S17_MB', '6.4')]).toString());
const pdfBytes = readFileSync(pdf.path);
process.stderr.write(`s17: report.pdf ${pdf.size} bytes, marker ${pdf.marker}, sha256 ${pdf.sha256.slice(0, 12)}…\n`);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ccm = () => (existsSync(CCM_LOG) ? readFileSync(CCM_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const labMsgs = async (lid) => (await brain(LAB, `/session/${lid}/message`)).body || [];

const box = await chromium.launch();
const desk = await box.newContext({ viewport: { width: 1280, height: 900 } });
const consolePage = await desk.newPage();
const phoneBrowser = await chromium.launch({
  args: [`--host-resolver-rules=MAP ${new URL(AP).hostname} ${AP_IP}`, '--ignore-certificate-errors'],
});
const ctx = await phoneBrowser.newContext({
  ...devices['Pixel 7'],
  ignoreHTTPSErrors: true,
  storageState: { cookies: [], origins: [{ origin: AP, localStorage: [
    { name: 'bifrost-door', value: 'v2' },
    { name: 'bifrost-first-turn', value: '1' },
  ] }] },
});
const offAp = [];
const responses = [];
ctx.on('request', (r) => {
  const u = r.url();
  if (/^(https?|wss?):/.test(u) && !u.startsWith(`${AP}/`) && !u.startsWith(`${AP.replace(/^https/, 'wss')}/`)) offAp.push(u);
});
ctx.on('response', (r) => {
  if (r.url().includes('/api/artifact/') || r.url().includes('/api/file') || /\/api\/session\/[^/]+\/messages/.test(r.url()))
    responses.push({ t: Date.now(), url: r.url(), status: r.status(), type: r.headers()['content-type'] || '', method: r.request().method(), kind: r.request().resourceType() });
});
const phone = await ctx.newPage();
screens.push(['phone', phone], ['box', consolePage]);

/** type into the composer and tap send — the way a thumb does it */
async function send(text) {
  const boxEl = phone.getByPlaceholder('message…');
  await boxEl.tap({ timeout: 30_000 });
  await boxEl.fill(text, { timeout: 30_000 });
  await phone.getByRole('button', { name: 'send', exact: true }).tap({ timeout: 30_000 });
}

let mainId = '';
let proxy = '';
let labId = '';
let turn = null;
let joiner = null;

try {
  await step('S17.1', 'box console QR → the phone pairs through the ap → its list', async () => {
    await pair(consolePage, phone, { base: BASE, ap: AP, png: join(STATE, 's17-pair-qr.png') });
    mainId = String((await phoneFetch(phone, '/api/session/main')).body.id || '');
    must(/^ses_/.test(mainId), `MAIN ${mainId}`);
    return `MAIN ${mainId}`;
  });

  await step('S17.2', 'lab joins: its code + tunnel key on the phone, approved; it links over WireGuard; home learns it', async () => {
    mkdirSync(join(LABDATA, 'work'), { recursive: true });
    writeFileSync(join(LABDATA, 'work', 'CLAUDE.md'),
      `# Workspace (root lab)\n\nThis computer's work area is ${join(LABDATA, 'work')}.\n` +
      `Files for the owner go in the artifacts folder: ${ART}/ — link each one as [name](/api/artifact/<name>); it opens on their phone.\n`);
    const brainEnv = [
      `ANTHROPIC_BASE_URL=${env('PW_CC_MODEL')}`, 'ANTHROPIC_API_KEY=sim-offline-not-a-key',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'DISABLE_AUTOUPDATER=1', 'IS_SANDBOX=1',
      `TMPDIR=${env('TMPDIR', join(STATE, 'tmp'))}`,
    ];
    const out = openSync(join(STATE, 'joiner-lab.log'), 'a');
    joiner = spawn('python3', [
      join(HERE, '..', 'trunk-full-joiner.py'), '--state', LABST, '--hub', AP, '--cafile', env('PW_CAFILE'),
      '--from', env('PW_FAR2'), '--name', 'lab', '--os', 'linux', '--host', 'lab.local', '--brain-bin', env('PW_YGG_BIN'),
      '--mock-url', env('PW_MOCK'), '--brain-port', env('PW_LAB_PORT'), '--peer-port', env('PW_LAB_PEER'),
      '--net-bin', env('PW_NET_BIN'), '--wg-port', env('PW_LAB_WG'), '--wg-udp', env('PW_LAB_WG_UDP'),
      '--wg-pipe', env('PW_LAB_PIPE'), ...brainEnv.flatMap((e) => ['--brain-env', e]),
    ], { stdio: ['ignore', out, out] });
    await poll(() => existsSync(join(LABST, 'join.json')) || existsSync(join(LABST, 'error')), 30_000, 'no join.json');
    if (existsSync(join(LABST, 'error'))) throw new Error(`the joiner: ${readFileSync(join(LABST, 'error'), 'utf8').slice(0, 200)}`);
    const J = JSON.parse(readFileSync(join(LABST, 'join.json'), 'utf8'));
    await phone.goto(String(J.approve_url));
    await phone.getByTestId('join-code').filter({ hasText: String(J.code) }).waitFor({ timeout: 20_000 });
    await phone.getByTestId('join-wg-fp').filter({ hasText: String(J.wg_fp) }).waitFor({ timeout: 20_000 });
    await phone.getByTestId('join-approve').tap();
    await phone.getByTestId('join-status').filter({ hasText: 'lab' }).waitFor({ timeout: 20_000 });
    await poll(() => existsSync(join(LABST, 'linked')) || existsSync(join(LABST, 'error')), 40_000, 'lab never linked');
    if (existsSync(join(LABST, 'error'))) throw new Error(`the joiner: ${readFileSync(join(LABST, 'error'), 'utf8').slice(0, 200)}`);
    await poll(async () => ((await brain(HOME, '/root')).body.peers || []).includes('lab'), 30_000, 'home never learned lab');
    return `code ${J.code}, tunnel key ${J.wg_fp}`;
  });

  await step('S17.3', `setup: home's MAIN starts "${TITLE}" (agent claude) on root lab — a Claude Code session there`, async () => {
    must(mainId, 'needs S17.1');
    const r = await brain(HOME, `/session/${mainId}/message`, {
      method: 'POST',
      body: { parts: [{ type: 'text', text: tool([['session_start', { title: TITLE, agent: 'claude', root: 'lab', brief: 'Reply with exactly: READY' }]]) }] },
      timeout: 120_000,
    });
    must(r.status === 200, `MAIN answered ${r.status}`);
    const row = await poll(async () => ((await brain(HOME, '/tree')).body || []).find((x) => x.title === TITLE), 30_000, `no row "${TITLE}" on home`);
    proxy = row.id;
    labId = (await brain(HOME, `/session/${proxy}`)).body?.remote?.id || '';
    must(labId, `proxy ${proxy} has no remote`);
    const info = (await brain(LAB, `/session/${labId}`)).body;
    must(info?.harness?.kind === 'claude', `the lab session runs on ${JSON.stringify(info?.harness)}`);
    await poll(async () => (await labMsgs(labId)).some((m) => m.info.role === 'assistant' && textOf(m).includes('READY')), 90_000,
      `Claude Code never answered the brief on lab (cc_model saw ${ccm().length} request(s))`);
    return `proxy ${proxy} → ${labId} on lab (Claude Code, ${ccm().length} model call(s) so far)`;
  });

  await step('S17.4', `Ása attaches report.pdf (${(pdf.size / 1e6).toFixed(1)} MB) in the composer, asks for the marker word → lab holds the same bytes, in one message`, async () => {
    must(labId, 'needs S17.3');
    await phone.goto(`${AP}/`);
    const row = rowOf(phone, TITLE);
    await row.first().waitFor({ timeout: 30_000 });
    await row.first().tap();
    await phone.waitForURL(/\/session\//, { timeout: 20_000 });
    const [chooser] = await Promise.all([
      phone.waitForEvent('filechooser', { timeout: 15_000 }),
      phone.getByRole('button', { name: 'attach' }).tap(),
    ]);
    await chooser.setFiles(pdf.path);
    await sleep(500);
    const alert = await phone.locator('main [role="alert"]').allInnerTexts().catch(() => []);
    must(!alert.join(' ').trim(), `the composer says: ${alert.join(' ').slice(0, 200)}`);
    await send('what is the marker word in this pdf');
    const got = await poll(async () => {
      const u = (await labMsgs(labId)).filter((m) => m.info.role === 'user' && /marker word/i.test(textOf(m)));
      return u.length ? u : null;
    }, 120_000, 'the question never reached lab');
    turn = got[got.length - 1];
    must(got.length === 1, `${got.length} user messages with the question on lab`);
    const files = (turn.parts || []).filter((p) => p.type === 'file');
    must(files.length === 1, `lab's message has ${files.length} file part(s): ${JSON.stringify((turn.parts || []).map((p) => ({ type: p.type, name: p.filename, len: (p.text || p.url || '').length })))}`);
    const f = files[0];
    must(f.hash === pdf.sha256 && Number(f.size) === pdf.size, `file part ${JSON.stringify({ hash: f.hash, size: f.size, url: String(f.url).slice(0, 40) })} ≠ sha ${pdf.sha256.slice(0, 12)} size ${pdf.size}`);
    must(!String(f.url || '').startsWith('data:'), 'the file rode as a data: URL');
    const blob = join(LABDATA, 'data', 'files', 'blobs', pdf.sha256);
    must(existsSync(blob) && sha(readFileSync(blob)) === pdf.sha256, `lab has no files/blobs/${pdf.sha256.slice(0, 12)}…`);
    return `one message on lab: ${f.filename} ${f.mime} ${f.size} bytes, sha256 equal, ref ${f.url} (root ${f.root})`;
  });

  await step('S17.4w', 'it crossed the WireGuard link in pieces: one whole-file call is refused there (4 MB cap), a 1 MiB piece passes; the hub node carried it', async () => {
    must(turn, 'needs S17.4');
    const log = existsSync(join(LABST, 'brain.log')) ? readFileSync(join(LABST, 'brain.log'), 'utf8') : '';
    const pulled = log.split('\n').find((l) => l.includes(`files: pulled ${pdf.sha256}`));
    must(pulled && /from home/.test(pulled), `lab's brain never logged pulling it from home (${log.split('\n').filter((l) => l.startsWith('files:')).slice(-2).join(' | ')})`);
    // lab's way to home is its own tunnel door: /_wg/local = the hub, inside WireGuard
    const door = `http://127.0.0.1:${env('PW_LAB_WG')}/_wg/local`;
    const whole = await brain(door, `/file/${pdf.sha256}`, { timeout: 90_000 });
    must(whole.status >= 400, `the tunnel passed the whole ${pdf.size}-byte file in one call (${whole.status}, ${whole.raw.length} bytes)`);
    const piece = await brain(door, `/file/${pdf.sha256}?offset=1048576&len=1048576`, { timeout: 60_000 });
    must(piece.status === 200 && piece.raw.equals(pdfBytes.subarray(1048576, 2 * 1048576)), `a 1 MiB piece through the tunnel: ${piece.status}, ${piece.raw.length} bytes`);
    const hubwg = (readFileSync(join(STATE, 'wg-hub.toml'), 'utf8').match(/^http = "([^"]+)"/m) || [])[1];
    const peers = (await brain(`http://${hubwg}`, '/_wg')).body || [];
    const lab = peers.find((p) => p.id === 'lab') || {};
    const node = (await brain(`http://${hubwg}`, '/_wg/_node')).body || {};
    must(lab.up && Number(lab.tx) + Number(lab.rx) >= pdf.size, `the hub node's lab peer: ${JSON.stringify(lab)}`);
    const dropped = Object.entries(node.dropped || {}).filter(([k, v]) => v && ['unknown_key', 'wrong_link', 'replay', 'auth_fail', 'spoofed_ip'].includes(k));
    must(dropped.length === 0, `the hub node dropped ${JSON.stringify(node.dropped)}`);
    return `${pulled.trim()} · whole file through the tunnel → ${whole.status} ${String(whole.body?.error || whole.body || '').slice(0, 60)} · 1 MiB piece → 200, equal · hub node ↔ lab tx ${lab.tx} rx ${lab.rx} bytes`;
  });

  await step('S17.5', 'Claude Code was handed it: the prompt names the file at a path on lab with those bytes; its Read sent the model that PDF', async () => {
    must(turn, 'needs S17.4');
    const reqs = await poll(() => {
      const r = ccm().filter((x) => x.attached && x.attached.name);
      return r.length >= 2 ? r : null;
    }, 90_000, `cc_model never got a turn naming an attached file: ${JSON.stringify(ccm().slice(-2).map((x) => x.prompt))}`);
    const a = reqs[0].attached;
    must(a.name === 'report.pdf' && /pdf/.test(a.mime), `attached line ${JSON.stringify(a)}`);
    must(existsSync(a.path) && sha(readFileSync(a.path)) === pdf.sha256, `the path in the prompt (${a.path}) does not hold the PDF`);
    const read = reqs.find((x) => x.result);
    must(read && read.result.document_bytes === pdf.size && read.result.sha256 === pdf.sha256,
      `Read handed the model ${JSON.stringify(read && read.result)}`);
    return `"[attached by the owner: ${a.name} (${a.mime}, ${a.size}) — ${a.path.replace(STATE, '$STATE')} — …]" · Read → a ${read.result.document_bytes}-byte PDF document, sha256 equal`;
  });

  await step('S17.6', `the reply holds the marker word (${pdf.marker}) — in lab's store and on the phone's screen`, async () => {
    must(turn, 'needs S17.4');
    const reply = await poll(async () => {
      const ms = await labMsgs(labId);
      const at = ms.findIndex((m) => m.info.id === turn.info.id);
      return ms.slice(at + 1).find((m) => m.info.role === 'assistant' && m.info.time?.completed) || null;
    }, 90_000, 'lab never answered');
    must(textOf(reply).includes(pdf.marker), `lab answered "${textOf(reply).slice(0, 160)}"`);
    await phone.locator('[data-mi]').filter({ hasText: pdf.marker }).first().waitFor({ timeout: 60_000 });
    return `"${textOf(reply).slice(0, 100)}"`;
  });

  let href = '';
  await step('S17.7', '"now write marker.html into your artifacts folder with the marker word and link it" → the file on lab, the link on the phone', async () => {
    must(turn, 'needs S17.4');
    await send('now write marker.html into your artifacts folder with the marker word and link it');
    const file = join(ART, 'marker.html');
    await poll(() => existsSync(file), 90_000, `no ${file} (cc_model: ${JSON.stringify(ccm().slice(-1).map((x) => [x.action, x.artifacts_dir, x.word]))})`);
    must(readFileSync(file, 'utf8').includes(pdf.marker), 'marker.html does not hold the marker word');
    const link = phone.locator('[data-mi] a[href*="marker.html"]').last();
    await link.waitFor({ timeout: 60_000 });
    href = (await link.getAttribute('href')) || '';
    return `lab: ${file.replace(STATE, '$STATE')} · the phone's link: ${href}`;
  });

  await step('S17.8', 'Ása taps the link → the page opens: 200, text/html, the marker word on it', async () => {
    must(href, 'needs S17.7');
    const since = Date.now();
    const popup = ctx.waitForEvent('page', { timeout: 15_000 }).catch(() => null);
    await phone.locator('[data-mi] a[href*="marker.html"]').last().tap();
    const view = (await popup) || phone;
    await view.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    const doc = await poll(() => responses.find((r) => r.t >= since && r.url.includes('/api/artifact/marker.html') && r.kind === 'document'), 30_000,
      `no document load of the link after the tap (${JSON.stringify(responses.filter((r) => r.t >= since).slice(-3))})`);
    must(doc.status === 200, `the link answered ${doc.status} (${doc.url.replace(AP, '')})`);
    must(/^text\/html/.test(doc.type), `content-type ${doc.type}`);
    const text = await view.locator('body').innerText({ timeout: 15_000 });
    must(text.includes(pdf.marker), `the page shows "${text.slice(0, 120)}"`);
    if (view !== phone) screens.push(['popup', view]);
    return `${doc.url.replace(AP, '')} → ${doc.status} ${doc.type}, "${pdf.marker}" on the page (${view === phone ? 'same tab' : 'a new tab'})`;
  });

  await step('∀', `the phone only ever talked to ${AP}`, async () => {
    must(offAp.length === 0, offAp.slice(0, 3).join(' '));
  });
} finally {
  writeFileSync(join(STATE, 's17-responses.json'), JSON.stringify(responses, null, 1));
  process.stderr.write(`s17: ${failed.length ? 'RED ' + failed.join(' ') : 'GREEN'} in ${Math.round((Date.now() - t00) / 1000)} s\n`);
  if (joiner) joiner.kill('SIGTERM');
  await phoneBrowser.close().catch(() => {});
  await box.close().catch(() => {});
}
process.exit(failed.length ? 1 : 0);
