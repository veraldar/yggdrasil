import { defineConfig } from '@playwright/test';

/** The live door proof (e2e/live-door.spec.ts): the real ap.veraldar.org and :8447, no web server. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /live-door\.spec\.ts/,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  outputDir: process.env.PW_OUT ? `${process.env.PW_OUT}/pw` : '/tmp/live-door/pw',
});
