import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../fixture/', import.meta.url));
const cli = fileURLToPath(new URL('../../../dist/cli/index.js', import.meta.url));
const testHome = path.join(tmpdir(), 'pyric-cli-site-e2e');

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.pw.ts',
  timeout: 30_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5201',
    headless: true,
  },
  webServer: {
    command: `bun ${cli} dev --ui --no-open --no-capture --no-watch --host 127.0.0.1 --port 5201`,
    cwd: fixture,
    env: { ...process.env, HOME: testHome, USERPROFILE: testHome },
    url: 'http://127.0.0.1:5201/__pyric/ui/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
