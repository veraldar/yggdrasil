import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** The roots sheet (E2 · the whole tree) on its own rig: sim/roots-sheet-e2e.sh starts two
 *  brains on the mock upstream (home + lab), this app in devices mode against home, and seeds a
 *  device — never a live brain. A Pixel-7 phone (412×915) that walked the door. */
const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:18520';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /roots-sheet\.spec\.ts/,
  use: {
    ...base.use,
    baseURL: BASE,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(BASE).origin,
          localStorage: [
            { name: 'bifrost-door', value: 'v2' },
            { name: 'bifrost-first-turn', value: '1' },
          ],
        },
      ],
    },
  },
  projects: [{ name: 'pixel-7', use: { ...devices['Pixel 7'] } }],
});
