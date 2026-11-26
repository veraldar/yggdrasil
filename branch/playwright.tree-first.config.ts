import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** The door + the first voice turn live on the SANDBOX server (:8090) only —
 *  the main config targets the live :8080, which doesn't carry the flow.
 *  Phone shape for real: the main config's Desktop Chrome project overrides
 *  its viewport. first-turn-voice talks to the real sandbox stack (LiveKit →
 *  lk-agent-ygg → STT → yggdrasil) through Chrome's own capture path. */
const OWN_ROUTE = /answers carried from veraldar\.org|back\/forward walk the steps/;
const phone = { ...devices['Desktop Chrome'], viewport: { width: 360, height: 780 } };

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /(tree-first|first-turn-voice|voice-wait)\.spec\.ts/,
  // a FRESH device (no storageState): the door is the subject here
  use: { ...base.use, storageState: undefined, baseURL: process.env.PW_BASE_URL || 'http://127.0.0.1:8090' },
  // two door tests answer POST /api/onboard with their own page.route(); a request the app's service worker
  // handled (sw.js answers /api/*) never reaches a page route. Those two, and only those, run without the
  // worker; every other door test keeps it, as a phone has it.
  projects: [
    { name: 'chromium', grepInvert: OWN_ROUTE, use: phone },
    { name: 'chromium-no-sw', grep: OWN_ROUTE, use: { ...phone, serviceWorkers: 'block' } },
  ],
});
