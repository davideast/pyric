import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../../packages/cli/test/e2e/hosted',
  testMatch: 'i16-collected-heap.pw.ts',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { headless: true },
});
