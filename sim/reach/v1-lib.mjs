/* v1-lib.mjs — the v1 trunk's side of the phone drivers (s16.mjs under sim/trunk-rtc-v1-e2e.sh,
 * two-voice-v1.mjs): the admin's laptop signed in to the trunk (claim-admin.py's JSON), a fresh
 * second factor for it (TOTP from the seed), the real single-use QR (/pair → POST /t/pair/qr,
 * or `trunk-ctl pair-qr`), and a phone redeeming it (POST /t/pair/redeem) and opening the door.
 */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, must } from './rig-lib.mjs';

function b32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/[\s=]/g, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

/** RFC 6238, SHA-1, 6 digits, 30 s */
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', b32(secret)).update(msg).digest();
  const off = mac[19] & 0x0f;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** a page's own fetch (its cookies; Origin set by the browser on writes) */
export const pageFetch = (page, path, init = {}) =>
  page.evaluate(
    async ({ path, init }) => {
      const r = await fetch(path, {
        method: init.method || 'GET',
        headers: init.body ? { 'content-type': 'application/json' } : {},
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      const text = await r.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* text */
      }
      return { status: r.status, via: r.headers.get('x-bifrost-via'), body };
    },
    { path, init }
  );

/** the admin's laptop: its own Chromium (at home, through the VPS), signed in with the claim's cookies */
export async function adminDesk({ ap, apIp, adminPath }) {
  const host = new URL(ap).hostname;
  const admin = JSON.parse(readFileSync(adminPath, 'utf8'));
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${host} ${apIp}`, '--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  const c = { domain: host, secure: true, httpOnly: true, sameSite: 'Strict' };
  await ctx.addCookies([
    { name: 'bifrost_device', value: admin.cookies.bifrost_device, path: '/', ...c },
    ...(admin.cookies.bifrost_refresh ? [{ name: 'bifrost_refresh', value: admin.cookies.bifrost_refresh, path: '/t/auth', ...c }] : []),
  ]);
  const page = await ctx.newPage();
  return { browser, ctx, page, admin };
}

/** a fresh second factor on the admin's device (a TOTP step is never taken twice) */
export async function stepUp(page, admin) {
  const now = Math.floor(Date.now() / 30_000);
  let s = Math.max(now - 1, (admin.last_step ?? 0) + 1);
  if (s > now + 1) {
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 300));
    s = Math.floor(Date.now() / 30_000);
  }
  const r = await pageFetch(page, '/t/auth/step-up', { method: 'POST', body: { totp: totpAt(admin.totp_secret, s) } });
  must(r.status === 200, `step-up: ${r.status} ${JSON.stringify(r.body)}`);
  admin.last_step = s;
}

/** the phone redeems a QR link: the shell's /pair page → POST /t/pair/redeem → "joined" → the door
 *  by itself (spec F5 step 3: the page goes where the trunk's `next` says — no tap); the landing is
 *  waited for, never tapped, so nothing here races that navigation */
export async function redeem(phone, url, ap) {
  const redeemed = phone.waitForResponse((r) => r.url().endsWith('/t/pair/redeem'));
  await phone.goto(url);
  const r = await redeemed;
  must(r.status() === 200, `redeem: ${r.status()} ${await r.text().catch(() => '')}`);
  const next = (await r.json().catch(() => ({}))).next;
  must(next === '/', `redeem: the landing is ${next} (a door root is online: /)`);
  await phone.locator('#p-joined').waitFor({ timeout: 10_000 });
  await phone.waitForURL(`${ap}/`, { timeout: 30_000 });
  await phone.getByTestId('roots').waitFor({ timeout: 30_000 });
}

/** the admin's /pair shows the QR; the phone "scans" it (zbarimg) and redeems it through the trunk */
export async function pairV1(desk, phone, { ap, png }) {
  await desk.page.goto(`${ap}/devices`);
  await stepUp(desk.page, desk.admin);
  await desk.page.goto(`${ap}/pair`);
  const qr = desk.page.locator('#p-qr-img');
  await qr.locator('svg').waitFor({ timeout: 20_000 });
  writeFileSync(png, await qr.screenshot());
  const url = execFileSync('zbarimg', ['--raw', '-q', png]).toString().trim();
  must(url.startsWith(`${ap}/pair#v=2&t=bfnp-`), `QR says ${url.replace(/t=.*/, 't=…')}`);
  await redeem(phone, url, ap);
  await desk.page.locator('#p-joined').waitFor({ timeout: 10_000 });
  return url;
}

/** a pairing link straight from the trunk's console (`trunk-ctl pair-qr`) */
export function consoleQr(ctl) {
  const argv = ctl.split(' ').filter(Boolean);
  return JSON.parse(execFileSync(argv[0], [...argv.slice(1), 'pair-qr'], { encoding: 'utf8' })).url;
}
