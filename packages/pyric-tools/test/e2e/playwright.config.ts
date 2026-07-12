import { defineConfig } from '@playwright/test';

// Manual repro for the served-mode auth bug (the worker over Tailscale / a
// non-localhost http origin). Tests are named `*.pw.ts` so `bun test` (which
// matches `*.test.ts` / `*.spec.ts`) never picks them up; Playwright finds them
// via `testMatch` below. Requires the @pyric/cli dist (`bun run build:pyric-tools`).
//
// localhost: the webServer starts `pyric dev` on the fixture automatically.
// Tailscale repro: run your own serve and set E2E_BASE=http://<tailnet-host>:<port>.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.pw.ts',
  timeout: 30_000,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE ?? 'http://127.0.0.1:5180',
    headless: true,
    ignoreHTTPSErrors: true,
  },
  // Only auto-start a localhost serve when not pointed at an external (tailnet) base.
  webServer: process.env.E2E_BASE
    ? undefined
    : {
        command: 'node ../../../dist/cli/index.js dev --port 5180 --no-open',
        cwd: 'fixture',
        url: 'http://127.0.0.1:5180',
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
