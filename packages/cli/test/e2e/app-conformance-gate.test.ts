import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../../..');
const cliPackage = JSON.parse(
  readFileSync(resolve(root, 'packages/cli/package.json'), 'utf8'),
) as { scripts?: Record<string, string> };
const workflow = readFileSync(resolve(root, '.github/workflows/build.yml'), 'utf8');
const browserJobStart = workflow.indexOf('  browser-conformance:');
const browserJobEnd = workflow.indexOf('\n  packaging:', browserJobStart);
const browserJob = workflow.slice(browserJobStart, browserJobEnd);

describe('served app conformance merge gate', () => {
  test('the CLI script runs every SharedWorker topology proof', () => {
    const command = cliPackage.scripts?.['test:app-conformance'];
    expect(command).toBeDefined();
    expect(command).toContain('--config test/e2e/playwright.config.ts');
    expect(command).toContain('app-deletion.pw.ts');
    expect(command).toContain('app-multi-app.pw.ts');
    expect(command).toContain('ai-worker-boundary.pw.ts');
    expect(command).toContain('messaging-app-boundary.pw.ts');
  });

  test('required CI installs Chromium and runs the proof after building', () => {
    expect(browserJobStart).toBeGreaterThanOrEqual(0);
    expect(browserJobEnd).toBeGreaterThan(browserJobStart);
    expect(browserJob).toContain('Cache Playwright Chromium');
    expect(browserJob).toContain('bunx playwright install chromium');
    expect(browserJob).toContain('bunx playwright install-deps chromium');
    expect(browserJob).toContain('bun run --cwd packages/cli test:app-conformance');
    const build = browserJob.indexOf('bash scripts/build.sh');
    const cache = browserJob.indexOf('Cache Playwright Chromium');
    const browser = browserJob.indexOf('bunx playwright install chromium');
    const dependencies = browserJob.indexOf('bunx playwright install-deps chromium');
    const proof = browserJob.indexOf('bun run --cwd packages/cli test:app-conformance');
    expect(build).toBeLessThan(cache);
    expect(cache).toBeLessThan(browser);
    expect(browser).toBeLessThan(dependencies);
    expect(dependencies).toBeLessThan(proof);
  });
});
