import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Hermetic 360px phone E2E for artifact gallery thumbnail laziness + gzip compression:
 *  its own Next app (next start on 8266) against files-brain.mjs on 4266 and an isolated
 *  artifacts dir. Never touches the live brain or live services. */
const APP_PORT = Number(process.env.ARTIFACT_PERF_APP_PORT || 8266);
const FAKE_PORT = Number(process.env.ARTIFACT_PERF_BRAIN_PORT || 4266);
const BRAIN = process.env.E2E_OC_URL || `http://127.0.0.1:${FAKE_PORT}`;
const baseURL = process.env.PW_BASE_URL || `http://127.0.0.1:${APP_PORT}`;
const TMP = process.env.E2E_ARTIFACT_PERF_TMP || '/tmp/artifact-perf-e2e';
process.env.E2E_ARTIFACTS_DIR ||= `${TMP}/artifacts`;
process.env.E2E_OC_URL ||= BRAIN;

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /artifact-perf\.spec\.ts/,
  timeout: 120_000,
  outputDir: 'test-results/artifact-perf',
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
          ],
        },
      ],
    },
  },
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
