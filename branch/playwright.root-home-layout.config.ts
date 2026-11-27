import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** A root's page is the home screen of that computer — on its own rig
 *  (sim/root-home-layout-e2e.sh: three brains on the mock upstream — home, lab, and "old", a
 *  brain from before the per-root settings routes — and this app in devices mode), never a
 *  live brain. The owner's phone: an Android at 360 px wide, touch, the app's world = utopia. */
const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:18560';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /root-home-layout\.spec\.ts/,
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
            { name: 'theme', value: 'utopia' },
          ],
        },
      ],
    },
  },
  projects: [
    {
      name: 'android-360',
      use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 }, deviceScaleFactor: 3 },
    },
  ],
});
