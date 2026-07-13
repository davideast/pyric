import { defineConfig } from '@playwright/test';

// Real-browser soak suite for the bridge lifecycle layer (peer slot,
// standby, sub re-issue dedup, MCP route). Each test spawns its own
// `pyric dev --ui --bridge --no-open --port 0 --json` serve in a temp copy
// of the fixture — there is deliberately NO shared webServer here.
//
// Files are named `*.soak.ts` so neither `bun test` (`*.test.ts` /
// `*.spec.ts`) nor the sibling auth e2e config (`**/*.pw.ts`) ever picks
// them up. Run via the root `bun run test:soak` (requires the built
// @pyric/cli dist + `bunx playwright install chromium`).
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.soak.ts',
  // The headline scenario soaks ~60s of real time on top of serve boot.
  timeout: 150_000,
  reporter: 'list',
  workers: 1,
  fullyParallel: false,
  use: {
    headless: true,
  },
});
