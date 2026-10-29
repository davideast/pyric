/**
 * #1423: `pyric sandbox --hosted -- vite` in a Vite project with no build
 * stops on the missing `hosting.public` directory. Its hint must name the way
 * a Vite app reaches the Node host, `pyric({ hosted: true })` in its Vite
 * config, and not send the user to a dev script that runs the in-page sandbox.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingPublicDirHint } from '../../src/cli/public-dir-hint.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-public-dir-hint-'));
  dirs.push(dir);
  for (const file of files) writeFileSync(join(dir, file), '');
  return dir;
}

describe('missingPublicDirHint', () => {
  it('names pyric({ hosted: true }) and the Vite config for --hosted in a Vite project', () => {
    const cwd = project(['vite.config.ts']);
    const hint = missingPublicDirHint(join(cwd, 'dist'), { cwd, hosted: true });
    expect(hint).toContain('pyric({ hosted: true }) in vite.config.ts');
    expect(hint).not.toContain('bun run dev');
  });

  it('names the Vite config file the project has', () => {
    const cwd = project(['vite.config.mjs']);
    expect(missingPublicDirHint(join(cwd, 'dist'), { cwd, hosted: true })).toContain('in vite.config.mjs');
  });

  it('keeps the build hint without --hosted', () => {
    const cwd = project(['vite.config.ts']);
    const hint = missingPublicDirHint(join(cwd, 'dist'), { cwd, hosted: false });
    expect(hint).toContain('No build yet?');
    expect(hint).not.toContain('hosted: true');
  });

  it('keeps the build hint for --hosted in a project with no Vite config', () => {
    const cwd = project([]);
    const hint = missingPublicDirHint(join(cwd, 'dist'), { cwd, hosted: true });
    expect(hint).toContain('No build yet?');
    expect(hint).not.toContain('hosted: true');
  });

  it('names pyric({ hosted: true }) for --hosted in a Vite project whatever the directory is called', () => {
    const cwd = project(['vite.config.ts']);
    expect(missingPublicDirHint(join(cwd, 'public'), { cwd, hosted: true })).toContain('pyric({ hosted: true })');
  });

  it('gives no hint for a directory that is not build output in a project with no Vite config', () => {
    const cwd = project([]);
    expect(missingPublicDirHint(join(cwd, 'public'), { cwd, hosted: true })).toBe('');
  });
});
