// Finding Codex on the host: only an npm install of @openai/codex is bound.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexInstall } from './install.ts';

/** A prefix with `bin/codex` linked to `<package>/bin/codex.js`, whose package.json names `name`. */
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
  test('finds codex on PATH and binds its npm package', () => {
    const { pathDir, packageDir, launcher } = installed('@openai/codex');
    expect(codexInstall({ PATH: `/nonexistent:${pathDir}` })).toEqual({ command: launcher, binds: [packageDir] });
  });

  test('refuses a codex outside an npm install of @openai/codex, and no codex at all', () => {
    expect(() => codexInstall({ PATH: installed('something-else').pathDir })).toThrow('is not in an npm install of @openai/codex');
    expect(() => codexInstall({ PATH: installed(null).pathDir })).toThrow('is not in an npm install of @openai/codex');
    expect(() => codexInstall({ PATH: '/nonexistent' })).toThrow('no codex on PATH');
  });
});
