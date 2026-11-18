import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JOB_TMP_MARKER } from '../../../../scripts/lib/private-job-tmpdir.ts';

const CLI_ROOT = resolve(import.meta.dir, '../..');
const scratchRoots: string[] = [];

afterEach(() => {
  while (scratchRoots.length > 0) {
    const dir = scratchRoots.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('serve and snapshot test suite TMPDIR hygiene', () => {
  it('actively allocates inside PYRIC_TEST_TMP_ROOT and leaves both PYRIC_TEST_TMP_ROOT and ambient TMPDIR empty', () => {
    const cacheParent = join(homedir(), '.cache');
    mkdirSync(cacheParent, { recursive: true });
    const dedicatedTmp = mkdtempSync(join(cacheParent, 'pyric-ut-tmpdir-hygiene-'));
    scratchRoots.push(dedicatedTmp);

    // Keep ambient TMPDIR distinct from PYRIC_TEST_TMP_ROOT because private-job-tmpdir
    // refuses PYRIC_TEST_TMP_ROOT === os.tmpdir().
    const ambientTmp = mkdtempSync(join(tmpdir(), 'pyric-tmpdir-ambient-'));
    scratchRoots.push(ambientTmp);

    // Seed a dead-PID marker directory so the empty-dir check at the end cannot pass vacuously.
    const staleChild = join(dedicatedTmp, 'cli-stale-dead');
    mkdirSync(staleChild);
    writeFileSync(join(staleChild, JOB_TMP_MARKER), '2147483646\n');
    expect(existsSync(staleChild)).toBe(true);

    const suites = [
      'test/serve/rules.test.ts',
      'test/serve/snapshot-promote.test.ts',
      'test/serve/vite-real-path-deny.test.ts',
    ];
    for (const suite of suites) {
      const result = spawnSync('bun', ['test', suite], {
        cwd: CLI_ROOT,
        env: {
          ...process.env,
          PYRIC_TEST_TMP_ROOT: dedicatedTmp,
          TMPDIR: ambientTmp,
          TMP: ambientTmp,
          TEMP: ambientTmp,
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
    }

    expect(readdirSync(dedicatedTmp)).toEqual([]);
    expect(readdirSync(ambientTmp)).toEqual([]);
  }, 60_000);
});
