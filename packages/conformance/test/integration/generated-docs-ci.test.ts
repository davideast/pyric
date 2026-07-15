import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('generated conformance documentation CI contract', () => {
  it('runs the clean-checkout, deterministic site proof on every code PR', () => {
    const workflow = readFileSync(new URL('../../../../.github/workflows/build.yml', import.meta.url), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL('../../../site-docs/package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const verifier = readFileSync(new URL('../../../site-docs/scripts/verify-generated.ts', import.meta.url), 'utf8');
    expect(workflow).toContain('bun run --cwd packages/site-docs test:generated');
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
