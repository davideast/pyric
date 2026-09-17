import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  workers: 1,
  timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:53917', headless: true },
  webServer: {
    command: 'node test-server.mjs',
    cwd: import.meta.dirname,
    url: 'http://127.0.0.1:53917',
    env: { TEAMS_HOSTED: process.env.TEAMS_HOSTED ?? '1', TEAMS_PORT: '53917', PYRIC_PROJECT: 'orbit-demo' },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
