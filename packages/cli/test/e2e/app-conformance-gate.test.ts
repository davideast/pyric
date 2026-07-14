import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../../..');
const cliPackage = JSON.parse(
  readFileSync(resolve(root, 'packages/cli/package.json'), 'utf8'),
) as { scripts?: Record<string, string> };
const workflow = readFileSync(resolve(root, '.github/workflows/build.yml'), 'utf8');

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
    expect(workflow).toContain('bun x playwright install --with-deps chromium');
    expect(workflow).toContain('bun run --cwd packages/cli test:app-conformance');
    expect(workflow.indexOf('bash scripts/build.sh')).toBeLessThan(
      workflow.indexOf('bun run --cwd packages/cli test:app-conformance'),
    );
  });
});
