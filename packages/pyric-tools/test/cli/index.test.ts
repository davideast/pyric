import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIREBASE_TESTED_AGAINST } from '../../src/version/compat-target.js';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [CLI_ENTRY, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('pyric dev command surface', () => {
  it('rejects the removed serve spelling instead of retaining an alias', () => {
    expect(runCli(['serve']).code).toBe(1);
  });

  it('advertises dev and never serve', () => {
    const { code, stdout } = runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('pyric dev [flags]');
    expect(stdout).not.toContain('pyric serve');
  });
});

const ownVersion = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

describe('pyric version output', () => {
  for (const flag of ['--version', '-v']) {
    it(`${flag} names the package and tested-against Firebase versions`, () => {
      const { code, stdout } = runCli([flag]);
      expect(code).toBe(0);
      expect(stdout).toContain(ownVersion);
      expect(stdout).toContain(FIREBASE_TESTED_AGAINST);
    });
  }
});
