// Finding the agent on the host: only an npm install of its own package is bound.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexInstall } from './install.ts';

/** A prefix with the launcher in `bin/` linked into `<package>/bin/`, whose package.json names `name`. */
function installed(name: string | null): { pathDir: string; packageDir: string; launcher: string } {
  const prefix = mkdtempSync(join(tmpdir(), 'factory-install-'));
  const packageDir = join(prefix, 'node_modules', '@openai', 'codex');
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  if (name !== null) writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name }));
  const launcher = join(packageDir, 'bin', 'codex.js');
  writeFileSync(launcher, '');
  chmodSync(launcher, 0o755);
  const pathDir = join(prefix, 'bin');
  mkdirSync(pathDir);
  symlinkSync(launcher, join(pathDir, 'codex'));
  return { pathDir, packageDir, launcher };
}

describe('codexInstall', () => {
  test('finds the agent on PATH and binds its npm package', () => {
    const { pathDir, packageDir, launcher } = installed('@openai/codex');
    expect(codexInstall({ PATH: `/nonexistent:${pathDir}` })).toEqual({ command: launcher, binds: [packageDir] });
  });

  test('refuses a launcher outside an npm install of the agent’s package, and no launcher at all', () => {
    expect(() => codexInstall({ PATH: installed('something-else').pathDir })).toThrow('is not in an npm install of its package');
    expect(() => codexInstall({ PATH: installed(null).pathDir })).toThrow('is not in an npm install of its package');
    expect(() => codexInstall({ PATH: '/nonexistent' })).toThrow('the agent is not on PATH');
  });
});
