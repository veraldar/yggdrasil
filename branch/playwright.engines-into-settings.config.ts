import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Engines-into-settings 360 px mobile touch verification against an isolated rig
 *  (mock upstream + brain + this worktree's next start — never a live brain). */
const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:18570';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /engines-into-settings\.spec\.ts/,
  use: {
    ...base.use,
    baseURL: BASE,
    serviceWorkers: 'block',
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
