import { type BrowserContext, type Page, expect, test } from '@playwright/test';

/**
 * A tapped artifact link is a page NAVIGATION: no Authorization header, only the cookie — and the
 * cookie is SameSite=Strict, so a link followed from another site (a phone's browser opening the PWA's
 * link out of the app) arrives with none; and the access cookie outlives its 15-minute token, so a
 * link opened later arrives with an expired one. Both ended in a bare JSON 401 "device token
 * required" (owner, 11-26, engine-fallback-proposal.html) — the app's own pages got the /pair
 * rescue (lib/gate.ts pageGate), the artifact link did not.
 *
 * Runs against a devices-mode box on a LAN address: playwright.artifact-link.config.ts.
 */
const LAN = process.env.AL_LAN_URL || '';
const BASE = process.env.AL_BASE || '';
const URL_ = `${LAN}/api/artifact/link-proof.html`;
const PROOF = 'artifact-link-proof-bytes';

test.skip(!LAN, 'run with playwright.artifact-link.config.ts');
test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

async function pairedPhone(browser: import('@playwright/test').Browser): Promise<BrowserContext> {
  const desk = await browser.newContext(); // loopback = the box's console
  const minted = await (await desk.request.post(`${BASE}/api/pair/code`)).json();
  const code = new URLSearchParams(String(minted.url).split('#')[1]).get('code');
  await desk.close();
  const phone = await browser.newContext({
    viewport: { width: 360, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  const claim = await phone.request.post(`${LAN}/api/pair/claim`, {
    data: { code, name: 'link-probe' },
  });
  expect(claim.status()).toBe(200);
  expect((await phone.cookies()).find((c) => c.name === 'bifrost_device')?.sameSite).toBe('Strict');
  return phone;
}

const proofOn = async (p: Page) => {
  await p.waitForLoadState('domcontentloaded');
  // the failure this pins: a bare JSON 401 where the artifact should be
  await expect(p.locator('body')).not.toContainText('device token required', { timeout: 1 });
  await expect(p.locator('#proof')).toHaveText(PROOF, { timeout: 20_000 });
};

test('a paired phone taps the link from another site (Strict cookie withheld): the artifact opens', async ({
  browser,
}) => {
  const phone = await pairedPhone(browser);
  // the proof the premise holds: this very navigation reaches the box with no cookie at all
  const seen: string[] = [];
  phone.on('request', (r) => r.url() === URL_ && seen.push(r.headers()['cookie'] || ''));
  const chat = await phone.newPage();
  await chat.route('http://elsewhere.test/**', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<a id="l" target="_blank" rel="noreferrer" href="${URL_}">Smarter engine fallback proposal</a>`,
    })
  );
  await chat.goto('http://elsewhere.test/chat');
  const [tab] = await Promise.all([phone.waitForEvent('page'), chat.click('#l')]);
  await proofOn(tab);
  expect(seen[0], 'the first request of the tap carried no cookie').toBe('');
});

test('an access token that ran out: opening the artifact link refreshes and opens', async ({
  browser,
}) => {
  const phone = await pairedPhone(browser);
  await new Promise((r) => setTimeout(r, 6_000)); // BIFROST_ACCESS_TTL_S=4
  const tab = await phone.newPage();
  await tab.goto(URL_);
  await proofOn(tab);
});

test('a stranger (never paired) is not served the artifact, nor a bare JSON error', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const tab = await ctx.newPage();
  await tab.goto(URL_);
  await expect(tab.getByTestId('pair-quiet')).toBeVisible({ timeout: 20_000 });
  expect(await tab.content()).not.toContain(PROOF);
  // and the fetch an app script makes still gets the status line it reads
  expect(
    (
      await ctx.request.get(URL_, { headers: { accept: '*/*', 'sec-fetch-dest': 'empty' } })
    ).status()
  ).toBe(401);
});
