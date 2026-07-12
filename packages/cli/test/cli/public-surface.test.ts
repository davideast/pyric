import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const packageRoot = join(import.meta.dir, '..', '..');
const entry = join(packageRoot, 'src', 'cli', 'index.ts');

function run(args: string[]) {
  const result = spawnSync('bun', [entry, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('pyric command surface', () => {
  it('exposes local development and verification without project administration', () => {
    const result = run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('pyric dev');
    expect(result.stdout).toContain('pyric verify');
    expect(result.stdout).toContain('pyric firestore rules lint');
    expect(result.stdout).toContain('pyric firestore rules resolve');
    expect(result.stdout).toContain('pyric firestore indexes generate');
    expect(result.stdout).toContain('pyric database rules generate');
    expect(result.stdout).not.toContain('rules:lint');
    expect(result.stdout).not.toContain('database:rules');
    expect(result.stdout).not.toMatch(/^\s*pyric deploy\b/m);
    expect(result.stdout).not.toMatch(/^\s*pyric login\b/m);
    expect(result.stdout).not.toContain('auth:configure-provider');
    expect(result.stdout).not.toContain('firestore:discover');
  });

  it('does not dispatch removed project-administration commands', () => {
    const result = run(['deploy', 'rules']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown command 'deploy'");
  });

  it('dispatches service-first rules commands', () => {
    const result = run(['firestore', 'rules', 'lint']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('pyric firestore rules lint: missing rules-file path');
    expect(result.stderr).not.toContain("unknown command 'firestore'");
  });
});
