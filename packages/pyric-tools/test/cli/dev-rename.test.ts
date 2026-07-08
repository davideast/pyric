/**
 * `pyric dev` command contract (the command was named `serve` pre-npm; the
 * old name was removed outright — never published, no consumers).
 *
 * Pins:
 *   1. `pyric serve` is an unknown command — generic usage error, exit 1 —
 *      not an alias and not a bespoke stub.
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

describe('pyric dev command surface', () => {
  it('`pyric serve` is an unknown command (no alias, no bespoke stub)', () => {
    const { code } = runCli(['serve']);
    expect(code).toBe(1);
  });

  it('--help advertises `pyric dev` and never `pyric serve`', () => {
    const { code, stdout } = runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('pyric dev [flags]');
    expect(stdout).not.toContain('pyric serve');
  });
});
