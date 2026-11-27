import { defineConfig } from '@playwright/test';

/** L16: the "which reply is said aloud for a held turn" rule (lib/held-reply.ts) — pure logic,
 *  no app, no brain:  npx playwright test -c playwright.held.config.ts */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'held-reply.spec.ts',
  reporter: 'list',
});
