import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('CLI prebuild recreates missing served inventory before loading its consumers', () => {
  const root = mkdtempSync(join(tmpdir(), 'pyric-clean-prebuild-'));
  try {
    // Isolate generated writes from other suites and retain the already-built
    // workspace dependencies, as the package build does before CLI prebuild.
    for (const path of ['src', 'scripts', 'package.json']) {
      cpSync(join(cliRoot, path), join(root, path), { recursive: true });
    }
    symlinkSync(join(cliRoot, 'node_modules'), join(root, 'node_modules'));
    const inventory = join(root, 'src/conformance/.generated/served-availability.ts');
    rmSync(inventory, { force: true });
    expect(existsSync(inventory)).toBe(false);
    const run = spawnSync(process.execPath, ['run', 'prebuild'], {
      cwd: root,
      env: { ...process.env, PYRIC_CONFORMANCE_READY: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const succeeded = run.status === 0;
    expect({ status: run.status, error: run.error, stderr: succeeded ? '' : run.stderr })
      .toEqual({ status: 0, error: undefined, stderr: '' });
    expect(existsSync(inventory)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 35_000);
