import { mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { defineConfig } from '@playwright/test';

/** artifact-link.spec: a devices-mode box on a LAN address (loopback is the console — it would pass
 *  every gate), a throwaway devices file, a throwaway artifacts folder. Never the live services. */
const PORT = Number(process.env.AL_PORT || 18311);
const lanIp = () => {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('172.')) return i.address;
  return '';
};
const LAN = process.env.AL_LAN || lanIp();
const dir = process.env.AL_STATE || path.join(os.tmpdir(), `artifact-link-${process.pid}`);
mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
writeFileSync(
  path.join(dir, 'artifacts', 'link-proof.html'),
  '<!doctype html><title>link proof</title><p id="proof">artifact-link-proof-bytes</p>'
);
process.env.AL_LAN_URL = `http://${LAN}:${PORT}`;
process.env.AL_BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /artifact-link\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { viewport: { width: 360, height: 780 } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node server.mjs',
    url: `http://127.0.0.1:${PORT}/pair`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      NODE_ENV: 'production',
      BIFROST_AUTH: 'devices',
      BIFROST_DEVICES_FILE: path.join(dir, 'devices.json'),
      BIFROST_OBS: 'off',
      BIFROST_ADMIN_TOKEN: 'admin-artifact-link-test',
      BIFROST_PUBLIC_URL: `http://${LAN}:${PORT}`,
      OPENCODE_URL: 'http://127.0.0.1:9', // no brain: the artifact route needs none
      BIFROST_BRIDGE_URL: 'http://127.0.0.1:9',
      ARTIFACTS_DIR: path.join(dir, 'artifacts'),
      ARTIFACTS_MAIN_DIR: '',
      BIFROST_ACCESS_TTL_S: '4',
      BIFROST_RATE_BURST: '500',
      PORT: String(PORT),
      HOST: '0.0.0.0',
    },
  },
});
