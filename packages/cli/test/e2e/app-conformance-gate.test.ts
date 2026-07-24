import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../../..');
const rootPackage = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
) as { scripts?: Record<string, string> };
const cliPackage = JSON.parse(
  readFileSync(resolve(root, 'packages/cli/package.json'), 'utf8'),
) as { scripts?: Record<string, string> };
const workflow = readFileSync(resolve(root, '.github/workflows/build.yml'), 'utf8');
const mainJobStart = workflow.indexOf('  build-and-test:');
const mainJobEnd = workflow.indexOf('\n  library-tests:', mainJobStart);
const mainJob = workflow.slice(mainJobStart, mainJobEnd);
const libraryJobStart = mainJobEnd;
const libraryJobEnd = workflow.indexOf('\n  browser-conformance:', libraryJobStart);
const libraryJob = workflow.slice(libraryJobStart, libraryJobEnd);
const browserJobStart = workflow.indexOf('  browser-conformance:');
const browserJobEnd = workflow.indexOf('\n  packaging:', browserJobStart);
const browserJob = workflow.slice(browserJobStart, browserJobEnd);
const standaloneJobStart = workflow.indexOf('  standalone:');
const standaloneJobEnd = workflow.indexOf('\n  required:', standaloneJobStart);
const standaloneJob = workflow.slice(standaloneJobStart, standaloneJobEnd);

describe('served app conformance merge gate', () => {
  test('required CI splits CLI and library tests without a standalone docs job', () => {
    expect(workflow).not.toContain('\n  documentation:');
    expect(workflow).not.toContain('\n  docs-only:');
    expect(mainJobStart).toBeGreaterThanOrEqual(0);
    expect(mainJobEnd).toBeGreaterThan(mainJobStart);
    expect(mainJob).toContain('uses: ./.github/actions/restore-dist');
    expect(mainJob).toContain('flavor: packages');
    expect(mainJob).toContain('bun run test:ci:cli');
    expect(mainJob).not.toContain('bun run test:ci:libraries');
    expect(libraryJobStart).toBeGreaterThanOrEqual(0);
    expect(libraryJobEnd).toBeGreaterThan(libraryJobStart);
    expect(libraryJob).toContain('uses: ./.github/actions/restore-dist');
    expect(libraryJob).toContain('flavor: packages');
    expect(libraryJob).toContain('bun run test:ci:libraries');
    expect(libraryJob).not.toContain('bun run test:ci:cli');
    const complete = rootPackage.scripts?.test?.split(' && ') ?? [];
    const split = [
      ...(rootPackage.scripts?.['test:ci:cli']?.split(' && ') ?? []),
      ...(rootPackage.scripts?.['test:ci:libraries']?.split(' && ') ?? []),
    ];
    expect(split).toHaveLength(complete.length);
    expect([...split].sort()).toEqual([...complete].sort());
  });

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
    // The apt dependency step is deliberately absent: the runner image already
    // carries Chrome's shared-library set, and reinstalling it cost 23s per
    // run. Pin the absence so it cannot silently return.
    expect(browserJob).not.toContain('bunx playwright install-deps chromium');
    expect(browserJob).toContain('bun run --cwd packages/cli test:app-conformance');
    expect(browserJob).toContain('bun run --cwd packages/cli test:site-cli');
    expect(browserJob).toContain('bun run --cwd packages/cli test:site-static');
    // The full build + composed public site now arrive through the
    // content-keyed restore-dist composite (site flavor); the composite runs
    // scripts/build.sh and scripts/build-site.sh itself on a cache miss.
    expect(browserJob).toContain('uses: ./.github/actions/restore-dist');
    expect(browserJob).toContain('flavor: site');
    const build = browserJob.indexOf('uses: ./.github/actions/restore-dist');
    const cache = browserJob.indexOf('Cache Playwright Chromium');
    const browser = browserJob.indexOf('bunx playwright install chromium');
    const proof = browserJob.indexOf('bun run --cwd packages/cli test:app-conformance');
    expect(build).toBeLessThan(cache);
    expect(cache).toBeLessThan(browser);
    expect(browser).toBeLessThan(proof);
  });

  test('standalone CI embeds the Astro site before compiling the binary', () => {
    expect(standaloneJobStart).toBeGreaterThanOrEqual(0);
    expect(standaloneJobEnd).toBeGreaterThan(standaloneJobStart);
    expect(standaloneJob).toContain('uses: ./.github/actions/restore-dist');
    expect(standaloneJob).toContain('flavor: site');
    expect(standaloneJob).not.toContain('flavor: packages');
    expect(standaloneJob.indexOf('uses: ./.github/actions/restore-dist')).toBeLessThan(
      standaloneJob.indexOf('bun run --cwd packages/cli compile host'),
    );
  });
});
