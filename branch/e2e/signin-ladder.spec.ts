import { readFileSync } from 'fs';
import { join } from 'path';
import { devices, expect, test } from '@playwright/test';

/**
 * G2.1 · signin-ladder (v1 port of pair-ladder.spec.ts):
 * Phone (Pixel 7) starts unauthenticated (sees /login, zero app bytes) → signs in via the
 * real v1 trunk /login form (email + password + recovery/MFA) → lands on home →
 * creates a session and completes a typed turn on the real brain → logs out → redirected to /login.
 */
const STATE = process.env.PW_V1_STATE || '';
const BASE = process.env.PW_BASE_URL || '';

test.skip(!STATE || !BASE, 'needs scripts/v1-ladder.sh');
test.use({ ...devices['Pixel 7'], serviceWorkers: 'block' });

type Admin = {
  email: string;
  password: string;
  recovery_codes: string[];
};
const admin = (): Admin => JSON.parse(readFileSync(join(STATE, 'admin.json'), 'utf8'));

test('signin-ladder: stranger → /login → sign in → home → typed turn → logout', async ({ page, request }) => {
  test.setTimeout(180_000);
  const a = admin();

  await test.step('1 unauthenticated phone lands on /login with zero app bytes', async () => {
    const raw = await request.get('/', { maxRedirects: 0 });
    expect(raw.status()).toBe(302);
    expect(raw.headers().location).toMatch(/^\/login/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  await test.step('2 sign in through the v1 trunk login flow', async () => {
    await page.locator('#l-email').fill(a.email);
    await page.locator('#l-password').fill(a.password);
    await page.locator('#l-use-recovery').click();
    await page.locator('#l-recovery').fill(a.recovery_codes[1]);
    await page.locator('#l-btn').click();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 20_000 });
  });

  await test.step('3 signed-in phone reaches the app and completes a typed turn on the brain', async () => {
    await page.evaluate(() => {
      localStorage.setItem('bifrost-door', 'v2');
      localStorage.setItem('bifrost-first-turn', '1');
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'new session', exact: true })).toBeVisible({ timeout: 20_000 });
    const me = await page.evaluate(() => fetch('/t/me').then((r) => r.json()));
    expect(me.account.email).toBe(a.email);
    expect(me.device.role).toBe('admin');

    const word = `V1-LADDER-${Date.now().toString(36)}`;
    await page.getByRole('button', { name: 'new session', exact: true }).tap();
    await page.waitForURL(/\/session\//, { timeout: 20_000 });
    const box = page.locator('textarea').first();
    await expect(box).toBeVisible({ timeout: 15_000 });
    await box.fill(`Reply with exactly: ${word}`);
    await page.getByRole('button', { name: /send/i }).first().tap();
    await expect(page.getByText(word)).toBeVisible({ timeout: 60_000 });
  });

  await test.step('4 logout clears the session and returns to /login', async () => {
    const lo = await page.evaluate(() =>
      fetch('/t/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(
        (r) => r.status
      )
    );
    expect(lo).toBe(200);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});
