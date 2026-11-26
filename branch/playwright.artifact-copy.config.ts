import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Hermetic 360px phone E2E for the artifact copy-link keys (grid card + chat):
 *  its own Next app (next start on 8264) against the fake brain (files-brain.mjs on 4264)
 *  and its own artifacts dir. Never touches the live brain or live services. */
const APP_PORT = Number(process.env.ARTIFACT_COPY_APP_PORT || 8265);
const FAKE_PORT = Number(process.env.ARTIFACT_COPY_BRAIN_PORT || 4265);
const BRAIN = process.env.E2E_OC_URL || `http://127.0.0.1:${FAKE_PORT}`;
const baseURL = process.env.PW_BASE_URL || `http://127.0.0.1:${APP_PORT}`;
const TMP = process.env.E2E_ARTIFACT_COPY_TMP || '/tmp/artifact-copy-e2e';
process.env.E2E_ARTIFACTS_DIR ||= `${TMP}/artifacts`;
process.env.E2E_OC_URL ||= BRAIN;

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /artifact-copy.spec\.ts/,
  timeout: 120_000,
  outputDir: 'test-results/artifact-copy',
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
