import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Soak-style smoke check for the composed static site (`dist/site/`) built by
// `scripts/build-site.sh`. Named `*.pw.ts` (not `*.test.ts`/`*.spec.ts`) so
// `bun test` never picks it up — matches the convention in
// packages/pyric-tools/test/e2e/playwright.config.ts.
//
// `webServer` serves the ALREADY-BUILT `dist/site/` with a plain static file
// server (python3's http.server) — there is no `pyric dev` behind this site,
// which is the whole point of the check: everything must degrade cleanly
// with zero server routes.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.pw.ts',
  timeout: 30_000,
  reporter: 'list',
  use: {
    baseURL: process.env.SITE_E2E_BASE ?? 'http://127.0.0.1:5199',
    headless: true,
  },
  webServer: process.env.SITE_E2E_BASE
    ? undefined
    : {
        command: 'python3 -m http.server 5199 --bind 127.0.0.1 --directory ../../../../../dist/site',
        cwd: __dirname,
        url: 'http://127.0.0.1:5199',
        reuseExistingServer: false,
        timeout: 20_000,
      },
});
