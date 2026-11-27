import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:8250';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /root-detail\.spec\.ts/,
  use: {
    ...base.use,
    baseURL: BASE,
    viewport: { width: 360, height: 780 },
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
  projects: [{ name: 'phone-360', use: { viewport: { width: 360, height: 780 } } }],
});
