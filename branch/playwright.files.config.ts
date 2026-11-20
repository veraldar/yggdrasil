import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Package 2 — files are files (e2e/files-reach.spec.ts): a Pixel 7 picks files, they go up in
 *  pieces, the message carries them, a file another root made opens here.
 *  Runs its own app (next start on FILES_APP_PORT, 8261) on this tree's build against
 *  E2E_OC_URL — or, without one, the stand-in brain e2e/fixtures/files-brain.mjs on :4261
 *  (the contract's file routes, faithfully). PW_BASE_URL: an app already served (no start).
 *  The real brain: E2E_OC_URL=http://127.0.0.1:426x with YGG_FILE_MAX_MB=5, and the other
 *  root's artifacts dir in E2E_LAB_ARTIFACTS (its name in E2E_LAB_ROOT). */
const APP_PORT = Number(process.env.FILES_APP_PORT || 8261);
const FAKE_PORT = 4261;
const BRAIN = process.env.E2E_OC_URL || `http://127.0.0.1:${FAKE_PORT}`;
const baseURL = process.env.PW_BASE_URL || `http://127.0.0.1:${APP_PORT}`;
const TMP = process.env.E2E_FILES_TMP || '/home/dweeb_xyz/.cache/p2-reach/app-tmp/files-e2e';
process.env.E2E_LAB_ARTIFACTS ||= `${TMP}/lab-artifacts`;
process.env.E2E_HOME_ARTIFACTS ||= `${TMP}/home-artifacts`;
process.env.E2E_FILE_MAX_MB ||= '5';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /files-reach\.spec\.ts/,
  timeout: 120_000,
  outputDir: 'test-results/files-reach',
  webServer: [
    ...(process.env.E2E_OC_URL
      ? []
      : [
          {
            command: 'node e2e/fixtures/files-brain.mjs',
            url: `${BRAIN}/root`,
            env: {
              PORT: String(FAKE_PORT),
              YGG_FILE_MAX_MB: process.env.E2E_FILE_MAX_MB,
              FAKE_LAB_NAME: process.env.E2E_LAB_ROOT || 'lab',
              FAKE_LAB_ARTIFACTS: process.env.E2E_LAB_ARTIFACTS,
            },
            reuseExistingServer: false,
            stdout: 'pipe' as const,
          },
        ]),
    ...(process.env.PW_BASE_URL
      ? []
      : [
          {
            command: `npx next start -p ${APP_PORT} -H 127.0.0.1`,
            url: `${baseURL}/api/ping`,
            env: {
              OPENCODE_URL: BRAIN,
              ARTIFACTS_DIR: process.env.E2E_HOME_ARTIFACTS,
              ARTIFACTS_MAIN_DIR: '',
              BIFROST_AUTH: 'tailnet',
            },
            timeout: 90_000,
            reuseExistingServer: false,
          },
        ]),
  ],
  use: {
    ...base.use,
    baseURL,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(baseURL).origin,
          localStorage: [
            { name: 'bifrost-door', value: 'v2' },
            { name: 'bifrost-first-turn', value: '1' },
            { name: 'oz-mode', value: 'text' },
          ],
        },
      ],
    },
  },
  projects: [{ name: 'pixel7', use: { ...devices['Pixel 7'] } }],
});
