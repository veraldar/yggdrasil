import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** md-page (11-23): the .md → phone page contract, hermetic — its own app
 *  (next start on 8262) against its own fake brain (e2e/fixtures/files-brain.mjs
 *  on 4262), its own artifacts dir (~/.cache/p2-reach/md-page-e2e/artifacts).
 *  Nothing live is touched. PW_BASE_URL aims it at an already-served app. */
const APP_PORT = Number(process.env.MD_APP_PORT || 8262);
const FAKE_PORT = 4262;
const BRAIN = process.env.E2E_OC_URL || `http://127.0.0.1:${FAKE_PORT}`;
const baseURL = process.env.PW_BASE_URL || `http://127.0.0.1:${APP_PORT}`;
const TMP = process.env.E2E_MD_TMP || '/home/dweeb_xyz/.cache/p2-reach/md-page-e2e';
process.env.E2E_ARTIFACTS_DIR ||= `${TMP}/artifacts`;

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /md-page\.spec\.ts/,
  timeout: 120_000,
  outputDir: 'test-results/md-page',
  webServer: [
    {
      command: 'node e2e/fixtures/files-brain.mjs',
      url: `${BRAIN}/root`,
      env: { PORT: String(FAKE_PORT) },
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe' as const,
    },
    ...(process.env.PW_BASE_URL
      ? []
      : [
          {
            command: `npx next start -p ${APP_PORT} -H 127.0.0.1`,
            url: `${baseURL}/api/ping`,
            env: {
              OPENCODE_URL: BRAIN,
              ARTIFACTS_DIR: process.env.E2E_ARTIFACTS_DIR,
              ARTIFACTS_MAIN_DIR: '',
              BIFROST_AUTH: 'tailnet',
            },
            timeout: 90_000,
            reuseExistingServer: false,
          },
        ]),
  ],
});
