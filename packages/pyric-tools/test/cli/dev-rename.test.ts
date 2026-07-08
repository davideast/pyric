/**
 * `pyric serve` → `pyric dev` rename (Tier 1 of the adoption-experience plan).
 *
 * Pins the two contracts of the rename:
 *   1. `pyric serve` is a HARD error stub — one line on stderr, exit 1 —
 *      never a silent alias, so scripts and muscle memory get corrected.
 *   2. The help text advertises `dev`, not `serve`.
 *
 * The auto-open gating (`--no-open` / `--json` never pop a browser) is pinned
 * separately in test/serve/open-browser.test.ts (`shouldAutoOpen`).
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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

describe('pyric serve → pyric dev rename', () => {
  it('`pyric serve` is a hard error stub: one line, exit 1, no server started', () => {
    const { code, stdout, stderr } = runCli(['serve']);
    expect(code).toBe(1);
    expect(stderr).toBe('pyric serve was renamed to pyric dev\n');
    expect(stdout).toBe('');
  });

  it('the stub fires even with flags attached (no silent fallthrough)', () => {
    const { code, stderr } = runCli(['serve', '--port', '0', '--json', '--no-open']);
    expect(code).toBe(1);
    expect(stderr).toContain('pyric serve was renamed to pyric dev');
  });

  it('--help advertises `pyric dev` and never `pyric serve`', () => {
    const { code, stdout } = runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('pyric dev [flags]');
    expect(stdout).not.toContain('pyric serve');
  });
});
