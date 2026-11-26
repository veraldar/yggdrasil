import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Hermetic 360px phone E2E for the requests board (/requests): the rig brain (sim/requests-board-rig.sh —
 *  a sanitized copy of the live sessions, no harness, no model) on :19700 and its own Next app on :19701.
 *  Never the twin, never the live brain. */
const BRAIN_PORT = Number(process.env.RB_BRAIN_PORT || 19700);
const APP_PORT = Number(process.env.RB_APP_PORT || 19701);
const BRAIN = `http://127.0.0.1:${BRAIN_PORT}`;
const baseURL = `http://127.0.0.1:${APP_PORT}`;
process.env.E2E_OC_URL ||= BRAIN;

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /requests-board.spec\.ts/,
  timeout: 120_000,
  outputDir: 'test-results/requests-board',
  use: {
    ...base.use,
    baseURL,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [
            { name: 'bifrost-door', value: 'v2' },
            { name: 'bifrost-first-turn', value: '1' },
          ],
        },
      ],
    },
  },
  webServer: [
    {
      command: `bash ../sim/requests-board-rig.sh up && exec tail -f /dev/null`,
      url: `${BRAIN}/session`,
      timeout: 120_000,
      reuseExistingServer: true,
    },
    {
      command: `npx next start -p ${APP_PORT} -H 127.0.0.1`,
      url: `${baseURL}/api/ping`,
      env: {
        OPENCODE_URL: BRAIN,
        ARTIFACTS_DIR: '',
        ARTIFACTS_MAIN_DIR: '',
        BIFROST_AUTH: 'tailnet',
      },
      timeout: 90_000,
      reuseExistingServer: false,
    },
  ],
});
