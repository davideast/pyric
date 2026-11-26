// Safe reproduction scratch cleanup (#1767), verifying both AGENTS.md Rule 8
// gates: allowlisted parent location (`~/.pyric/<subroot>` or `~/.cache/pyric-*`)
// with non-symlink `lstatSync` and unconditional `tmpdir()` refusal, plus a
// regular `.pyric-job-tmp` ownership marker.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from '../../scripts/lib/private-job-tmpdir.ts';
import * as ownerAccessModule from './owner-access.ts';
import { REPRO_SCRATCH_MARKER, removeReproTryScratch, stampReproTryMarker } from './repro-scratch.ts';
import { reproScratchRoot } from './round-paths.ts';

const ALLOWLISTED_TEST_ENV = {
  PYRIC_TEST_TMP_ROOT: join(homedir(), '.cache', 'pyric-ut-repro-scratch'),
};
const createdJobDirs: string[] = [];

function makeAllowlistedBase(label: string): string {
  const dir = createPrivateJobTmpDir(label, ALLOWLISTED_TEST_ENV);
  createdJobDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdJobDirs.length > 0) {
    const dir = createdJobDirs.pop();
    if (dir !== undefined) {
      removePrivateJobTmpDir(dir, ALLOWLISTED_TEST_ENV);
    }
  }
});

describe('reproScratchRoot', () => {
  test('defaults to ~/.cache/pyric-builders-repros when PYRIC_BUILDERS_DIR is unset', () => {
    expect(reproScratchRoot({})).toBe(join(homedir(), '.cache', 'pyric-builders-repros'));
    expect(reproScratchRoot({ PYRIC_BUILDERS_DIR: '/custom/dir' })).toBe('/custom/dir');
  });
});

describe('removeReproTryScratch', () => {
  test('removes a marked scratch directory under ~/.cache/pyric-*, including chmod 000 children', () => {
    const base = makeAllowlistedBase('repro-ok');
    const tryDir = join(base, 'r1', 'r1-1.repros', 'p1', 'try-1');
    mkdirSync(join(tryDir, 'app'), { recursive: true });
    writeFileSync(join(tryDir, 'app', 'locked.txt'), 'locked\n');
    chmodSync(join(tryDir, 'app', 'locked.txt'), 0o000);
    stampReproTryMarker(tryDir);

    expect(removeReproTryScratch(tryDir)).toBe(true);
    expect(existsSync(tryDir)).toBe(false);
    expect(existsSync(base)).toBe(true);
  });

  test('refuses a directory without the .pyric-job-tmp ownership marker, or with a symlinked marker', () => {
    const base = makeAllowlistedBase('repro-nomark');
    const unmarked = join(base, 'try-unmarked');
    mkdirSync(unmarked, { recursive: true });
    writeFileSync(unmarked + '/keep.txt', 'keep\n');
    expect(removeReproTryScratch(unmarked)).toBe(false);
    expect(existsSync(unmarked)).toBe(true);

    const outsideMarker = join(base, 'real-marker');
    writeFileSync(outsideMarker, '1\n');
    symlinkSync(outsideMarker, join(unmarked, REPRO_SCRATCH_MARKER));
    expect(removeReproTryScratch(unmarked)).toBe(false);
    expect(existsSync(unmarked)).toBe(true);
  });

  test('refuses a symbolic link at the target directory and leaves the link target untouched', () => {
    const base = makeAllowlistedBase('repro-link');
    const realTarget = join(base, 'real-dir');
    mkdirSync(realTarget, { recursive: true });
    stampReproTryMarker(realTarget);
    const linkPath = join(base, 'try-link');
    symlinkSync(realTarget, linkPath);

    expect(removeReproTryScratch(linkPath)).toBe(false);
    expect(existsSync(realTarget)).toBe(true);
    unlinkSync(linkPath);
  });

  test('refuses paths inside tmpdir() or XDG_RUNTIME_DIR even when marked', () => {
    const osTmpBase = mkdtempSync(join(tmpdir(), 'repro-scratch-ostmp-'));
    const tryInOsTmp = join(osTmpBase, 'try-1');
    mkdirSync(tryInOsTmp);
    stampReproTryMarker(tryInOsTmp);
    try {
      expect(removeReproTryScratch(tryInOsTmp)).toBe(false);
      expect(existsSync(tryInOsTmp)).toBe(true);
    } finally {
      unlinkSync(join(tryInOsTmp, REPRO_SCRATCH_MARKER));
      rmdirSync(tryInOsTmp);
      rmdirSync(osTmpBase);
    }

    const base = makeAllowlistedBase('repro-xdg');
    const xdgDir = join(base, 'xdg-runtime');
    const tryInXdg = join(xdgDir, 'try-1');
    mkdirSync(tryInXdg, { recursive: true });
    stampReproTryMarker(tryInXdg);
    expect(removeReproTryScratch(tryInXdg, { XDG_RUNTIME_DIR: xdgDir })).toBe(false);
    expect(existsSync(tryInXdg)).toBe(true);
    expect(removeReproTryScratch(tmpdir())).toBe(false);
  });

  test('returns false instead of throwing when filesystem removal fails with EBUSY', () => {
    const base = makeAllowlistedBase('repro-busy');
    const tryDir = join(base, 'try-busy');
    mkdirSync(tryDir, { recursive: true });
    stampReproTryMarker(tryDir);

    const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    const spy = spyOn(ownerAccessModule, 'restoreOwnerAccess').mockImplementationOnce(() => {
      throw busy;
    });
    try {
      expect(removeReproTryScratch(tryDir)).toBe(false);
      expect(existsSync(tryDir)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
