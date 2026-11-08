import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realProjectPathWithin } from '../../../../src/bridge/surface/arguments/project-real-path.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';

const tempDirs: string[] = [];

function createTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('realProjectPathWithin', () => {
  const fail = failFor('database', 'extractIndexes');

  it('accepts paths and internal symlinks resolving inside the project directory', () => {
    const proj = createTemp('pyric-real-path-proj-');
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'app.ts'), 'export const a = 1;');
    symlinkSync(join(proj, 'src', 'app.ts'), join(proj, 'internal-link.ts'));

    const direct = realProjectPathWithin(proj, 'src/app.ts', 'paths', fail);
    expect('path' in direct).toBe(true);
    if ('path' in direct) {
      expect(direct.path).toBe(join(proj, 'src', 'app.ts'));
    }

    const internal = realProjectPathWithin(proj, 'internal-link.ts', 'paths', fail);
    expect('path' in internal).toBe(true);
    if ('path' in internal) {
      expect(internal.path).toBe(join(proj, 'src', 'app.ts'));
    }
  });

  it('refuses symlinks, broken symlinks, and symlinked ancestor directories escaping outside projectDir', () => {
    const proj = createTemp('pyric-real-path-proj-');
    const outside = createTemp('pyric-real-path-out-');
    writeFileSync(join(outside, 'secret.ts'), 'export const s = 1;');
    symlinkSync(join(outside, 'secret.ts'), join(proj, 'escape.ts'));
    symlinkSync(join(outside, 'missing.ts'), join(proj, 'broken.ts'));
    symlinkSync(outside, join(proj, 'escaped-dir'));

    const escapeFile = realProjectPathWithin(proj, 'escape.ts', 'paths', fail);
    expect('path' in escapeFile).toBe(false);
    if (!('path' in escapeFile)) {
      expect(escapeFile.summary).toContain('outside the project directory');
    }

    const brokenLink = realProjectPathWithin(proj, 'broken.ts', 'paths', fail);
    expect('path' in brokenLink).toBe(false);

    const missingUnderEscapedDir = realProjectPathWithin(
      proj,
      'escaped-dir/new.rules.json',
      'rulesPath',
      fail,
    );
    expect('path' in missingUnderEscapedDir).toBe(false);
  });
});
