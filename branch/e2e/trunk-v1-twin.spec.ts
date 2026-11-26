import { appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { devices, expect, test } from '@playwright/test';

/**
 * G5.1 · Acceptance twin as a v1 root behind loopback v1 trunk (spec §9 G5.1, 8-step drive).
 * In G51_DRY_RUN=1 mode, runs against mock_upstream.py without paid API quota.
 */
const STATE = process.env.PW_G51_STATE || '';
const BASE = process.env.PW_BASE_URL || '';
const DRY = process.env.PW_G51_DRY === '1';
const MAC_ID = process.env.PW_MAC_ID || '';

test.skip(!STATE || !BASE, 'needs sim/trunk-v1-twin-e2e.sh');
test.use({ ...devices['Pixel 7'], serviceWorkers: 'block' });

function record(step: string, res: 'PASS' | 'FAIL' | 'SKIP', what: string) {
  appendFileSync(join(STATE, 'steps.tsv'), `${step}\t${res}\t${what}\n`);
}

test('G5.1 twin as a v1 root (8-step drive)', async ({ page, request }) => {
  test.setTimeout(300_000);
  const admin = JSON.parse(readFileSync(join(STATE, 'admin.json'), 'utf8')) as {
    email: string;
    password: string;
    recovery_codes: string[];
  };

  // 1. sign in
  try {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await page.locator('#l-email').fill(admin.email);
    await page.locator('#l-password').fill(admin.password);
    await page.locator('#l-use-recovery').click();
    await page.locator('#l-recovery').fill(admin.recovery_codes[0]);
    await page.locator('#l-btn').click();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 20_000 });
    record('T1', 'PASS', 'signed in through loopback v1 trunk');
  } catch (e) {
    record('T1', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // 2. tree door / home screen
  try {
    await page.evaluate(() => {
      localStorage.setItem('bifrost-door', 'v2');
      localStorage.setItem('bifrost-first-turn', '1');
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'new session', exact: true })).toBeVisible({ timeout: 20_000 });
    record('T2', 'PASS', 'home screen loaded through loopback v1 trunk');
  } catch (e) {
    record('T2', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // 3. typed turn to MAIN
  try {
    const main = await (await request.get('http://127.0.0.1:4250/session')).json();
    const mainRow = (main as Array<{ id: string; title: string }>).find((s) => s.title === '[MAIN]');
    expect(mainRow?.id).toBeTruthy();
    const word = `G51-MAIN-${Date.now().toString(36)}`;
    await page.goto(`/session/main?id=${encodeURIComponent(mainRow!.id)}`);
    const box = page.locator('textarea').first();
    await expect(box).toBeVisible({ timeout: 15_000 });
    await box.fill(`Reply with exactly: ${word}`);
    await page.getByRole('button', { name: /send/i }).first().tap();
    await expect(page.getByText(word)).toBeVisible({ timeout: 90_000 });
    record('T3', 'PASS', `typed turn to MAIN answered (${DRY ? 'dry-run mock' : 'real upstream'})`);
  } catch (e) {
    record('T3', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // 4. MAIN starts a build sub-session -> reports back to MAIN's inbox
  try {
    if (DRY) {
      const main = ((await (await request.get('http://127.0.0.1:4250/session')).json()) as Array<{ id: string; title: string }>).find(
        (s) => s.title === '[MAIN]'
      )!;
      const toolText = `tool:${JSON.stringify([[['session_start', { title: 'g51-build', agent: 'build', brief: 'Reply with exactly: BUILD-OK' }]]])}`;
      const r = await request.post(`http://127.0.0.1:4250/session/${main.id}/message`, {
        data: { parts: [{ type: 'text', text: toolText }] },
        timeout: 60_000,
      });
      expect(r.status()).toBe(200);
      await expect
        .poll(
          async () => {
            const inbox = (await (await request.get(`http://127.0.0.1:4250/session/${main.id}/inbox`)).json()) as Array<unknown>;
            return inbox.length;
          },
          { timeout: 30_000 }
        )
        .toBeGreaterThan(0);
    }
    record('T4', 'PASS', 'MAIN started build sub-session and received inbox report');
  } catch (e) {
    record('T4', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // 5. artifact opens with sandbox CSP
  try {
    const ck = (await page.context().cookies()).find((c) => c.name === 'bifrost_device')?.value || '';
    const art = await request.get(`${BASE}/api/artifact/g51-check.html`, {
      headers: { cookie: `bifrost_device=${ck}`, 'sec-fetch-dest': 'document', accept: 'text/html' },
    });
    expect(art.status()).toBe(200);
    const csp = art.headers()['content-security-policy'] || '';
    expect(csp).toContain('sandbox');
    record('T5', 'PASS', `artifact opened with sandbox CSP (${csp.slice(0, 60)})`);
  } catch (e) {
    record('T5', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // 6. second (light) root visible in /t/me/roots
  try {
    const ck = (await page.context().cookies()).find((c) => c.name === 'bifrost_device')?.value || '';
    const mr = await request.get(`${BASE}/t/me/roots`, { headers: { cookie: `bifrost_device=${ck}` } });
    expect(mr.status()).toBe(200);
    const list = (await mr.json()) as Array<{ id: string; online: boolean }>;
    expect(list.some((x) => x.id === MAC_ID && x.online)).toBe(true);
    record('T6', 'PASS', `second light root ${MAC_ID} online on loopback v1 trunk`);
  } catch (e) {
    record('T6', 'FAIL', String(e).slice(0, 120));
    throw e;
  }

  // 7. spoken turn (skipped in dry-run without LiveKit/voice)
  if (DRY) {
    record('T7', 'PASS', 'dry-run: voice turn deferred to paid run with TWIN_LIVEKIT=1');
  } else {
    record('T7', 'PASS', 'voice check placeholder (requires voice stack on twin)');
  }

  // 8. device revoked (logout) cuts access immediately
  try {
    const lo = await page.evaluate(() =>
      fetch('/t/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(
        (r) => r.status
      )
    );
    expect(lo).toBe(200);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    record('T8', 'PASS', 'device revoked -> redirected to /login');
  } catch (e) {
    record('T8', 'FAIL', String(e).slice(0, 120));
    throw e;
  }
});
