import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../packages/cli/dist/cli/index.js', import.meta.url));

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.pw.ts',
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4289',
    headless: true,
  },
  webServer: {
    command: `bun ${cli} dev --port 4288 --no-open -- bun x next dev --port 4289`,
    url: 'http://127.0.0.1:4289',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
