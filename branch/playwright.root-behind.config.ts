import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** The "not up to date" marker on its own rig: sim/root-behind-e2e.sh starts three brains on the
 *  mock upstream (home + lab on this tree's brain, old on an older one), this app in devices mode
 *  against home, and seeds a device — never a live brain. An Android phone at 360×780, touch. */
const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:18540';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /root-behind\.spec\.ts/,
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
  projects: [
    {
      name: 'android-360',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 360, height: 780 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
