/**
 * `pyric --version` / `-v` prints two numbers, not one: @pyric/cli' own
 * version (what you installed) and the Firebase version this release is
 * conformance-tested against (the `fb` dist-tag claim — see
 * packages/pyric/docs/explanation/versioning-and-compatibility.md). A
 * bare package version answers "what did I install" but not "what does
 * it behave like," which is the question this command exists to answer.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { FIREBASE_TESTED_AGAINST } from '../../src/version/compat-target.js';

const PKG_ROOT = join(import.meta.dir, '..', '..');
const CLI_ENTRY = join(PKG_ROOT, 'src', 'cli', 'index.ts');

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', [CLI_ENTRY, ...args], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const ownVersion = (
  JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

describe('pyric --version', () => {
  it('--version prints the @pyric/cli version and the tested-against Firebase version', () => {
    const { code, stdout } = runCli(['--version']);
    expect(code).toBe(0);
    expect(stdout).toContain(ownVersion);
    expect(stdout).toContain(FIREBASE_TESTED_AGAINST);
  });

  it('-v is the same as --version', () => {
    const { code, stdout } = runCli(['-v']);
    expect(code).toBe(0);
    expect(stdout).toContain(ownVersion);
    expect(stdout).toContain(FIREBASE_TESTED_AGAINST);
  });
});
