import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('generated conformance documentation CI contract', () => {
  it('runs the clean-checkout, deterministic site proof on every code PR', () => {
    const workflow = readFileSync(new URL('../../../../.github/workflows/build.yml', import.meta.url), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL('../../../site-docs/package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const verifier = readFileSync(new URL('../../../site-docs/scripts/verify-generated.ts', import.meta.url), 'utf8');
    const job = workflow.slice(workflow.indexOf('  generated-docs:'), workflow.indexOf('  build-and-test:'));
    expect(job).toContain('Cache Playwright Chromium');
    expect(job).toContain('bunx playwright install chromium');
    expect(job).toContain('bunx playwright install-deps chromium');
    expect(job).toContain('bun run --cwd packages/site-docs test:generated');
    const cache = job.indexOf('Cache Playwright Chromium');
    const browser = job.indexOf('bunx playwright install chromium');
    const dependencies = job.indexOf('bunx playwright install-deps chromium');
    const proof = job.indexOf('bun run --cwd packages/site-docs test:generated');
    expect(cache).toBeLessThan(browser);
    expect(browser).toBeLessThan(dependencies);
    expect(dependencies).toBeLessThan(proof);
    expect(workflow).not.toContain('paths-ignore:');
    expect(manifest.scripts?.['test:generated']).toBe('bun scripts/verify-generated.ts && bun scripts/audit-rhythm.ts');
    expect(verifier).toContain("['ls-files', '--others', '--exclude-standard', '-z']");
  });

  it('proves the compact Playground query through a clean-checkout package build', () => {
    const workflow = readFileSync(new URL('../../../../.github/workflows/build.yml', import.meta.url), 'utf8');
    const job = workflow.slice(workflow.indexOf('  playground-caniuse:'), workflow.indexOf('  generated-docs:'));
    expect(job).toContain('bash scripts/build.sh --packages-only');
    expect(job).toContain('bun run --cwd packages/playground test:can-i-use');
    expect(job).not.toContain('bun run build:cli');
  });
});
