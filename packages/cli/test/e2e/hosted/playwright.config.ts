import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.pw.ts',
  timeout: 45_000,
  reporter: 'list',
  workers: 1,
  fullyParallel: false,
  use: {
    headless: true,
    trace: 'retain-on-failure',
  },
});
