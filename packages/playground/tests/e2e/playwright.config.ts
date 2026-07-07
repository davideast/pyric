import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the playground deploy E2E proof. The test
 * drives the live Astro dev server (assumed running on :4321 — start
 * it with `bun run dev` in another shell). We don't auto-spawn the
 * server here because the dev workflow is to leave it up between
 * test runs; the proof exits in ~5min and a cold start of the SDK
 * workspace + Astro adds ~15s for no benefit.
 *
 * Single worker, retries=0 — the test ships real Firebase artifacts
 * to a real project; parallel runs would race on rules + indexes,
 * and a retried run would double-deploy.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  timeout: 10 * 60_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: 'http://localhost:4321',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
