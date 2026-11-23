import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** md-e2e-b (11-23): the pre-existing artifact suites re-run against this
 *  branch's build on a throwaway app (:8263) + fake brain (:4263), the
 *  app's artifacts env at its DEFAULTS (the worktree's ../artifacts plus
 *  the implicit main dir — artifact-plumb tests exactly that union).
 *  PW_BASE_URL aims it at an already-served app. */
const APP_PORT = Number(process.env.MDB_APP_PORT || 8263);
const FAKE_PORT = 4263;
const BRAIN = process.env.E2E_OC_URL || `http://127.0.0.1:${FAKE_PORT}`;
const baseURL = process.env.PW_BASE_URL || `http://127.0.0.1:${APP_PORT}`;

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /(artifacts|chat-files|artifact-plumb)\.spec\.ts/,
  timeout: 120_000,
  outputDir: 'test-results/md-e2e-b',
  // pin the target: tests hit THIS run's app, never :8080
  use: { ...base.use, baseURL },
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
            url: `http://127.0.0.1:${APP_PORT}/api/ping`,
            env: {
              OPENCODE_URL: BRAIN,
              BIFROST_AUTH: 'tailnet',
            },
            timeout: 90_000,
            reuseExistingServer: false,
          },
        ]),
  ],
});
